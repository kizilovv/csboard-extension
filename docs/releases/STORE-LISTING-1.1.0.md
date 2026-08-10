# Chrome Web Store listing packet — CSBOARD 1.1.0

Date: 2026-08-10

This file is the copy source for the first Chrome Web Store submission. Keep
the Dashboard answers, the published extension privacy policy and runtime
behavior identical. Chrome's August 2026 policy requires every collection to be
prominently disclosed, even when it supports the extension's single purpose.

Official references:

- <https://developer.chrome.com/docs/webstore/cws-dashboard-listing>
- <https://developer.chrome.com/docs/webstore/cws-dashboard-privacy>
- <https://developer.chrome.com/docs/webstore/cws-dashboard-distribution>
- <https://developer.chrome.com/docs/webstore/program-policies/user-data-faq>
- <https://developer.chrome.com/blog/cws-policy-updates-2026>

## Manifest metadata

- Name: `CSBoard - Tool For CS2 Trading`
- Version: `1.1.0`
- Short description: `CS2 price comparison, user-confirmed Steam Market tools, and opt-in encrypted portfolio sync.`
- Default language: English
- Recommended primary category: Shopping
- Homepage: <https://csboard.com>
- Support: <https://github.com/kizilovv/csboard-extension/issues>
- Privacy policy after this branch reaches `main`:
  <https://github.com/kizilovv/csboard-extension/blob/main/PRIVACY.md>

Do not use the general CSBOARD website privacy URL as the extension policy.
The Dashboard URL must resolve publicly to the extension-specific policy in
`PRIVACY.md` before submission.

## Single purpose

Help users evaluate, manage and track CS2 items across the supported Steam,
CSFloat, Buff163 and CSBOARD trading surfaces.

Every shipped feature must remain inside that narrow CS2-item-trading purpose:
price comparison, item metadata, user-confirmed Steam actions, trade views and
optional portfolio synchronization.

## Detailed description

CSBOARD adds practical CS2 item information and trading controls to the pages
where you already work.

Features:

- Compare current prices on supported Steam inventory, market and trade pages.
- Open exact CSFloat searches using item wear, paint and pattern information.
- Review seller proceeds, buyer total and Steam fees before a Market listing.
- Use optional Buff163 page helpers for listing age, currency conversion and
  price comparison. Buff helpers are off by default.
- View recent Steam trades with current reference prices. Reference prices are
  not presented as historical cost basis or realized profit.
- Optionally pair with CSFolder and synchronize your current CS2 inventory
  (contexts 2 and 16) plus up to 100 most recent Steam trades through the
  encrypted CSBOARD gateway.

Portfolio uploads are off by default. Pairing does not enable them. After you
enable uploads and a source, you can sync immediately and automatic sync is
scheduled about once per hour. When Trade History is enabled, accepted offers
from the last 30 days provide correlation metadata, including an optional
completed trade ID and allowlisted Buff163/CSFloat marketplace hint. Active
trade offers and raw Steam offer notes/messages are not uploaded. Version 1.1
does not upload Steam Market history.

Steam cookies, session/access tokens, passwords, Steam Guard secrets and raw
authenticated pages are never uploaded. Steam Market or trade-page actions run
directly against Steam only after a user action; CSBOARD cannot trigger them.
The extension contains no ads, third-party trackers or remote executable code.

## Permission justifications

### `storage`

Stores user settings, public price/rate caches, sanitized sync status, bounded
encrypted outbox metadata and session-only Steam read state needed by visible
features. Portfolio upload consent remains off by default and is persisted so
an update cannot silently enable it.

### `unlimitedStorage`

The local public price catalog contains more than 24,000 item records. The
permission prevents cache eviction from breaking price overlays and also gives
large inventories a bounded local encrypted outbox during a temporary gateway
failure. It is not used for page dumps, browsing history or analytics.

### `alarms`

Schedules public price/rate refreshes, bounded encrypted-outbox retries and,
only after explicit portfolio opt-in, automatic portfolio sync about once per
hour. The same consent and source checks protect manual and automatic sync.

### `steamcommunity.com`

Runs the disclosed UI on Steam inventory, market, trade, history and profile
pages; reads normalized CS2 item facts; and submits only user-confirmed Steam
actions directly to Steam.

### `api.steampowered.com`

Performs fixed Steam Economy reads for the user's own inventory/trade features.
Read credentials remain session-only and are never returned to page scripts or
uploaded to CSBOARD.

### `csboard.com` and `csboard.trade`

Fetches public prices/rates, optionally follows the signed-in user's CSBOARD
price preferences, performs encrypted device pairing/portfolio ingestion, and
submits separately reviewed CSBOARD P2P publish/unpublish actions. External
website messaging exposes only version/capability status.

### `csfloat.com`

Adds the disclosed CSBOARD price comparison and exact item lookup metadata to
CSFloat pages. It does not upload the user's CSFloat authentication data.

### `buff.163.com` and HTTPS subdomains

Provides the off-by-default Buff163 display helpers through a declared content
script. The host permission is required in 1.1 so that shipped feature can run
on Buff after the user enables it; changing to programmatic injection during
Store preparation would add avoidable regression risk. The content script
starts inert, and the strict same-origin allowlist reads only the marketplace
responses needed to decorate the current page after opt-in. Raw Buff responses
remain local and are not uploaded.

## Remote code

Select: **No, I am not using remote code.**

All executable JavaScript and cryptographic code is bundled in the Manifest V3
artifact. Remote responses are validated data and are not evaluated as code.

## Privacy practices — data types

Use the conservative declarations below because Chrome treats locally handled
data as user data too. Re-check the exact checkbox labels shown by the current
Dashboard.

### Select

- Personally identifiable information: SteamID64/account identifiers are used
  to bind the active Steam account and counterparties to inventory/trade facts.
- Authentication information: a fixed-operation Steam read provider handles a
  session credential locally. Credentials are session-only and never uploaded.
- Financial and payment information: the extension handles marketplace prices,
  wallet currency and user-entered listing prices to show totals and execute a
  confirmed listing. Portfolio sync does not upload derived prices or a guessed
  cost basis.
- Website content: supported page/item facts such as asset identity, market
  name, wear, paint, stickers, holds, prices and trade item identities are read
  to render the requested feature. Only the separately opted-in portfolio
  subset is uploaded.
- Personal communications: for accepted offers from the last 30 days, an offer
  note may be inspected in memory only to derive an allowlisted Buff163/CSFloat
  hint. Raw Steam offer notes/messages are not logged, stored or uploaded.

### Do not select unless Dashboard wording changes or runtime changes

- Health information
- Location
- Web history
- User activity / behavioral tracking

The extension does not collect arbitrary browsing history, clicks, keystrokes,
scrolling, unrelated messages or location. The only message-like content it
handles is the bounded accepted-offer note processing disclosed above; the raw
note remains in memory only and is discarded. Merely running a declared content
script on a supported page must not be represented as analytics.

## Limited Use certification

Certify only while the following remain true:

- Data is used only to provide or improve the disclosed CS2 trading purpose.
- Data is not sold or transferred except as necessary to provide the feature,
  protect against abuse, comply with law, or complete a developer transaction
  after the user's prior consent.
- Data is not used for personalized advertising, unrelated profiling,
  creditworthiness or lending.
- Humans do not read individual user data except with explicit support consent,
  for security, or as required by law.

The matching affirmative statement is in `PRIVACY.md` under
`Chrome Web Store Limited Use`.

## Prominent consent flow for portfolio upload

The popup must show the open `Data and automatic sync` disclosure before the
portfolio master switch. Pairing keeps the switch and both visible sources off.
Upload begins only after the user separately enables the master switch and at
least one source. The disclosure names both visible sources, the 100-trade
bound, the accepted-offer enrichment that follows Trade History, its raw-note
exclusion and the hourly automatic schedule.

## Reviewer test instructions

Do not place real Steam, CSBOARD or Steam Guard credentials in source control.
Paste the following into the optional Dashboard test-instructions field:

> Public price overlays and item links can be reviewed on supported public
> Steam Market and CSFloat pages without special credentials. Own-inventory,
> recent-trade, selling and CSFolder sync features require the reviewer to use
> their own logged-in Steam/CSBOARD/CSFolder sessions. Open the extension popup
> to see that portfolio pairing, the upload master switch and both sources are
> off by default. Pairing alone keeps uploads off. The open disclosure explains
> the inventory/trade fields, accepted-offer correlation, raw-note exclusion and
> hourly automatic schedule before consent.
> Steam credentials are never entered into the extension or sent to CSBOARD.

If CWS requests a dedicated test account, create and provide it only through
the private Dashboard field. Never provide a Steam Guard shared/identity secret.

## Distribution for the first canary

- Visibility: `Private`
- Add the owner's Google Account as a trusted tester.
- Add only specific test regions if required; otherwise use all regions.
- Private items still receive the same policy review as public items.
- After the Store assigns the permanent extension ID, add that exact ID to the
  CSBOARD production extension allowlist before the Store-installed canary.
- Publish publicly only after Store-installed pairing, inventory/trade sync,
  prices, trade views and user-confirmed Steam actions pass.

## Graphic assets and Dashboard fields still requiring owner input

- Verify publisher identity and website ownership for `csboard.com`.
- Choose the public publisher display name.
- Upload at least one 1280x800 screenshot (up to five). Recommended set:
  Steam price overlay, exact CSFloat lookup, Steam listing review, open
  portfolio consent/pairing UI, and opt-in Buff helper.
- Upload the 128x128 Store icon from the artifact.
- Prepare the 440x280 small promo tile. A 1400x560 marquee tile is optional.
- Optionally provide a non-private YouTube demo URL.
- Confirm primary category, default locale, mature-content answer and regions.
- Enter homepage, support and extension-specific privacy URLs.
- Select the data-type checkboxes and all truthful Limited Use certifications.
- Enter reviewer instructions if the Dashboard requests authenticated coverage.
- Record the newly assigned extension ID and add it to the backend allowlist.
- Select `Private`, add trusted testers, submit for review, and retain the exact
  uploaded ZIP, SHA-256, SBOM and provenance as the first rollback baseline.

## Pre-upload blockers

1. Publish the updated extension privacy policy at the Dashboard URL.
2. Generate a fresh Store ZIP from a clean committed tree; do not upload the
   older artifact in `artifacts/releases/`.
3. Obtain the Store item ID and add it to the production allowlist before the
   Store-installed end-to-end canary.
