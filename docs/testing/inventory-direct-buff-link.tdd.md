# Inventory direct BUFF link and scroll diagnosis

## Source and journeys

The journeys were derived from user smoke feedback on Steam's redesigned CS2
inventory:

1. As a trader, selecting an inventory item must open its direct BUFF
   `/goods/<goods_id>` page whenever that market item exists in `buffIds.json`.
2. As a trader, selecting an item after slightly scrolling must not be blamed
   on CSBOARD without a clean-Steam control measurement.

The installed Steam UI supplied a new opaque v2 inspect action that no longer
contains the legacy `A<assetid>D` token. The selected card still exposes the
exact identity through an element id shaped as `730_<context>_<asset>` and the
`.activeInfo` class.

## Task report

| Guarantee | Test or measurement | RED evidence | GREEN evidence |
|---|---|---|---|
| A v2 inspect action resolves the exact selected inventory asset | `test/inventory-lookup.test.ts` | `b4278f2`: the new test target failed because `inventory-lookup.ts` did not exist | `03c7a29`: focused target 9/9 PASS and `AK-47 \| Redline (Field-Tested)` resolves to `https://buff.163.com/goods/33960` |
| Ambiguous name-only matches remain generic instead of guessing a wear | `test/inventory-lookup.test.ts` | The old inventory implementation matched only the heading after the inspect token disappeared | Two equal display names return `undefined`; no arbitrary BUFF goods page is selected |
| Inventory wiring reads Steam's selected CS2 item | `test/inventory-lookup.test.ts` source-contract check | The source had no `.item.app730.activeInfo[id]` fallback | The source passes that selected element id into `resolveInventoryLookupItem` |
| The observed scroll movement exists without CSBOARD | Read-only in-app browser measurement on the signed-in Steam inventory | N/A: diagnosis, not a production change | With zero `.csboard-*` elements, a visible item click changed `scrollY` from `260` to `292.5` while document height changed from `1690` to `1623`; the inventory content script contains no `scrollTo`, `scrollIntoView`, or `focus` call |

## Validation

- `node --import tsx --test test/inventory-lookup.test.ts test/inspect-actions.test.ts`
  — PASS, 9/9.
- `npm run typecheck` — PASS.
- `npm test` — PASS, 208/208, no skipped tests.
- `node --experimental-test-coverage --import tsx --test test/inventory-lookup.test.ts`
  — `inventory-lookup.ts`: 100% lines, 86.67% branches, 93.33% functions.
- `npm audit --omit=dev --audit-level=high` — 0 vulnerabilities before both
  task commits.

## Known gap

The clean-Steam control proves the scroll movement is native to Steam's
inventory detail swap. CSBOARD still adds content to that changing panel, so
the exact visual distance can vary with the selected item's description,
stickers, and trade-protection text. No global scroll override was added: it
would fight legitimate user scrolling and Steam pagination for a native layout
behavior that CSBOARD does not invoke programmatically.
