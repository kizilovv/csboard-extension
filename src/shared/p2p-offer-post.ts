/*
  The POST that creates one Steam trade offer.

  Lifted out of the trade-page content script so the service worker can do the
  same thing without a tab, which is the whole point: opening a visible Steam
  window and waiting for a content script to boot is a handshake with four ways
  to fail (pop-up blocker, slow load, Steam sign-in wall, a script that never
  answers), and sellers hit `TAB_UNREACHABLE` on a send that Steam would have
  accepted. CSFloat posts this straight from the background and so do we now.

  Steam wants three things here. Two travel on their own:

    · `sessionid` — Steam's CSRF token, and NOT httpOnly, which is why it can be
      read at all. The content script takes it from `document.cookie`; the
      service worker asks `chrome.cookies` for the same value.
    · `steamLoginSecure` and friends — carried by `credentials: 'include'`,
      because the extension holds host permission for steamcommunity.com.

  The third is the Referer, and it is the reason this file needs a note. Steam
  rejects a create-offer POST whose Referer is not a trade page, and `Referer`
  is a forbidden header: assigning it in `fetch` does nothing in any current
  browser. From a trade page the browser sets it for free. From the background
  there is no page, so it is set declaratively instead — see
  `src/steamcommunity_ruleset.json`, which rewrites it for exactly this URL and
  only for requests this extension initiates. Remove that rule and every
  background send fails with a Steam error that looks like a session problem.
*/

import { buildTradeOfferPayload, type P2PTabSendResult } from './p2p-send-protocol';

export const TRADE_SEND_URL = 'https://steamcommunity.com/tradeoffer/new/send';

/*
  Steam answers a rejected offer with 200 and an `strError` in the JSON, so the
  HTTP status alone says almost nothing. These are the phrases that matter,
  matched loosely because Steam localises and reworks them, and each maps to a
  different thing for the seller to do.
*/
export function classifySteamError(message: string): P2PTabSendResult {
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

export interface OfferPostInput {
  sessionId: string;
  /** SteamID64 of the buyer, as Steam's `partner` field wants it. */
  partnerSteamId: string;
  /** The `token` query parameter from the buyer's trade URL. */
  partnerToken: string;
  assetId: string;
  appId: number;
  contextId: string;
  message: string;
  /**
   * Only the content script passes this, and only because it is already on the
   * page Steam wants to see. From the background it is deliberately absent:
   * `fetch` cannot set Referer, and the declarative rule supplies it.
   */
  referer?: string;
}

export async function postTradeOffer(input: OfferPostInput): Promise<P2PTabSendResult> {
  const body = new URLSearchParams({
    sessionid: input.sessionId,
    serverid: '1',
    partner: input.partnerSteamId,
    tradeoffermessage: input.message,
    json_tradeoffer: buildTradeOfferPayload({
      assetId: input.assetId,
      appId: input.appId,
      contextId: input.contextId,
    }),
    captcha: '',
    trade_offer_create_params: JSON.stringify({ trade_offer_access_token: input.partnerToken }),
  });

  let response: Response;
  try {
    response = await fetch(TRADE_SEND_URL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        ...(input.referer ? { Referer: input.referer } : {}),
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: body.toString(),
    });
  } catch (error) {
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
