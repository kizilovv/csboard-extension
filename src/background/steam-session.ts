import { createLogger } from '../shared/logger';
import { Fail, Ok, type Result } from '../shared/result';

const logger = createLogger('steam-session');

export interface SteamSessionInfo {
  readonly isLoggedIn: boolean;
  readonly steamId?: string;
}

/**
 * Reads the active Steam account from the authenticated community page.
 * It extracts only the account id required for account-binding checks; no
 * session credential is returned, stored, logged, or uploaded.
 */
export async function fetchSteamSession(): Promise<Result<SteamSessionInfo>> {
  try {
    const response = await fetch('https://steamcommunity.com', {
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9;q=0.8',
      },
    });
    if (!response.ok) {
      return Fail(`Steam returned HTTP ${response.status}`, 'API_ERROR', response.status >= 500);
    }

    const html = await response.text();
    const steamId = html.match(/g_steamID\s*=\s*"(\d+)"/)?.[1];
    const result: SteamSessionInfo = {
      isLoggedIn: typeof steamId === 'string',
      ...(steamId ? { steamId } : {}),
    };
    logger.debug('Steam account session checked', {
      isLoggedIn: result.isLoggedIn,
    });
    return Ok(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Steam session request failed';
    logger.warn('Steam account session check failed', { error: message });
    return Fail(message, 'NETWORK_ERROR', true);
  }
}
