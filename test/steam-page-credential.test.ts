import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  isSteamPageCredentialRequest,
  isTrustedSteamPageSender,
  normalizeSteamPageCredential,
  normalizeSteamPageCredentialResponse,
} from '../src/shared/steam-page-credential.ts';

const TOKEN = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJFZERTQSJ9.payload-part.signature-part';
const STEAM_ID = '76561198000000042';
const OTHER_STEAM_ID = '76561198000000001';

function withDocument(html: string, attr?: string | null, inlineScripts?: string[]) {
  const previous = (globalThis as Record<string, unknown>)['document'];
  (globalThis as Record<string, unknown>)['document'] = {
    documentElement: { innerHTML: html },
    scripts: (inlineScripts ?? [html]).map((textContent) => ({ src: '', textContent })),
    querySelector(selector: string) {
      if (selector !== '#application_config' || attr === undefined) return null;
      return { getAttribute: () => attr };
    },
  };
  return () => {
    (globalThis as Record<string, unknown>)['document'] = previous;
  };
}

async function readCredential() {
  const mod = await import('../src/shared/steam-page-credential.ts');
  return mod.readSteamPageCredential();
}

test('the page credential is read from the application config attribute', async () => {
  const restore = withDocument(
    '<html>Steam shell</html>',
    TOKEN,
    [`var g_steamID = "${STEAM_ID}";`],
  );
  try {
    assert.deepEqual(await readCredential(), {
      pageAccessToken: TOKEN,
      pageSteamId: STEAM_ID,
    });
  } finally {
    restore();
  }
});

test('an html-escaped token is unescaped before it is handed on', async () => {
  const restore = withDocument(
    '<html>Steam shell</html>',
    `&quot;${TOKEN}&quot;`,
    [`var g_steamID = "${STEAM_ID}";`],
  );
  try {
    const credential = await readCredential();
    assert.equal(credential?.pageAccessToken, TOKEN);
  } finally {
    restore();
  }
});

test('the inline bootstrap is used when the attribute is absent', async () => {
  const restore = withDocument(
    '<html>Steam shell</html>',
    null,
    [`data-loyalty_webapi_token="&quot;${TOKEN}&quot;"; g_steamID = "${STEAM_ID}";`],
  );
  try {
    const credential = await readCredential();
    assert.equal(credential?.pageAccessToken, TOKEN);
    assert.equal(credential?.pageSteamId, STEAM_ID);
  } finally {
    restore();
  }
});

test('user-authored body text cannot spoof the Steam account binding', async () => {
  const restore = withDocument(
    `<main>g_steamID = "${OTHER_STEAM_ID}";</main>`,
    TOKEN,
    [`var g_steamID = "${STEAM_ID}";`],
  );
  try {
    assert.equal((await readCredential())?.pageSteamId, STEAM_ID);
  } finally {
    restore();
  }
});

test('conflicting Steam bootstrap account assignments fail closed', async () => {
  const restore = withDocument('<main></main>', TOKEN, [
    `g_steamID = "${STEAM_ID}";`,
    `g_steamID = "${OTHER_STEAM_ID}";`,
  ]);
  try {
    assert.equal(await readCredential(), null);
  } finally {
    restore();
  }
});

test('a page without a signed-in account yields no credential', async () => {
  // A token without an account id cannot be bound to anything, and passing it
  // on would let the worker read whichever account it happens to belong to.
  const restore = withDocument('<html>no session here</html>', TOKEN);
  try {
    assert.equal(await readCredential(), null);
  } finally {
    restore();
  }
});

test('a blank or malformed token is refused', async () => {
  for (const bad of ['', '   ', 'short', `${TOKEN} with space`]) {
    const restore = withDocument(`<html>g_steamID = "${STEAM_ID}";</html>`, bad);
    try {
      assert.equal(await readCredential(), null, `expected null for ${JSON.stringify(bad)}`);
    } finally {
      restore();
    }
  }
});

test('the worker bridge accepts only the exact Steam HTTPS origin and extension id', () => {
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
  assert.equal(isTrustedSteamPageSender({
    id: extensionId,
    url: 'https://steamcommunity.com/id/trader/inventory',
    origin: 'https://steamcommunity.com',
  }, extensionId), true);
  for (const sender of [
    { id: extensionId, url: 'http://steamcommunity.com/id/trader' },
    { id: extensionId, url: 'https://evil.steamcommunity.com/id/trader' },
    { id: extensionId, url: 'https://csfloat.com/' },
    { id: 'another-extension', url: 'https://steamcommunity.com/' },
  ]) {
    assert.equal(isTrustedSteamPageSender(sender, extensionId), false);
  }
});

test('the credential bridge contract is exact-schema and bounded', () => {
  assert.deepEqual(normalizeSteamPageCredential({
    pageAccessToken: TOKEN,
    pageSteamId: STEAM_ID,
  }), {
    pageAccessToken: TOKEN,
    pageSteamId: STEAM_ID,
  });
  assert.equal(normalizeSteamPageCredential({
    pageAccessToken: TOKEN,
    pageSteamId: STEAM_ID,
    html: '<secret>',
  }), null);
  assert.equal(normalizeSteamPageCredential({
    pageAccessToken: TOKEN,
    pageSteamId: '123',
  }), null);
  assert.equal(isSteamPageCredentialRequest({
    type: 'REQUEST_STEAM_PAGE_CREDENTIAL',
    version: 1,
  }), true);
  assert.equal(isSteamPageCredentialRequest({
    type: 'REQUEST_STEAM_PAGE_CREDENTIAL',
    version: 1,
    arbitrary: true,
  }), false);
  assert.deepEqual(normalizeSteamPageCredentialResponse({
    credential: { pageAccessToken: TOKEN, pageSteamId: STEAM_ID },
  }), { pageAccessToken: TOKEN, pageSteamId: STEAM_ID });
  assert.equal(normalizeSteamPageCredentialResponse({
    credential: { pageAccessToken: TOKEN, pageSteamId: STEAM_ID },
    extra: true,
  }), null);
});

test('the bridge is exact-origin, bounded-retry, and has no storage/log/network capability', async () => {
  const manifest = JSON.parse(await readFile(
    new URL('../src/manifest.json', import.meta.url),
    'utf8',
  )) as { content_scripts?: Array<{ matches?: string[]; js?: string[] }> };
  const entry = manifest.content_scripts?.find((candidate) =>
    candidate.js?.includes('src/content-scripts/steam/page-credential-bridge.ts'));
  assert.deepEqual(entry?.matches, ['https://steamcommunity.com/*']);

  const source = await readFile(
    new URL('../src/content-scripts/steam/page-credential-bridge.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /MAX_INITIAL_ATTEMPTS = 20/);
  assert.match(source, /CREDENTIAL_REFRESH_MS = 4 \* 60 \* 1_000/);
  assert.match(source, /isSteamPageCredentialRequest\(message\)/);
  assert.match(source, /sender\.id !== chrome\.runtime\.id/);
  assert.doesNotMatch(source, /chrome\.storage|\bfetch\s*\(|createLogger|console\./);
});

test('a token minted for another account is refused by the read provider', async () => {
  const { createSteamReadSessionProvider } = await import(
    '../src/background/steam-read-session-provider.ts'
  );
  let requestedUrl = '';
  const provider = createSteamReadSessionProvider({
    steamId: STEAM_ID,
    fetchImpl: (async (input: unknown) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ response: { trade_offers_sent: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch,
  });

  // Wrong account: ignored, so the provider still has to mint for itself.
  provider.offerAccessToken(TOKEN, OTHER_STEAM_ID);
  provider.offerAccessToken(TOKEN, STEAM_ID);
  await provider.readTradeOffers();
  assert.ok(
    requestedUrl.includes(`access_token=${encodeURIComponent(TOKEN)}`),
    `expected the accepted token in ${requestedUrl.slice(0, 160)}`,
  );
});

test('the read provider survives a brand-checked global fetch', async () => {
  // Reproduces WorkerGlobalScope semantics: the real `fetch` throws
  // "Illegal invocation" unless its receiver is the global object. Storing it
  // bare in a field and calling `this.fetchImpl(...)` therefore failed every
  // single request inside the service worker, which killed price rendering on
  // the whole trade-offers page.
  const realFetch = globalThis.fetch;
  let calls = 0;
  const brandChecked = function (this: unknown, ...args: unknown[]) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation");
    }
    calls += 1;
    const url = String(args[0]);
    const body = url.includes('GetTradeOffers')
      ? { response: { trade_offers_sent: [], trade_offers_received: [], descriptions: [] } }
      : {};
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  };
  (globalThis as Record<string, unknown>)['fetch'] = brandChecked;
  try {
    const { createSteamReadSessionProvider } = await import(
      '../src/background/steam-read-session-provider.ts'
    );
    const provider = createSteamReadSessionProvider({ steamId: STEAM_ID });
    provider.offerAccessToken(TOKEN, STEAM_ID);
    const result = await provider.readTradeOffers();
    assert.equal(result.complete, true);
    assert.ok(calls > 0, 'expected the provider to actually reach the network layer');
  } finally {
    (globalThis as Record<string, unknown>)['fetch'] = realFetch;
  }
});
