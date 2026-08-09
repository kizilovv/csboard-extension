// CSBOARD Buff163 page-world bridge.
//
// This script is intentionally self-contained: it runs in Buff's page world,
// starts inert, and only mirrors small JSON responses from a fixed GET-only
// allowlist after the isolated content script explicitly enables it.

(() => {
  'use strict';

  const INSTALL_MARK = '__CSBOARD_BUFF_INTERCEPTOR_V1__';
  const API_EVENT = 'CSBOARD_BUFF_API_RESPONSE_V1';
  const CONTROL_EVENT = 'CSBOARD_BUFF_CONTROL_V1';
  const NAVIGATION_EVENT = 'CSBOARD_BUFF_NAVIGATION_V1';
  const VERSION = 1;
  const MAX_JSON_BYTES = 1_500_000;

  if (window[INSTALL_MARK] === true) return;
  Object.defineProperty(window, INSTALL_MARK, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true,
  });

  let enabled = false;

  const isBuffHost = (hostname) =>
    hostname === 'buff.163.com' || hostname.endsWith('.buff.163.com');

  const normalizedAllowedUrl = (rawUrl) => {
    let url;
    try {
      url = new URL(String(rawUrl), location.href);
    } catch {
      return null;
    }

    if (url.protocol !== 'https:' || !isBuffHost(url.hostname)) return null;

    const path = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '');
    const allowed =
      path === '/api/market/goods/sell_order' ||
      path === '/api/market/goods/buy_order' ||
      path === '/api/market/goods/bundle_inventory' ||
      path.startsWith('/api/market/bundle_overview/') ||
      path === '/api/market/goods/buying' ||
      path === '/api/market/goods' ||
      path === '/api/market/sell_order/top_bookmarked' ||
      /^\/api\/market\/shop\/[^/]+\/sell_order$/.test(path) ||
      /^\/api\/market\/shop\/[^/]+\/bill_order$/.test(path) ||
      /^\/api\/market\/shop\/[^/]+\/featured$/.test(path) ||
      path === '/api/market/item_desc_detail' ||
      path === '/api/market/goods/price_history';

    return allowed ? url.toString() : null;
  };

  const isRecord = (value) =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  const jsonByteLength = (value) => {
    try {
      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      if (typeof serialized !== 'string') return null;
      return new TextEncoder().encode(serialized).byteLength;
    } catch {
      return null;
    }
  };

  const declaredContentLength = (rawValue) => {
    if (typeof rawValue !== 'string') return null;
    const text = rawValue.trim();
    if (!/^\d+$/.test(text)) return null;
    const value = Number(text);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };

  const emitApiResponse = (status, rawUrl, data) => {
    if (!enabled || !Number.isInteger(status) || status < 200 || status > 299) return;
    const url = normalizedAllowedUrl(rawUrl);
    if (!url || !isRecord(data)) return;
    const bytes = jsonByteLength(data);
    if (bytes === null || bytes > MAX_JSON_BYTES) return;

    document.dispatchEvent(new CustomEvent(API_EVENT, {
      detail: { version: VERSION, status, url, data },
    }));
  };

  const parseJsonText = (text) => {
    if (typeof text !== 'string') return null;
    // UTF-8 is never smaller than one byte per JS code unit for ASCII JSON,
    // so this cheap guard avoids allocating a second large byte buffer.
    if (text.length > MAX_JSON_BYTES) return null;
    const bytes = jsonByteLength(text);
    if (bytes === null || bytes > MAX_JSON_BYTES) return null;
    try {
      const value = JSON.parse(text);
      return isRecord(value) ? value : null;
    } catch {
      return null;
    }
  };

  const readJsonResponseCapped = async (response) => {
    const body = response.body;
    if (!body || typeof body.getReader !== 'function') return null;

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    let text = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array)) {
          await reader.cancel();
          return null;
        }
        totalBytes += chunk.value.byteLength;
        if (totalBytes > MAX_JSON_BYTES) {
          await reader.cancel();
          return null;
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      return parseJsonText(text);
    } catch {
      try {
        await reader.cancel();
      } catch {
        // The clone may already be closed.
      }
      return null;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // No-op when the stream already released its lock.
      }
    }
  };

  const emitNavigation = () => {
    if (!enabled) return;
    document.dispatchEvent(new CustomEvent(NAVIGATION_EVENT, {
      detail: { version: VERSION, url: location.href },
    }));
  };

  document.addEventListener(CONTROL_EVENT, (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    if (!isRecord(detail) || detail.version !== VERSION || typeof detail.enabled !== 'boolean') {
      return;
    }
    enabled = detail.enabled;
    if (enabled) queueMicrotask(emitNavigation);
  });

  // Fetch interception never changes the request, response, credentials, or
  // timing visible to Buff. The clone is inspected asynchronously.
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function csboardBuffFetch(input, init) {
      const requestMethod = String(
        init?.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET'),
      ).toUpperCase();
      const requestUrl = typeof Request !== 'undefined' && input instanceof Request
        ? input.url
        : String(input);
      const allowedUrl = requestMethod === 'GET' ? normalizedAllowedUrl(requestUrl) : null;
      const responsePromise = nativeFetch.apply(this, arguments);

      if (enabled && allowedUrl) {
        void Promise.resolve(responsePromise).then(async (response) => {
          if (!(response instanceof Response) || !response.ok) return;
          const responseUrl = normalizedAllowedUrl(response.url || allowedUrl);
          if (!responseUrl) return;

          const declaredLength = declaredContentLength(response.headers.get('content-length'));
          if (declaredLength !== null && declaredLength > MAX_JSON_BYTES) return;

          try {
            const data = await readJsonResponseCapped(response.clone());
            if (data) emitApiResponse(response.status, responseUrl, data);
          } catch {
            // A failed clone/parse must not affect Buff's original response.
          }
        }).catch(() => undefined);
      }

      return responsePromise;
    };
  }

  // XHR interception records metadata at open() time and reads only completed,
  // allowlisted GET responses. No request bodies or headers are inspected.
  const xhrMeta = new WeakMap();
  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function csboardBuffOpen(method, url) {
    const upperMethod = String(method || 'GET').toUpperCase();
    const allowedUrl = upperMethod === 'GET' ? normalizedAllowedUrl(url) : null;
    xhrMeta.set(this, { method: upperMethod, allowedUrl });

    if (allowedUrl) this.addEventListener('loadend', () => {
      if (!enabled) return;
      const meta = xhrMeta.get(this);
      if (!meta || meta.method !== 'GET' || !meta.allowedUrl) return;
      if (!Number.isInteger(this.status) || this.status < 200 || this.status > 299) return;

      const responseUrl = normalizedAllowedUrl(this.responseURL || meta.allowedUrl);
      if (!responseUrl) return;

      const declaredLength = declaredContentLength(this.getResponseHeader('content-length'));
      if (declaredLength !== null && declaredLength > MAX_JSON_BYTES) return;

      try {
        if (this.responseType === 'json') {
          // A parsed object cannot be byte-capped before allocation and a
          // response Content-Length is not a trustworthy bound after content
          // decoding. Fail closed; Buff's normal text XHR and Fetch paths are
          // handled below/above with actual byte limits.
          return;
        }
        if (this.responseType === '' || this.responseType === 'text') {
          const data = parseJsonText(this.responseText);
          if (data) emitApiResponse(this.status, responseUrl, data);
        }
      } catch {
        // Cross-origin/invalid response access fails closed.
      }
    }, { once: true });

    return nativeOpen.apply(this, arguments);
  };

  const wrapHistoryMethod = (methodName) => {
    const original = history[methodName];
    if (typeof original !== 'function') return;
    history[methodName] = function csboardBuffHistory() {
      const result = original.apply(this, arguments);
      queueMicrotask(emitNavigation);
      return result;
    };
  };

  wrapHistoryMethod('pushState');
  wrapHistoryMethod('replaceState');
  window.addEventListener('popstate', emitNavigation);
  window.addEventListener('hashchange', emitNavigation);
})();
