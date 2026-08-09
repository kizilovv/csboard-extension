import test from 'node:test';
import assert from 'node:assert/strict';

type Bag = Record<string, unknown>;

function storageArea(bag: Bag) {
  return {
    async get(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => key in bag).map((key) => [key, bag[key]]));
    },
    async set(values: Bag) {
      Object.assign(bag, values);
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete bag[key];
    },
  };
}

test('v3 migration destroys legacy Steam credentials and keeps BetterBuff opt-in off', async () => {
  const local: Bag = {
    csboard_storage_version: 1,
    csboard_steam_access_token: 'plaintext-secret',
    csboard_encrypted_access_token: 'ciphertext',
    csboard_access_token_iv: 'iv',
    csboard_settings: { currency: 'EUR', priceSource: 'steam' },
  };
  const session: Bag = {
    csboard_steam_access_token: 'session-secret',
    csboard_session_crypto_key: { k: 'exported-key' },
  };

  Object.assign(globalThis, {
    chrome: { storage: { local: storageArea(local), session: storageArea(session) } },
  });

  const { runMigrations, getSettings } = await import('../../src/shared/storage');
  await runMigrations();

  assert.equal(local.csboard_storage_version, 3);
  assert.equal(local.csboard_steam_access_token, undefined);
  assert.equal(local.csboard_encrypted_access_token, undefined);
  assert.equal(local.csboard_access_token_iv, undefined);
  assert.equal(session.csboard_steam_access_token, undefined);
  assert.equal(session.csboard_session_crypto_key, undefined);

  const settings = await getSettings();
  assert.equal(settings.currency, 'EUR');
  assert.equal(settings.priceSource, 'steam');
  assert.equal(settings.followCsboardSettings, true);
  assert.equal(settings.showCsboardPricesOnCsfloat, true);
  assert.equal(settings.showBetterBuffOnBuff, false);
  assert.equal(settings.portfolioSyncEnabled, false);
  assert.deepEqual(settings.portfolioSources, {
    inventory: false,
    tradeOffers: false,
    tradeHistory: false,
    marketHistory: false,
  });
});
