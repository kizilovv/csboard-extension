// ============================================================
// CSBOARD — Result<T, E> Pattern
// ============================================================
// Railway-oriented error handling. No more try/catch spaghetti.
// Every function that can fail returns Result<T, E>.
// Callers decide how to handle errors — not the function itself.
//
// Usage:
//   const result = await api.getBoards();
//   if (result.ok) {
//     console.log(result.value.boards);
//   } else {
//     logger.error('Failed to get boards', result.error);
//   }

import { CSBoardError, type ErrorCode } from './types';

// --- Core Result Type ---

export type Result<T, E = CSBoardError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

// --- Constructors ---

export function Ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function Err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

// Shorthand for CSBoardError
export function Fail(
  message: string,
  code: ErrorCode,
  retryable = false,
  context?: Record<string, unknown>,
): Result<never, CSBoardError> {
  return Err(new CSBoardError(message, code, retryable, context));
}

// --- Combinators ---

/** Map over a successful result */
export function mapResult<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U,
): Result<U, E> {
  return result.ok ? Ok(fn(result.value)) : result;
}

/** Chain results (flatMap / bind) */
export function flatMap<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  return result.ok ? fn(result.value) : result;
}

/** Unwrap with default */
export function unwrapOr<T, E>(result: Result<T, E>, defaultValue: T): T {
  return result.ok ? result.value : defaultValue;
}

/** Unwrap or throw (escape hatch — use sparingly) */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw result.error;
}

// --- Async helpers ---

/** Wrap a Promise into a Result (catches thrown errors) */
export async function tryCatch<T>(
  fn: () => Promise<T>,
  code: ErrorCode = 'UNKNOWN',
): Promise<Result<T, CSBoardError>> {
  try {
    return Ok(await fn());
  } catch (err) {
    if (err instanceof CSBoardError) return Err(err);
    const message = err instanceof Error ? err.message : String(err);
    return Fail(message, code);
  }
}

/** Run multiple Results in parallel, collect all successes or first error */
export async function allResults<T, E>(
  results: Promise<Result<T, E>>[],
): Promise<Result<T[], E>> {
  const settled = await Promise.all(results);
  const firstError = settled.find((r): r is Extract<typeof r, { ok: false }> => !r.ok);
  if (firstError) return firstError;
  return Ok(settled.map((r) => (r as { ok: true; value: T }).value));
}
