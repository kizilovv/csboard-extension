import assert from 'node:assert/strict';
import test from 'node:test';

const SETTINGS_KEY = 'csboard_settings';

function installChromeStub(initial: Record<string, unknown>) {
  const store: Record<string, unknown> = { ...initial };
  (globalThis as Record<string, unknown>)['chrome'] = {
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const key of list) if (key in store) out[key] = store[key];
          return out;
        },
        set: async (values: Record<string, unknown>) => { Object.assign(store, values); },
        remove: async () => {},
      },
    },
    runtime: { id: 'test' },
  };
  return store;
}

test('changing currency never rewrites unrelated switches', async () => {
  // The engine used to copy the entire settings blob into its own field on
  // init and write that snapshot back on every price-setting change. Any
  // switch the user flipped afterwards was silently reverted to whatever it
  // was when the worker started — the BetterBuff toggle that "enabled" and
  // stayed off.
  const store = installChromeStub({
    [SETTINGS_KEY]: {
      currency: 'USD',
      priceSource: 'buff163',
      showBetterBuffOnBuff: false,
      showCsboardPricesOnCsfloat: true,
      portfolioSyncEnabled: true,
    },
    csboard_prices: {},
    csboard_exchange_rates: {},
  });

  const { priceEngine } = await import('../src/shared/price-engine.ts');
  await priceEngine.init();

  // The user flips the switch through the normal settings path.
  const current = store[SETTINGS_KEY] as Record<string, unknown>;
  store[SETTINGS_KEY] = { ...current, showBetterBuffOnBuff: true };

  // ...and only then the price settings are saved.
  await priceEngine.updateSettings({ currency: 'EUR' });

  const saved = store[SETTINGS_KEY] as Record<string, unknown>;
  assert.equal(saved.currency, 'EUR', 'price setting must be written');
  assert.equal(saved.showBetterBuffOnBuff, true, 'unrelated switch must survive');
  assert.equal(saved.showCsboardPricesOnCsfloat, true);
  assert.equal(saved.portfolioSyncEnabled, true);
});
