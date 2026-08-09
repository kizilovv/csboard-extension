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
const EXTERNAL_PROTOCOL_VERSION = 1 as const;
const MAX_EXTERNAL_REQUEST_BYTES = 2_048;

export type ExternalStatusErrorCode =
  | 'UNAUTHORIZED_ORIGIN'
  | 'INVALID_MESSAGE'
  | 'UNSUPPORTED_VERSION';

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

function isExactExternalStatusMessage(value: unknown): value is ExternalStatusMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'payload,requestId,type,version' ||
      record['version'] !== EXTERNAL_PROTOCOL_VERSION ||
      record['type'] !== EXTERNAL_STATUS_MESSAGE_TYPE ||
      typeof record['requestId'] !== 'string' ||
      !/^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[A-Za-z0-9_-]{1,64})$/i
        .test(record['requestId']) ||
      typeof record['payload'] !== 'object' || record['payload'] === null ||
      Array.isArray(record['payload']) || Object.keys(record['payload']).length !== 0) {
    return false;
  }
  return true;
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
  return typeof requestId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(requestId)
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

/** Registers the complete external surface: exactly one static status message. */
export function registerExternalStatusRouter(options: {
  readonly allowedOrigins: readonly string[];
  readonly extensionVersion: string;
}): () => void {
  const allowedOrigins = new Set(options.allowedOrigins.map((value) => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== value) {
      throw new GatewayPayloadError('INVALID_PAYLOAD', { reason: 'invalid-external-origin' });
    }
    return url.origin;
  }));

  const listener = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): boolean => {
    const senderOrigin = getSenderOrigin(sender);
    sendResponse(dispatchExternalStatus(message, senderOrigin, {
      allowedOrigins,
      extensionVersion: options.extensionVersion,
    }));
    return false;
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
