# Mixed History Part Ordering — ODD Task

**Status:** Implemented and verified; bounded continuation of mixed assistant-part ordering.
**Route:** Prepare this task record, then implement and verify the focused adapter/test/docs unit across the authorized surfaces. This prep plus multi-file route is justified by preserving audit context before source changes.
**Delivery:** Ask-on-risk; forecast <=400 authored lines (advisory). No commit, branch, push, PR, install, live server/provider/network/database operation, or native lifecycle. RDD is off; no review approval is implied.

## Objective

Preserve authoritative relative order among the server-history assistant parts when streamed text/tool parts coexist, while deterministically placing new parts without inventing chronology.

## Authorized surfaces

- `src/extension/opencode-chat.ts` — assistant part ordering implementation only.
- `tests/opencode-chat.test.ts` — focused mixed-history regression coverage.
- `odd/tasks/mixed-history-part-ordering.md` — this task record and evidence.
- `odd/tasks/opencode-visual-extension.md` — bounded M4/M9 tracker correction.
- `docs/progress.md` — concise status/evidence correction.

## Stable checklist and acceptance

- [x] Add a regression with at least two history parts whose IDs/timestamps conflict with history order, plus a newly streamed text part; observed the previous fallback fail with history tool moved ahead of the live part.
- [x] Merge deterministically without a pairwise comparator that can violate comparator consistency; preserve the history subset's relative order and avoid duplicate/drop behavior.
- [x] Preserve established all-history ordering and history-free all-durable-sequence ordering; mixed sets with history retain the historical subset even when all items have sequence evidence. Keep selection/history refresh logic untouched.
- [x] Record that placement of new parts is deterministic, not recovered chronology when evidence is missing.
- [x] Update M4 only with existing mapping/card facts and test/runtime caveats; leave M4 and M9 partial.
- [x] Run exact authorized focused verification commands and record observed outcomes below.
- [x] Mirror this full task record to project Engram at `odd/mixed-history-part-ordering/tasks` and read back both copies.

## Checks

TDD: RED then GREEN, triangulate relevant alternate cases. Required final commands, foreground and individually: `pnpm exec vitest run --config vitest.config.ts tests/opencode-chat.test.ts tests/webview.test.tsx`; `pnpm run typecheck`; `pnpm run build`. No full suite or live/browser E2E.

## Proof

The durable-sequence regression observed RED (1 failed, 51 skipped; actual text `BAC`, expected `ABCD`) then GREEN (1 passed, 51 skipped). Final verification: `pnpm exec vitest run --config vitest.config.ts tests/opencode-chat.test.ts tests/webview.test.tsx` — 2 files / 73 tests passed; `pnpm run typecheck` — passed; `pnpm run build` — passed. History subsets preserve exact history order; streamed parts use durable sequence for placement only when every part has a sequence, otherwise timestamp/arrival/ID, and missing chronology is not reconstructed. History-free all-sequence sorting remains intact. All proof is deterministic/mock-only. M4 and M9 remain partial; no live OpenCode/runtime/UI claim is made. Full task record mirrored to project Engram observation #2909 and read back against this file. Slash commands and unrelated pre-existing work were not changed. No commit/branch/push/PR/install/native lifecycle was performed.
