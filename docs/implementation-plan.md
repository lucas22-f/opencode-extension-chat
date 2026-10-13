# Implementation plan

The sequence below mirrors the authoritative M0–M10 milestone table in [`../odd/tasks/opencode-visual-extension.md`](../odd/tasks/opencode-visual-extension.md). That ODD document alone owns acceptance criteria, status, evidence, and next step; this file is a concise sequencing guide, not a second task tracker.

## Milestone sequence

1. **M0 — Research and architecture:** pin OpenCode 1.19.0, document source-level research and design constraints, define feature acceptance, and verify the isolated sparse reference clone at the pinned commit. Complete at research/reference level only; the nested upstream checkout is not product code and does not imply runtime verification.
2. **M1 — Minimal Extension Host + React Webview scaffold:** establish the distinct extension identity and sidebar/expanded Webview shell. The Windows managed path resolves the real PowerShell shim from PATH, derives and validates the adjacent `opencode.exe`, and spawns it directly with safe fixed argv, an explicit trusted-workspace cwd, reported URL, exact process ownership, graceful disposal, and bounded fallback cleanup. Extension Host/coexistence checks remain pending.
3. **M2 — Real OpenCode connection/server health:** use the pinned `@opencode-ai/sdk@1.19.0` health route with an explicit attach-only URL or one default `127.0.0.1:4096` probe. A no-response result may start a trusted-workspace managed server on loopback with port `0` and `--pure`. The previous real smoke used the PowerShell wrapper and predates the direct-executable correction; no real server smoke has run for the current path. Configured-URL live attach and Extension Host behavior remain pending.
4. **M3 — Real chat, sessions, and streaming:** connect prompt/session flow to the server and render responses incrementally from real pinned events. Do not simulate response streaming or session state.
5. **M4 — Tools:** derive tool cards, types, states, and supplied metadata from actual events. Show file changes only when verified payloads provide them.
6. **M5 — Permissions/questions:** display and respond to server-issued permission and question requests using verified pinned operations and server-refreshed state.
7. **M6 — History/models:** support server-returned history and open/resume/create; send delete only after confirmation and only if the pinned API supports it, otherwise document and omit it. Populate provider/model/agent/mode choices only from verified API values and avoid unsupported persistence claims.
8. **M7 — Editor files/context/diffs:** pass active-file, selection, and line-range references through VS Code APIs; gate attachments, change summaries, native diff/editor navigation on verified OpenCode and VS Code support.
9. **M8 — MCP/skills/subagents:** show configured/connected servers, tools, skills, and child sessions only when pinned API/events establish them; verify each administrative or interaction action before exposing it.
10. **M9 — Security, reliability, tests, performance:** complete workspace-trust, credential, CSP/input, multi-window/workspace, Windows-path, cancellation, and recovery checks; add and run unit, integration, contract, Extension Host/UI, and real v1.19.0 checks. Record resource use as observations. Provider-cost E2E remains optional and explicitly authorized.
11. **M10 — Docs, VSIX, clean install, report:** deliver README and architecture/development/testing/troubleshooting/security/compatibility/changelog documentation; inspect VSIX metadata/content and confirm `upstream-opencode-v1.19.0/` is excluded; verify clean side-by-side installation where available; report exact evidence, known limitations, and artifact location.

## Verification and sequencing rules

- The first baseline remains OpenCode CLI/SDK 1.19.0. The SDK package root and `./v2` subpath are distinct surfaces; use each only for routes verified in the pinned version. OpenCode 2.x remains unsupported until a separate compatibility change is verified.
- Record exact pass/fail/blocked outcomes in the canonical ODD tracker. The product now has a pnpm toolchain, scripts, and focused tests; the nested source-reference clone is not product code. `vsce` was not found.
- Keep test workspaces isolated from user workspaces. Optional provider-cost E2E must be explicitly authorized before running. Do not invent performance or memory thresholds; record scenario and observed values until a baseline is agreed.
- Keep changes reviewable by coherent milestone. A roughly 400-line size is advisory only and must not force an artificial split.

## Current handoff

M0 source-level research/architecture and the pinned, clean sparse reference clone are complete. M1 and M2 are partial: current focused direct-executable/lease tests, typecheck, and build pass. A parent-observed direct-binary `--version` probe returned `1.19.0`; it does not verify server lifecycle. The prior real smoke used the PowerShell wrapper and predates the correction. Configured-URL live attach and Extension Host/coexistence checks remain pending. Current shutdown requests pinned SDK `instance.dispose()` first and uses bounded forced process-tree termination only as a lease-verified fallback for the still-live owned root.
