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

function cleanToken(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const token = raw.replace(/&quot;/g, '').replace(/"/g, '').trim();
  if (token.length < 16 || token.length > 4_096 || /\s/.test(token)) return null;
  return token;
}

export function readSteamPageCredential(): SteamPageCredential | null {
  const config = document.querySelector('#application_config');
  const token = cleanToken(config?.getAttribute('data-loyalty_webapi_token')) ??
    // Some Steam pages ship the config blob without the attribute; the token is
    // still in the inline bootstrap.
    cleanToken(/data-loyalty_webapi_token\s*=\s*"([^"]+)"/.exec(document.documentElement.innerHTML)?.[1]);
  if (!token) return null;

  const steamId = /g_steamID\s*=\s*"(\d{17})"/.exec(document.documentElement.innerHTML)?.[1];
  if (!steamId) return null;

  return { pageAccessToken: token, pageSteamId: steamId };
}
