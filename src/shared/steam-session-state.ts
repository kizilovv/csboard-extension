/*
  Whether this browser has a Steam login the extension can use.

  Everything a seller does through csboard rides on the Steam login in THIS
  browser: sending the item and watching the offer. Before 1.1.26 the tracking
  pass returned without one before it reported anything — no heartbeat, so
  csboard never saw the extension — and that return was a log line in a
  service worker nobody opens. The support case that prompted this
  (2026-09-25): the extension was installed and enabled, selling on the site
  stayed unavailable, and nothing on the seller's screen said why.

  So the pass writes down what it found, and four readers show it: the
  toolbar badge, the popup, csboard's status probe, and the heartbeat, which
  now goes out either way and carries this verdict to the backend.

  `unknown` is "never checked", not a third state of the login: a fresh install
  before its first pass, or storage written by a build older than this key.
  Readers treat it as "say nothing", never as "missing" — a warning on an
  install that simply has not looked yet is a false alarm.
*/

export const STEAM_SESSION_STATE_KEY = 'csboard_steam_session';

export type SteamSessionState = 'ok' | 'missing' | 'unknown';

/** What a check can conclude. `unknown` is only ever the absence of one. */
export type SteamSessionVerdict = Exclude<SteamSessionState, 'unknown'>;

export interface SteamSessionSnapshot {
  readonly state: SteamSessionState;
  /** When the verdict was reached. Null exactly when the state is `unknown`. */
  readonly checkedAt: number | null;
}

export const UNKNOWN_STEAM_SESSION: SteamSessionSnapshot = { state: 'unknown', checkedAt: null };

export function normalizeSteamSessionSnapshot(value: unknown): SteamSessionSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return UNKNOWN_STEAM_SESSION;
  }
  const record = value as Record<string, unknown>;
  const state = record['state'];
  const checkedAt = record['checkedAt'];
  if ((state !== 'ok' && state !== 'missing') ||
      typeof checkedAt !== 'number' || !Number.isFinite(checkedAt) || checkedAt <= 0) {
    return UNKNOWN_STEAM_SESSION;
  }
  return { state, checkedAt };
}

export async function readSteamSessionState(): Promise<SteamSessionSnapshot> {
  try {
    const stored = await chrome.storage.local.get(STEAM_SESSION_STATE_KEY);
    return normalizeSteamSessionSnapshot(stored?.[STEAM_SESSION_STATE_KEY]);
  } catch {
    return UNKNOWN_STEAM_SESSION;
  }
}

/** Returns what was stored before, so a caller can act on the transition. */
export async function writeSteamSessionState(
  state: SteamSessionVerdict,
  now: number = Date.now(),
): Promise<SteamSessionSnapshot> {
  const previous = await readSteamSessionState();
  const next: SteamSessionSnapshot = { state, checkedAt: now };
  await chrome.storage.local.set({ [STEAM_SESSION_STATE_KEY]: next });
  return previous;
}
