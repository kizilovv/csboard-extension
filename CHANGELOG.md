# Changelog

## 1.1.6 — Sync reliability hotfix

- Restored manual and hourly portfolio sync when the extension worker starts
  cold by requesting an account-bound credential from an open signed-in Steam
  tab on demand. The credential remains memory-only and is never logged,
  persisted or uploaded.
- Paginated and deduplicated recent Steam trade history, preserved successful
  sources when another source fails, and surfaced partial-history and
  source-specific errors instead of collapsing the whole run into one generic
  sync failure.

## 1.1.5 — Store hotfix

- Restored exact float, paint seed and paint identity metadata for the signed-in
  user's items on Steam trade-offer pages. The extension now reads Steam's
  enriched `rgInventory` item properties and decodes the inspect certificate
  when a direct float property is absent.
- Applied the same validated property parser to inventory and background Steam
  reads, preserving direct metadata when available and safely ignoring malformed
  certificates.

## 1.1.4 — Store release candidate

- Restored hourly portfolio sync in browsers that block third-party Steam
  cookies. Signed-in Steam pages now offer a short-lived credential directly to
  the extension worker; it is exact-origin checked, bound to the paired Steam
  account, kept only in memory, and never logged, stored or uploaded.
- A newly available Steam credential immediately recovers a sync stuck at the
  retry ceiling while a persisted throttle keeps automatic reads at no more
  than once per hour.
- Fixed local Trade History pagination to send Steam's real time/trade cursor,
  honor the API `more` marker and report `total_trades` when available.

## 1.1.0 — local release candidate

- Added one canonical asset-aware CSFloat lookup across Steam and CSFloat
  surfaces, including StatTrak/Souvenir category, wear range, knife/glove float
  ceiling and lowest-price buy-now sorting.
- Added popup settings for currency, price source, CSBOARD preference sync and
  CSBOARD prices on CSFloat, with live repaint and context-16 preservation.
- Hardened Sell, Quick Sell, Instant Sell and capped sequential bulk listing
  with exact own-asset checks, Steam wallet fee math, live reprice, review,
  explicit confirmation, rate-limit stop and Steam Guard result states.
- Added opt-in CSFolder-authorized, HPKE-encrypted device pairing and portfolio
  sync for inventory contexts 2/16 plus up to 100 most recent Steam trades.
  The same consent-gated path supports Sync now and automatic sync about once
  per hour. Enabling Trade History also uploads correlation metadata for
  accepted offers from the last 30 days, including an optional completed trade
  ID and allowlisted Buff163/CSFloat hint. Active trade offers, raw Steam offer
  notes/messages and Steam Market history are not uploaded in 1.1. Five-minute
  codes are hash-only at rest, consumed through a dedicated
  server-to-server HMAC channel, and never expose Steam credentials.
- Scoped inventory identity to app/context/asset, minimized redundant display
  metadata before chunking, and verified a rich 5,000-item snapshot remains
  within 64 encrypted chunks.
- Added the CSBOARD HPKE gateway, signed discovery, replay/idempotency controls,
  CSFolder normalized-fact outbox and non-destructive reconciliation inbox.
- Added CSFloat listing age and sold-time metadata with safe reset behavior for
  reused cards, plus resilient CSBOARD account-avatar initials fallback.
- Added an off-by-default BetterBuff-style Buff163 integration with a single
  popup switch, strict same-origin API allowlist, local listing-age/currency/
  comparison helpers and safe marketplace links. Raw Buff responses are not
  logged, persisted or uploaded; guessed bargain prices and lottery embedding
  from the reference project are intentionally excluded.
- Split P2P listing from execution and added popup eligibility plus separately
  reviewed publish/unpublish with durable backend idempotency. Steam trade,
  purchase, order and settlement execution remain disabled.
- Added unit, interoperability, security and built-artifact capability gates.
- Added deterministic release ZIPs with SHA-256, normalized SPDX SBOM and
  provenance metadata that binds the archive and SBOM digests.

No production deployment, database migration, Web Store upload or real Steam
listing is performed by this local release candidate.
