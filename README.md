# CSBOARD Extension

Read-only price overlay for CS2 items on Steam Community pages and CSFloat. Open source, no tracking.

- Homepage: <https://csboard.com>
- Privacy policy: <https://csboard.com/en/privacy>
- Terms of service: <https://csboard.com/en/terms>
- License: [MIT](LICENSE)

## What it does

- Shows multi-source prices (Buff163, Steam, CSFloat, Skinport, DMarket, YouPin, Lisskins) on Steam inventory, market, trade-offer, and profile pages.
- Overlays price/diff information on CSFloat listings.
- Displays Steam trade history with USD values from local cache (Steam-side only — no server sync).
- Optional: signs you in to CSBOARD via cookies to inherit your preferred currency / price source.

## Endpoints used

Only public/auth endpoints that exist on production:

| Endpoint | Purpose |
|---|---|
| `GET  /api/extension/prices` | Full price dump (~MB, cached, 5-min ETag) |
| `GET  /api/extension/exchange-rates` | Currency conversion rates |
| `GET  /api/auth/me` | Cookie-based user check (currency + priceSource sync) |
| `POST /api/auth/logout` | Clear session cookie |

That's it. Everything else is direct Steam Web API or local computation.

## Geo-aware domain resolution

Production CSBOARD is geo-routed at nginx:
- `csboard.com` — non-RU traffic (canonical).
- `csboard.trade` — RU traffic (no VPN required).

When a visitor's geo doesn't match the domain, nginx 302's them to the other host. `fetch(credentials:'include')` strips cookies on cross-origin redirects and POST bodies don't survive 302 reliably — so the extension can't just point at one domain.

On first run the extension probes both with `redirect: 'error'`. The one that does NOT 302 is the user's local host, and the choice is cached in `chrome.storage.local` for 24h. See [`src/shared/config.ts`](src/shared/config.ts).

## Build

```
npm install
npm run build
```

Output: `build/` (load as unpacked extension in Chrome).

## Layout

```
src/
  manifest.json            # MV3 manifest
  background/
    service-worker.ts      # Message router + price/exchange-rate refresh
  content-scripts/
    steam/                 # Inventory/market/trade-offer/profile overlays
    csfloat/               # CSFloat listing overlay
  pages/
    trade-history.html     # Local-only trade history viewer
  popup/                   # Extension popup
  shared/
    api.ts                 # Auth-only API client (rate-limited, cookie-based)
    config.ts              # Geo-aware origin resolver
    price-engine.ts        # In-memory price cache + multi-currency formatting
    ...
```

## Privacy

- No telemetry, no analytics, no third-party trackers.
- Cookies sent only on requests to `csboard.com` / `csboard.trade` (your CSBOARD session) and `steamcommunity.com` (Steam session).
- Steam access tokens are stored encrypted at rest (AES-GCM with a session key, see [`src/shared/crypto.ts`](src/shared/crypto.ts)).

## License

MIT.
