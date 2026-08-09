import { getApiBase } from '../shared/config';
import {
  P2P_LISTING_TERMS_VERSION,
  type P2PEligibleAsset,
  type P2PListingCommitResult,
  type P2PListingReview,
  type PrepareP2PListingRequest,
} from '../popup/contracts';

export { P2P_LISTING_TERMS_VERSION } from '../popup/contracts';

const MAX_REVIEW_AGE_MS = 2 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_CHARS = 512 * 1_024;
const ALLOWED_API_BASES = new Set([
  'https://csboard.com/api',
  'https://csboard.trade/api',
]);

interface P2PIntentResponse {
  readonly intentId: string;
  readonly action: 'create' | 'unpublish';
  readonly idempotencyKey: string;
  readonly termsVersion: typeof P2P_LISTING_TERMS_VERSION;
  readonly operationalAssetId: string;
  readonly listingId: string | null;
  readonly assetRevision: string;
  readonly marketHashName: string;
  readonly priceMinor: number;
  readonly currency: 'USD';
  readonly expiresAt: string;
}

interface StoredReview {
  readonly review: P2PListingReview;
  readonly intent: P2PIntentResponse;
}

export interface P2PListingControllerDependencies {
  readonly apiBase?: () => Promise<string>;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly randomUuid?: () => string;
  readonly randomReviewId?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, pattern: RegExp, code: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(code);
  return value;
}

function optionalString(value: unknown, pattern: RegExp, code: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, pattern, code);
}

function priceMinor(value: unknown, code = 'P2P_INVALID_PRICE'): number {
  if (!Number.isSafeInteger(value) || (value as number) < 10 || (value as number) > 10_000_000) {
    throw new Error(code);
  }
  return value as number;
}

function parseIsoTimestamp(value: unknown, code: string): string {
  const raw = requiredString(value, /^.{10,64}$/, code);
  if (!Number.isFinite(Date.parse(raw))) throw new Error(code);
  return raw;
}

function parseNullableIsoTimestamp(value: unknown, code: string): string | null {
  return value === null ? null : parseIsoTimestamp(value, code);
}

function parseEligibilityReason(value: unknown): P2PEligibleAsset['reasons'][number] {
  if (!isRecord(value) ||
      typeof value.code !== 'string' || !/^[A-Za-z0-9:_-]{1,96}$/.test(value.code) ||
      typeof value.message !== 'string' ||
      !/^[^\u0000-\u001f\u007f]{1,240}$/.test(value.message)) {
    throw new Error('P2P_INVALID_ELIGIBILITY_RESPONSE');
  }
  return Object.freeze({ code: value.code, message: value.message });
}

function parseEligibleAsset(value: unknown): P2PEligibleAsset {
  if (!isRecord(value)) throw new Error('P2P_INVALID_ELIGIBILITY_RESPONSE');
  const rawReasons = value.reasons;
  if (!Array.isArray(rawReasons) || rawReasons.length > 32 ||
      (value.contextId !== '2' && value.contextId !== '16') ||
      typeof value.eligibility !== 'boolean' || value.currency !== 'USD') {
    throw new Error('P2P_INVALID_ELIGIBILITY_RESPONSE');
  }
  const reasons = rawReasons.map(parseEligibilityReason);
  const snapshotCompletedAt = parseNullableIsoTimestamp(
    value.snapshotCompletedAt,
    'P2P_INVALID_ELIGIBILITY_RESPONSE',
  );
  if ((value.eligibility && (snapshotCompletedAt === null || reasons.length > 0)) ||
      (!value.eligibility && reasons.length === 0)) {
    throw new Error('P2P_INVALID_ELIGIBILITY_RESPONSE');
  }
  const listingId = value.listingId === null
    ? null
    : requiredString(
      value.listingId,
      /^[A-Za-z0-9:_-]{1,128}$/,
      'P2P_INVALID_ELIGIBILITY_RESPONSE',
    );
  const listingState = value.listingState === null
    ? null
    : requiredString(
      value.listingState,
      /^[A-Za-z0-9_-]{1,32}$/,
      'P2P_INVALID_ELIGIBILITY_RESPONSE',
    );
  if ((listingId === null) !== (listingState === null)) {
    throw new Error('P2P_INVALID_ELIGIBILITY_RESPONSE');
  }
  return Object.freeze({
    operationalAssetId: requiredString(
      value.operationalAssetId,
      /^[A-Za-z0-9:._-]{1,256}$/,
      'P2P_INVALID_ELIGIBILITY_RESPONSE',
    ),
    assetRevision: requiredString(
      value.assetRevision,
      /^[A-Za-z0-9:_-]{16,128}$/,
      'P2P_INVALID_ELIGIBILITY_RESPONSE',
    ),
    marketHashName: requiredString(
      value.marketHashName,
      /^[^\u0000-\u001f\u007f]{1,256}$/,
      'P2P_INVALID_ELIGIBILITY_RESPONSE',
    ),
    contextId: value.contextId,
    eligibility: value.eligibility,
    reasons: Object.freeze(reasons),
    listingId,
    listingState,
    currency: 'USD',
    snapshotCompletedAt,
  });
}

function parseEligibilityResponse(value: unknown): readonly P2PEligibleAsset[] {
  if (!isRecord(value) || !Array.isArray(value.assets) || value.assets.length > 5_000) {
    throw new Error('P2P_INVALID_ELIGIBILITY_RESPONSE');
  }
  const assets = value.assets.map(parseEligibleAsset);
  if (new Set(assets.map((asset) => asset.operationalAssetId)).size !== assets.length) {
    throw new Error('P2P_INVALID_ELIGIBILITY_RESPONSE');
  }
  return Object.freeze(assets);
}

function parseIntentResponse(value: unknown): P2PIntentResponse {
  if (!isRecord(value)) throw new Error('P2P_INVALID_REVIEW_RESPONSE');
  const action = value.action;
  if (action !== 'create' && action !== 'unpublish') {
    throw new Error('P2P_INVALID_REVIEW_RESPONSE');
  }
  if (value.currency !== 'USD' || value.termsVersion !== P2P_LISTING_TERMS_VERSION) {
    throw new Error('P2P_INVALID_REVIEW_RESPONSE');
  }
  return {
    intentId: requiredString(
      value.intentId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      'P2P_INVALID_REVIEW_RESPONSE',
    ),
    action,
    idempotencyKey: requiredString(
      value.idempotencyKey,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      'P2P_INVALID_REVIEW_RESPONSE',
    ),
    termsVersion: P2P_LISTING_TERMS_VERSION,
    operationalAssetId: requiredString(
      value.operationalAssetId,
      /^[A-Za-z0-9:._-]{1,256}$/,
      'P2P_INVALID_REVIEW_RESPONSE',
    ),
    listingId: value.listingId === null
      ? null
      : requiredString(
        value.listingId,
        /^[A-Za-z0-9:_-]{1,128}$/,
        'P2P_INVALID_REVIEW_RESPONSE',
      ),
    assetRevision: requiredString(
      value.assetRevision,
      /^[A-Za-z0-9:_-]{16,128}$/,
      'P2P_INVALID_REVIEW_RESPONSE',
    ),
    marketHashName: requiredString(
      value.marketHashName,
      /^[^\u0000-\u001f\u007f]{1,256}$/,
      'P2P_INVALID_REVIEW_RESPONSE',
    ),
    priceMinor: priceMinor(value.priceMinor, 'P2P_INVALID_REVIEW_RESPONSE'),
    currency: 'USD',
    expiresAt: parseIsoTimestamp(value.expiresAt, 'P2P_INVALID_REVIEW_RESPONSE'),
  };
}

function validatePrepareRequest(value: PrepareP2PListingRequest): PrepareP2PListingRequest {
  const operationalAssetId = requiredString(
    value.operationalAssetId,
    /^[A-Za-z0-9:._-]{1,256}$/,
    'P2P_INVALID_REQUEST',
  );
  const assetRevision = requiredString(
    value.assetRevision,
    /^[A-Za-z0-9:_-]{16,128}$/,
    'P2P_INVALID_REQUEST',
  );
  if (value.action === 'create') {
    return {
      action: 'create',
      operationalAssetId,
      assetRevision,
      priceMinor: priceMinor(value.priceMinor),
    };
  }
  if (value.action === 'unpublish') {
    return {
      action: 'unpublish',
      operationalAssetId,
      assetRevision,
      listingId: requiredString(
        value.listingId,
        /^[A-Za-z0-9:_-]{1,128}$/,
        'P2P_INVALID_REQUEST',
      ),
    };
  }
  throw new Error('P2P_INVALID_REQUEST');
}

function assertApiBase(value: string): string {
  const normalized = value.replace(/\/$/, '');
  if (!ALLOWED_API_BASES.has(normalized)) throw new Error('P2P_API_ORIGIN_NOT_ALLOWED');
  return normalized;
}

function safeBackendError(status: number): Error {
  if (status === 401 || status === 403) return new Error('P2P_AUTH_REQUIRED');
  if (status === 404) return new Error('P2P_LISTING_UNAVAILABLE');
  if (status === 409 || status === 410) return new Error('P2P_REVIEW_STALE');
  if (status === 429) return new Error('P2P_RATE_LIMITED');
  if (status >= 400 && status < 500) return new Error('P2P_REQUEST_REJECTED');
  return new Error('P2P_BACKEND_UNAVAILABLE');
}

function isTerminalCommitError(error: unknown): boolean {
  const code = error instanceof Error ? error.message : '';
  return code === 'P2P_AUTH_REQUIRED' ||
    code === 'P2P_LISTING_UNAVAILABLE' ||
    code === 'P2P_REVIEW_STALE' ||
    code === 'P2P_RATE_LIMITED' ||
    code === 'P2P_REQUEST_REJECTED';
}

export class P2PListingController {
  private readonly apiBase: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly randomUuid: () => string;
  private readonly randomReviewId: () => string;
  private readonly reviews = new Map<string, StoredReview>();
  private readonly confirmations = new Map<string, Promise<P2PListingCommitResult>>();

  constructor(dependencies: P2PListingControllerDependencies = {}) {
    this.apiBase = dependencies.apiBase ?? getApiBase;
    // 🔴 `fetch` must keep its global receiver. Stored bare and invoked as
    // `this.fetchImpl(...)` the service worker rejects every call with
    // "Illegal invocation": `this` is the instance, not WorkerGlobalScope.
    this.fetchImpl = dependencies.fetchImpl ?? fetch.bind(globalThis);
    this.now = dependencies.now ?? Date.now;
    this.randomUuid = dependencies.randomUuid ?? (() => crypto.randomUUID());
    this.randomReviewId = dependencies.randomReviewId ?? (() => `review_${crypto.randomUUID()}`);
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const base = assertApiBase(await this.apiBase());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`${base}${path}`, {
        ...init,
        credentials: 'include',
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers as Record<string, string> | undefined),
        },
      });
      if (!response.ok) throw safeBackendError(response.status);
      const text = await response.text();
      if (text.length === 0 || text.length > MAX_RESPONSE_CHARS) {
        throw new Error('P2P_INVALID_BACKEND_RESPONSE');
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error('P2P_INVALID_BACKEND_RESPONSE');
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('P2P_')) throw error;
      throw new Error('P2P_BACKEND_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
    }
  }

  async listEligibleAssets(): Promise<readonly P2PEligibleAsset[]> {
    return parseEligibilityResponse(await this.request('/p2p/my/eligible-assets'));
  }

  async prepare(rawRequest: PrepareP2PListingRequest): Promise<P2PListingReview> {
    const request = validatePrepareRequest(rawRequest);
    const assets = await this.listEligibleAssets();
    const asset = assets.find((candidate) =>
      candidate.operationalAssetId === request.operationalAssetId);
    if (!asset || asset.assetRevision !== request.assetRevision) {
      throw new Error('P2P_ASSET_REVISION_CHANGED');
    }
    if (request.action === 'create' && !asset.eligibility) {
      throw new Error('P2P_ASSET_INELIGIBLE');
    }
    if (request.action === 'unpublish' && (
      asset.listingId !== request.listingId || asset.listingState !== 'active'
    )) {
      throw new Error('P2P_LISTING_UNAVAILABLE');
    }

    const idempotencyKey = this.randomUuid();
    requiredString(
      idempotencyKey,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      'P2P_RANDOMNESS_UNAVAILABLE',
    );
    const intentBody = request.action === 'create'
      ? {
          action: 'create' as const,
          operationalAssetId: request.operationalAssetId,
          assetRevision: request.assetRevision,
          priceMinor: request.priceMinor,
          currency: 'USD' as const,
          termsVersion: P2P_LISTING_TERMS_VERSION,
        }
      : {
          action: 'unpublish' as const,
          operationalAssetId: request.operationalAssetId,
          listingId: request.listingId,
          assetRevision: request.assetRevision,
          termsVersion: P2P_LISTING_TERMS_VERSION,
        };
    const intent = parseIntentResponse(await this.request('/p2p/listing-intents', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(intentBody),
    }));

    const bindingMatches = intent.action === request.action
      && intent.idempotencyKey === idempotencyKey
      && intent.termsVersion === P2P_LISTING_TERMS_VERSION
      && intent.operationalAssetId === request.operationalAssetId
      && intent.assetRevision === request.assetRevision
      && intent.marketHashName === asset.marketHashName
      && intent.currency === 'USD'
      && (request.action === 'create'
        ? intent.listingId === null && intent.priceMinor === request.priceMinor
        : intent.listingId === request.listingId);
    if (!bindingMatches) throw new Error('P2P_REVIEW_BINDING_MISMATCH');

    const now = this.now();
    const remoteExpiry = Date.parse(intent.expiresAt);
    if (!Number.isFinite(remoteExpiry) || remoteExpiry <= now) {
      throw new Error('P2P_REVIEW_EXPIRED');
    }
    const reviewId = this.randomReviewId();
    requiredString(reviewId, /^[A-Za-z0-9_-]{16,128}$/, 'P2P_RANDOMNESS_UNAVAILABLE');
    const review: P2PListingReview = Object.freeze({
      reviewId,
      action: intent.action,
      operationalAssetId: intent.operationalAssetId,
      assetRevision: intent.assetRevision,
      marketHashName: intent.marketHashName,
      listingId: intent.listingId,
      priceMinor: intent.priceMinor,
      currency: intent.currency,
      termsVersion: intent.termsVersion,
      expiresAt: Math.min(remoteExpiry, now + MAX_REVIEW_AGE_MS),
    });
    this.reviews.set(reviewId, { review, intent });
    return review;
  }

  cancel(reviewId: string): void {
    const validReviewId = requiredString(
      reviewId,
      /^[A-Za-z0-9_-]{16,128}$/,
      'P2P_INVALID_REVIEW_ID',
    );
    if (this.confirmations.has(validReviewId)) throw new Error('P2P_REVIEW_IN_PROGRESS');
    this.reviews.delete(validReviewId);
  }

  confirm(reviewIdValue: string): Promise<P2PListingCommitResult> {
    const reviewId = requiredString(
      reviewIdValue,
      /^[A-Za-z0-9_-]{16,128}$/,
      'P2P_INVALID_REVIEW_ID',
    );
    const existing = this.confirmations.get(reviewId);
    if (existing) return existing;
    const pending = this.performConfirm(reviewId).finally(() => {
      this.confirmations.delete(reviewId);
    });
    this.confirmations.set(reviewId, pending);
    return pending;
  }

  private async performConfirm(reviewId: string): Promise<P2PListingCommitResult> {
    const stored = this.reviews.get(reviewId);
    if (!stored) throw new Error('P2P_REVIEW_NOT_FOUND');
    if (this.now() >= stored.review.expiresAt) {
      this.reviews.delete(reviewId);
      throw new Error('P2P_REVIEW_EXPIRED');
    }

    const commitBody = {
      intentId: stored.intent.intentId,
      termsVersion: stored.intent.termsVersion,
      operationalAssetId: stored.intent.operationalAssetId,
      listingId: stored.intent.listingId,
      assetRevision: stored.intent.assetRevision,
      priceMinor: stored.intent.priceMinor,
      currency: stored.intent.currency,
    };
    const path = stored.intent.action === 'create'
      ? '/p2p/listings'
      : `/p2p/listings/${encodeURIComponent(stored.intent.listingId ?? '')}`;
    try {
      const response = await this.request(path, {
        method: stored.intent.action === 'create' ? 'POST' : 'DELETE',
        headers: { 'Idempotency-Key': stored.intent.idempotencyKey },
        body: JSON.stringify(commitBody),
      });
      if (!isRecord(response)) throw new Error('P2P_INVALID_BACKEND_RESPONSE');
      const listingId = optionalString(
        response.listingId ?? response.id,
        /^[A-Za-z0-9:_-]{1,128}$/,
        'P2P_INVALID_BACKEND_RESPONSE',
      );
      if (!listingId || (stored.intent.listingId && listingId !== stored.intent.listingId)) {
        throw new Error('P2P_INVALID_BACKEND_RESPONSE');
      }
      this.reviews.delete(reviewId);
      return { success: true, action: stored.intent.action, listingId };
    } catch (error) {
      // A timeout, transport/5xx failure, or malformed success response is
      // ambiguous: the commit may already be durable. Keep this exact review
      // until expiry so retry reuses the same intent and Idempotency-Key.
      if (isTerminalCommitError(error)) this.reviews.delete(reviewId);
      throw error;
    }
  }
}
