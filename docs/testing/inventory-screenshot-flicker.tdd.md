# Inventory screenshot action — TDD evidence

## Source and journey

No plan file was supplied. The journey was derived from the reported Steam
inventory behavior: when a user opens an item, `Get screenshot` must stay
visible beside Steam's `Inspect in Game` action and must not flicker in the
volatile lookup block while Steam rerenders the detail panel. The BUFF,
CSFloat, and CSBOARD lookups must remain in their original top metadata area
and stay clickable inside Steam's React-rendered detail panel. They must use
the real marketplace marks and appear exactly once even when Steam exposes two
temporary matching anchor rows.

The final implementation reference is the installed, known-working CSBOARD
1.1.18 bundle. Its inventory actions are ordinary light-DOM anchors inserted
immediately after the CS2 game row. User smoke evidence showed the exact
1.1.18 labels (`Buff`, `CSFloat`, `CSBOARD`) alternating with the 1.1.19 labels
(`Lookup on ...`). Both enabled builds used `.csboard-lookup-inline`, and both
MutationObservers removed that class. The shared DOM ownership caused a live
anchor to disappear between pointer down and click. The earlier CSFloat-style
Shadow DOM attempt did not solve that cross-version ownership race.

## RED / GREEN report

| Behavior | Test | RED evidence | GREEN evidence |
|---|---|---|---|
| Repeated observer passes reuse one screenshot button immediately after `Inspect in Game` | `test/inspect-actions.test.ts` — `keeps one screenshot button immediately after Inspect in Game across rerenders` | `upsertCsfolderScreenshotAction is not a function` | Focused test target: 6/6 PASS |
| The top BUFF/CSFloat/CSBOARD block never owns `Get screenshot` | `test/inspect-actions.test.ts` — `inventory keeps screenshot out of the volatile top lookup block` | Source fragment still contained `Get screenshot` | Focused test target: 6/6 PASS |
| The generated CSFolder URL is never rediscovered as a native Steam inspect link | Same inventory wiring test | Native selector accepted any URL containing `csgo_econ_action_preview` | Selector is pinned to `steam://`; focused test target: 6/6 PASS |
| BUFF, CSFloat, and CSBOARD stay clickable while store 1.1.18 and unpacked 1.1.19 are both enabled | `test/inspect-actions.test.ts` — `inventory lookup actions survive a simultaneously enabled 1.1.18 content script` | 1.1.19 reused `.csboard-lookup-inline`, deleted/rebuilt its own action row, and the focused test failed on the missing isolated class | 1.1.19 owns `.csboard-marketplace-actions-v119`, updates links in place, hides/removes only the 1.1.18 legacy row, and renders three accessible 36×36 logo-only links; focused test and browser interaction QA pass |
| Logo-only actions use the original marketplace image assets, not homemade glyphs | `test/marketplace-brand-icons.test.ts` — `marketplace actions embed the exact real BUFF, CSFloat, and CSBOARD PNG assets` | The real-brand module was missing and the UI contained inline substitute SVG | Embedded PNG bytes match the reviewed BUFF, CSFloat, and CSBOARD SHA-256 hashes and dimensions; focused test 2/2 PASS |
| Two visible Steam anchors still produce one upper action row | `test/marketplace-brand-icons.test.ts` — `inventory renders one real-logo row at the primary visible Steam anchor` | The injector iterated `anchors.forEach` and rendered both rows | The first visible anchor owns the only row and every stale duplicate is removed; focused test and two-anchor browser QA pass |

RED checkpoints: `968c5e7`, `49ce7df`, `4b0d546`, `283124e`, `e415a60`,
`04944cf`. GREEN implementation checkpoints: `7ac4c31`, `caf5adb`, `2ea4a38`,
`caaff62`. Real-logo/single-row RED checkpoint: `1aeb4b4`; GREEN checkpoint:
`78d448c`; runtime-test refactor: `56ce978`. The bottom-placement, Shadow DOM,
and substitute-SVG attempts were superseded by the cross-version-safe,
real-brand light-DOM implementation after successive user smoke feedback.

## Validation

- `node --import tsx --test test/inspect-actions.test.ts` — PASS, 6/6.
- `npm run typecheck` — PASS.
- `npm test` — PASS, 205/205, no skipped tests.
- `node --experimental-test-coverage --import tsx --test test/inspect-actions.test.ts`
  — `inspect-actions.ts`: 80.20% lines, 84.62% branches, 80.00% functions.
- `node --experimental-test-coverage --import tsx --test test/marketplace-brand-icons.test.ts`
  — `marketplace-brand-icons.ts`: 100% lines, 88.89% branches, 100% functions.
- In-app browser interaction QA on a localhost competing-injector fixture —
  PASS for BUFF, CSFloat, and CSBOARD. A simulated 1.1.18 injector attempted to
  recreate the legacy row every 20 ms while 1.1.19 removed it. After hundreds
  of mutation cycles, the original v1.1.19 node remained connected, zero
  legacy rows were visible, all links measured 36×36 with empty visible text,
  and the three click counters advanced 1 → 2 → 3.
- In-app browser QA on a second two-anchor fixture — one action row remained at
  owner `0`; its real PNGs loaded at 32×32, 48×48, and 48×48 natural pixels,
  rendered at 28×28 inside 36×36 links, and all three clicks completed.
- Store build and package capability audit — PASS.
- Real bundled service-worker boundary test — PASS, 1/1.

The first full-suite attempt exposed iCloud `compressed,dataless` placeholders
inside `node_modules`, not a product regression. `npm ci` restored the exact
`package-lock.json` tree; the same full command then passed 202/202.

## Known gaps

The authenticated Steam inventory DOM was inspected read-only to verify the
current game-row and native inspect structure, but the test browser does not
load the unpacked development build. Final extension-in-Steam visual placement
therefore remains a user smoke test. Browser interaction behavior has no
committed screenshot baseline, so visual-regression status is INCONCLUSIVE;
cross-version DOM ownership, stable node reuse, selector isolation, square
logo-only layout, TypeScript compilation, the complete unit suite, and the
packaged artifact boundary are automated.
