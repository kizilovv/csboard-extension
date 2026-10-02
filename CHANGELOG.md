# Changelog

## 1.1.28

- A Steam tab left open for more than a day no longer breaks the extension.
  Steam's token lives 24 hours and a page keeps the one it loaded with, so an
  old tab kept handing over a dead token and every Steam read failed with 403
  until the tab was reloaded: sales stopped updating and a payout waited on a
  check that could not run, with the browser open and signed in. The extension
  now reads the token's own expiry, never accepts an expired one, prefers the
  Steam tab with the freshest token, and an old tab fetches a current token
  from Steam by itself.
- A token Steam has refused is not accepted again from a page.
- A failed read of the offers list no longer stops the trade-history check,
  which is the one a payout waits on after Steam's seven-day protection ends.

## 1.1.27

- Warns a seller about the incoming-trade scam. In September five P2P sellers
  accepted an incoming offer from a farm account that asked for the skin they
  had just sold on CSBoard, taking it for the delivery. CSBoard never sends a
  seller an offer; he always sends it. When an incoming offer asks for a skin
  of a live CSBoard sale and does not come from that sale's buyer, the offer
  page gets a red block and Accept needs a second click; the offers list marks
  the offer. Nothing shows when the seller comes out ahead in value, and there
  is no system notification.
- Warns about the Steam API-key scam on a buyout. When an incoming offer asks
  for a skin of a live CSBoard buyout and is neither the vendor's offer nor
  from the vendor's bot, the same block appears with advice to revoke the API
  key.
- An offer missing from Steam's list is no longer confirmed to CSBoard as
  cancelled. Its real state is read on its own first; an accepted offer is
  never reported as a cancellation.

## 1.1.26

- The extension now says when this browser has no Steam login. The tracking
  pass used to return on it with a log line and nothing else: no heartbeat
  reached csboard, the site said selling was unavailable, and the seller's own
  screen showed an installed, enabled extension. That was the whole of a
  support case on 2026-09-25. The pass now records `ok` / `missing`, and three
  places read it: an amber "!" on the toolbar icon with "Log into Steam in this
  browser" as its tooltip, a banner at the top of the popup with a button to
  Steam's login page, and a `steamSession` word on the `GET_EXTENSION_STATUS`
  answer so csboard can say the same thing from the extension's own finding.
- A sale still wins the icon. The "!" shows only while there is no sale to
  count; with both, the count stays on the badge and the tooltip carries the
  login hint. When the login comes back the last count is put back without a
  round trip to csboard.
- Only a real sign-out is a warning. Steam not answering (offline, maintenance)
  leaves the last verdict standing, and `unknown` (never checked) shows
  nothing, so a fresh install is not greeted with an alarm before it has
  looked. It looks right away: the install-time catch-up pass is the first check.
- The warning clears itself. While it stands, the popup re-checks on open and a
  signed-in steamcommunity.com page re-checks when it loads; finding the login
  back runs the tracking pass at once, which is what tells csboard.
- A pass without a Steam login still reports to csboard. The heartbeat
  (`POST /p2p/ext/status`) goes out either way and now carries
  `steamSession: 'ok' | 'missing'`; everything that reads Steam is skipped when
  it is missing. The call is what pairs the device, so a seller who installs
  the extension is paired before he logs into Steam, and the site can say
  "log into Steam in this browser" instead of "no client". Needs the backend
  that reads the field: an older one would count such a device as able to
  send. Not sent when csboard says nobody is signed in to it here.
- The pass looks for the login through an open steamcommunity.com tab first.
  It names the csboard account (`/auth/me`) so the page-credential bridge can
  lend a signed-in tab's token; with third-party cookies blocked the worker's
  own read of Steam sees a signed-out page, and the pass used to stop there.
  A Steam login for another account falls back to the unnamed read, as before.
  No new permissions.
- The tracking pass reads Steam offers without the description table. It read
  GetTradeOffers twice per pass (tracking, then cancellations), both times
  with every item's names, icons and tags, and used none of them; CSFloat's
  tracker does not ask for them either. Less to download, less for Steam to
  refuse. The trade-offers page overlays still get them.
- A failed Steam read says why. The heartbeat's `errors.offers` /
  `errors.history` used to be "GatewayPayloadError: INVALID_PAYLOAD" for
  every failure alike; they now carry the reason and HTTP status, e.g.
  `(reason=steam-read-failed, status=429)`. csboard only calls the extension
  blind when that keeps happening, not on one such pass.

## 1.1.25

- Trade tracking now tells csboard WHEN, not only what. Status reports of an
  accepted offer carry Steam's `time_updated` and history reports carry
  `time_init`, so a browser reopened hours after the buyer accepted still dates
  the delivery from the trade itself. On 2026-09-12 a sale was closed for
  "offer never confirmed" while the skin had been with the buyer for two hours,
  because the only clock csboard had was the moment it finally heard.
- Offers sent outside csboard are recognised. The tracker reads the send queue
  as well as the watch list, and an Active, Accepted or Guard-pending offer that
  hands the sale's asset to the sale's buyer is annotated against that sale,
  the way the Send button would have — the same post-hoc annotation csfloat's
  extension does. A seller who sends from Steam on his phone no longer runs a
  two-hour clock against a delivery that already happened.
- Purchases are watched too. The tracker reads the buyer's own trade history
  for every purchase in flight and reports the row that shows the skin arrived,
  by the id the seller held it under. When the seller's browser is closed —
  the ordinary way a delivered sale went silent — the buyer's browser is now
  the witness, as it is with csfloat's extension.
- A heartbeat after every tracking pass: version, whether the Steam token is
  usable, host permissions, what is being watched and where the last pass
  failed, filed to `/p2p/ext/status`. csboard used to know only that the
  extension had called; now it knows whether the call could see anything.

## 1.1.24

- A failed send now tells the backend why. `classifySteamError` folds every
  refusal it does not recognise into `STEAM_REFUSED` and keeps Steam's own
  wording in `detail` — and that wording died in the browser. On 2026-09-09 a
  seller reported five of ten cases would not send; the only party that had ever
  seen Steam's reason was his browser, so answering "why" meant reading code and
  guessing. It posts to `/p2p/ext/send-failed`, fire-and-forget, because a note
  about a failure must never turn one failure into two.

## 1.1.23

- Everything one buyer takes from one seller now goes in a SINGLE trade offer.
  Each lot is its own order, and every order used to become its own Steam offer:
  a buyer who took ten Fracture Cases produced ten offers, ten Guard
  confirmations, and a seller reporting on 2026-09-09 that he had sent five and
  the rest would not go at all. The pieces to do better were already here —
  `postTradeOffer` has always accepted a list of assets and was simply handed a
  list of one.

  The backend decides the grouping, not the extension: it returns every order
  that shares the seller, the buyer and the exact trade URL, each one locked so
  two clicks cannot produce two offers for the same asset. Same buyer is not the
  same destination — an order from an outside marketplace carries its own trade
  URL and the token can rotate between purchases — so a sibling whose URL
  differs is left for its own send.

  Reporting follows the offer: one call to `annotate-trade-batch` covers every
  order in it, and the backend answers per order rather than as a unit. By the
  time anything is reported the items have already left the inventory, so
  refusing the whole report because one order went sideways would leave the rest
  unannotated and heading for a no-send penalty on goods that were delivered.

  Both ends stay compatible in both directions: an older backend sends no batch
  and this extension sends the single order exactly as before, and an older
  extension ignores the new field.

## 1.1.22

- The trade offers list shows the other side's float, not only ours. Steam
  serves `asset_properties` — wear rating, pattern seed, item certificate —
  from the ordinary public inventory endpoint for any profile, with no access
  token and no trade session; the offers API is simply the one source that
  never carries them, which is what made this look impossible. A partner is
  read once one of their offers comes within a screen of the viewport, three
  reads at a time, and every asset id learned that way is cached, because a
  float never changes.
- Those reads no longer wait on anything. Steam's own trade-offers API answers
  in 1.5-4 seconds, and queueing partner reads behind it made that delay the
  floor for every float on the page; the partner's account id is in each
  offer's avatar, which is all a read needs.
- New **View in 3D** in a trade slot's action menu, above Get screenshot. It
  opens over the page rather than in a tab. Steam sends a `frame-src` allowlist
  with every community page and no third-party viewer is on it, so the modal
  frames an extension page, which frames the viewer — a direct frame renders a
  blank box and reports nothing.
- A failed enrichment says why. `Failed to enrich our items [object Object]`
  was our own bug: the cause was passed as log data, one level below the text a
  user can screenshot.

## 1.1.21

- The popup speaks Russian, and picks the language itself. Detection follows the
  browser's own UI language, then its accept-language list, and a picker in the
  header pins English or Russian when the browser's answer is the wrong one — a
  Russian trader running an English Chrome is the common case here, not the
  exception. Chrome's native `_locales` was not used precisely because it offers
  no such override. Only the popup is translated; the overlays drawn on Steam,
  CSFloat and Buff are still English.
- The master on/off switch became three per-site switches: Steam, CSFloat,
  Buff163. A profile that had the master OFF comes out of migration 4 muted on
  all three — the popup no longer draws a control that could undo it, so that
  intent has to be carried over rather than reset.
- The settings panel lost roughly half its words. The account paragraph that
  restated the connection pill, four per-toggle descriptions, the "records"
  suffix on every count and the standalone price-cache card are gone; the
  CSFolder data disclosure keeps every fact it stated, in a collapsed block
  directly above the upload switch it belongs to.

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
