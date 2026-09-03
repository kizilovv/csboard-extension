/*
  Sends the Steam trade for one обмен с доплатой.

  The same shape as `p2p-trade-send.ts`, and for the same reason — the page says
  "send deal N" and NOTHING else. What leaves the inventory, who receives it and
  which copy is asked for in return all come from csboard's own record of the
  deal, fetched here under the sender's own session. A scripted page has nothing
  to substitute.

  Two things differ from the P2P delivery:

    · The offer is TWO-SIDED and multi-asset. A deal gives the sender's pile and
      asks for the one copy the recipient accepted with, which is why
      `buildTradeOfferBody` exists.
    · There is no tab fallback. The P2P path keeps one because it predates the
      background POST; here the background POST is the only route from the
      start. Every failure it can produce is already a sentence the sender can
      act on — sign in to Steam, the item is gone, they cannot receive — and a
      retry is one click inside the 12-hour window. A tab flow would add three
      more ways to fail (pop-up blocker, slow load, content script that never
      answers) to a path that does not need it.

  Nothing here decides anything about the MONEY. The cash leg settles on csboard
  after Steam's 7-day hold, gated on the skin actually arriving; reporting the
  offer id only starts the recipient's clock.
*/

import { getApiBase } from '../shared/config';
import { createLogger } from '../shared/logger';
import { parseTradeUrl, type P2PSendFailure, type P2PTabSendResult } from '../shared/p2p-send-protocol';
import { postTradeOffer } from '../shared/p2p-offer-post';

const logger = createLogger('topup-deal-send');

export type TopUpSendOutcome =
  | { ok: true; steamTradeOfferId: string; needsMobileConfirmation: boolean }
  | { ok: false; code: P2PSendFailure; detail?: string };

/** The backend's instruction. Every field is read, none is supplied. */
interface TopUpSendTask {
  dealId: string;
  assetIdsToGive: string[];
  assetIdToReceive: string;
  appId: number;
  contextId: string;
  partnerTradeUrl: string;
  partnerSteamId: string;
  message: string;
  secondsRemaining: number;
}

/**
 * Steam's CSRF token, without a page and without the `cookies` permission.
 *
 * Identical to the P2P path's reader and deliberately duplicated rather than
 * exported from it: `cookies` stays out of the manifest (two tests assert it,
 * and adding it would disable the extension for every existing user until they
 * re-approve), and Steam prints the same token into every signed-in page, so
 * one authenticated GET yields it. A signed-OUT browser gets a page without the
 * variable — which is the answer we want, and the sender is told exactly that
 * instead of "the offer was refused".
 */
const SESSION_ID_PAGE = 'https://steamcommunity.com/market/';

async function readSessionId(): Promise<string | null> {
  try {
    const response = await fetch(SESSION_ID_PAGE, { credentials: 'include', cache: 'no-store' });
    if (!response.ok) return null;
    const html = await response.text();
    const match = /g_sessionID\s*=\s*"([^"]+)"/.exec(html);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function fetchTask(dealId: string): Promise<TopUpSendTask | TopUpSendOutcome> {
  const base = await getApiBase();
  let response: Response;
  try {
    response = await fetch(`${base}/top-up-deals/ext/send-task/${encodeURIComponent(dealId)}`, {
      method: 'GET',
      // The sender's own csboard session. Without it the backend cannot know
      // whose deal this is, and it refuses rather than guessing.
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    return { ok: false, code: 'TASK_UNAVAILABLE', detail: String(error) };
  }

  if (response.status === 401) return { ok: false, code: 'NOT_SIGNED_IN_CSBOARD' };
  if (!response.ok) {
    // The backend's refusal envelope: a human sentence in `message`, a machine
    // string in `error`. Carry the sentence — it already says what to do.
    let detail: string | undefined;
    try {
      const body = (await response.json()) as { message?: string; error?: string };
      detail = body?.message ?? body?.error;
    } catch {
      detail = `HTTP ${response.status}`;
    }
    return { ok: false, code: 'TASK_UNAVAILABLE', detail };
  }

  try {
    return (await response.json()) as TopUpSendTask;
  } catch (error) {
    return { ok: false, code: 'TASK_UNAVAILABLE', detail: String(error) };
  }
}

/**
 * Tell csboard the offer exists.
 *
 * A failure here is OUR problem, never the sender's: Steam already has the
 * offer, and reporting a send failure would make him send a second one for the
 * same skins. It is logged and swallowed, exactly as in the P2P path.
 */
async function reportSent(task: TopUpSendTask, steamTradeOfferId: string): Promise<void> {
  const base = await getApiBase();
  try {
    const response = await fetch(`${base}/top-up-deals/ext/annotate-trade`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dealId: task.dealId, steamTradeOfferId }),
    });
    if (!response.ok) {
      logger.warn('Trade sent but annotate failed', { dealId: task.dealId, status: response.status });
    }
  } catch (error) {
    logger.warn('Trade sent but annotate threw', { dealId: task.dealId, error: String(error) });
  }
}

export async function sendTopUpDealTrade(dealId: string): Promise<TopUpSendOutcome> {
  const task = await fetchTask(dealId);
  if ('ok' in task) return task;

  const partner = parseTradeUrl(task.partnerTradeUrl);
  if (!partner) {
    return { ok: false, code: 'PARTNER_UNAVAILABLE', detail: 'their trade link is not usable' };
  }
  if (!task.assetIdsToGive?.length || !task.assetIdToReceive) {
    return { ok: false, code: 'TASK_UNAVAILABLE', detail: 'the deal is missing its items' };
  }

  const sessionId = await readSessionId();
  if (!sessionId) return { ok: false, code: 'NO_STEAM_SESSION' };

  const result: P2PTabSendResult = await postTradeOffer({
    sessionId,
    partnerSteamId: partner.partnerSteamId,
    partnerToken: partner.partnerToken,
    giveAssetIds: task.assetIdsToGive,
    receiveAssetIds: [task.assetIdToReceive],
    appId: task.appId,
    contextId: task.contextId,
    message: task.message,
    // No referer: fetch cannot set it, the declarative rule in
    // steamcommunity_ruleset.json does. Remove that rule and this fails with a
    // Steam error that reads like a session problem.
  });

  if (!result.ok) return result;

  await reportSent(task, result.steamTradeOfferId);
  return {
    ok: true,
    steamTradeOfferId: result.steamTradeOfferId,
    needsMobileConfirmation: result.needsMobileConfirmation === true,
  };
}
