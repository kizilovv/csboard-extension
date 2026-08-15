# CSBOARD Extension

CS2 trading helper for Steam Community, CSFloat and Buff163. Version 1.1 combines price overlays, exact CSFloat lookups, opt-in Buff marketplace helpers, user-confirmed Steam Market listing tools, and optional encrypted portfolio synchronization.

- Homepage: <https://csboard.com>
- Privacy policy: [PRIVACY.md](PRIVACY.md)
- Terms: <https://csboard.com/en/terms>
- License: [MIT](LICENSE)

## Features

- Multi-source prices on Steam inventory, market, trade-offer, history and profile surfaces.
- One asset-aware CSFloat lookup builder with StatTrak/Souvenir category, wear, float, paint and lowest-price filters.
- Popup settings for currency, price source, CSBOARD-settings sync and the CSBOARD comparison on CSFloat.
- Opt-in BetterBuff-style helpers on Buff163: listing age, selected-currency display, explicit live-price comparisons and safe item/search links. The Buff surface is off by default and never uploads Buff responses.
- Steam `Sell`, `Quick Sell`, `Instant Sell` and sequential bulk review. Every write is initiated and confirmed by the user and goes directly to Steam.
- Optional CSFolder-authorized portfolio pairing and synchronization of normalized own-inventory contexts `2` and `16` plus up to 100 most recent Steam trades. When Trade History is enabled, accepted offers from the last 30 days add correlation metadata: an optional completed trade ID and allowlisted Buff163/CSFloat marketplace hint. Active trade offers and raw Steam offer notes/messages are not uploaded, and Steam Market history remains unavailable. Uploads and both visible sources are off by default; after explicit opt-in the same safe path supports Sync now and automatic sync about once per hour.
- P2P eligibility plus reviewed publish/unpublish for the user's CSBOARD listing. Version 1.1 has no P2P buy/order/settlement capability and does not let CSBOARD or a website create, accept or confirm a Steam trade.

## Security boundary

- `onMessageExternal` exposes a bounded `GET_EXTENSION_STATUS` response to the two exact CSBOARD origins and one exact-schema `PAIR_AND_ENABLE_PORTFOLIO_SYNC` action to `https://csfolder.com`. That action accepts only a single-use CSFolder code, enables exactly Inventory + Trade History and triggers the existing fenced sync path; it cannot unpair, select arbitrary sources, sell, trade or expose Steam credentials.
- Steam cookies, `sessionid`, access/session tokens, passwords and Steam Guard/shared/identity secrets never leave the browser and never enter the sync outbox.
- A narrow internal read-session provider can add a session-only Steam credential only to fixed read operations. Callers never receive the credential.
- Version 1.1.4 restores hourly sync with third-party cookies blocked: an exact-origin Steam content script offers the page's short-lived credential to the worker, where it is account-bound, memory-only and never logged, stored locally or uploaded.
- Opt-in portfolio chunks are validated and scanned, then encrypted before `fetch()` with the versioned CSBOARD HPKE gateway protocol and signed by a non-extractable per-install device key.
- Before chunking, redundant localized inventory `name` and per-asset Steam CDN `iconUrl` fields are omitted. Canonical market name, composite app/context/asset identity and all ownership, hold, wear, paint and sticker facts needed for reconciliation/P2P remain intact; this keeps a metadata-rich 5,000-item snapshot inside the fixed 64-chunk contract.
- The backend re-checks signatures, time windows, replay/idempotency and the same secret denylist after decrypt. Missing production key configuration fails closed; there is no plaintext fallback.
- All extension executable code is bundled in the Manifest V3 artifact. No remote JavaScript or WebAssembly is loaded.

## Network destinations

| Destination | Purpose |
|---|---|
| CSBOARD `/api/extension/*` | Public price/rate feeds and extension health |
| CSBOARD `/api/auth/*` | Optional cookie-authenticated user/settings and logout |
| CSBOARD `/api/extension/v2/*` | Opt-in encrypted pairing confirmation, device status/revoke and normalized portfolio ingestion |
| CSBOARD `/api/p2p/*` | Cookie-authenticated eligibility and separately reviewed listing publish/unpublish only |
| Steam Community / Web API | Page overlays, fixed authenticated reads and direct user-confirmed market actions |
| CSFloat | The visited marketplace page, its public metadata, and exact search links |
| Buff163 | Opt-in local enhancement of the visited Buff page and its same-origin marketplace responses |

The pairing code is generated in the user's authenticated CSFolder portfolio,
not by CSBOARD. The extension has no CSFolder host permission and does not call
the CSFolder consume API. After the user's explicit connect click, that exact
origin may send only the bounded code/request message to the installed extension.
The extension places the code only inside the HPKE-encrypted `pair/confirm`
envelope; CSBOARD then validates
the one-time assertion through a dedicated TLS + HMAC server-to-server call to
CSFolder and durably binds the returned SteamID64. There is no CSBOARD
`/pair/create` route.

Steam Market writes are never proxied through CSBOARD. Portfolio uploads use
`credentials: omit` after device pairing and are accepted only by the dedicated
protected gateway.

## Build and verification

```bash
npm install
npm run typecheck
npm test
npm run build
npm run audit:capabilities
npm run test:artifact
```

Output is `build/`, which can be loaded as an unpacked Chrome extension. A Store candidate additionally requires pinned production gateway configuration:

```bash
CSBOARD_EXTENSION_BUILD_PROFILE=store \
CSBOARD_GATEWAY_HOSTS=https://csboard.com,https://csboard.trade \
CSBOARD_GATEWAY_ROOT_JWK='{"kty":"EC","crv":"P-256","kid":"…","x":"…","y":"…"}' \
npm run build:store
npm run package:store
```

`package:store` re-runs the packaged capability tests, requires a clean commit,
and writes a deterministic Store zip, SHA-256 file, normalized SPDX SBOM,
SBOM SHA-256 and provenance JSON under `artifacts/releases/`. The provenance
binds the archive, source commit, build profile and SBOM digest. The build
variable contains only the public discovery root; HPKE and discovery private
keys remain backend-only.

Without the owner-provided public root, build the explicit local preflight:

```bash
npm run build
npm run package:preflight
```

That deterministic archive contains `UNCONFIGURED-NOT-FOR-WEB-STORE.txt`.
Lookup, settings and local Steam UI can be reviewed unpacked, while protected
portfolio sync fails closed. The repository does not contain production private
keys. Store upload, production migrations and deployment are separate
owner-approved actions.

## Layout

```text
src/
  background/       internal router, Steam read provider, collector, HPKE gateway/outbox
  content-scripts/  Steam, CSFloat and opt-in Buff163 UI
  popup/            settings, pairing and manual-sync UI
  shared/           schemas, pricing, lookup and normalized contracts
scripts/            release/config/capability gates
test/               source-level unit and contract tests
test-artifact/      black-box tests against the real bundled service worker
```

See [CHANGELOG.md](CHANGELOG.md) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for release notes and
dependency notices.

## Privacy

There is no advertising, behavioral analytics or remote telemetry by default. Portfolio synchronization is disabled until the user pairs and explicitly enables it. Inventory and Trade History are the only visible source choices; accepted-offer correlation follows Trade History. See [PRIVACY.md](PRIVACY.md) for the exact collected fields and exclusions.
