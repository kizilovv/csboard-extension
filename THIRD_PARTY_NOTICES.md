# Third-party notices

This project bundles the following runtime libraries under their respective
licenses. Their source and license texts remain available from the linked
upstream packages and the installed package metadata.

- `@hpke/core` and `@hpke/common` — MIT License — RFC 9180 HPKE.
- `@csfloat/cs2-inspect-serializer` and `@protobuf-ts/runtime` — MIT License —
  CS2 inspect serialization and its generated protobuf runtime.
- `csgo-fade-percentage-calculator` — MIT License — fade metadata calculation.
- `buffer`, `base64-js`, `ieee754` and `crc-32` — MIT/ISC-compatible
  licenses — browser data encoding used by bundled runtime modules.

The build copies the exact license text and version for every package present in
the esbuild dependency graph to `third_party_licenses/` inside the extension
artifact. A missing license is a build failure.

The Quick Sell, Instant Sell and bulk-review behavior is a clean-room product
implementation based on observable workflow requirements and public Steam
interfaces. No GPL-licensed CS2Trader source code is copied into this MIT
artifact. Re-review provenance before accepting future upstream patches.

The CSFloat listing-age and sold-time UX is a behaviorally compatible,
independent implementation informed by the public BetterFloat product and API
field contract. BetterFloat is © 2024 Rums and its repository is licensed
CC BY-NC-SA 4.0. No BetterFloat source file, artwork, or executable module is
bundled into this artifact; the implementation here uses its own DTO, time
formatter, DOM lifecycle/reset logic, styles, and tests. Re-review provenance
before accepting any direct upstream code.

The Buff163 enhancement UX is an independent, behavior-compatible
implementation informed by the public
[`GODrums/BetterBuff`](https://github.com/GODrums/BetterBuff) repository at
commit `49b731fe58b62d8c3b0771f4c8ca727e7bc4e17d`. Its package metadata declares
MIT, but that checkout does not contain a standalone license-text file. To keep
provenance unambiguous, no BetterBuff source module, Svelte component, icon,
pattern database, generated schema or executable artifact is bundled here.
CSBOARD uses its own typed event boundary, DOM implementation, styles and
tests. Re-review license provenance before accepting direct upstream code or
assets in the future.
