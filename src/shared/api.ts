// ============================================================
// CSBOARD-PROD API Client
// ============================================================
// Cookie-based auth (credentials: 'include'). Geo-aware base URL via
// getApiBase() — see config.ts.
//
// Production-only endpoints:
//   GET  /api/auth/me
//   POST /api/auth/logout
// Bulk price + exchange-rate fetches happen directly in the service worker
// (background/service-worker.ts) against /api/extension/*.

import type { AuthState, UserProfile } from './types';
import { CSBoardError } from './types';
import { type Result, Ok, Fail } from './result';
import { createLogger } from './logger';
import { getApiBase } from './config';

const logger = createLogger('api');

const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  retryableStatuses: new Set([408, 429, 500, 502, 503, 504]),
} as const;

const RATE_LIMIT = {
  maxTokens: 30,
  refillRate: 10,
  refillIntervalMs: 1000,
} as const;

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private maxTokens: number,
    private refillRate: number,
    private refillIntervalMs: number,
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens > 0) {
      this.tokens--;
      return;
    }
    const waitMs = this.refillIntervalMs / this.refillRate;
    await new Promise((r) => setTimeout(r, waitMs));
    return this.acquire();
  }

  private refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const newTokens = (elapsed / this.refillIntervalMs) * this.refillRate;
    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
    this.lastRefill = now;
  }
}

const rateLimiter = new TokenBucket(
  RATE_LIMIT.maxTokens,
  RATE_LIMIT.refillRate,
  RATE_LIMIT.refillIntervalMs,
);

const inflightRequests = new Map<string, Promise<unknown>>();

function deduplicationKey(endpoint: string, options?: RequestInit): string {
  const method = options?.method ?? 'GET';
  const body = options?.body ? String(options.body) : '';
  return `${method}:${endpoint}:${body}`;
}

async function apiFetch<T>(
  endpoint: string,
  options?: RequestInit,
  retryCount = 0,
): Promise<Result<T, CSBoardError>> {
  const dedupKey = deduplicationKey(endpoint, options);

  const existing = inflightRequests.get(dedupKey);
  if (existing) {
    return existing as Promise<Result<T, CSBoardError>>;
  }

  const promise = executeRequest<T>(endpoint, options ?? {}, retryCount);

  const method = options?.method ?? 'GET';
  if (method === 'GET') {
    inflightRequests.set(dedupKey, promise);
    promise.finally(() => inflightRequests.delete(dedupKey));
  }

  return promise;
}

async function executeRequest<T>(
  endpoint: string,
  options: RequestInit,
  retryCount: number,
): Promise<Result<T, CSBoardError>> {
  await rateLimiter.acquire();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };

  const base = await getApiBase();
  const url = `${base}${endpoint}`;

  try {
    const response = await fetch(url, {
      ...options,
      headers,
      credentials: 'include',
    });

    if (response.status === 401) {
      return Fail('Not authenticated', 'AUTH_EXPIRED', false);
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const delay = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : calculateBackoff(retryCount);

      if (retryCount < RETRY_CONFIG.maxRetries) {
        logger.warn('Rate limited, retrying', { endpoint, delay, attempt: retryCount + 1 });
        await sleep(delay);
        return executeRequest(endpoint, options, retryCount + 1);
      }
      return Fail('Rate limited', 'RATE_LIMITED', true);
    }

    if (RETRY_CONFIG.retryableStatuses.has(response.status) && retryCount < RETRY_CONFIG.maxRetries) {
      const delay = calculateBackoff(retryCount);
      logger.warn('Retryable error', { endpoint, status: response.status, delay, attempt: retryCount + 1 });
      await sleep(delay);
      return executeRequest(endpoint, options, retryCount + 1);
    }

    if (!response.ok) {
      const body = await response.json().catch(() => ({ message: `HTTP ${response.status}` }));
      return Fail(
        body.message || `HTTP ${response.status}`,
        'API_ERROR',
        false,
        { status: response.status, endpoint },
      );
    }

    const data = await response.json() as T;
    return Ok(data);
  } catch (err) {
    if (retryCount < RETRY_CONFIG.maxRetries) {
      const delay = calculateBackoff(retryCount);
      logger.warn('Network error, retrying', { endpoint, error: String(err), delay, attempt: retryCount + 1 });
      await sleep(delay);
      return executeRequest(endpoint, options, retryCount + 1);
    }

    return Fail(
      err instanceof Error ? err.message : 'Network error',
      'NETWORK_ERROR',
      true,
      { endpoint },
    );
  }
}

function calculateBackoff(retryCount: number): number {
  const base = RETRY_CONFIG.baseDelayMs * Math.pow(2, retryCount);
  const capped = Math.min(base, RETRY_CONFIG.maxDelayMs);
  const jitter = capped * Math.random() * 0.5;
  return capped + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// Public API
// ============================================================

export async function getAuthStatus(): Promise<AuthState> {
  const result = await apiFetch<UserProfile>('/auth/me');

  if (result.ok) {
    return { isLoggedIn: true, user: result.value };
  }

  if (result.error.code !== 'NETWORK_ERROR') {
    return { isLoggedIn: false };
  }

  logger.warn('Auth check failed (network)', { error: result.error.message });
  return { isLoggedIn: false };
}

export async function logout(): Promise<void> {
  await apiFetch<void>('/auth/logout', { method: 'POST' });
}
