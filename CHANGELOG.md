# Changelog

## 1.1.20

- The site can ask us to send the trade for one **обмен с доплатой** — a deal
  where the sender gives skins plus cash from their CSBoard balance for one
  specific copy of a skin. The command is the narrowest kind this file allows:
  the page names a DEAL id and nothing else, and the items on BOTH sides, the
  recipient and their trade token are read by the background from CSBoard's own
  record of that deal. A console on the page has nothing to substitute.
- The offer builder now fills both halves of a Steam trade. Until now every
  offer this extension created gave one item and asked for nothing, which is
  right for a paid delivery and useless for a swap. The single-item delivery
  body is unchanged, byte for byte — the P2P path is live and widening a
  working payload builder is not the place to discover a mistake.
- No tab flow for deals. The background POST is the only route: it needs no
  pop-up, no page load and no content script, and every failure it can produce
  is already a sentence the sender can act on. A failed send is retried with one
  click inside the deal's 12-hour window.
- No new permissions, and no new origins. The deal command rides the same
  csboard-only allowlist as delivery and sync; CSFolder cannot reach it.
- Nothing here decides anything about money. Reporting the Steam offer id only
  starts the recipient's clock — the cash settles on CSBoard after Steam's
  7-day hold and only once the skin is observed to have arrived.

## 1.1.19

- Added one-click CSFolder screenshots beside Steam's Inspect in Game action in
  inventories and trade offers, plus direct CSBOARD lookup links.
- Sticker rows in Steam item details now show the selected extension price
  source next to each accessory.

## 1.1.18

- The Market totals panel is readable again. On `/market/` it was inserted into
  Steam's own tab rail — a 30px-tall strip whose tab buttons and "Sell an item"
  button are absolutely positioned on top of it — so the tabs covered the
  listings/fees/proceeds line and the rest of the panel spilled out of the strip
  onto the table of listings below. It now sits under the rail, in normal flow.

## 1.1.17

- A refusal from csboard reaches the seller as itself. The send used to flatten
  every backend refusal into "we could not build the trade, reload the page",
  which is wrong for all of them and dangerous for one: `send_in_progress` means
  the trade IS going out, and reloading to press again is how a second Steam
  offer for the same skin gets created. The backend's own code is carried
  through now, and the site phrases each one.
- The one-time pairing code is gone from the popup. It asked the user to fetch a
  5-minute string from CSFolder and retype it into a browser popup, for a
  handshake the website now completes in one click. The popup points at the
  CSFolder portfolio instead, and unpairing stays where it was.

## 1.1.16

- The site can ask for a tracking pass NOW, so "I confirmed it in Steam Guard"
  stops meaning "wait for an alarm". Confirming an offer in Guard tells us
  nothing on its own: until the next pass the order page still says the item
  needs sending, which is how one sale collected three Guard confirmations in
  half an hour. The new command carries no payload and reports no findings —
  the pass tells csboard what it saw through its usual route, and the page
  re-reads its own order.
- Sending a P2P trade no longer opens a Steam window. The offer is POSTed from
  the service worker, the way CSFloat does it: `sessionid` is read from
  `g_sessionID` on a signed-in Steam page, the login cookies ride on the request
  under host permission we already hold, and the Referer that Steam insists on
  is supplied by a declarative rule, since `fetch` may not set that header. The
  old flow needed a pop-up to survive the browser, a page to finish loading and
  a content script to answer inside twenty seconds; sellers were getting "check
  your pop-up blocker" on offers Steam would have accepted.
- The trade tab remains as a fallback, and only for the two failures a page
  could plausibly fix: a missing Steam session, or a request refused in a way
  the worker could not read. An item that is gone, a partner who cannot receive
  or a trade-banned account are verdicts, and a window teaches the seller
  nothing he was not just told.
- No new user-visible permission. `cookies` would be the obvious way to read
  `sessionid` and is deliberately not taken: Chrome presents it as "read your
  cookies on all sites", which disables the extension for every existing seller
  until they re-approve it.

## 1.1.15

- Portfolio sync no longer aborts when Steam returns an empty, zero or
  out-of-range optional expiration or escrow timestamp. Valid epoch seconds
  are retained; invalid optional metadata is omitted before DTO validation.

## 1.1.14

- Fixed the reason no cancellation was ever confirmed and no trade history was
  ever reported. The P2P pass was reading offers through the PORTFOLIO reader,
  which drops every offer that is not accepted — so pending, cancelled and
  declined offers were invisible to it, and an offer could never be seen to
  die. It now reads the display reader, which returns every offer with its real
  state. Separately, the completed-trade half asked for 200 rows against a
  hard limit of 100 and threw before making a request, every pass since it was
  written, leaving reversal detection blind.
- The cancellation of Steam offers for sales csboard has already closed no
  longer sits downstream of the trade-reporting half in the same try block. Any
  fault in reporting — a Steam history read timing out, say — used to skip
  cancelling entirely, which is backwards: reporting only informs, while
  cancelling is what stops a skin leaving for money that has already gone back.
- The cancellation pass now reports what it did on every run that had work.
  Cancelled-but-Steam-still-lists-it-alive produced complete silence before, so
  a half-closed sale left nothing in the console to find.

## 1.1.13

- The toolbar icon now carries a count of the sales waiting on you, and the
  extension can raise a desktop notification the moment one arrives. Both read
  the same delivery queue your own csboard session returns — sales that need
  you to accept or send, not ones parked in Steam's hold, because a number that
  never falls is a number people stop reading. The notification is announced
  once per order rather than once per poll, and clicking it opens that order.
- New `notifications` permission, for exactly that. It is used nowhere else.
- Sale notifications have their own switch in the settings panel, separate from
  the page overlays: this one leaves the browser and lands on your desktop, so
  it gets its own consent. Turning it off leaves the icon count in place.

## 1.1.12

- A master switch for everything the extension draws on other sites. Off, no
  overlay, float badge or comparison link is added to Steam, CSFloat or Buff;
  the per-site toggles keep their own state underneath, so switching back on
  restores what you had. It deliberately does not touch P2P delivery: sales you
  have already accepted keep being delivered, and a Steam offer for an order
  csboard has closed still gets cancelled.
- Opening an item on CSFloat no longer narrows the comparable search to a
  knife's own float. A knife's price moves with its pattern and its wear band,
  not the third decimal, and the clamp was hiding most of the market. Gloves
  keep it.
- Sales that csboard has closed while their Steam offer was still live are now
  cancelled from your browser, and the cancellation is confirmed by re-reading
  Steam's own state rather than trusting the request that sent it.

## 1.1.6 — Store release

- The CSBOARD website can now ask the extension to refresh the Steam inventory
  snapshot a listing needs, and ask whether that run has finished. Both
  commands are pinned to the exact `csboard.com` / `csboard.trade` origins and
  return no Steam data; an unpaired install, or one with portfolio uploads
  switched off, is refused with a status code rather than being switched on.
  A missing signed-in Steam tab is reported to the site under its own name so
  it can say what to do instead of "sync failed".
- Removed the popup's P2P listing panel. Publishing and unpublishing a lot now
  happen on the website and in the mobile app; the extension keeps the
  inventory sync and the Steam surfaces. The listing API access, its message
  types and its stored review state are gone with it.

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
