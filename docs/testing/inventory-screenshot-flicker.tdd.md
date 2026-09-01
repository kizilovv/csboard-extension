# Inventory screenshot action — TDD evidence

## Source and journey

No plan file was supplied. The journey was derived from the reported Steam
inventory behavior: when a user opens an item, `Get screenshot` must stay
visible beside Steam's `Inspect in Game` action and must not flicker in the
volatile lookup block while Steam rerenders the detail panel. The BUFF,
CSFloat, and CSBOARD lookups must remain in their original top metadata area
and stay clickable inside Steam's React-rendered detail panel.

The implementation reference is the installed CSFloat 5.17.0 inventory
module. Its `SelectedItemInfo` is injected immediately after the CS2 game row
for both `#iteminfo0` and `#iteminfo1`, and its controls render inside a custom
element's Shadow DOM. The same insertion and event-isolation pattern is used
here. The installed CS2 Trader 3.6.1 inventory bundle was also inspected for
its Steam inventory lifecycle and observer behavior.

## RED / GREEN report

| Behavior | Test | RED evidence | GREEN evidence |
|---|---|---|---|
| Repeated observer passes reuse one screenshot button immediately after `Inspect in Game` | `test/inspect-actions.test.ts` — `keeps one screenshot button immediately after Inspect in Game across rerenders` | `upsertCsfolderScreenshotAction is not a function` | Focused test target: 6/6 PASS |
| The top BUFF/CSFloat/CSBOARD block never owns `Get screenshot` | `test/inspect-actions.test.ts` — `inventory keeps screenshot out of the volatile top lookup block` | Source fragment still contained `Get screenshot` | Focused test target: 6/6 PASS |
| The generated CSFolder URL is never rediscovered as a native Steam inspect link | Same inventory wiring test | Native selector accepted any URL containing `csgo_econ_action_preview` | Selector is pinned to `steam://`; focused test target: 6/6 PASS |
| BUFF, CSFloat, and CSBOARD stay at the top without Steam cancelling them | `test/inspect-actions.test.ts` — `inventory lookup links use the CSFloat Shadow DOM pattern in the top metadata area` | The controls were ordinary light-DOM anchors and the temporary bottom placement failed the requested source assertions | A `csboard-lookup-actions` host is inserted after the game row and owns open Shadow DOM links; focused test and browser interaction QA pass |

RED checkpoints: `968c5e7`, `49ce7df`, `4b0d546`, `283124e`, `e415a60`.
GREEN implementation checkpoints: `7ac4c31`, `caf5adb`, `2ea4a38`. The
`caf5adb` bottom-placement attempt was superseded by the reference-based
Shadow DOM implementation in `2ea4a38` after user smoke feedback.

## Validation

- `node --import tsx --test test/inspect-actions.test.ts` — PASS, 6/6.
- `npm run typecheck` — PASS.
- `npm test` — PASS, 203/203, no skipped tests.
- `node --experimental-test-coverage --import tsx --test test/inspect-actions.test.ts`
  — `inspect-actions.ts`: 80.20% lines, 84.62% branches, 80.00% functions.
- In-app browser interaction QA on a localhost Shadow DOM fixture — PASS for
  BUFF, CSFloat, and CSBOARD. A Steam-like delegated handler saw only the
  `CSBOARD-LOOKUP-ACTIONS` host; all three URLs changed and
  `steamCancelled=false`.
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
DOM ownership, Shadow DOM event isolation, stable reuse, selector isolation,
TypeScript compilation, the complete unit suite, and the packaged artifact
boundary are automated.
