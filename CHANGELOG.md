# Changelog

## 1.1.0 — local release candidate

- Added one canonical asset-aware CSFloat lookup across Steam and CSFloat
  surfaces, including StatTrak/Souvenir category, wear range, knife/glove float
  ceiling and lowest-price buy-now sorting.
- Added popup settings for currency, price source, CSBOARD preference sync and
  CSBOARD prices on CSFloat, with live repaint and context-16 preservation.
- Hardened Sell, Quick Sell, Instant Sell and capped sequential bulk listing
  with exact own-asset checks, Steam wallet fee math, live reprice, review,
  explicit confirmation, rate-limit stop and Steam Guard result states.
- Added opt-in CSFolder-authorized, HPKE-encrypted device pairing and manual
  portfolio sync for inventory contexts 2/16, trade offers and trade history.
  Five-minute codes are hash-only at rest, consumed through a dedicated
  server-to-server HMAC channel, and never expose Steam credentials.
- Scoped inventory identity to app/context/asset, minimized redundant display
  metadata before chunking, and verified a rich 5,000-item snapshot remains
  within 64 encrypted chunks. Trade-offer reads keep the newest 1,000
  deterministically and show a non-fatal truncation warning when needed.
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
