/**
 * First-party Steam session bridge.
 *
 * Chromium may hide Steam cookies from the extension service worker, while a
 * signed-in steamcommunity.com page already has the short-lived Web API token
 * in its DOM. Send the two-field credential only to our own worker. The worker
 * validates this exact HTTPS origin and account, keeps the token in memory,
 * and rate-limits actual portfolio syncs to the disclosed hourly cadence.
 *
 * The one request this file makes is to Steam itself, for the page it already
 * runs on the origin of. The credential goes to the worker and nowhere else.
 */

import { sendMessageIfContextAlive } from '../../shared/message-bus';
import {
  isSteamPageCredentialRequest,
  isSteamTokenExpired,
  readSteamPageCredential,
  STEAM_COMMUNITY_ORIGIN,
  type SteamPageCredential,
  type SteamPageCredentialResponse,
} from '../../shared/steam-page-credential';

const CREDENTIAL_REFRESH_MS = 4 * 60 * 1_000;
const INITIAL_RETRY_MS = 250;
const MAX_INITIAL_ATTEMPTS = 20;
/** Any signed-in community page carries the token; this is the one the worker mints from. */
const TOKEN_PAGE_PATH = '/my/tradehistory?l=english';
/** A refetch that did not help is not repeated on every ask. */
const REFETCH_MIN_INTERVAL_MS = 60 * 1_000;

/*
  The token in this page's DOM is the one Steam wrote when the page LOADED, and
  it dies 24 hours after it was issued. A tab left open past that is not a
  credential source any more, it is a source of 403s: the worker asked, this
  script answered with the dead token, and every read failed until somebody
  reloaded the tab.

  So an expired page token is never handed over. Instead the page is fetched
  again from here, where the request is first-party and Steam's cookies ride
  along whatever the browser does to third-party ones, and the token is read
  out of that copy. Kept in memory only, like the worker's.
*/
let refetched: SteamPageCredential | null = null;
let refetching: Promise<void> | null = null;
let lastRefetchAt = 0;

function liveCredential(): SteamPageCredential | null {
  const now = Date.now();
  for (const credential of [readSteamPageCredential(), refetched]) {
    if (credential && !isSteamTokenExpired(credential.pageAccessToken, now)) return credential;
  }
  return null;
}

function refetchCredential(): Promise<void> {
  if (refetching) return refetching;
  if (Date.now() - lastRefetchAt < REFETCH_MIN_INTERVAL_MS) return Promise.resolve();
  lastRefetchAt = Date.now();
  refetching = (async () => {
    try {
      const response = await fetch(`${STEAM_COMMUNITY_ORIGIN}${TOKEN_PAGE_PATH}`, {
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'text/html' },
      });
      // Signed out lands on a login page of another origin, or does not land.
      if (!response.ok || new URL(response.url).origin !== STEAM_COMMUNITY_ORIGIN) return;
      // An inert copy: a parsed document runs no scripts and loads nothing.
      const copy = new DOMParser().parseFromString(await response.text(), 'text/html');
      refetched = readSteamPageCredential(copy);
    } catch {
      // Offline, or Steam is down. The worker has its own way to a token.
    } finally {
      refetching = null;
    }
  })();
  return refetching;
}

function offerCredential(): boolean {
  if (window.location.origin !== STEAM_COMMUNITY_ORIGIN) return false;
  const credential = liveCredential();
  if (!credential) {
    // The page is there and its token is not: get a fresh one for the next ask.
    if (readSteamPageCredential()) void refetchCredential();
    return false;
  }
  sendMessageIfContextAlive({
    type: 'OFFER_STEAM_PAGE_CREDENTIAL',
    version: 1,
    data: credential,
  });
  return true;
}

function offerWithBoundedInitialRetry(attempt = 1): void {
  if (offerCredential() || attempt >= MAX_INITIAL_ATTEMPTS) return;
  window.setTimeout(() => offerWithBoundedInitialRetry(attempt + 1), INITIAL_RETRY_MS);
}

// A cold MV3 worker cannot wait up to four minutes for the periodic offer when
// the user has just pressed Sync now. It may ask an already-open trusted Steam
// tab for the same two-field credential. The response goes only to our own
// extension worker and is neither stored nor exposed to the page.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id ||
      window.location.origin !== STEAM_COMMUNITY_ORIGIN ||
      !isSteamPageCredentialRequest(message)) {
    return false;
  }
  const live = liveCredential();
  if (live || !readSteamPageCredential()) {
    sendResponse({ credential: live } satisfies SteamPageCredentialResponse);
    return false;
  }
  // Expired: answer once the refetch is in. A worker that has stopped waiting
  // simply drops the answer, and the next ask finds the token already here.
  void refetchCredential().then(() => {
    sendResponse({ credential: liveCredential() } satisfies SteamPageCredentialResponse);
  });
  return true;
});

offerWithBoundedInitialRetry();
window.addEventListener('pageshow', () => offerWithBoundedInitialRetry());
window.setInterval(() => offerWithBoundedInitialRetry(), CREDENTIAL_REFRESH_MS);
