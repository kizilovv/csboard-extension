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
  readSteamPageCredential,
  STEAM_COMMUNITY_ORIGIN,
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

offerWithBoundedInitialRetry();
window.addEventListener('pageshow', () => offerWithBoundedInitialRetry());
window.setInterval(() => offerWithBoundedInitialRetry(), CREDENTIAL_REFRESH_MS);
