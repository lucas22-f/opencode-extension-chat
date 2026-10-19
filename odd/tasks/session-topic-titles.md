# Automatic session topic titles — ODD feature
Objective: save a recognizable title from the first accepted user prompt without extra model inference.
Branch: `feat/session-topic-titles`; delivery: ask-on-risk, forecast ~350 authored lines; tests: Vitest with isolated SDK HTTP fixtures.

## Specs

- S1: "Luego segui por darle nombre de las sesiones al tema del que hablo primero el usuario luego de que hablo el usuario tal como lo hacen los agentes mas modernos, guardan el nombre de la session con el tema del que se habla" — name an untouched, empty default session after the first validated prompt admission, persist via the pinned public API, and display the confirmed title in history and the active heading. Implementation assumption: a normalized, bounded excerpt of the first nonblank prompt line, not a second inference call.
- S2: "quiero que le des un vistazo a esta tambien https://github.com/morluto/rea luego" — evaluate that repository read-only after the naming work, without installing it at that stage.
- S3: "perfecto, subilo despues instalate esa herramienta y dejala funcional" — publish the title work, then install and verify REA. Implementation scope: project-local tool installation and Pi MCP configuration, no global configuration, provider or account changes.

## Tasks

- T1 | S1 | route: inline (one dependent behavior) | done: first-prompt naming, server confirmation and preservation checks | commit: pending closure.
- T2 | S1 | route: independent verify (Risk item 1: updates stored session titles) | in_progress: independent focused checks passed (9 passed, 68 skipped); isolated commit and authorized push remain | commit: pending.
- T3 | S2 | route: read-only research | done: README, JS workflows/recovery and Electron observation documentation reviewed; findings saved in project memory | commit: not applicable to external research.

- T4 | S3 | route: inline (sequential environment work, no parallel writer trigger) | pending: pinned project-local REA install and Pi MCP configuration | commit: pending.
- T5 | S3 | route: functional checks plus independent verify (Risk item 5: tool installation/configuration) | pending: CLI/static analysis and stdio MCP proof; report session reload requirement | commit: pending.

## Log

L10 — Independent verifier mvelfgn7-j-oy5s ran in the actual project with existing dependencies: 9 title tests passed, 68 unrelated tests skipped, exit 0. S1 met, no blocker. It confirmed admission/eligibility, Unicode bounds, custom/child/history preservation, server confirmation and connection guards. The staged title work unit excludes prior uncommitted fixes (6 paths, 190 authored lines before closing evidence).
L8 — New authorization (verbatim): perfecto, subilo despues instalate esa herramienta y dejala funcional
L9 — Environment diagnosis: actual project resolves @vitejs/plugin-react and its @rolldown/pluginutils dependency. The earlier failure came from the verifier's copied dependency tree, not the working project. Do not reinstall product dependencies; the HTTP test fixtures already isolate session mutations. REA will be installed under .tools/rea and registered in .pi/mcp.json, both inside the project, with no global setup or automatic native-engine installation.

L1 — Original request (verbatim): Luego segui por darle nombre de las sesiones al tema del que hablo primero el usuario luego de que hablo el usuario tal como lo hacen los agentes mas modernos, guardan el nombre de la session con el tema del que se habla
L2 — Follow-up (verbatim): quiero que le des un vistazo a esta tambien https://github.com/morluto/rea luego
L3 — Pinned evidence at 733b2c627e5aec39cb33cc22373bdce33053ef2c: core session.ts creates `New session - <ISO>`; the legacy SessionPrompt has ensureTitle but is not proof of title generation in the core runner used here. Public legacy PATCH /session/:sessionID accepts title; its handler calls setTitle; session/projector.ts lines234-239 projects SessionV1.Event.Updated into the same SessionTable read by v2. No speculative v2 title event or endpoint will be invented.
L7 — REA read-only result: https://github.com/morluto/rea is an actual CLI/MCP implementation, unlike a methodology-only skill router. Its static JavaScript application graph and feature-tracing tools may help inspect an authorized extracted extension directory. Its Electron passive inspection accepts local file:// targets, so it must not be assumed to cover VS Code's vscode-webview:// frames. Source recovery documents a caller-supplied Wakaru engine on Linux x64, not a ready Windows workflow. No installation, MCP registration, target-process inspection or source reuse was performed. Sources: docs/javascript-application-workflows.md, docs/javascript-recovery.md, docs/electron-observation.md in the upstream main branch; reviewed docs are not hands-on verification.
L6 — Independent verifier mvekkx21-i-c05a inspected the title path and reported evidence consistent with S1, but its isolated dependency copy failed before test discovery: ERR_MODULE_NOT_FOUND for @rolldown/pluginutils, exit 1, 0 tests. S1 is unverified independently. No automatic rerun, dependency installation or additional verifier is authorized. The verifier also reported an out-of-project scratch directory; parent did not access or delete it. T2 stays blocked pending the user's decision; no title feature commit/push is claimed.
L5 — RED: two first-title/failure-isolation tests failed (exit 1). GREEN: focused adapter suite 74 passed; after adding Unicode, child/custom and established-session cases the full suite passed 252 tests with 1 gated smoke skipped. Build job-19 passed typecheck and both bundles; whitespace check passed (Windows line-ending warnings only). Native assess could not form the untracked candidate; its Risk item 1 fallback plan requires an independent verifier. No live session writes or provider requests were made.
L4 — Naming must not alter custom/child/established sessions or rejected/unknown submissions, block an accepted chat turn, repeat inference, or expose prompt/title content in diagnostics. Recheck the server title before writing and retain connection-generation guards; the API has no compare-and-swap guarantee against an external client renaming between GET and PATCH. Use isolated mock sessions for tests, no live server writes.
