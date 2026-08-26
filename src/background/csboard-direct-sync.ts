// ============================================================
// CSBOARD direct inventory sync
// ============================================================
//
// WHY THIS EXISTS.
//
// Publishing a lot on csboard.com needs a COMPLETE inventory snapshot the
// backend has accepted, and only a client holding the seller's Steam session
// can make one. This extension had exactly one road to deliver it — the
// encrypted CSFolder gateway — and that road is closed to anyone who has never
// used CSFolder: the only thing that mints a gateway device row is a
// `CSF-XXXX-XXXX-XXXX-XXXX` code issued at csfolder.com/portfolio. A
// csboard-only seller cannot obtain one, so every refresh was refused with
// `NOT_PAIRED`, and the board could not be listed on at all.
//
// This module is the second road, and it is deliberately the SAME one the
// phone app already drives: the seller's own csboard session cookie
// authenticates the upload, and the backend checks that the Steam account we
// read is the one linked to that csboard account. No pairing, no device key,
// no CSFolder, no settings toggle.
//
// WHAT IT MAY DO, EXACTLY.
//
//   - Read this browser's Steam inventory (contexts 2 and 16).
//   - POST it to OUR backend.
//
// That is the whole list. `CsboardDirectSyncOutcome` deliberately carries no
// item, no Steam id, no count and no upstream error text, because the caller
// of the caller is a WEB PAGE. The page asked for an action; it gets a verdict.
// Steam data leaves this extension in one direction only — to csboard.
//
// WHAT IT MUST NOT TOUCH.
//
// The CSFolder path. Nothing here reads or writes `portfolioSyncEnabled`,
// `portfolioSources`, the device key store, the gateway outbox or the pairing
// registration. A press on csboard.com is not consent to start uploading a
// portfolio to a different product, and this file is where that promise is
// kept.

import type { PortfolioItemDto } from '../shared/gateway-dto';

/** Where the snapshot goes, relative to the resolved csboard API base. */
export const CSBOARD_DIRECT_SYNC_PATH = '/p2p/ext/inventory-sync';

/**
 * The backend refuses a body over this, and so do we — one press earlier and
 * without spending a full Steam read on something that cannot be accepted.
 * Mirrors `appInventorySyncSchema.items.max(5000)`.
 */
export const CSBOARD_DIRECT_SYNC_MAX_ITEMS = 5_000;

/**
 * Every refusal this path is allowed to name.
 *
 * Each one exists because the seller can DO something different about it.
 * Anything we cannot tell apart collapses to `SYNC_TRIGGER_FAILED` rather than
 * inventing a fifth cause the site would then have to word.
 */
export type CsboardDirectSyncRefusal =
  /** No csboard session in this browser. The backend answered 401. */
  | 'CSBOARD_SIGN_IN_REQUIRED'
  /** Signed in to csboard, but that account has no Steam account linked. */
  | 'STEAM_ACCOUNT_NOT_LINKED'
  /** No signed-in steamcommunity.com session to read. */
  | 'STEAM_SESSION_REQUIRED'
  /** Steam is signed into a DIFFERENT account than the csboard one. */
  | 'STEAM_ACCOUNT_MISMATCH'
  /** More items than the ingest accepts. */
  | 'INVENTORY_TOO_LARGE'
  /** Network, Steam or backend failure we cannot name any more precisely. */
  | 'SYNC_TRIGGER_FAILED';

/**
 * What the run produced. `snapshotEstablished` is the BACKEND's verdict on
 * whether the snapshot was complete enough to make anything listable — it is
 * not derived from Steam data and is never forwarded to a page.
 */
export type CsboardDirectSyncOutcome =
  | { readonly ok: true; readonly snapshotEstablished: boolean }
  | { readonly ok: false; readonly refused: CsboardDirectSyncRefusal };

/** Who is signed in to csboard in this browser, as far as the backend says. */
export type CsboardSyncAccount =
  | { readonly state: 'signed-in'; readonly steamId: string | null }
  | { readonly state: 'signed-out' }
  | { readonly state: 'unreachable' };

/** The backend's answer to one upload, reduced to what changes our verdict. */
export type CsboardDirectSyncUploadVerdict =
  | { readonly outcome: 'accepted'; readonly snapshotEstablished: boolean }
  | { readonly outcome: 'unauthenticated' }
  | { readonly outcome: 'account-mismatch' }
  | { readonly outcome: 'steam-not-linked' }
  | { readonly outcome: 'rejected' };

/** Exactly the fields `appInventorySyncSchema` accepts. It is `.strict()`, so
 *  an extra key is a 400 — the projection below is what guarantees there is
 *  never one, even if `PortfolioItemDto` grows a field. */
export interface CsboardDirectSyncWireItem {
  readonly appId: '730';
  readonly contextId: '2' | '16';
  readonly assetId: string;
  readonly classId: string;
  readonly instanceId: string;
  readonly amount: string;
  readonly marketHashName: string;
  readonly name?: string;
  readonly iconUrl?: string;
  readonly tradable: boolean;
  readonly marketable: boolean;
  readonly onHold: boolean;
  readonly tradableAfter?: number;
  readonly floatValue?: number;
  readonly paintSeed?: number;
  readonly paintIndex?: number;
  readonly defIndex?: number;
}

export interface CsboardDirectSyncRequestBody {
  readonly steamId: string;
  readonly syncRunId: string;
  readonly completeContexts2And16: boolean;
  readonly items: readonly CsboardDirectSyncWireItem[];
}

export interface CsboardDirectSteamReader {
  readInventoryContext(contextId: '2' | '16'): Promise<{
    readonly complete: boolean;
    readonly items: readonly PortfolioItemDto[];
  }>;
}

export interface CsboardDirectSyncDeps {
  /** Reads `/auth/me`. The cookie is the whole authentication story. */
  readCsboardAccount(): Promise<CsboardSyncAccount>;
  /** Binds a Steam reader to the csboard account's OWN Steam id. Throws
   *  `STEAM_SESSION_REQUIRED` / `STEAM_ACCOUNT_MISMATCH`. */
  openSteamReader(steamId: string): Promise<CsboardDirectSteamReader>;
  upload(body: CsboardDirectSyncRequestBody): Promise<CsboardDirectSyncUploadVerdict>;
  newSyncRunId(): string;
}

/**
 * Project one read item onto the wire shape.
 *
 * Optional fields are omitted rather than sent as `undefined`: `JSON.stringify`
 * drops an `undefined` value but a zod `.strict()` schema sees the key when it
 * is present with any other value, and `exactOptionalPropertyTypes` will not
 * let us pretend otherwise.
 */
export function toCsboardDirectSyncWireItem(item: PortfolioItemDto): CsboardDirectSyncWireItem {
  return {
    appId: '730',
    contextId: item.contextId,
    assetId: item.assetId,
    classId: item.classId,
    instanceId: item.instanceId,
    amount: item.amount,
    marketHashName: item.marketHashName,
    ...(item.name !== undefined ? { name: item.name } : {}),
    ...(item.iconUrl !== undefined ? { iconUrl: item.iconUrl } : {}),
    tradable: item.tradable,
    marketable: item.marketable,
    onHold: item.onHold,
    ...(item.tradableAfter !== undefined ? { tradableAfter: item.tradableAfter } : {}),
    ...(item.floatValue !== undefined ? { floatValue: item.floatValue } : {}),
    ...(item.paintSeed !== undefined ? { paintSeed: item.paintSeed } : {}),
    ...(item.paintIndex !== undefined ? { paintIndex: item.paintIndex } : {}),
    ...(item.defIndex !== undefined ? { defIndex: item.defIndex } : {}),
  };
}

/**
 * Turn one HTTP answer into a verdict.
 *
 * Only the STATUS and our own `code` are read. The backend's prose is written
 * for whoever reads the logs and must never become a branch — or a sentence a
 * seller sees.
 */
export function interpretCsboardDirectSyncResponse(
  status: number,
  body: unknown,
): CsboardDirectSyncUploadVerdict {
  if (status === 401) return { outcome: 'unauthenticated' };
  const record = typeof body === 'object' && body !== null && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
  if (status >= 200 && status < 300) {
    return { outcome: 'accepted', snapshotEstablished: record?.['snapshotEstablished'] === true };
  }
  const code = typeof record?.['code'] === 'string' ? record['code'] : null;
  if (code === 'steam_account_mismatch') return { outcome: 'account-mismatch' };
  if (code === 'steam_not_linked') return { outcome: 'steam-not-linked' };
  return { outcome: 'rejected' };
}

/** The two Steam failures the seller can act on, by the marker the read throws. */
export function classifyCsboardDirectSteamError(error: unknown): CsboardDirectSyncRefusal {
  const message = error instanceof Error ? error.message : '';
  if (message === 'STEAM_SESSION_REQUIRED') return 'STEAM_SESSION_REQUIRED';
  if (message === 'STEAM_ACCOUNT_MISMATCH') return 'STEAM_ACCOUNT_MISMATCH';
  const safeContext = (error as { safeContext?: Record<string, unknown> } | null)?.safeContext;
  const reason = safeContext?.['reason'];
  if (reason === 'steam-session-unavailable') return 'STEAM_SESSION_REQUIRED';
  if (reason === 'steam-account-mismatch') return 'STEAM_ACCOUNT_MISMATCH';
  return 'SYNC_TRIGGER_FAILED';
}

/**
 * One direct sync, start to finish.
 *
 * Order is deliberate: csboard first, Steam second. Asking who is signed in
 * costs one small request and answers two of the six refusals, and it is the
 * only way to learn which Steam account this snapshot is allowed to be about.
 * Reading Steam first would spend seconds on an inventory nobody can attribute.
 */
export async function runCsboardDirectSync(
  deps: CsboardDirectSyncDeps,
): Promise<CsboardDirectSyncOutcome> {
  let account: CsboardSyncAccount;
  try {
    account = await deps.readCsboardAccount();
  } catch {
    return { ok: false, refused: 'SYNC_TRIGGER_FAILED' };
  }
  if (account.state === 'signed-out') return { ok: false, refused: 'CSBOARD_SIGN_IN_REQUIRED' };
  if (account.state === 'unreachable') return { ok: false, refused: 'SYNC_TRIGGER_FAILED' };
  const steamId = account.steamId;
  if (!steamId || !/^\d{17}$/.test(steamId)) {
    return { ok: false, refused: 'STEAM_ACCOUNT_NOT_LINKED' };
  }

  let items: CsboardDirectSyncWireItem[];
  let complete: boolean;
  try {
    // Bound to the csboard account's own Steam id, so a browser signed into a
    // second Steam account is refused rather than filed under the first.
    const reader = await deps.openSteamReader(steamId);
    const context2 = await reader.readInventoryContext('2');
    const context16 = await reader.readInventoryContext('16');
    complete = context2.complete && context16.complete;
    items = [...context2.items, ...context16.items].map(toCsboardDirectSyncWireItem);
  } catch (error) {
    return { ok: false, refused: classifyCsboardDirectSteamError(error) };
  }

  // Sending a truncated read as complete would tell the backend that whatever
  // fell off the end is no longer owned, and it would cancel those listings.
  if (items.length > CSBOARD_DIRECT_SYNC_MAX_ITEMS) {
    return { ok: false, refused: 'INVENTORY_TOO_LARGE' };
  }

  let verdict: CsboardDirectSyncUploadVerdict;
  try {
    verdict = await deps.upload({
      steamId,
      syncRunId: deps.newSyncRunId(),
      completeContexts2And16: complete,
      items,
    });
  } catch {
    return { ok: false, refused: 'SYNC_TRIGGER_FAILED' };
  }

  switch (verdict.outcome) {
    case 'accepted':
      return { ok: true, snapshotEstablished: verdict.snapshotEstablished };
    case 'unauthenticated':
      return { ok: false, refused: 'CSBOARD_SIGN_IN_REQUIRED' };
    case 'account-mismatch':
      return { ok: false, refused: 'STEAM_ACCOUNT_MISMATCH' };
    case 'steam-not-linked':
      return { ok: false, refused: 'STEAM_ACCOUNT_NOT_LINKED' };
    default:
      return { ok: false, refused: 'SYNC_TRIGGER_FAILED' };
  }
}
