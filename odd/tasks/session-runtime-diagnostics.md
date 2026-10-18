# Session Runtime Diagnostics — ODD Task

**Status:** Bounded implementation and follow-up corrections verified. The confirmed SDK/server response-envelope mismatch is fixed and verified with realistic mocked SDK transport; post-fix runtime revalidation remains pending.
**Route:** Delegated preparation and focused multi-file implementation under `src/extension/opencode-chat.ts`, `src/extension/diagnostics.ts`, `src/shared/chat-state.ts`, `src/webview/App.tsx`, and corresponding focused tests. Preserve existing user-confirmed dirty work and the working slash selector.
**Delivery advisory:** Forecast at or below 400 changed lines; use `ask-on-risk` if scope grows. No commits, branches, push, PR, install, network, live server/provider/database request, localhost request, or native RDD lifecycle action is authorized.

## Objective

Correct the confirmed OpenCode 1.19.0 history-record type misclassification and session activity response parsing, and improve privacy-safe diagnosis without claiming post-fix runtime success before it is revalidated.

## Tasks and acceptance

1. **Correct known history records.** Inspect exact pinned 1.19.0 protocol shapes and installed SDK types. Map known supported records safely or count explicitly skipped metadata by allowlisted type; do not classify these as unsupported or silently discard shell/synthetic text without a documented, tested policy. Unknown types remain unsupported; malformed known user/assistant records remain invalid. Preserve trusted IDs and current validation.
2. **Classify activity failures without false idle.** Distinguish HTTP status, request failure, invalid response shape, and missing SDK method/data with fixed safe diagnostic categories. UI messages must be actionable and fixed; expose status only, no raw content/IDs/paths/URLs/credentials. Clear activity failure only on authoritative success/event. Keep generation/selection race checks; do not enable unsupported cancel or imply idle.
3. **Parse the exact active-session response.** The installed SDK 1.19.0 client returns success as `{ data: <HTTP JSON body>, response }`; the pinned server handler returns the body `{ data: Record<SessionID, { type: 'running' }> }`. The adapter's previous implementation validated `response.data` as the map rather than validating the nested HTTP body's `data`, deterministically producing `invalid-shape`. Parse only the nested payload with the existing strict map schema; malformed successful responses must continue to fail without marking the session inactive.
4. **Preserve activity HTTP failures.** Inspect the pinned SDK `RequestResult` behavior. Handle `{error,response}` status before parsing `data` or throw on errors, without logging raw error/body. Cover 401/403/404/405/503, successful malformed data, network throw, and missing method; only authoritative success/events clear errors.
5. **Bound switch metadata.** Apply existing safe length limits to switch-record agent/provider/model fields; reject oversized records rather than truncate. Tests must prove no partial metadata is rendered and no secret/content is put in diagnostics.

## User-observed evidence and source-confirmed cause

After reload, the user observed history success with 19 raw records, 18 mapped, and 1 unsupported; SSE connected; persistent activity-unknown state; and `session.activity.failed` with reason `invalid-shape`. The installed SDK and pinned handler sources confirm the envelope mismatch described in task 3. This explains the invalid-shape failure in the previous adapter; it does not establish that the runtime succeeds after the fix. The exact dropped history type is not yet known, and this does not establish incremental streaming.

## Verification

- History RED: fixture failed because known system/synthetic/shell/compaction/switch entries were omitted; diagnostic RED: recorder dropped the new activity failure event.
- GREEN: focused verification passed 3 files / 77 tests.
- `pnpm run typecheck` passed.
- `pnpm run build` passed (Webview 482.63 kB / 142.71 kB gzip; Extension 278.39 kB / 66.35 kB gzip).
- Follow-up RED: 7 tests failed across HTTP 401/403/404/405/503 misclassification, network failure classification, and oversized switch metadata acceptance.
- Follow-up GREEN: focused verification passed 3 files / 85 tests; `pnpm run typecheck` passed; `pnpm run build` passed (Webview 482.71 kB / 142.74 kB gzip; Extension 278.65 kB / 66.42 kB gzip).

Pinned SDK client source confirms non-throwing error results contain `error` plus `response`; the adapter now inspects that envelope before parsing data. Valid statuses retain fixed actionable categories; no body/error text is recorded. Network throws, invalid successful data, and unavailable SDK method remain distinct. Existing failure details persist during pending refresh and clear only on valid active-map response or authoritative busy event. Switch agent/provider/model identifiers are capped at 256 chars and overlong records are rejected, not truncated; neutral context is rendered as plain text rather than Markdown. No live server request was authorized or performed; the post-fix runtime still requires reload-based validation. Unrelated dirty work was preserved; no commits, branches, push, PR, install, network, server/provider/database request, localhost request, or native RDD lifecycle action was performed.

## Confirmed envelope correction

- The installed SDK success result wraps the full HTTP body in `RequestResult.data`; the pinned handler's HTTP body is `{ data: activeSessionMap }`. The adapter now guards that outer body and applies the unchanged strict `activeSessionMapSchema` to its nested `data`.
- RED: the realistic nested-body regression failed against the old adapter with `sessionActivityErrorCategory === "invalid-shape"` (expected `null`). GREEN: `pnpm exec vitest run --config vitest.config.ts tests/opencode-chat.test.ts tests/diagnostics.test.ts tests/webview.test.tsx` passed 3 files / 85 tests. The regression confirms active and inactive refreshes succeed; malformed successful bodies and HTTP error status handling remain covered.
- `pnpm run typecheck` passed. `pnpm run build` passed (Webview JS 482.71 kB / 142.74 kB gzip; Extension JS 278.72 kB / 66.45 kB gzip).
- The user-observed post-reload `invalid-shape` is explained by the verified source mismatch, but the Extension Host has not been reloaded after this correction; actual post-fix runtime behavior remains unverified. M3 and M9 remain partial.
