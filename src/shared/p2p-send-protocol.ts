/*
  Sending a P2P trade, and why it is built this way.

  ── THE GUARANTEE ─────────────────────────────────────────────────────────

  A buyer pays for one specific copy of a skin — a specific assetId. The whole
  reason this send goes through the extension is that the SELLER never chooses
  what goes in the offer: the item is filled in by code, from an instruction the
  csboard backend issues against the order the buyer actually paid for.

  That guarantee has two halves, and both are load-bearing:

    The page cannot choose either. csboard.com is allowed to say "send order N"
    and nothing more. Everything that decides what leaves the inventory — the
    asset, the recipient, the order number in the message — is fetched by the
    BACKGROUND worker from the backend, under the seller's own csboard session.
    A console on the sell page has nothing to tamper with.

    The backend checks the result. `POST /p2p/ext/annotate-trade` refuses an
    offer whose given assets do not contain the order's assetId, so even a
    wholly compromised extension cannot get a substituted skin accepted as
    delivery.

  ── WHY A TAB, AND NOT A BACKGROUND FETCH ─────────────────────────────────

  Steam's trade endpoint wants three things a service worker cannot supply
  convincingly: the `sessionid` CSRF token (a non-httpOnly cookie readable only
  from a page context), a `Referer` that is the trade page for THIS partner, and
  the partner's token from the trade URL. So the background opens the buyer's
  trade URL in a tab, and the content script already injected on
  `steamcommunity.com/tradeoffer/*` performs the POST from inside that page,
  where all three are naturally true.

  The tab is the seller's own browser doing what it would do anyway — it is not
  a bypass of anything. What it is NOT is Steam's own item picker: the offer is
  posted with a fixed payload rather than assembled by hand.
*/

/** The one command the page may send. Everything else is decided server-side. */
export const P2P_SEND_TRADE_MESSAGE_TYPE = 'P2P_SEND_TRADE' as const;

/** Background → content script, once the tab is on the right trade page. */
export const P2P_TAB_SEND_COMMAND = 'CSBOARD_P2P_TAB_SEND' as const;

/*
  Background → content script: kill an offer this seller already sent.

  The mirror of the send, and needed for the same reason: Steam's cancel wants
  the `sessionid` cookie and a same-origin request, neither of which a service
  worker has. It runs on `steamcommunity.com/tradeoffer/<id>/`, where this
  extension's content script is already injected.

  It exists because a sale can end on csboard while its Steam offer is still
  alive — the send window closes, the buyer is refunded — and an offer left
  standing can still be accepted. That trade would then have happened entirely
  outside the site: the seller loses the skin, the buyer keeps both it and the
  refund, and no record on our side ever says so.
*/
export const P2P_TAB_CANCEL_COMMAND = 'CSBOARD_P2P_TAB_CANCEL' as const;

/** Background → tab. One id; the tab decides nothing here either. */
export interface P2PTabCancelCommand {
  type: typeof P2P_TAB_CANCEL_COMMAND;
  orderId: string;
  steamTradeOfferId: string;
}

/**
 * The tab's answer.
 *
 * `ok` means Steam ACCEPTED the cancel call — not that the offer is confirmed
 * dead. Proving that is a separate read, because a client reporting its own
 * success is the weakest evidence available for something this expensive.
 */
export type P2PTabCancelResult =
  | { ok: true }
  | {
    ok: false;
    code: 'NO_STEAM_SESSION' | 'STEAM_REFUSED' | 'TAB_UNREACHABLE' | 'UNKNOWN';
    detail?: string;
  };

/** What the backend tells us to send. Mirrors `P2PSendTask` on the server. */
export interface P2PSendInstruction {
  orderId: string;
  assetId: string;
  appId: number;
  contextId: string;
  marketHashName: string;
  partnerTradeUrl: string;
  partnerSteamId: string;
  message: string;
  secondsRemaining: number;
}

/** Background → tab. Deliberately flat: the tab decides nothing. */
export interface P2PTabSendCommand {
  type: typeof P2P_TAB_SEND_COMMAND;
  orderId: string;
  assetId: string;
  appId: number;
  contextId: string;
  /** SteamID64 of the buyer, as Steam's `partner` field wants it. */
  partnerSteamId: string;
  /** The `token` query parameter from the buyer's trade URL. */
  partnerToken: string;
  message: string;
}

export type P2PTabSendResult =
  | { ok: true; steamTradeOfferId: string; needsMobileConfirmation: boolean; needsEmailConfirmation: boolean }
  | { ok: false; code: P2PSendFailure; detail?: string };

/*
  Failure codes, each of which is a DIFFERENT thing for the seller to do.

  Collapsing these into one "send failed" is what turns a five-second fix
  (you are signed out of Steam) into a support ticket, so every one of them
  reaches the website as its own code with its own sentence.
*/
export type P2PSendFailure =
  | 'NO_STEAM_SESSION'      // not signed in to steamcommunity.com in this browser
  | 'STEAM_REFUSED'         // Steam rejected the offer (trade ban, escrow, privacy)
  | 'ITEM_NOT_IN_INVENTORY' // the asset is not there any more
  | 'PARTNER_UNAVAILABLE'   // buyer cannot receive trades right now
  | 'TAB_UNREACHABLE'       // the trade tab did not answer
  | 'RATE_LIMITED'
  | 'TASK_UNAVAILABLE'      // the backend would not issue an instruction
  | 'NOT_SIGNED_IN_CSBOARD'
  | 'UNKNOWN';

/**
 * The partner id and token, taken from a Steam trade URL.
 *
 * Steam's own URL carries `partner` as a 32-bit account id, while the offer
 * body wants the 64-bit SteamID — the conversion is the constant below, and
 * getting it wrong sends the offer to a stranger, so it is done in one place.
 */
export function parseTradeUrl(url: string): { partnerSteamId: string; partnerToken: string } | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'steamcommunity.com') return null;
    const partner = parsed.searchParams.get('partner');
    const token = parsed.searchParams.get('token');
    if (!partner || !token) return null;
    const accountId = BigInt(partner);
    // 76561197960265728 — the base of the individual SteamID64 space.
    const steamId64 = (accountId + 76561197960265728n).toString();
    return { partnerSteamId: steamId64, partnerToken: token };
  } catch {
    return null;
  }
}

/**
 * The exact body Steam wants, for any number of items on either side.
 *
 * `json_tradeoffer` is Steam's own shape and is not ours to improve.
 *
 * Both sides are populated because two different products use this now:
 *
 *   P2P delivery  — we give one asset, we ask for nothing. `them` stays empty:
 *                   the buyer already paid, and an offer that asks for
 *                   something back is a different transaction than the one they
 *                   paid for. Use `buildTradeOfferPayload`.
 *   Обмен с доплатой — we give N assets and ask for the ONE copy the deal is
 *                   about, with the cash leg settled on csboard afterwards.
 *
 * The asset lists still never come from a page. They come from the backend's
 * send task, exactly as the single asset always did.
 */
export function buildTradeOfferBody(input: {
  giveAssetIds: readonly string[];
  receiveAssetIds?: readonly string[];
  appId: number;
  contextId: string;
}): string {
  const asset = (assetid: string) => ({
    appid: input.appId,
    contextid: input.contextId,
    amount: 1,
    assetid,
  });
  return JSON.stringify({
    newversion: true,
    version: 2,
    me: { assets: input.giveAssetIds.map(asset), currency: [], ready: false },
    them: { assets: (input.receiveAssetIds ?? []).map(asset), currency: [], ready: false },
  });
}

/**
 * The one-item delivery body, unchanged.
 *
 * Kept as its own function rather than folded into the call sites so the P2P
 * path is byte-for-byte what it always was: it is live, it works, and widening
 * a working payload builder is not the place to find that out.
 */
export function buildTradeOfferPayload(input: {
  assetId: string;
  appId: number;
  contextId: string;
}): string {
  return buildTradeOfferBody({
    giveAssetIds: [input.assetId],
    appId: input.appId,
    contextId: input.contextId,
  });
}
