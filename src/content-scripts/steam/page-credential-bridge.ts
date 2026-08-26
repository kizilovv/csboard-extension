/**
 * First-party Steam session bridge.
 *
 * Chromium may hide Steam cookies from the extension service worker, while a
 * signed-in steamcommunity.com page already has the short-lived Web API token
 * in its DOM. Send the two-field credential only to our own worker. The worker
 * validates this exact HTTPS origin and account, keeps the token in memory,
 * and rate-limits actual portfolio syncs to the disclosed hourly cadence.
 */

import { sendMessageIfContextAlive } from '../../shared/message-bus';
import {
  isSteamPageCredentialRequest,
  readSteamPageCredential,
  STEAM_COMMUNITY_ORIGIN,
  type SteamPageCredentialResponse,
} from '../../shared/steam-page-credential';

const CREDENTIAL_REFRESH_MS = 4 * 60 * 1_000;
const INITIAL_RETRY_MS = 250;
const MAX_INITIAL_ATTEMPTS = 20;

function offerCredential(): boolean {
  if (window.location.origin !== STEAM_COMMUNITY_ORIGIN) return false;
  const credential = readSteamPageCredential();
  if (!credential) return false;
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
  const response: SteamPageCredentialResponse = {
    credential: readSteamPageCredential(),
  };
  sendResponse(response);
  return false;
});

offerWithBoundedInitialRetry();
window.addEventListener('pageshow', () => offerWithBoundedInitialRetry());
window.setInterval(() => offerWithBoundedInitialRetry(), CREDENTIAL_REFRESH_MS);
