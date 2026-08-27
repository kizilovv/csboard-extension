/*
  Sends the trade for one P2P order, start to finish.

  The sequence, and the reason for each step:

    1. Ask OUR backend what to send. The page asked only "send order N"; the
       asset, the recipient and the order number all come from the order the
       buyer paid for. A scripted page has nothing to tamper with.
    2. Open the buyer's trade URL in a tab. Steam's send endpoint needs the
       `sessionid` cookie, a Referer that is this partner's trade page, and the
       partner token — a service worker has none of them convincingly.
    3. Have the content script in that tab post the offer, with a payload built
       from the instruction rather than from anything on the page.
    4. Tell our backend the offer id, which refuses the report outright if the
       offer did not contain the order's asset.

  Nothing here trusts the seller's browser with the DECISION. It only borrows
  the seller's session to carry it out, which is what the seller would be doing
  by hand anyway — minus the item picker where a substitution could happen.
*/

import { getApiBase } from '../shared/config';
import { createLogger } from '../shared/logger';
import {
  P2P_TAB_SEND_COMMAND,
  parseTradeUrl,
  type P2PSendFailure,
  type P2PSendInstruction,
  type P2PTabSendCommand,
  type P2PTabSendResult,
} from '../shared/p2p-send-protocol';

const logger = createLogger('p2p-trade-send');

/** How long to wait for the trade tab to load and answer. */
const TAB_READY_TIMEOUT_MS = 20_000;
const TAB_POLL_MS = 400;

export type P2PSendOutcome =
  | { ok: true; steamTradeOfferId: string; needsMobileConfirmation: boolean }
  | { ok: false; code: P2PSendFailure; detail?: string };

async function fetchInstruction(orderId: string): Promise<P2PSendInstruction | P2PSendOutcome> {
  const base = await getApiBase();
  let response: Response;
  try {
    response = await fetch(`${base}/p2p/ext/send-task/${encodeURIComponent(orderId)}`, {
      method: 'GET',
      // The seller's own csboard session. Without it the backend cannot know
      // whose order this is, and it refuses rather than guessing.
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    return { ok: false, code: 'TASK_UNAVAILABLE', detail: String(error) };
  }

  if (response.status === 401) return { ok: false, code: 'NOT_SIGNED_IN_CSBOARD' };
  if (!response.ok) {
    let detail: string | undefined;
    try {
      const body = await response.json();
      // The backend's refusal envelope: a human sentence in `error`, a machine
      // string in `code`. Carry the sentence — it already says what to do.
      detail = typeof body?.error === 'string' ? body.error : undefined;
    } catch { /* no body worth reading */ }
    return { ok: false, code: 'TASK_UNAVAILABLE', detail };
  }

  try {
    return (await response.json()) as P2PSendInstruction;
  } catch (error) {
    return { ok: false, code: 'TASK_UNAVAILABLE', detail: String(error) };
  }
}

/** Open the partner's trade page. The tab is the seller's own browser. */
async function openTradeTab(tradeUrl: string): Promise<number | null> {
  const tab = await chrome.tabs.create({ url: tradeUrl, active: true });
  return typeof tab.id === 'number' ? tab.id : null;
}

/*
  Talk to the tab by RETRYING the message rather than by watching tab.status.

  Reading a tab's load state means asking for the "tabs" permission, and a new
  permission on a published extension is a slower Google review for something we
  do not need: a content script that has not booted yet simply does not answer,
  and one that has answers immediately. Retrying until it replies measures the
  same thing without widening what this extension may see.

  A tab that never answers is also meaningful on its own — it means Steam served
  a sign-in wall instead of the trade page, which is a session problem and is
  reported as one.
*/
async function commandTab(tabId: number, command: P2PTabSendCommand): Promise<P2PTabSendResult> {
  const deadline = Date.now() + TAB_READY_TIMEOUT_MS;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, command);
      if (result && typeof result === 'object') return result as P2PTabSendResult;
      lastError = 'empty reply';
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => { setTimeout(resolve, TAB_POLL_MS); });
  }
  return { ok: false, code: 'TAB_UNREACHABLE', detail: lastError };
}

async function reportSent(
  instruction: P2PSendInstruction,
  result: Extract<P2PTabSendResult, { ok: true }>,
): Promise<void> {
  const base = await getApiBase();
  const response = await fetch(`${base}/p2p/ext/annotate-trade`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      orderId: instruction.orderId,
      steamTradeOfferId: result.steamTradeOfferId,
      // The backend refuses this report if the order's own asset is not in the
      // list, which is the check that survives even a compromised extension.
      givenAssetIds: [instruction.assetId],
      partnerSteamId: instruction.partnerSteamId,
      needsMobileConfirmation: result.needsMobileConfirmation,
      needsEmailConfirmation: result.needsEmailConfirmation,
    }),
  });
  if (!response.ok) {
    // The offer IS sent — Steam has it. Failing to record that is our problem,
    // not the seller's, and it must not be reported to him as a send failure:
    // he would send a second one.
    logger.warn('Trade sent but annotate failed', {
      orderId: instruction.orderId,
      status: response.status,
    });
  }
}

export async function sendP2PTradeForOrder(orderId: string): Promise<P2PSendOutcome> {
  const instruction = await fetchInstruction(orderId);
  if ('ok' in instruction) return instruction;

  const partner = parseTradeUrl(instruction.partnerTradeUrl);
  if (!partner) {
    return { ok: false, code: 'TASK_UNAVAILABLE', detail: 'buyer trade url is not usable' };
  }

  const tabId = await openTradeTab(instruction.partnerTradeUrl);
  if (tabId === null) return { ok: false, code: 'TAB_UNREACHABLE' };

  try {
    const result = await commandTab(tabId, {
      type: P2P_TAB_SEND_COMMAND,
      orderId: instruction.orderId,
      assetId: instruction.assetId,
      appId: instruction.appId,
      contextId: instruction.contextId,
      partnerSteamId: partner.partnerSteamId,
      partnerToken: partner.partnerToken,
      message: instruction.message,
    });

    if (!result.ok) return result;

    await reportSent(instruction, result);

    return {
      ok: true,
      steamTradeOfferId: result.steamTradeOfferId,
      needsMobileConfirmation: result.needsMobileConfirmation,
    };
  } finally {
    /*
      Close the tab we opened, whatever happened.

      Left open, a seller clearing ten sales ends up with ten Steam trade pages
      and no idea which of them did anything. In `finally` because a failed send
      leaves a tab behind just as surely as a successful one — and the failure
      is already reported through the return value, not through the tab.
    */
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // Already gone: the seller closed it, or Steam navigated it away.
    }
  }
}
