# CSBOARD Extension — Privacy Policy

**Last updated:** May 2, 2026
**Effective for:** CSBOARD browser extension v1.0.0 and later

This privacy policy describes the data handling practices of the CSBOARD browser extension only. The CSBOARD website ([csboard.com](https://csboard.com)) is governed by a [separate privacy policy](https://csboard.com/en/privacy).

## TL;DR

- The extension is **read-only**. It does not modify your Steam account, inventory, listings, or trades.
- The extension does **not collect any personal data** about you.
- The extension does **not transmit your browsing activity, item data, or trade history** to any server.
- The extension makes outbound network requests to **only three domains**: csboard.com (price database), Steam, and CSFloat (their own APIs that the extension reads passively).
- The extension is **open source** under the MIT license: <https://github.com/kizilovv/csboard-extension>.

## What the extension reads locally

To render price overlays, the extension's content scripts and service worker read the following information **locally on your device**:

| Data | Where | Why | Sent anywhere? |
|---|---|---|---|
| Item market hash names | DOM of Steam / CSFloat pages you visit | Look up the item's price in the local cache | **No** |
| Item float values, paint seeds, sticker info | DOM / page-context API responses on Steam / CSFloat | Render float % / pattern indicators | **No** |
| Steam inventory contents (your own + trade partner's) | Steam Community DOM and JSON endpoints you already loaded | Compute trade-offer total values | **No** |
| Your CSBOARD session cookie (if present) | `csboard.com` / `csboard.trade` cookie store, via `chrome.cookies.get` | Inherit your saved currency and preferred price source | **No** |
| URLs of pages you visit on Steam / CSFloat | Content-script execution context (the script runs only on these matched URLs) | Determine which overlay variant to inject | **No** |

None of this information is logged, persisted to any remote server, or shared with any third party.

## What the extension fetches over the network

The extension makes outbound network requests to these endpoints only:

| Endpoint | Purpose | Frequency |
|---|---|---|
| `GET https://csboard.com/api/extension/prices` (with ETag) | Cached multi-marketplace price dump (~24,000 items as static JSON) | Every 5 minutes via `chrome.alarms` |
| `GET https://csboard.com/api/extension/exchange-rates` | Currency conversion rates | On demand |
| `GET https://csboard.com/api/auth/me` | Cookie-based check of your saved currency / price source preferences (only fires if a CSBOARD cookie is present) | On install + on demand |
| `POST https://csboard.com/api/auth/logout` | Clear session cookie (only fires if you click the logout button in the extension popup) | User-initiated |
| `GET https://csfloat.com/api/v1/meta/exchange-rates` | CSFloat's own currency conversion rates, for live currency switching on CSFloat | On demand |
| Standard Steam Web API endpoints already used by the page itself (e.g., inventory JSON, trade history) | Resolve item metadata when the page does not expose it | On demand, scoped to the page you are viewing |

These are all `GET` requests for public, non-personal data, except `/api/auth/me` and `/api/auth/logout`, which include only the standard CSBOARD session cookie.

The extension does **not** send: your Steam ID, your trade history, the contents of your inventory, your trade URL, your float values, your visited URLs, your IP, or any data identifying you personally.

## Data we do not collect

The extension does **not** collect any of the following:

- Personally identifiable information (name, email, address, age, government ID)
- Health information
- Financial or payment information
- Authentication credentials, passwords, or security questions
- Personal communications (email, chat, messages)
- Location data (GPS, region, precise IP-derived location)
- Web browsing history beyond Steam and CSFloat pages necessary for the overlay
- User activity data (clicks, keystrokes, scrolling)
- Website content beyond what is needed to render an item price overlay

## Permissions used and why

| Permission | Why it is required |
|---|---|
| `storage`, `unlimitedStorage` | Cache the ~4MB price database locally so the overlay renders instantly |
| `alarms` | Schedule the 5-minute background refresh of the price database (`setTimeout` is unreliable in Manifest V3 service workers) |
| `cookies` | Read your existing CSBOARD session cookie (csboard.com / csboard.trade only) to inherit your saved currency / price-source preferences. Cookies from no other domain are read |
| `notifications` | **Disabled by default.** Optional opt-in price-drop alerts for items you explicitly add to a watchlist |
| `declarativeNetRequestWithHostAccess` | Adjust response headers on steamcommunity.com so the content script's overlay can be injected past Steam's strict Content-Security-Policy. Scoped to steamcommunity.com only |
| `host_permissions` (steamcommunity.com, store.steampowered.com, api.steampowered.com, csfloat.com, csboard.com, csboard.trade) | Inject the overlay on Steam Community / CSFloat pages and fetch the cached price database from CSBOARD. No other origins are accessed |

## No remote code

All JavaScript and WebAssembly that runs as part of the extension is bundled inside the extension package at build time. The extension does not load remote scripts via `<script src>`, `import()`, `eval()`, `new Function()`, or any equivalent mechanism. Network requests fetch only static JSON data, which is parsed and used as plain values.

## Third-party services

The extension does not embed third-party analytics, tracking pixels, advertising SDKs, or fingerprinting libraries.

## Children's privacy

The extension does not knowingly collect any data from anyone, including children. If you are under the age of 13 (or the equivalent minimum age in your jurisdiction), please consult a parent or guardian before using software that interacts with the Steam marketplace.

## Changes to this policy

If this policy changes, we will publish the updated version at the same URL and bump the "Last updated" date at the top. Material changes will also be noted in the extension's GitHub release notes.

## Contact

Questions, concerns, or data requests:

- Open an issue: <https://github.com/kizilovv/csboard-extension/issues>
- Email the maintainer: see the contact details on <https://csboard.com>

## Open source

The full source code, build scripts, and release artifacts are public:

<https://github.com/kizilovv/csboard-extension>

You can audit exactly what the extension does at any time.
