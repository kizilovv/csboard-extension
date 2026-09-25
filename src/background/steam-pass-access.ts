/*
  How the tracking pass gets at Steam, and what it concludes when it cannot.

  The pass used to ask for a reader without naming an account, which leaves the
  worker's own read of steamcommunity.com as the only proof of a login. That
  read is cross-site from the extension origin: with third-party cookies
  blocked it sees a signed-out page while the seller is plainly signed in, and
  the pass returned before calling csboard at all. The page-credential bridge
  (an open steamcommunity.com tab lending its token) exists for exactly this,
  but it only runs when the caller names the account it expects, and the pass
  never did. So a seller could be signed in, have the extension, and still be
  "no client" on the site (support, 2026-09-25).

  So the pass names it: the SteamID64 of the csboard account signed in to this
  browser, from the same `/auth/me` the direct sync reads. Only when the bridge
  and the worker's read both come up empty is the login `missing`.

  A Steam login for a DIFFERENT account than the csboard one falls back to the
  unnamed read, which is what the pass always did — a pass that worked before
  this still works the same way.

  Dependencies are passed in so this can be tested without a service worker.
*/

import type { CsboardSyncAccountRead } from '../shared/api';

export type CsboardAccountState = CsboardSyncAccountRead['state'];

export type PassSteamAccess<P> =
  | { readonly state: 'ok'; readonly provider: P; readonly csboard: CsboardAccountState }
  /** Steam answered, and nobody usable is signed in — by the bridge or the worker's read. */
  | { readonly state: 'missing'; readonly csboard: CsboardAccountState }
  /** Steam did not answer. Not a verdict about the login. */
  | { readonly state: 'unreachable'; readonly error: unknown; readonly csboard: CsboardAccountState };

export interface PassSteamAccessDeps<P> {
  readonly readCsboardAccount: () => Promise<CsboardSyncAccountRead>;
  /** `getSteamReadProvider`: with an account, the bridge runs before the worker's read. */
  readonly openReader: (expectedSteamId?: string) => Promise<P>;
  /** Steam answered "signed out", as opposed to not answering. */
  readonly isSignedOut: (error: unknown) => boolean;
}

function isAccountMismatch(error: unknown): boolean {
  return error instanceof Error && error.message === 'STEAM_ACCOUNT_MISMATCH';
}

export async function resolvePassSteamAccess<P>(
  deps: PassSteamAccessDeps<P>,
): Promise<PassSteamAccess<P>> {
  const account = await deps.readCsboardAccount()
    .catch((): CsboardSyncAccountRead => ({ state: 'unreachable' }));
  const csboard = account.state;
  const expectedSteamId = account.state === 'signed-in' ? account.steamId : null;

  if (expectedSteamId) {
    try {
      return { state: 'ok', provider: await deps.openReader(expectedSteamId), csboard };
    } catch (error) {
      // The named read already made the worker's own probe after the bridge
      // found nothing; asking again unnamed would repeat the same request.
      if (deps.isSignedOut(error)) return { state: 'missing', csboard };
      if (!isAccountMismatch(error)) return { state: 'unreachable', error, csboard };
    }
  }

  try {
    return { state: 'ok', provider: await deps.openReader(), csboard };
  } catch (error) {
    return deps.isSignedOut(error)
      ? { state: 'missing', csboard }
      : { state: 'unreachable', error, csboard };
  }
}
