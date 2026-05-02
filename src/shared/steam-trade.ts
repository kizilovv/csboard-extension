// ============================================================
// CSBOARD — Steam Trade Offer Creator
// ============================================================
// Replicates CSFloat's pattern: extract g_sessionID, POST to
// /tradeoffer/new/send with form-encoded body.
// Referer header injected via declarativeNetRequest rule.

import { createLogger } from './logger';
import { type Result, Ok, Fail } from './result';

const logger = createLogger('steam-trade');

// --- Types ---

export interface CreateSteamTradeRequest {
  /** Partner's Steam ID (64-bit) */
  partnerSteamId64: string;
  /** Partner's trade token (from their trade URL) */
  tradeToken: string;
  /** Asset IDs user is giving */
  assetIdsToGive: string[];
  /** Asset IDs user is receiving */
  assetIdsToReceive: string[];
  /** Optional trade message */
  message?: string;
}

export interface CreateSteamTradeResponse {
  success: boolean;
  tradeOfferId?: string;
  needsMobileConfirmation?: boolean;
  needsEmailConfirmation?: boolean;
  error?: string;
}

interface SteamSessionInfo {
  isLoggedIn: boolean;
  steamId?: string;
  sessionId?: string;
}

// --- Session ID Extraction (CSFloat pattern) ---

/**
 * Fetch the Steam community home page and extract g_sessionID + g_steamID.
 * Steam uses browser cookies, so credentials: 'include' is required.
 */
export async function fetchSteamSession(): Promise<Result<SteamSessionInfo>> {
  try {
    logger.debug('Fetching Steam session...');

    const resp = await fetch('https://steamcommunity.com', {
      credentials: 'include',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9;q=0.8',
      },
    });

    if (!resp.ok) {
      return Fail(`Steam returned HTTP ${resp.status}`, 'API_ERROR', resp.status >= 500);
    }

    const text = await resp.text();

    const result: SteamSessionInfo = { isLoggedIn: false };

    // Extract g_steamID
    const steamIdMatch = text.match(/g_steamID\s*=\s*"(\d+)"/);
    if (steamIdMatch && steamIdMatch[1]) {
      result.isLoggedIn = true;
      result.steamId = steamIdMatch[1];
    }

    // Extract g_sessionID — THE critical piece
    const sessionIdMatch = text.match(/g_sessionID\s*=\s*"([0-9a-fA-F]+)"/);
    if (sessionIdMatch && sessionIdMatch[1]) {
      result.sessionId = sessionIdMatch[1];
    }

    logger.info('Steam session fetched', {
      isLoggedIn: result.isLoggedIn,
      hasSteamId: !!result.steamId,
      hasSessionId: !!result.sessionId,
    });

    return Ok(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Failed to fetch Steam session', { error: message });
    return Fail(message, 'NETWORK_ERROR', true);
  }
}

// --- Trade Offer Creation (CSFloat pattern) ---

/**
 * Create a Steam trade offer by POSTing to /tradeoffer/new/send.
 *
 * Requirements:
 * - User must be logged into Steam in the browser
 * - declarativeNetRequest rule must inject Referer header
 * - Trade token must be valid for the partner
 */
export async function createSteamTradeOffer(
  req: CreateSteamTradeRequest,
): Promise<Result<CreateSteamTradeResponse>> {
  try {
    // Step 1: Get session ID
    const sessionResult = await fetchSteamSession();
    if (!sessionResult.ok) {
      return Fail(`Failed to get Steam session: ${sessionResult.error.message}`, 'AUTH_REQUIRED');
    }

    const session = sessionResult.value;
    if (!session.isLoggedIn || !session.sessionId) {
      return Fail('Not logged into Steam. Please log in at steamcommunity.com', 'AUTH_REQUIRED');
    }

    logger.info('Creating trade offer', {
      partner: req.partnerSteamId64,
      giving: req.assetIdsToGive.length,
      receiving: req.assetIdsToReceive.length,
    });

    // Step 2: Build trade offer JSON (CSFloat format)
    function itemMapper(assetId: string) {
      return {
        appid: 730,       // CS2
        contextid: '2',   // Community items
        amount: 1,
        assetid: assetId,
      };
    }

    const offerData = {
      newversion: true,
      version: req.assetIdsToGive.length + req.assetIdsToReceive.length + 1,
      me: {
        assets: req.assetIdsToGive.map(itemMapper),
        currency: [],
        ready: false,
      },
      them: {
        assets: req.assetIdsToReceive.map(itemMapper),
        currency: [],
        ready: false,
      },
    };

    const tradeParams = {
      trade_offer_access_token: req.tradeToken,
    };

    // Step 3: Build form data
    const formData = {
      sessionid: session.sessionId,
      serverid: '1',
      partner: req.partnerSteamId64,
      tradeoffermessage: req.message || 'CSBOARD Trade',
      json_tradeoffer: JSON.stringify(offerData),
      captcha: '',
      trade_offer_create_params: JSON.stringify(tradeParams),
    };

    // Step 4: POST to Steam
    // NOTE: Referer header is injected by declarativeNetRequest rule
    const resp = await fetch('https://steamcommunity.com/tradeoffer/new/send', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body: new URLSearchParams(formData).toString(),
    });

    const text = await resp.text();

    // Step 5: Parse response
    let json: Record<string, unknown> | undefined;
    try {
      json = JSON.parse(text);
    } catch {
      logger.error('Failed to parse Steam response as JSON', { text: text.substring(0, 200) });
    }

    if (!resp.ok || !json) {
      return Fail(
        json?.strError as string || `Steam returned HTTP ${resp.status}`,
        'API_ERROR',
        resp.status >= 500,
      );
    }

    if (json.strError) {
      return Fail(json.strError as string, 'API_ERROR');
    }

    const tradeOfferId = String(json.tradeofferid || '');
    if (!tradeOfferId) {
      return Fail('Steam did not return a trade offer ID', 'API_ERROR');
    }

    logger.info('Trade offer created successfully', {
      tradeOfferId,
      needsMobileConfirmation: json.needs_mobile_confirmation,
    });

    return Ok({
      success: true,
      tradeOfferId,
      needsMobileConfirmation: json.needs_mobile_confirmation as boolean,
      needsEmailConfirmation: json.needs_email_confirmation as boolean,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Trade offer creation failed', { error: message });
    return Fail(message, 'NETWORK_ERROR', true);
  }
}

// ============================================================
// Mobile Authenticator Check (trade hold / escrow duration)
// ============================================================
// Proactively detect whether the seller has Steam Mobile Authenticator. If
// not, Steam applies a 15-day escrow to every trade they send — incompatible
// with P2P marketplace flow. We query IEconService/GetTradeHoldDurations and
// read `my_escrow.escrow_end_duration_seconds` (0 means mobile guard active).

export interface MobileAuthStatus {
  hasMobileAuth: boolean;
  myEscrowSeconds: number;
  steamId: string;
}

export async function checkMobileAuthStatus(
  accessToken: string,
  ownSteamId: string,
): Promise<Result<MobileAuthStatus>> {
  try {
    // Steam requires `steamid_target` — pass our own steamid so the response's
    // `my_escrow` block reflects our account state regardless of partner.
    const url =
      `https://api.steampowered.com/IEconService/GetTradeHoldDurations/v1/` +
      `?access_token=${encodeURIComponent(accessToken)}` +
      `&steamid_target=${encodeURIComponent(ownSteamId)}`;

    const resp = await fetch(url);
    if (!resp.ok) {
      return Fail(`Steam returned HTTP ${resp.status}`, 'API_ERROR', resp.status >= 500);
    }

    const body = (await resp.json()) as {
      response?: { my_escrow?: { escrow_end_duration_seconds?: number } };
    };
    const seconds = body.response?.my_escrow?.escrow_end_duration_seconds ?? 0;
    return Ok({
      hasMobileAuth: seconds === 0,
      myEscrowSeconds: seconds,
      steamId: ownSteamId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('checkMobileAuthStatus failed', { error: message });
    return Fail(message, 'NETWORK_ERROR', true);
  }
}

// ============================================================
// Cancel Trade Offer
// ============================================================
// Used when backend marks an order as expired (8h buyer-accept window)
// and the live Steam offer needs to be cancelled so the item is released
// and the buyer can't accept after refund.

/**
 * Cancel a sent Steam trade offer via /tradeoffer/:id/cancel.
 * Requires an authenticated Steam session (g_sessionID).
 */
export async function cancelSteamTradeOffer(tradeOfferId: string): Promise<Result<{ success: true }>> {
  try {
    const sessionResult = await fetchSteamSession();
    if (!sessionResult.ok) return sessionResult;
    const session = sessionResult.value;

    if (!session.isLoggedIn || !session.sessionId) {
      return Fail('Not logged in to Steam', 'AUTH_REQUIRED');
    }

    const resp = await fetch(`https://steamcommunity.com/tradeoffer/${tradeOfferId}/cancel`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body: new URLSearchParams({ sessionid: session.sessionId }).toString(),
    });

    if (!resp.ok) {
      return Fail(`Steam cancel returned HTTP ${resp.status}`, 'API_ERROR', resp.status >= 500);
    }

    logger.info('Cancelled Steam trade offer', { tradeOfferId });
    return Ok({ success: true as const });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Cancel trade offer failed', { tradeOfferId, error: message });
    return Fail(message, 'NETWORK_ERROR', true);
  }
}
