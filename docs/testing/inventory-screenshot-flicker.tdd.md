# Inventory screenshot action — TDD evidence

## Source and journey

No plan file was supplied. The journey was derived from the reported Steam
inventory behavior: when a user opens an item, `Get screenshot` must stay
visible beside Steam's `Inspect in Game` action and must not flicker in the
volatile lookup block while Steam rerenders the detail panel. The BUFF,
CSFloat, and CSBOARD lookups must remain in their original top metadata area
and stay clickable inside Steam's React-rendered detail panel.

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

RED checkpoints: `968c5e7`, `49ce7df`, `4b0d546`, `283124e`, `e415a60`,
`04944cf`. GREEN implementation checkpoints: `7ac4c31`, `caf5adb`, `2ea4a38`,
`caaff62`. The bottom-placement and Shadow DOM attempts were superseded by the
cross-version-safe light-DOM implementation after successive user smoke
feedback.

## Validation

- `node --import tsx --test test/inspect-actions.test.ts` — PASS, 6/6.
- `npm run typecheck` — PASS.
- `npm test` — PASS, 203/203, no skipped tests.
- `node --experimental-test-coverage --import tsx --test test/inspect-actions.test.ts`
  — `inspect-actions.ts`: 80.20% lines, 84.62% branches, 80.00% functions.
- In-app browser interaction QA on a localhost competing-injector fixture —
  PASS for BUFF, CSFloat, and CSBOARD. A simulated 1.1.18 injector attempted to
  recreate the legacy row every 20 ms while 1.1.19 removed it. After hundreds
  of mutation cycles, the original v1.1.19 node remained connected, zero
  legacy rows were visible, all links measured 36×36 with empty visible text,
  and the three click counters advanced 1 → 2 → 3.
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
