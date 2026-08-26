import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CSBOARD_DIRECT_SYNC_MAX_ITEMS,
  classifyCsboardDirectSteamError,
  interpretCsboardDirectSyncResponse,
  runCsboardDirectSync,
  toCsboardDirectSyncWireItem,
  type CsboardDirectSyncDeps,
  type CsboardDirectSyncRequestBody,
  type CsboardSyncAccount,
} from '../../src/background/csboard-direct-sync.ts';
import type { PortfolioItemDto } from '../../src/shared/gateway-dto.ts';

const OWN_STEAM_ID = '76561198000000001';
const OTHER_STEAM_ID = '76561198000000002';

function item(overrides: Partial<PortfolioItemDto> = {}): PortfolioItemDto {
  return {
    appId: '730',
    contextId: '2',
    assetId: '111',
    classId: '222',
    instanceId: '0',
    amount: '1',
    marketHashName: 'AK-47 | Redline (Field-Tested)',
    tradable: true,
    marketable: true,
    onHold: false,
    ...overrides,
  } as PortfolioItemDto;
}

interface Harness {
  deps: CsboardDirectSyncDeps;
  readonly openedFor: string[];
  readonly contexts: string[];
  readonly uploads: CsboardDirectSyncRequestBody[];
}

function harness(options: {
  account?: CsboardSyncAccount;
  context2?: { complete: boolean; items: readonly PortfolioItemDto[] };
  context16?: { complete: boolean; items: readonly PortfolioItemDto[] };
  steamError?: unknown;
  upload?: CsboardDirectSyncDeps['upload'];
} = {}): Harness {
  const openedFor: string[] = [];
  const contexts: string[] = [];
  const uploads: CsboardDirectSyncRequestBody[] = [];
  const deps: CsboardDirectSyncDeps = {
    async readCsboardAccount() {
      return options.account ?? { state: 'signed-in', steamId: OWN_STEAM_ID };
    },
    async openSteamReader(steamId) {
      openedFor.push(steamId);
      if (options.steamError) throw options.steamError;
      return {
        async readInventoryContext(contextId) {
          contexts.push(contextId);
          const source = contextId === '2' ? options.context2 : options.context16;
          return source ?? { complete: true, items: [item({ contextId })] };
        },
      };
    },
    async upload(body) {
      uploads.push(body);
      return options.upload
        ? options.upload(body)
        : { outcome: 'accepted', snapshotEstablished: true };
    },
    newSyncRunId: () => 'sync-run-0000001',
  };
  return { deps, openedFor, contexts, uploads };
}

test('a browser with no csboard session is refused before Steam is touched', async () => {
  const h = harness({ account: { state: 'signed-out' } });
  assert.deepEqual(await runCsboardDirectSync(h.deps), {
    ok: false,
    refused: 'CSBOARD_SIGN_IN_REQUIRED',
  });
  // The seller's Steam session is not something to spend on a snapshot that
  // could never be attributed to anyone.
  assert.deepEqual(h.openedFor, []);
  assert.deepEqual(h.uploads, []);
});

test('an unreachable backend is not reported as a signed-out seller', async () => {
  const h = harness({ account: { state: 'unreachable' } });
  assert.deepEqual(await runCsboardDirectSync(h.deps), {
    ok: false,
    refused: 'SYNC_TRIGGER_FAILED',
  });
  assert.deepEqual(h.openedFor, []);
});

test('a csboard account with no Steam linked has its own name', async () => {
  for (const account of [
    { state: 'signed-in', steamId: null },
    { state: 'signed-in', steamId: 'not-a-steam-id' },
  ] as CsboardSyncAccount[]) {
    const h = harness({ account });
    assert.deepEqual(await runCsboardDirectSync(h.deps), {
      ok: false,
      refused: 'STEAM_ACCOUNT_NOT_LINKED',
    });
    assert.deepEqual(h.openedFor, []);
  }
});

test('the Steam read is bound to the account csboard named, not to whoever is signed in', async () => {
  const h = harness();
  await runCsboardDirectSync(h.deps);
  assert.deepEqual(h.openedFor, [OWN_STEAM_ID]);
  assert.deepEqual(h.contexts, ['2', '16']);
  assert.equal(h.uploads[0]?.steamId, OWN_STEAM_ID);
});

test('the two Steam failures a seller can act on keep their own names', async () => {
  const cases: ReadonlyArray<readonly [unknown, string]> = [
    [new Error('STEAM_SESSION_REQUIRED'), 'STEAM_SESSION_REQUIRED'],
    [new Error('STEAM_ACCOUNT_MISMATCH'), 'STEAM_ACCOUNT_MISMATCH'],
    [
      Object.assign(new Error('INVALID_PAYLOAD'), {
        safeContext: { reason: 'steam-session-unavailable' },
      }),
      'STEAM_SESSION_REQUIRED',
    ],
    [new Error('indexeddb is corrupt'), 'SYNC_TRIGGER_FAILED'],
  ];
  for (const [error, refused] of cases) {
    assert.equal(classifyCsboardDirectSteamError(error), refused);
    const h = harness({ steamError: error });
    assert.deepEqual(await runCsboardDirectSync(h.deps), { ok: false, refused });
    assert.deepEqual(h.uploads, []);
  }
});

test('a partial read is uploaded, but never as a complete one', async () => {
  // Completeness is what lets the backend cancel listings for assets it no
  // longer sees. Claiming it on a truncated read would unpublish real lots.
  const h = harness({ context16: { complete: false, items: [] } });
  const outcome = await runCsboardDirectSync(h.deps);
  assert.deepEqual(outcome, { ok: true, snapshotEstablished: true });
  assert.equal(h.uploads[0]?.completeContexts2And16, false);
});

test('an inventory past the ingest ceiling is refused instead of truncated', async () => {
  const items = Array.from(
    { length: CSBOARD_DIRECT_SYNC_MAX_ITEMS + 1 },
    (_, index) => item({ assetId: String(index + 1) }),
  );
  const h = harness({
    context2: { complete: true, items },
    context16: { complete: true, items: [] },
  });
  assert.deepEqual(await runCsboardDirectSync(h.deps), {
    ok: false,
    refused: 'INVENTORY_TOO_LARGE',
  });
  assert.deepEqual(h.uploads, []);
});

test('the wire item carries the ingest contract exactly and nothing else', async () => {
  // The backend schema is `.strict()`. An extra key is a 400 for every seller
  // at once, so the projection — not the read — decides what is sent.
  const wire = toCsboardDirectSyncWireItem({
    ...item({ contextId: '16', floatValue: 0.21, tradableAfter: 1_800_000_000 }),
    stickers: [{ slot: 0, name: 'Katowice' }],
    somethingNew: true,
  } as unknown as PortfolioItemDto);
  assert.deepEqual(Object.keys(wire).sort(), [
    'amount', 'appId', 'assetId', 'classId', 'contextId', 'floatValue', 'instanceId',
    'marketHashName', 'marketable', 'onHold', 'tradable', 'tradableAfter',
  ]);
  assert.equal('stickers' in wire, false);
  assert.equal('somethingNew' in wire, false);
});

test('the outcome hands back a verdict, never Steam data', async () => {
  const h = harness();
  const outcome = await runCsboardDirectSync(h.deps);
  assert.deepEqual(Object.keys(outcome).sort(), ['ok', 'snapshotEstablished']);
  assert.equal(JSON.stringify(outcome).includes(OWN_STEAM_ID), false);
  assert.equal(JSON.stringify(outcome).includes('AK-47'), false);
});

test('the backend answer decides the refusal, and only via status and code', async () => {
  assert.deepEqual(interpretCsboardDirectSyncResponse(200, { snapshotEstablished: true }), {
    outcome: 'accepted',
    snapshotEstablished: true,
  });
  assert.deepEqual(interpretCsboardDirectSyncResponse(200, { snapshotEstablished: false }), {
    outcome: 'accepted',
    snapshotEstablished: false,
  });
  assert.deepEqual(interpretCsboardDirectSyncResponse(401, { error: 'Unauthorized' }), {
    outcome: 'unauthenticated',
  });
  assert.deepEqual(
    interpretCsboardDirectSyncResponse(400, { code: 'steam_account_mismatch' }),
    { outcome: 'account-mismatch' },
  );
  assert.deepEqual(
    interpretCsboardDirectSyncResponse(400, { code: 'steam_not_linked' }),
    { outcome: 'steam-not-linked' },
  );
  // Prose is never a branch: only the code is read.
  assert.deepEqual(
    interpretCsboardDirectSyncResponse(400, {
      error: 'The browser is signed into a different Steam account',
    }),
    { outcome: 'rejected' },
  );
  assert.deepEqual(interpretCsboardDirectSyncResponse(500, null), { outcome: 'rejected' });
});

test('every upload verdict reaches the caller as a bounded refusal', async () => {
  const cases = [
    [{ outcome: 'unauthenticated' }, 'CSBOARD_SIGN_IN_REQUIRED'],
    [{ outcome: 'account-mismatch' }, 'STEAM_ACCOUNT_MISMATCH'],
    [{ outcome: 'steam-not-linked' }, 'STEAM_ACCOUNT_NOT_LINKED'],
    [{ outcome: 'rejected' }, 'SYNC_TRIGGER_FAILED'],
  ] as const;
  for (const [verdict, refused] of cases) {
    const h = harness({ upload: async () => verdict });
    assert.deepEqual(await runCsboardDirectSync(h.deps), { ok: false, refused });
  }
  const thrown = harness({
    upload: async () => { throw new Error('POST https://csboard.com/api failed: ECONNRESET'); },
  });
  assert.deepEqual(await runCsboardDirectSync(thrown.deps), {
    ok: false,
    refused: 'SYNC_TRIGGER_FAILED',
  });
});

test('the seller is refused for a second Steam account rather than filed under the first', async () => {
  // The mismatch is decided by the reader, which is opened against the csboard
  // account's own id — this asserts the id we hand it is that one and not the
  // second account's.
  const h = harness({
    steamError: new Error('STEAM_ACCOUNT_MISMATCH'),
    account: { state: 'signed-in', steamId: OWN_STEAM_ID },
  });
  await runCsboardDirectSync(h.deps);
  assert.deepEqual(h.openedFor, [OWN_STEAM_ID]);
  assert.equal(h.openedFor.includes(OTHER_STEAM_ID), false);
});
