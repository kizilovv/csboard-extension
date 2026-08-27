/*
  Posts one P2P delivery offer, from inside the Steam trade page.

  This file exists because Steam's trade endpoint needs three things that only a
  page context has: the `sessionid` CSRF cookie, a `Referer` that is the trade
  page for this exact partner, and the partner token from the URL. The
  background worker has none of them, so it opens the buyer's trade URL and asks
  this script to do the POST.

  What this script does NOT do is decide anything. The asset, the partner and
  the message all arrive in the command; there is no code path here that reads
  the page's own item selection. That is the point — Steam's trade window is
  where a seller could substitute a different skin, and this send never consults
  it.
*/

import {
  P2P_TAB_CANCEL_COMMAND,
  P2P_TAB_SEND_COMMAND,
  buildTradeOfferPayload,
  type P2PTabCancelCommand,
  type P2PTabCancelResult,
  type P2PTabSendCommand,
  type P2PTabSendResult,
} from '../../shared/p2p-send-protocol';
import { createLogger } from '../../shared/logger';

const logger = createLogger('p2p-send');

const TRADE_SEND_URL = 'https://steamcommunity.com/tradeoffer/new/send';

/** Steam's CSRF token. Not httpOnly, which is why a page can read it at all. */
function readSessionId(): string | null {
  const match = /(?:^|;\s*)sessionid=([^;]+)/.exec(document.cookie);
  const raw = match?.[1];
  return raw ? decodeURIComponent(raw) : null;
}

/*
  Steam answers a rejected offer with 200 and an `strError` in the JSON, so the
  HTTP status alone says almost nothing. These are the phrases that matter,
  matched loosely because Steam localises and reworks them, and each maps to a
  different thing for the seller to do.
*/
function classifySteamError(message: string): P2PTabSendResult {
  const text = message.toLowerCase();
  if (text.includes('not available to trade') || text.includes('trade ban') || text.includes('probation')) {
    return { ok: false, code: 'STEAM_REFUSED', detail: message };
  }
  if (text.includes('they have a trade ban') || text.includes('unable to receive') || text.includes('inventory is full')) {
    return { ok: false, code: 'PARTNER_UNAVAILABLE', detail: message };
  }
  if (text.includes('item') && (text.includes('no longer') || text.includes('not found'))) {
    return { ok: false, code: 'ITEM_NOT_IN_INVENTORY', detail: message };
  }
  if (text.includes('logged in') || text.includes('sign in')) {
    return { ok: false, code: 'NO_STEAM_SESSION', detail: message };
  }
  return { ok: false, code: 'STEAM_REFUSED', detail: message };
}

async function sendOffer(command: P2PTabSendCommand): Promise<P2PTabSendResult> {
  const sessionId = readSessionId();
  if (!sessionId) return { ok: false, code: 'NO_STEAM_SESSION' };

  const body = new URLSearchParams({
    sessionid: sessionId,
    serverid: '1',
    partner: command.partnerSteamId,
    tradeoffermessage: command.message,
    json_tradeoffer: buildTradeOfferPayload({
      assetId: command.assetId,
      appId: command.appId,
      contextId: command.contextId,
    }),
    captcha: '',
    trade_offer_create_params: JSON.stringify({ trade_offer_access_token: command.partnerToken }),
  });

  let response: Response;
  try {
    response = await fetch(TRADE_SEND_URL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        // Steam checks this against the partner in the body. The background
        // navigated us here precisely so it is true rather than forged.
        Referer: window.location.href,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: body.toString(),
    });
  } catch (error) {
    logger.warn('Trade POST failed at the network layer', { error: String(error) });
    return { ok: false, code: 'UNKNOWN', detail: String(error) };
  }

  if (response.status === 429) return { ok: false, code: 'RATE_LIMITED' };
  if (response.status === 401 || response.status === 403) {
    return { ok: false, code: 'NO_STEAM_SESSION', detail: `HTTP ${response.status}` };
  }

  let payload: {
    tradeofferid?: string;
    strError?: string;
    needs_mobile_confirmation?: boolean;
    needs_email_confirmation?: boolean;
  } | null = null;
  try {
    payload = await response.json();
  } catch {
    // A non-JSON body from this endpoint is Steam's sign-in page or an error
    // wall — either way the session is what failed, not the offer.
    return { ok: false, code: 'NO_STEAM_SESSION', detail: `HTTP ${response.status}` };
  }

  if (payload?.strError) return classifySteamError(payload.strError);
  if (!payload?.tradeofferid) {
    return { ok: false, code: 'UNKNOWN', detail: `HTTP ${response.status}, no offer id` };
  }

  return {
    ok: true,
    steamTradeOfferId: String(payload.tradeofferid),
    needsMobileConfirmation: payload.needs_mobile_confirmation === true,
    needsEmailConfirmation: payload.needs_email_confirmation === true,
  };
}

/*
  Cancel an offer this seller sent, from the offer's own page.

  Same shape as the send and the same reason for living in a tab: Steam wants
  the `sessionid` token and a same-origin POST. Nothing is inferred from the
  page — the offer id arrives in the command.

  Only a 200 is treated as accepted. Every other answer is reported as a
  failure and retried on the next pass, because the caller's next step is to go
  and READ the offer's state, and a cancel wrongly recorded as done would stop
  it looking.
*/
async function cancelOffer(command: P2PTabCancelCommand): Promise<P2PTabCancelResult> {
  const sessionId = readSessionId();
  if (!sessionId) return { ok: false, code: 'NO_STEAM_SESSION' };

  let response: Response;
  try {
    response = await fetch(
      `https://steamcommunity.com/tradeoffer/${encodeURIComponent(command.steamTradeOfferId)}/cancel`,
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Referer: window.location.href,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: new URLSearchParams({ sessionid: sessionId }).toString(),
      },
    );
  } catch (error) {
    logger.warn('Cancel POST failed at the network layer', { error: String(error) });
    return { ok: false, code: 'UNKNOWN', detail: String(error) };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, code: 'NO_STEAM_SESSION', detail: `HTTP ${response.status}` };
  }
  if (!response.ok) {
    return { ok: false, code: 'STEAM_REFUSED', detail: `HTTP ${response.status}` };
  }
  return { ok: true };
}

/*
  Only the extension's own background may command a send.

  `sender.id === chrome.runtime.id` is the check that matters: a web page
  reaches `onMessageExternal`, never this listener, so nothing on the open web
  can drive a trade offer out of the seller's account through this path.
*/
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return undefined;
  if (sender.id !== chrome.runtime.id) return undefined;

  if (message.type === P2P_TAB_SEND_COMMAND) {
    sendOffer(message as P2PTabSendCommand)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, code: 'UNKNOWN', detail: String(error) }));
    return true; // async response
  }

  if (message.type === P2P_TAB_CANCEL_COMMAND) {
    cancelOffer(message as P2PTabCancelCommand)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, code: 'UNKNOWN', detail: String(error) }));
    return true; // async response
  }

  return undefined;
});
