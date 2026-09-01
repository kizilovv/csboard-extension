# Inventory screenshot action — TDD evidence

## Source and journey

No plan file was supplied. The journey was derived from the reported Steam
inventory behavior: when a user opens an item, `Get screenshot` must stay
visible beside Steam's `Inspect in Game` action and must not flicker in the
volatile lookup block while Steam rerenders the detail panel. The BUFF,
CSFloat, and CSBOARD lookups must live in that same interactive action layer;
Steam's redesigned metadata row can be covered by transparent click targets.

## RED / GREEN report

| Behavior | Test | RED evidence | GREEN evidence |
|---|---|---|---|
| Repeated observer passes reuse one screenshot button immediately after `Inspect in Game` | `test/inspect-actions.test.ts` — `keeps one screenshot button immediately after Inspect in Game across rerenders` | `upsertCsfolderScreenshotAction is not a function` | Focused test target: 6/6 PASS |
| The top BUFF/CSFloat/CSBOARD block never owns `Get screenshot` | `test/inspect-actions.test.ts` — `inventory keeps screenshot out of the volatile top lookup block` | Source fragment still contained `Get screenshot` | Focused test target: 6/6 PASS |
| The generated CSFolder URL is never rediscovered as a native Steam inspect link | Same inventory wiring test | Native selector accepted any URL containing `csgo_econ_action_preview` | Selector is pinned to `steam://`; focused test target: 6/6 PASS |
| BUFF, CSFloat, and CSBOARD share the clickable native inspect layer | `test/inspect-actions.test.ts` — `inventory lookup links share the clickable Inspect in Game action layer` | Production still inserted the block after the covered game-title row | Block now follows `Get screenshot`, enables hit testing, and passes focused test + Chromium click QA |

RED checkpoints: `968c5e7`, `49ce7df`, `4b0d546`. GREEN implementation
checkpoints: `7ac4c31`, `caf5adb`.

## Validation

- `node --import tsx --test test/inspect-actions.test.ts` — PASS, 6/6.
- `npm run typecheck` — PASS.
- `npm test` — PASS, 203/203, no skipped tests.
- `node --experimental-test-coverage --import tsx --test test/inspect-actions.test.ts`
  — `inspect-actions.ts`: 80.20% lines, 84.62% branches, 80.00% functions.
- Headless Chromium action-layer QA using the production stylesheet — PASS;
  `elementFromPoint` resolved all three lookup anchors and every dispatched
  click reached its matching link.
- Store build and package capability audit — PASS.
- Real bundled service-worker boundary test — PASS, 1/1.

The first full-suite attempt exposed iCloud `compressed,dataless` placeholders
inside `node_modules`, not a product regression. `npm ci` restored the exact
`package-lock.json` tree; the same full command then passed 202/202.

## Known gaps

The authenticated Steam inventory itself is not available in the automated
runner, so the final pixel-level placement is left to the unpacked browser
smoke. DOM ownership, hit testing, stable reuse, selector isolation, TypeScript
compilation, the complete unit suite, and the packaged artifact boundary are
automated.
