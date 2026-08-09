import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('auth/me envelope is normalized into the extension profile contract', async () => {
  const api = await import('../src/shared/api.ts') as Record<string, unknown>;
  assert.equal(typeof api.normalizeAuthMePayload, 'function');
  assert.equal(typeof api.unwrapAuthMeUserPayload, 'function');

  const normalizeAuthMePayload = api.normalizeAuthMePayload as (value: unknown) => unknown;
  const unwrapAuthMeUserPayload = api.unwrapAuthMeUserPayload as (
    value: unknown,
  ) => Record<string, unknown> | null;
  const productionUser = {
    id: 'user-123',
    steamId: '76561198012345678',
    username: 'Test Keeper',
    avatar: 'https://avatars.steamstatic.com/example.jpg',
    isPremium: true,
    balanceUsd: 42.5,
    priceSource: 'csfloat',
    currency: 'EUR',
  };

  assert.equal(unwrapAuthMeUserPayload({ user: productionUser }), productionUser);
  assert.equal(unwrapAuthMeUserPayload(productionUser), productionUser);
  assert.equal(unwrapAuthMeUserPayload({ user: null }), null);

  assert.deepEqual(normalizeAuthMePayload({
    user: productionUser,
  }), {
    id: 'user-123',
    steamId: '76561198012345678',
    name: 'Test Keeper',
    avatar: 'https://avatars.steamstatic.com/example.jpg',
    isPremium: true,
    balance: 42.5,
    frozenBalance: 0,
  });

  assert.equal(normalizeAuthMePayload({ user: null }), null);
  assert.equal(normalizeAuthMePayload({ user: { id: 'missing-fields' } }), null);
});

test('avatar URL normalization permits only credential-free HTTPS URLs', async () => {
  const api = await import('../src/shared/api.ts') as Record<string, unknown>;
  assert.equal(typeof api.normalizeAvatarUrl, 'function');

  const normalizeAvatarUrl = api.normalizeAvatarUrl as (value: unknown) => string | null;
  assert.equal(
    normalizeAvatarUrl('https://avatars.steamstatic.com/example.jpg'),
    'https://avatars.steamstatic.com/example.jpg',
  );
  assert.equal(normalizeAvatarUrl('http://cdn.example.test/avatar.png'), null);
  assert.equal(normalizeAvatarUrl('javascript:alert(1)'), null);
  assert.equal(normalizeAvatarUrl('data:image/svg+xml,<svg/>'), null);
  assert.equal(normalizeAvatarUrl('https://user:pass@example.test/avatar.png'), null);
  assert.equal(normalizeAvatarUrl(''), null);
  assert.equal(normalizeAvatarUrl(null), null);
});

test('popup keeps a generated fallback visible until a safe avatar loads and after image errors', async () => {
  class FakeClassList {
    readonly values = new Set<string>();

    toggle(name: string, force?: boolean): boolean {
      const shouldAdd = force ?? !this.values.has(name);
      if (shouldAdd) this.values.add(name);
      else this.values.delete(name);
      return shouldAdd;
    }

    contains(name: string): boolean {
      return this.values.has(name);
    }
  }

  const image = {
    alt: '',
    classList: new FakeClassList(),
    onerror: null as null | (() => void),
    onload: null as null | (() => void),
    srcValue: null as string | null,
    get src() { return this.srcValue ?? ''; },
    set src(value: string) { this.srcValue = value; },
    getAttribute(name: string) {
      return name === 'src' ? this.srcValue : null;
    },
    removeAttribute(name: string) {
      if (name === 'src') this.srcValue = null;
    },
  };
  image.classList.values.add('hidden');

  const fallback = {
    classList: new FakeClassList(),
    textContent: '',
  };

  const originalDocument = globalThis.document;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      addEventListener() {},
      querySelector(selector: string) {
        if (selector === '#user-avatar') return image;
        if (selector === '#user-avatar-fallback') return fallback;
        return null;
      },
    },
  });

  try {
    const popup = await import('../src/popup/popup.ts') as Record<string, unknown>;
    assert.equal(typeof popup.renderUserAvatar, 'function');
    const renderUserAvatar = popup.renderUserAvatar as (user: {
      name: string;
      avatar: string | null;
    }) => void;

    renderUserAvatar({ name: 'Test Keeper', avatar: 'https://avatars.steamstatic.com/example.jpg' });
    assert.equal(fallback.textContent, 'TK');
    assert.equal(fallback.classList.contains('hidden'), false);
    assert.equal(image.classList.contains('hidden'), true);
    assert.equal(image.src, 'https://avatars.steamstatic.com/example.jpg');

    image.onload?.();
    assert.equal(fallback.classList.contains('hidden'), true);
    assert.equal(image.classList.contains('hidden'), false);
    assert.equal(image.alt, 'Test Keeper avatar');

    image.onerror?.();
    assert.equal(fallback.classList.contains('hidden'), false);
    assert.equal(image.classList.contains('hidden'), true);
    assert.equal(image.src, '');

    renderUserAvatar({ name: 'No Script', avatar: 'javascript:alert(1)' });
    assert.equal(fallback.textContent, 'NS');
    assert.equal(fallback.classList.contains('hidden'), false);
    assert.equal(image.classList.contains('hidden'), true);
    assert.equal(image.src, '');
  } finally {
    if (originalDocument === undefined) {
      Reflect.deleteProperty(globalThis, 'document');
    } else {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: originalDocument,
      });
    }
  }
});

test('popup markup never boots an image with an empty src and includes an initials fallback', () => {
  const html = readFileSync(new URL('../src/popup/popup.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="user-avatar"[^>]*\bsrc=""/);
  assert.match(html, /id="user-avatar-fallback"/);
});
