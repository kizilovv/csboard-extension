import {
  GatewayPayloadError,
  assertPairingCode,
} from '../shared/gateway-dto';
import type {
  PortfolioCollectorSource,
  PortfolioCollectorWarningCode,
  SafePortfolioFailureCode,
} from './portfolio-collector';

export const EXTERNAL_STATUS_MESSAGE_TYPE = 'GET_EXTENSION_STATUS' as const;
export const EXTERNAL_PAIR_AND_ENABLE_MESSAGE_TYPE =
  'PAIR_AND_ENABLE_PORTFOLIO_SYNC' as const;
export const EXTERNAL_REACTIVATE_MESSAGE_TYPE =
  'REACTIVATE_PORTFOLIO_SYNC' as const;
/**
 * The two commands the CSBOARD site may send.
 *
 * They deliberately carry the SAME names the popup uses on the internal
 * router: one action, one word, so a reader grepping for RUN_MANUAL_SYNC finds
 * every caller. They are still two different listeners with two different
 * authorisations — the internal ones keep requiring
 * `sender.id === chrome.runtime.id`, which no web page can satisfy, and these
 * keep requiring an origin in `syncAllowedOrigins`. Neither name is a shortcut
 * into the other listener.
 */
export const EXTERNAL_RUN_SYNC_MESSAGE_TYPE = 'RUN_MANUAL_SYNC' as const;

/*
  Deliver the item for one paid order.

  The narrowest command in this file: the page names an ORDER and nothing else.
  What leaves the seller's inventory — which asset, to whom, under which number —
  is fetched by the background from csboard's own API against the order the buyer
  paid for, so a scripted page has nothing to substitute. That is the whole
  reason delivery moved into the extension: Steam's own trade window lets a
  seller pick a different skin, and this path never consults it.
*/
export const EXTERNAL_SEND_TRADE_MESSAGE_TYPE = 'P2P_SEND_TRADE' as const;
/*
  Look at Steam now instead of at the next alarm.

  After the seller confirms an offer in Steam Guard, nothing tells us: the
  tracking pass finds it on its own schedule, and until it does the site still
  says the item needs sending. The seller has just done the thing and the page
  disagrees with him, which is the moment he presses Send a second time.

  So the page can ask for the pass to run now. It carries NO payload at all —
  no order id, nothing — because the pass already knows which sales it is
  watching, and a command with no fields is a command a page cannot steer.
*/
export const EXTERNAL_TRACK_NOW_MESSAGE_TYPE = 'P2P_TRACK_NOW' as const;
export const EXTERNAL_SYNC_STATUS_MESSAGE_TYPE =
  'GET_PORTFOLIO_SYNC_STATUS' as const;
const EXTERNAL_PROTOCOL_VERSION = 1 as const;
const MAX_EXTERNAL_REQUEST_BYTES = 2_048;

export type ExternalStatusErrorCode =
  | 'UNAUTHORIZED_ORIGIN'
  | 'INVALID_MESSAGE'
  | 'UNSUPPORTED_VERSION'
  | 'ACTION_IN_PROGRESS'
  | 'NOT_PAIRED'
  | 'PAIRING_FAILED'
  | 'ACTIVATION_FAILED'
  | 'SYNC_TRIGGER_FAILED'
  | 'SYNC_NOT_ENABLED'
  | 'STEAM_SESSION_REQUIRED'
  | 'CSBOARD_SIGN_IN_REQUIRED'
  | 'STEAM_ACCOUNT_NOT_LINKED'
  | 'STEAM_ACCOUNT_MISMATCH'
  | 'INVENTORY_TOO_LARGE'
  | 'SYNC_STATUS_UNAVAILABLE';

/**
 * Every refusal a manual-sync handler is allowed to name.
 *
 * A refusal is the one thing a page learns about the user's Steam session, so
 * the vocabulary is closed: anything a handler returns that is not in this
 * list collapses to SYNC_TRIGGER_FAILED. STEAM_SESSION_REQUIRED earns its own
 * word because it is the only refusal the seller can act on — it means "open a
 * signed-in steamcommunity.com tab", and a generic failure sends them looking
 * at their csboard account instead.
 */
export const EXTERNAL_SYNC_REFUSAL_CODES = [
  'ACTION_IN_PROGRESS',
  'NOT_PAIRED',
  'SYNC_NOT_ENABLED',
  'STEAM_SESSION_REQUIRED',
  // The direct csboard road's four (1.1.7). Each is here because the seller
  // does something DIFFERENT about it, and a seller told the wrong thing goes
  // and fixes an account that was never broken:
  //   sign in to csboard · link a Steam account · sign Steam into the right
  //   account · the inventory is past the ingest ceiling.
  // Note what is still absent: no Steam id, no item, no count, no upstream
  // status. A refusal is the one thing a page learns about the Steam session,
  // so it stays a bare word.
  'CSBOARD_SIGN_IN_REQUIRED',
  'STEAM_ACCOUNT_NOT_LINKED',
  'STEAM_ACCOUNT_MISMATCH',
  'INVENTORY_TOO_LARGE',
  'SYNC_TRIGGER_FAILED',
] as const;

export type ExternalSyncRefusalCode = typeof EXTERNAL_SYNC_REFUSAL_CODES[number];

export type ExternalStatusResponse =
  | {
      readonly version: 1;
      readonly requestId: string;
      readonly ok: true;
      readonly data: {
        readonly installed: true;
        readonly extensionVersion: string;
        readonly capabilityVersion: 1;
      };
    }
  /*
    A delivery attempt for one paid order.

    Two shapes, both `ok: true`, because the ENVELOPE succeeded either way — the
    extension was reached and it did the work. Whether Steam accepted the offer
    is the payload's business, and the site needs the difference between "signed
    out of Steam" and "buyer cannot receive items" to say anything useful, which
    the router's small error vocabulary cannot carry.
  */
  | {
      readonly version: 1;
      readonly requestId: string;
      readonly ok: true;
      readonly data: {
        readonly steamTradeOfferId: string;
        readonly needsMobileConfirmation: boolean;
      };
    }
  | {
      readonly version: 1;
      readonly requestId: string;
      readonly ok: true;
      readonly data: {
        readonly sendFailed: true;
        readonly code: string;
        readonly detail: string | null;
      };
    }
  /*
    A tracking pass ran. Deliberately says nothing about what it found: the
    findings go to csboard through the pass's own reporting, and the page reads
    them back off its order rather than taking the extension's word for them.
  */
  | {
      readonly version: 1;
      readonly requestId: string;
      readonly ok: true;
      readonly data: { readonly ran: true };
    }
  | {
      readonly version: 1;
      readonly requestId: string;
      readonly ok: true;
      readonly data: {
        readonly paired: true;
        readonly portfolioSyncEnabled: true;
        readonly enabledSources: readonly ['inventory', 'tradeHistory'];
        /** The initial run was handed to the existing fenced sync path. */
        readonly syncTriggered: true;
      };
    }
  | {
      readonly version: 1;
      readonly requestId: string;
      readonly ok: true;
      /**
       * A refresh is running. NOT "the snapshot arrived": the run is handed to
       * the same fenced path the popup uses and finishes on its own clock, and
       * only the CSBOARD backend can say a snapshot was accepted.
       */
      readonly data: { readonly syncTriggered: true };
    }
  | {
      readonly version: 1;
      readonly requestId: string;
      readonly ok: true;
      /** Exactly two facts. No Steam id, no item, no failure detail. */
      readonly data: {
        readonly paired: boolean;
        readonly syncState: 'idle' | 'syncing' | 'error';
      };
    }
  | {
      readonly version: 1;
      readonly requestId: string | null;
      readonly ok: false;
      readonly error: { readonly code: ExternalStatusErrorCode };
    };

export type InternalGatewayMessage =
  | { readonly type: 'PAIR_DEVICE'; readonly version: 1; readonly data: { readonly code: string } }
  | { readonly type: 'UNPAIR_DEVICE'; readonly version: 1 }
  | { readonly type: 'RUN_MANUAL_SYNC'; readonly version: 1 }
  | { readonly type: 'GET_PORTFOLIO_SYNC_STATUS'; readonly version: 1 };

export interface InternalGatewayStatus {
  readonly paired: boolean;
  readonly syncState: 'idle' | 'syncing' | 'error';
  readonly pendingEncryptedRequests: number;
  readonly lastFailureCode?: SafePortfolioFailureCode;
}

export interface InternalGatewayHandlers {
  pair(pairingCode: string): Promise<{ readonly paired: true }>;
  unpair(): Promise<{ readonly unpaired: true }>;
  syncNow(): Promise<{
    readonly queued: number;
    readonly inventoryItems: number;
    readonly trades: number;
    readonly offers: number;
    readonly failedSources: readonly PortfolioCollectorSource[];
    readonly warningCodes: readonly PortfolioCollectorWarningCode[];
  }>;
  status(): Promise<InternalGatewayStatus>;
}

interface ExternalStatusMessage {
  readonly version: 1;
  readonly type: typeof EXTERNAL_STATUS_MESSAGE_TYPE;
  readonly requestId: string;
  readonly payload: Readonly<Record<string, never>>;
}

interface ExternalPairAndEnableMessage {
  readonly version: 1;
  readonly type: typeof EXTERNAL_PAIR_AND_ENABLE_MESSAGE_TYPE;
  readonly requestId: string;
  readonly code: string;
}

interface ExternalReactivateMessage {
  readonly version: 1;
  readonly type: typeof EXTERNAL_REACTIVATE_MESSAGE_TYPE;
  readonly requestId: string;
}

export type ExternalManualSyncResult =
  | { readonly started: true }
  | { readonly refused: ExternalSyncRefusalCode };

export interface ExternalSyncStatusSnapshot {
  readonly paired: boolean;
  readonly syncState: 'idle' | 'syncing' | 'error';
}

/**
 * The whole of what the CSBOARD site may do here: cause a refresh, and ask
 * whether one is running.
 *
 * Both are deliberately WRITE-NOTHING-BACK: `requestManualSync` returns a
 * verdict, never inventory, and `readSyncStatus` returns two enum-ish facts.
 * The site does not need Steam data from the extension — it re-reads its own
 * backend once the snapshot lands there — so no handler here may hand a page
 * anything a Steam session produced.
 */
export interface ExternalSyncHandlers {
  /**
   * Start ONE refresh through the existing fenced sync path.
   *
   * Must resolve quickly whether or not the run has finished: the caller is a
   * web page with a short timeout that then watches its own backend.
   */
  requestManualSync(): Promise<ExternalManualSyncResult>;
  /** Whether this browser is paired, and what the last/current run is doing. */
  readSyncStatus(): Promise<ExternalSyncStatusSnapshot>;
  /**
   * Deliver the item for one paid order, and report the offer back to csboard.
   *
   * Takes an order id and nothing else — see EXTERNAL_SEND_TRADE_MESSAGE_TYPE.
   * Resolves with the Steam offer id, or a code naming what the seller has to
   * fix. Slower than the other two by nature: it opens a tab and waits for
   * Steam.
   */
  sendTradeForOrder(orderId: string): Promise<ExternalSendTradeResult>;
  /**
   * Run one tracking pass now, on the sales already being watched.
   *
   * Takes nothing and returns nothing on purpose: the page is asking us to
   * LOOK, not telling us what to find. Whatever the pass sees is reported to
   * csboard through the same route the scheduled pass uses, so the page learns
   * the outcome by re-reading its own order, never from this answer.
   */
  trackTradesNow(): Promise<void>;
}

/** What the delivery attempt tells the page. */
export type ExternalSendTradeResult =
  | { readonly ok: true; readonly steamTradeOfferId: string; readonly needsMobileConfirmation: boolean }
  | { readonly ok: false; readonly code: string; readonly detail?: string };

export interface ExternalPairAndEnableHandlers {
  /** Local gateway registration is the only accepted proof of pairing. */
  isPaired(): Promise<boolean>;
  /** The same encrypted, one-time-code pairing path used by the popup. */
  pair(pairingCode: string): Promise<void>;
  /** Persist exactly Inventory + Trade History as the only enabled sources. */
  enablePortfolioSync(): Promise<void>;
  /** Hand one immediate run to the existing fenced sync path. */
  syncNow(): Promise<void>;
  /** Must fail closed when enable/sync setup does not complete. */
  disablePortfolioSync(): Promise<void>;
}

function isExactExternalReactivateMessage(
  value: unknown,
): value is ExternalReactivateMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(',') === 'requestId,type,version' &&
    record['version'] === EXTERNAL_PROTOCOL_VERSION &&
    record['type'] === EXTERNAL_REACTIVATE_MESSAGE_TYPE &&
    isSafeExternalRequestId(record['requestId']);
}

/**
 * A message that is nothing but `{ version, type, requestId }`.
 *
 * The exactness is the point: an unknown extra key is rejected rather than
 * ignored, so a page cannot smuggle a source list, a Steam id or a price into
 * a command that has no parameters and must never grow one by accident.
 */
function isExactBareExternalMessage(value: unknown, type: string): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(',') === 'requestId,type,version' &&
    record['version'] === EXTERNAL_PROTOCOL_VERSION &&
    record['type'] === type &&
    isSafeExternalRequestId(record['requestId']);
}

function isExternalSyncRefusalCode(value: unknown): value is ExternalSyncRefusalCode {
  return typeof value === 'string' &&
    (EXTERNAL_SYNC_REFUSAL_CODES as readonly string[]).includes(value);
}

function isSafeExternalRequestId(value: unknown): value is string {
  return typeof value === 'string' &&
    /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[A-Za-z0-9_-]{1,64})$/i
      .test(value);
}

function isExactExternalStatusMessage(value: unknown): value is ExternalStatusMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'payload,requestId,type,version' ||
      record['version'] !== EXTERNAL_PROTOCOL_VERSION ||
      record['type'] !== EXTERNAL_STATUS_MESSAGE_TYPE ||
      !isSafeExternalRequestId(record['requestId']) ||
      typeof record['payload'] !== 'object' || record['payload'] === null ||
      Array.isArray(record['payload']) || Object.keys(record['payload']).length !== 0) {
    return false;
  }
  return true;
}

function isExactExternalPairAndEnableMessage(
  value: unknown,
): value is ExternalPairAndEnableMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'code,requestId,type,version' ||
      record['version'] !== EXTERNAL_PROTOCOL_VERSION ||
      record['type'] !== EXTERNAL_PAIR_AND_ENABLE_MESSAGE_TYPE ||
      !isSafeExternalRequestId(record['requestId']) ||
      typeof record['code'] !== 'string') {
    return false;
  }
  try {
    assertPairingCode(record['code']);
    return true;
  } catch {
    return false;
  }
}

function getSenderOrigin(sender: chrome.runtime.MessageSender): string | null {
  if (!sender.url) return null;
  try {
    const url = new URL(sender.url);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

function safeExternalRequestId(message: unknown): string | null {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return null;
  const requestId = (message as Record<string, unknown>)['requestId'];
  return isSafeExternalRequestId(requestId)
    ? requestId
    : null;
}

function externalError(
  requestId: string | null,
  code: ExternalStatusErrorCode,
): ExternalStatusResponse {
  return { version: 1, requestId, ok: false, error: { code } };
}

/** Pure external dispatcher. It has no provider, storage or internal-router dependency. */
export function dispatchExternalStatus(
  message: unknown,
  senderOrigin: string | null,
  options: {
    readonly allowedOrigins: ReadonlySet<string>;
    readonly extensionVersion: string;
  },
): ExternalStatusResponse {
  const requestId = safeExternalRequestId(message);
  if (!senderOrigin || !options.allowedOrigins.has(senderOrigin)) {
    return externalError(requestId, 'UNAUTHORIZED_ORIGIN');
  }
  let serializedBytes: number;
  try {
    serializedBytes = new TextEncoder().encode(JSON.stringify(message)).byteLength;
  } catch {
    return externalError(requestId, 'INVALID_MESSAGE');
  }
  if (serializedBytes > MAX_EXTERNAL_REQUEST_BYTES) {
    return externalError(requestId, 'INVALID_MESSAGE');
  }
  if (typeof message === 'object' && message !== null && !Array.isArray(message) &&
      'version' in message && (message as { version?: unknown }).version !== 1) {
    return externalError(requestId, 'UNSUPPORTED_VERSION');
  }
  if (!isExactExternalStatusMessage(message)) {
    return externalError(requestId, 'INVALID_MESSAGE');
  }
  return {
    version: 1,
    requestId: message.requestId,
    ok: true,
    data: {
      installed: true,
      extensionVersion: options.extensionVersion,
      capabilityVersion: 1,
    },
  };
}

function externalMessageType(message: unknown): string | null {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return null;
  const type = (message as Record<string, unknown>)['type'];
  return typeof type === 'string' ? type : null;
}

async function failClosedAfterActivationError(
  handlers: ExternalPairAndEnableHandlers,
): Promise<void> {
  try {
    await handlers.disablePortfolioSync();
  } catch {
    // The service-worker implementation raises an in-memory upload fence before
    // attempting storage cleanup. Never replace the original bounded verdict
    // with storage/network details.
  }
}

/** Which origins may send which command. One switch, so the answer to "what
 *  can this site do?" is read in one place. */
function allowedOriginsForExternalType(
  type: string | null,
  options: {
    readonly statusAllowedOrigins: ReadonlySet<string>;
    readonly pairingAllowedOrigins: ReadonlySet<string>;
    readonly syncAllowedOrigins: ReadonlySet<string>;
  },
): ReadonlySet<string> {
  switch (type) {
    case EXTERNAL_STATUS_MESSAGE_TYPE:
      return options.statusAllowedOrigins;
    case EXTERNAL_PAIR_AND_ENABLE_MESSAGE_TYPE:
    case EXTERNAL_REACTIVATE_MESSAGE_TYPE:
      return options.pairingAllowedOrigins;
    case EXTERNAL_RUN_SYNC_MESSAGE_TYPE:
    case EXTERNAL_SYNC_STATUS_MESSAGE_TYPE:
    // Delivery rides the same allowlist as sync, and for the same reason: both
    // are csboard asking us to act on the seller's own order. It is NOT opened
    // to the pairing origins — CSFolder has no orders and no business sending
    // anybody's skins.
    case EXTERNAL_SEND_TRADE_MESSAGE_TYPE:
    // Same allowlist again: asking us to look at Steam is strictly less than
    // asking us to send, and it is the same seller's own order either way.
    case EXTERNAL_TRACK_NOW_MESSAGE_TYPE:
      return options.syncAllowedOrigins;
    default:
      // An unknown type from any origin we speak to at all is INVALID_MESSAGE,
      // not UNAUTHORIZED_ORIGIN, so a site probing for a newer protocol can
      // tell "this build does not have it" from "you may not ask".
      return new Set([
        ...options.statusAllowedOrigins,
        ...options.pairingAllowedOrigins,
        ...options.syncAllowedOrigins,
      ]);
  }
}

/**
 * Complete external dispatcher — the entire list of things a web page can make
 * this extension do.
 *
 * Until 1.1.5 the line was "CSBOARD gets a read-only status probe and nothing
 * else". It moved, on purpose, in exactly one direction: CSBOARD may now also
 * CAUSE an inventory refresh (RUN_MANUAL_SYNC) and ask whether one is running
 * (GET_PORTFOLIO_SYNC_STATUS). Publishing a lot on the site needs an inventory
 * snapshot under five minutes old, and only a client with the seller's Steam
 * session — this extension, or the phone app — can make one; the site had no
 * way to ask for it and refused every listing instead.
 *
 * What did NOT move, and must not without another deliberate widening:
 *   - No page can pair or unpair. Pairing stays CSFolder-authoritative.
 *   - No page can change which sources are enabled, or turn uploads on. In
 *     1.1.7 a refresh from an install that is not enrolled in CSFolder no
 *     longer fails — it takes the DIRECT csboard road, which reads the
 *     inventory and posts it to csboard's own session-authenticated ingest —
 *     but it still does not enable itself the way the CSFolder activation path
 *     does. A press on a listing page is consent to send YOUR inventory to
 *     CSBOARD and to nothing else; the seller ends the run exactly as
 *     unenrolled in CSFolder as they began it.
 *   - No Steam data flows back to the page. The two answers here are a
 *     "started" flag and (paired, syncState); the snapshot itself goes only to
 *     the CSBOARD gateway, encrypted, exactly as before. The site learns the
 *     result by re-reading its own backend, which is also the only party that
 *     can confirm a snapshot actually landed.
 * The rule of thumb for the next reader: a page may ask for an ACTION it could
 * already trigger by hand in the popup. It may never ask for DATA.
 *
 * CSFolder keeps its bounded fresh-pair and already-paired activation commands
 * and nothing else, and cannot send either of the two new commands.
 */
export async function dispatchExternalMessage(
  message: unknown,
  senderOrigin: string | null,
  options: {
    readonly statusAllowedOrigins: ReadonlySet<string>;
    readonly pairingAllowedOrigins: ReadonlySet<string>;
    readonly syncAllowedOrigins: ReadonlySet<string>;
    readonly extensionVersion: string;
    readonly handlers: ExternalPairAndEnableHandlers;
    readonly syncHandlers: ExternalSyncHandlers;
  },
): Promise<ExternalStatusResponse> {
  const requestId = safeExternalRequestId(message);
  const type = externalMessageType(message);
  const allowed = allowedOriginsForExternalType(type, options);
  if (!senderOrigin || !allowed.has(senderOrigin)) {
    return externalError(requestId, 'UNAUTHORIZED_ORIGIN');
  }

  let serializedBytes: number;
  try {
    serializedBytes = new TextEncoder().encode(JSON.stringify(message)).byteLength;
  } catch {
    return externalError(requestId, 'INVALID_MESSAGE');
  }
  if (serializedBytes > MAX_EXTERNAL_REQUEST_BYTES) {
    return externalError(requestId, 'INVALID_MESSAGE');
  }
  if (typeof message === 'object' && message !== null && !Array.isArray(message) &&
      'version' in message && (message as { version?: unknown }).version !== 1) {
    return externalError(requestId, 'UNSUPPORTED_VERSION');
  }

  if (type === EXTERNAL_STATUS_MESSAGE_TYPE) {
    return dispatchExternalStatus(message, senderOrigin, {
      allowedOrigins: options.statusAllowedOrigins,
      extensionVersion: options.extensionVersion,
    });
  }

  if (type === EXTERNAL_RUN_SYNC_MESSAGE_TYPE) {
    if (requestId === null ||
        !isExactBareExternalMessage(message, EXTERNAL_RUN_SYNC_MESSAGE_TYPE)) {
      return externalError(requestId, 'INVALID_MESSAGE');
    }
    let result: ExternalManualSyncResult;
    try {
      result = await options.syncHandlers.requestManualSync();
    } catch {
      // A handler that threw has already lost the argument about what to say:
      // its message could name a storage path, a gateway host or a Steam
      // response. One bounded verdict leaves.
      return externalError(requestId, 'SYNC_TRIGGER_FAILED');
    }
    const outcome = result as { started?: unknown; refused?: unknown } | null | undefined;
    if (outcome && outcome.started === true) {
      return { version: 1, requestId, ok: true, data: { syncTriggered: true } };
    }
    return externalError(
      requestId,
      isExternalSyncRefusalCode(outcome?.refused) ? outcome.refused : 'SYNC_TRIGGER_FAILED',
    );
  }

  if (type === EXTERNAL_SEND_TRADE_MESSAGE_TYPE) {
    /*
      One field, checked exactly. The message must be
      {version, type, requestId, payload:{orderId}} and nothing else — an extra
      key is a page trying to smuggle in an asset or a recipient, and the answer
      to that is refusal, not best-effort parsing.
    */
    const payload = (message as { payload?: unknown } | null)?.payload;
    const orderId = (payload as { orderId?: unknown } | null)?.orderId;
    const payloadKeys = payload && typeof payload === 'object' ? Object.keys(payload) : [];
    /*
      One order, one field, checked exactly.

      A seller clearing several sales calls this once per sale — the site does
      the loop. That was a deliberate reversal: a batch command inside the
      extension meant a new store build for something the page can already do
      with the handshake it has, and every extra shape here is more surface a
      page could push on.
    */
    if (requestId === null ||
        typeof orderId !== 'string' ||
        orderId.length === 0 ||
        orderId.length > 64 ||
        payloadKeys.length !== 1) {
      return externalError(requestId, 'INVALID_MESSAGE');
    }

    let outcome: ExternalSendTradeResult;
    try {
      outcome = await options.syncHandlers.sendTradeForOrder(orderId);
    } catch {
      return externalError(requestId, 'SYNC_TRIGGER_FAILED');
    }
    if (outcome.ok) {
      return {
        version: 1,
        requestId,
        ok: true,
        data: {
          steamTradeOfferId: outcome.steamTradeOfferId,
          needsMobileConfirmation: outcome.needsMobileConfirmation === true,
        },
      };
    }
    /*
      The failure reaches the page as data, not as an error envelope.

      Each code is a different thing for the seller to do — signed out of Steam,
      item gone, buyer cannot receive — and the site phrases them. Squeezing
      them through the router's small error vocabulary would flatten all of them
      into one useless sentence.
    */
    return {
      version: 1,
      requestId,
      ok: true,
      data: { sendFailed: true, code: outcome.code, detail: outcome.detail ?? null },
    };
  }

  if (type === EXTERNAL_TRACK_NOW_MESSAGE_TYPE) {
    /*
      No payload, and that is checked rather than ignored. A message carrying
      fields is a page trying to steer a pass that is deliberately unsteerable.
    */
    const payload = (message as { payload?: unknown } | null)?.payload;
    const payloadKeys = payload && typeof payload === 'object' ? Object.keys(payload) : [];
    if (requestId === null || payloadKeys.length !== 0) {
      return externalError(requestId, 'INVALID_MESSAGE');
    }

    try {
      await options.syncHandlers.trackTradesNow();
    } catch {
      return externalError(requestId, 'SYNC_TRIGGER_FAILED');
    }
    /*
      `ran: true` means the pass completed, NOT that anything changed. The page
      finds out what changed by re-reading its own order, because that is the
      only account of it we would trust anyway.
    */
    return { version: 1, requestId, ok: true, data: { ran: true } };
  }

  if (type === EXTERNAL_SYNC_STATUS_MESSAGE_TYPE) {
    if (requestId === null ||
        !isExactBareExternalMessage(message, EXTERNAL_SYNC_STATUS_MESSAGE_TYPE)) {
      return externalError(requestId, 'INVALID_MESSAGE');
    }
    let snapshot: ExternalSyncStatusSnapshot;
    try {
      snapshot = await options.syncHandlers.readSyncStatus();
    } catch {
      return externalError(requestId, 'SYNC_STATUS_UNAVAILABLE');
    }
    // Re-derive both fields rather than forwarding the handler's object: the
    // answer to a web page is built here, from a closed set of values, and
    // cannot grow a field because something upstream started returning one.
    const syncState = (snapshot as { syncState?: unknown } | null)?.syncState;
    return {
      version: 1,
      requestId,
      ok: true,
      data: {
        paired: (snapshot as { paired?: unknown } | null)?.paired === true,
        syncState: syncState === 'syncing' || syncState === 'error' ? syncState : 'idle',
      },
    };
  }

  const isFreshPair = isExactExternalPairAndEnableMessage(message);
  const isReactivation = isExactExternalReactivateMessage(message);
  if (!isFreshPair && !isReactivation) {
    return externalError(requestId, 'INVALID_MESSAGE');
  }

  if (isFreshPair) {
    try {
      await options.handlers.pair(message.code);
    } catch {
      return externalError(message.requestId, 'PAIRING_FAILED');
    }
  } else {
    let paired: boolean;
    try {
      paired = await options.handlers.isPaired();
    } catch {
      return externalError(message.requestId, 'ACTIVATION_FAILED');
    }
    if (!paired) return externalError(message.requestId, 'NOT_PAIRED');
  }
  try {
    await options.handlers.enablePortfolioSync();
  } catch {
    await failClosedAfterActivationError(options.handlers);
    return externalError(message.requestId, 'ACTIVATION_FAILED');
  }
  try {
    await options.handlers.syncNow();
  } catch {
    await failClosedAfterActivationError(options.handlers);
    return externalError(message.requestId, 'SYNC_TRIGGER_FAILED');
  }
  return {
    version: 1,
    requestId: message.requestId,
    ok: true,
    data: {
      paired: true,
      portfolioSyncEnabled: true,
      enabledSources: ['inventory', 'tradeHistory'],
      syncTriggered: true,
    },
  };
}

function exactHttpsOrigins(values: readonly string[]): Set<string> {
  return new Set(values.map((value) => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== value || url.pathname !== '/') {
      throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'invalid-external-origin' });
    }
    return url.origin;
  }));
}

/**
 * Registers the complete external surface: the CSBOARD status probe, the two
 * CSBOARD sync commands, and two bounded CSFolder activations.
 */
export function registerExternalStatusRouter(options: {
  readonly statusAllowedOrigins: readonly string[];
  readonly pairingAllowedOrigins: readonly string[];
  /** Kept a separate list from `statusAllowedOrigins` even where the two hold
   *  the same origins: adding a site that may see whether the add-on is
   *  installed must never, by itself, hand that site a Steam read. */
  readonly syncAllowedOrigins: readonly string[];
  readonly extensionVersion: string;
  readonly handlers: ExternalPairAndEnableHandlers;
  readonly syncHandlers: ExternalSyncHandlers;
}): () => void {
  const statusAllowedOrigins = exactHttpsOrigins(options.statusAllowedOrigins);
  const pairingAllowedOrigins = exactHttpsOrigins(options.pairingAllowedOrigins);
  const syncAllowedOrigins = exactHttpsOrigins(options.syncAllowedOrigins);
  let activationInFlight: Promise<ExternalStatusResponse> | null = null;

  const listener = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): boolean => {
    const senderOrigin = getSenderOrigin(sender);
    const messageType = externalMessageType(message);
    const isActivation = messageType === EXTERNAL_PAIR_AND_ENABLE_MESSAGE_TYPE ||
      messageType === EXTERNAL_REACTIVATE_MESSAGE_TYPE;
    const isAuthorizedActivation = isActivation && senderOrigin !== null &&
      pairingAllowedOrigins.has(senderOrigin);
    const shouldTrackActivation = isAuthorizedActivation && (
      isExactExternalPairAndEnableMessage(message) ||
      isExactExternalReactivateMessage(message)
    );
    if (shouldTrackActivation && activationInFlight) {
      sendResponse(externalError(safeExternalRequestId(message), 'ACTION_IN_PROGRESS'));
      return false;
    }
    const pending = dispatchExternalMessage(message, senderOrigin, {
      statusAllowedOrigins,
      pairingAllowedOrigins,
      syncAllowedOrigins,
      extensionVersion: options.extensionVersion,
      handlers: options.handlers,
      syncHandlers: options.syncHandlers,
    });
    if (shouldTrackActivation) activationInFlight = pending;
    pending
      .then(sendResponse)
      .finally(() => {
        if (activationInFlight === pending) activationInFlight = null;
      });
    return true;
  };

  chrome.runtime.onMessageExternal.addListener(listener);
  return () => chrome.runtime.onMessageExternal.removeListener(listener);
}

function isInternalExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;
  const extensionRoot = chrome.runtime.getURL('/');
  return sender.url.startsWith(extensionRoot);
}

function parseInternalGatewayMessage(value: unknown): InternalGatewayMessage | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const type = record['type'];
  if (type === 'UNPAIR_DEVICE' || type === 'RUN_MANUAL_SYNC' ||
      type === 'GET_PORTFOLIO_SYNC_STATUS') {
    return Object.keys(record).sort().join(',') === 'type,version' && record['version'] === 1
      ? { type, version: 1 }
      : null;
  }
  if (type !== 'PAIR_DEVICE') return null;
  if (Object.keys(record).sort().join(',') !== 'data,type,version' || record['version'] !== 1 ||
      typeof record['data'] !== 'object' || record['data'] === null ||
      Array.isArray(record['data'])) return null;
  const data = record['data'] as Record<string, unknown>;
  if (Object.keys(data).length === 1 && typeof data['code'] === 'string') {
    return { type, version: 1, data: { code: data['code'] } };
  }
  return null;
}

export async function dispatchInternalGatewayMessage(
  message: unknown,
  sender: chrome.runtime.MessageSender,
  handlers: InternalGatewayHandlers,
): Promise<unknown> {
  if (!isInternalExtensionPage(sender)) return { ok: false, error: 'not-authorized' };
  const parsed = parseInternalGatewayMessage(message);
  if (!parsed) return { ok: false, error: 'unsupported-message' };
  try {
    switch (parsed.type) {
      case 'PAIR_DEVICE':
        assertPairingCode(parsed.data.code);
        return { ok: true, result: await handlers.pair(parsed.data.code) };
      case 'UNPAIR_DEVICE':
        return { ok: true, result: await handlers.unpair() };
      case 'RUN_MANUAL_SYNC':
        return { ok: true, result: await handlers.syncNow() };
      case 'GET_PORTFOLIO_SYNC_STATUS':
        return { ok: true, result: await handlers.status() };
    }
  } catch {
    return { ok: false, error: 'gateway-operation-failed' };
  }
}

/**
 * Standalone listener seam for service-worker integration. The main router must
 * ignore the four portfolio popup message types so only this listener responds.
 */
export function registerInternalGatewayRouter(handlers: InternalGatewayHandlers): () => void {
  const listener = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): boolean | undefined => {
    const parsed = parseInternalGatewayMessage(message);
    if (!parsed) return undefined;
    dispatchInternalGatewayMessage(parsed, sender, handlers).then(sendResponse);
    return true;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
