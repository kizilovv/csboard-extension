/**
 * Reads the Steam webapi token and account id that every logged-in
 * steamcommunity.com page already carries in its own DOM.
 *
 * 🔴 This is the only place the token is reliably available. The background
 * service worker can mint one too, but its fetch to steamcommunity.com is
 * cross-site relative to the `chrome-extension://` origin, so a browser that
 * blocks third-party cookies answers it logged-out. A content script is
 * first-party on the page and does not need a network request at all — both
 * values are already in the markup.
 *
 * Content scripts pass these to the worker, which hands them to the read
 * provider. Nothing stores or returns them.
 */

export interface SteamPageCredential {
  readonly pageAccessToken: string;
  readonly pageSteamId: string;
}

export const STEAM_COMMUNITY_ORIGIN = 'https://steamcommunity.com' as const;

function cleanToken(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const token = raw.replace(/&quot;/g, '').replace(/"/g, '').trim();
  if (token.length < 16 || token.length > 4_096 || /\s/.test(token)) return null;
  return token;
}

function uniqueInlineScriptMatch(pattern: RegExp): string | null {
  const matches = new Set<string>();
  for (const script of Array.from(document.scripts)) {
    // Steam's account bootstrap is inline. Never inspect remote script source
    // text or arbitrary body HTML, where user-authored content can imitate the
    // `g_steamID` spelling and cause an account-mismatch denial of service.
    if (script.src) continue;
    const match = pattern.exec(script.textContent ?? '')?.[1];
    if (match) matches.add(match);
  }
  return matches.size === 1 ? [...matches][0]! : null;
}

/**
 * Validates the deliberately tiny content-script -> worker credential message.
 * Unknown fields are refused so this bridge cannot quietly grow into a page
 * data transport. The returned value is suitable only for immediate in-memory
 * use; callers must never persist or log it.
 */
export function normalizeSteamPageCredential(value: unknown): SteamPageCredential | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== 'pageAccessToken' || keys[1] !== 'pageSteamId') {
    return null;
  }
  const token = typeof record['pageAccessToken'] === 'string'
    ? cleanToken(record['pageAccessToken'])
    : null;
  const steamId = typeof record['pageSteamId'] === 'string'
    ? record['pageSteamId']
    : '';
  if (!token || !/^7656119\d{10}$/.test(steamId)) return null;
  return { pageAccessToken: token, pageSteamId: steamId };
}

/** Exact-origin sender gate for the credential-only internal message. */
export function isTrustedSteamPageSender(
  sender: Pick<chrome.runtime.MessageSender, 'id' | 'url' | 'origin'>,
  extensionId: string,
): boolean {
  if (!extensionId || sender.id !== extensionId || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    if (url.origin !== STEAM_COMMUNITY_ORIGIN || url.username || url.password) return false;
    return sender.origin === undefined || sender.origin === STEAM_COMMUNITY_ORIGIN;
  } catch {
    return false;
  }
}

export function readSteamPageCredential(): SteamPageCredential | null {
  const config = document.querySelector('#application_config');
  const token = cleanToken(config?.getAttribute('data-loyalty_webapi_token')) ??
    // Some Steam pages ship the config blob without the attribute; the token is
    // still in a Steam-owned inline bootstrap script.
    cleanToken(uniqueInlineScriptMatch(
      /data-loyalty_webapi_token\s*=\s*"([^"]+)"/,
    ));
  if (!token) return null;

  const steamId = uniqueInlineScriptMatch(
    /(?:^|[;\n]\s*)(?:var\s+)?g_steamID\s*=\s*"(\d{17})"\s*;/,
  );
  if (!steamId) return null;

  return normalizeSteamPageCredential({ pageAccessToken: token, pageSteamId: steamId });
}
