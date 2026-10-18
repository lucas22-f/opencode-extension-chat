# Chat slash-command model selection

## Objective

Replace visible provider/model dropdowns with composer-local `/provider` and `/model` commands and an accessible chooser, while preserving agent selection and existing model-selection behavior.

## Scope and constraints

- Reuse server-returned provider/model choices and the existing validated selection callback.
- Keep command drafts local; never send recognized commands or invalid known arguments as prompts.
- Preserve ordinary multiline input, Shift+Enter, IME composition, prompt retry/draft behavior, and agent selection.
- Provide keyboard-accessible and clickable choices with truthful loading, error, empty, disconnected, and stale-selection states.
- No auth/provider-configuration commands, SDK/backend changes, dependencies, or package changes.
- No commit, branch, push, PR, install, live server/provider/network, database, or package work.

## Stable task and checklist

Route: delegated preparation followed by the authorized multifile implementation trigger. The correction remains confined to the six paths listed in the parent task's allowed edit surfaces.

1. Add deterministic helpers and tests for slash command parsing, filtering, and key routing.
2. Replace the provider/model dropdown UI with command discovery and accessible chooser behavior.
3. Verify the focused tests, typecheck, and build; record observed evidence here.

## Acceptance tests

- `/provider` opens providers and selecting one guides the user to its models without claiming an effective switch until model selection.
- `/model` opens available models; selection calls the existing callback and does not submit a prompt.
- Invalid known command arguments show a local no-match outcome and are never submitted.
- Keyboard selection, Escape, mouse selection, loading/empty/unavailable states, and refreshed/session-changed data are handled accessibly and without invented options.
- Agent selection and normal prompt behavior remain intact.

## Delivery

- Forecast: at most 400 authored lines is realistic; count only this task's authored changes, not pre-existing dirty work.
- Strategy: `ask-on-risk`; escalate if scope or the forecast changes materially.
- No commit is authorized. Parent owns review and next-step disposition.

## Evidence and next step

- Status: implementation complete; focused verification passed. Static markup tests do not exercise browser event dispatch or visual rendering.
- RED: focused test run failed as intended because the new command parser/filter helpers had not been implemented (`parseChoiceCommand is not a function`, `filterChoiceOptions is not a function`).
- GREEN: focused Vitest run passed 35 tests across `tests/prompt-composer.test.ts` and `tests/webview.test.tsx`.
- Verification: `pnpm run typecheck` passed; `pnpm run build` passed for webview and extension bundles.
- Authored-line forecast was about 400 lines across the original feature plus this correction; it excludes pre-existing dirty content and is an estimate rather than a diff-derived count.
- Correction: command parsing rejects multiline drafts; effective choices and selection guards are shared across keyboard and click actions; unavailable choices cannot clear the command draft; stale indices are normalized before navigation and Enter selection; combobox/listbox IDs and active descendants are emitted only for visible, available choices; long choice content wraps.
- RED for correction: focused tests failed on multiline parsing, stale-index navigation, and missing action/ARIA helpers before implementation.
- GREEN for correction: focused Vitest passed 35 tests; `pnpm run typecheck` passed; `pnpm run build` passed.
- Build output: parent checked `git status`; generated `dist/` artifacts were not listed and are expected ignored build output, not a source-scope concern.
- Limitations: test harness is static markup plus pure helper tests; no browser event, rendered active-descendant association, screen-reader, or visual interaction check was performed. Existing parent-owned dirty files were not included in the authored-line forecast.
- Next: parent spot-checks the focused selection and aria-state code; no commit was made.
