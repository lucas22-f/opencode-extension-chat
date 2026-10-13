# OpenCode Visual Extension — ODD Feature

**Status:** M1 partial; M2 partial — pinned health/version attach and direct-executable managed startup are implemented. An earlier Windows health-only smoke used the PowerShell wrapper and predates the direct-executable correction; no real server smoke has run since that correction. M2 remains partial because direct-executable runtime smoke, configured-URL live attach, and VS Code Extension Host/coexistence checks remain unverified.  
**Compatibility baseline:** OpenCode CLI 1.19.0, the version verified in the target environment.  
**Canonical tracker:** This document is the authoritative working specification and milestone tracker. Its full current content is mirrored to project Engram at `odd/opencode-visual-extension/tasks`.

## Objective

Deliver a distinct, chat-first graphical VS Code extension for OpenCode that can be installed alongside the official OpenCode extension. Users should be able to connect to an OpenCode server, work with sessions, chat, and respond to server permission or question requests from the graphical interface.

## Problem and value

The official OpenCode VS Code extension at v1.19.0 is a terminal launcher and context bridge, not a graphical chat experience. A separate extension can serve users who want to interact with OpenCode in a VS Code chat UI while preserving the official extension's identity and behavior.

## Scope

**In scope**

- An independently identified VS Code extension with a sidebar chat view and an expanded panel/tab experience.
- Chat composition and rendering, event-backed streaming, sessions/history, verified model/provider/agent/mode choices, tools, permissions/questions, editor context, and capability-gated MCP/skills/subagent visibility.
- Managed local-server lifecycle and explicit URL attachment, with process ownership, workspace trust, credential, and network boundaries made clear.
- Tests and checks appropriate to the established toolchain, user/developer/security/compatibility documentation, VSIX packaging, clean-install/coexistence verification, and a final evidence-based report.

**Out of scope for this baseline**

- Modifying, replacing, or claiming affiliation with the official OpenCode extension; copying its branding.
- Claiming compatibility with OpenCode 2.x/current development before a separate compatibility investigation and verification.
- Arbitrary TUI/server process discovery, unrestricted port scanning, or terminating processes not started and owned by this extension.
- Showing controls or status that imply an operation is available when the pinned API/events do not support it or the behavior has not been connected and tested.
- Reusing upstream code without preserving applicable license/copyright notices. Prefer the published SDK and APIs.

## Constraints and baseline

- At the initial audit, the workspace was empty and not a Git repository. The product root is now a Git repository with no commits; product files remain untracked. `.atl/` is unrelated runtime-generated state and is excluded by `.gitignore` and `.vscodeignore`. M1 established a pnpm-based product stack and deterministic test command, with current evidence recorded below.
- The official OpenCode source is present only as a shallow/sparse, pinned read-only reference checkout at `upstream-opencode-v1.19.0/`. It is a separate nested Git checkout, not product source or a fork. Future VSIX packaging must exclude this directory and verify that no reference-clone content is shipped.
- The target machine has Windows 10 x64, Node.js 24.15.0, npm 11.12.1, pnpm 10.18.0, VS Code 1.138.0, Go 1.26.1 (`windows/amd64`), and OpenCode CLI 1.19.0. `vsce` was not found.
- Use the pinned `@opencode-ai/sdk@1.19.0` contract. Its package-root API and `./v2` subpath are distinct surfaces; the health-only implementation imports `@opencode-ai/sdk/v2/client` and calls the pinned `global.health()` method.
- The SDK convenience server helper is not used because it hardcodes `opencode`, inherits cwd, and cannot pass the required workspace, port-0, and `--pure` arguments. Windows resolves the real `.ps1` shim path from absolute PATH entries, derives and validates its adjacent `node_modules/opencode-ai/bin/opencode.exe`, and spawns that executable directly with fixed argv and `shell: false`; other platforms invoke `opencode` directly. The managed process binds to `127.0.0.1`, reports its actual URL, and must pass the pinned health/version check.
- Shutdown authority exists only for the exact direct child started by the manager. On Windows, the manager resolves `taskkill.exe` before launch and first requests pinned SDK `instance.dispose()`. It waits for both the child to exit and the endpoint to become unavailable. Only if that bounded graceful attempt fails may it use bounded `/PID <owned executable pid> /T /F` taskkill, after confirming the root is still live and the workspace lease still owns it. Cleanup errors remain visible; attached, foreign, exited, and unowned processes are never taskkilled. The direct-executable process path has not been real-smoke tested.
- A managed server starts only after the one bounded default probe receives no HTTP response, from an explicit Connect action, in a trusted workspace with an absolute workspace directory. A responding but non-OpenCode endpoint, auth challenge, timeout, or version mismatch is not treated as absence. Keep credentials and process control in the extension host, not the Webview.
- Windows paths containing spaces or Unicode must be handled without shell interpolation. Workspace paths, process arguments, and resource references require validation. The extension must respect VS Code workspace trust and avoid sharing mutable session/process state across unrelated windows or workspaces.
- Use a restrictive Webview CSP, narrow `localResourceRoots`, `asWebviewUri` for local assets, validated message schemas, and VS Code state APIs for persisted view state.
- Only show values and affordances that are grounded in the connected 1.19.0 API/events. In particular, context-use metrics, model/agent choices, tool metadata, file changes, MCP/skills/subagent state, cancellation, and attachments must not be fabricated when the corresponding contract is absent or unverified.
- Performance and memory are to be measured and reported as observations; do not invent thresholds before a baseline exists. Tests use isolated workspaces. Any end-to-end scenario that may incur provider costs is optional and explicitly authorized before execution.
- Current OpenCode docs describe v2 and are not authoritative for the installed 1.19.0 contract. Version-pinned source citations and limitations are recorded in [`../../docs/research.md`](../../docs/research.md).

## Specifications and acceptance checks

### S1 — Independent identity and coexistence

The extension has a unique publisher/extension ID and command namespace, and does not modify or impersonate the official extension.

- **AC1.1:** Both extensions install in the same VS Code profile without overwriting each other's manifest, commands, or activation behavior.
- **AC1.2:** The extension name, publisher, icon, and documentation use distinct identity and do not imply official affiliation.

### S2 — Sidebar, expanded chat surface, and core navigation

The chat-first UI is reachable in the VS Code sidebar and can be opened in an expanded panel/tab. It exposes the expected header, navigation, settings, and connection state.

- **AC2.1:** A user can open the extension from its sidebar view and open the same active conversation in an expanded panel/tab.
- **AC2.2:** The header shows the current connection/session state and provides discoverable New, History, and Settings entry points.
- **AC2.3:** Loading, empty, disconnected, reconnecting, and error states are distinguishable and reflect actual extension/server state.
- **AC2.4:** Core navigation and controls are operable by keyboard, have accessible names/focus behavior, and work with both light and dark VS Code themes.

### S3 — Chat rendering, composer, and real event-backed streaming

Users can send prompts and observe actual server responses in the chat surface; streaming and tool/message states are derived from the selected pinned event contract, not simulated UI activity.

- **AC3.1:** The composer accepts multiple lines; a user can insert a newline without accidental submission and submit via a discoverable, documented keyboard action. Key behavior is explicitly tested.
- **AC3.2:** User/assistant content renders Markdown and code blocks; code content can be copied without losing its text.
- **AC3.3:** Assistant output appears incrementally only when corresponding OpenCode events/data arrive. A simulated stream or fabricated response cannot pass this check.
- **AC3.4:** Event decoding uses one selected, version-pinned surface; legacy SSE and v2 event envelopes are not conflated.
- **AC3.5:** Errors, incomplete responses, and loss of stream are surfaced; stale content is not represented as a current successful response.

### S4 — OpenCode 1.19.0 compatibility and server connection

The only initial compatibility target is OpenCode CLI 1.19.0 with the matching published SDK. The package-root SDK and its `./v2` subpath are distinct clients/surfaces; `./v2` is not a claim of CLI 2.x support.

- **AC4.1:** Each operation uses routes/types verified against pinned 1.19.0 source/package definitions; a current 2.x route is not assumed compatible.
- **AC4.2:** The extension can establish a real connection and report health/version using the pinned health contract; version mismatch is visible and actionable.
- **AC4.3:** Managed-server launch binds to loopback by default and uses the actual listening URL/port reported by the launched server.
- **AC4.4:** A configured attachment uses the explicit server URL; when none is configured, a user-triggered Connect checks only `127.0.0.1:4096`. No arbitrary process discovery or port sweep occurs; disconnecting an attached endpoint does not terminate it.
- **AC4.5:** The Windows path resolves the real `opencode.ps1` from an absolute PATH entry, derives and validates adjacent `node_modules/opencode-ai/bin/opencode.exe`, spawns that executable with fixed argv and `shell: false`, uses the selected workspace cwd, parses the actual loopback URL, and awaits process exit plus endpoint unavailability. Bounded taskkill is fallback-only for the exact still-live lease-owned root. Unit checks cover direct resolution and cleanup; a real server smoke after this correction remains pending.

### S5 — Sessions, history, models, providers, agents, and modes

Session and choice controls reflect only values and persistence behavior supported by pinned 1.19.0 endpoints/events.

- **AC5.1:** Users can create a session and open/resume a session returned by the server.
- **AC5.2:** History lists server-returned sessions and supports opening/resuming. If the pinned API supports deletion, send it only after explicit confirmation; if not, document the limitation and omit the delete control.
- **AC5.3:** After extension restart, recover/reopen only sessions returned by the server's pinned API; do not claim local or server persistence semantics beyond verified source/API evidence.
- **AC5.4:** Provider/model/agent/mode choices are populated from verified server data and submitted using verified fields. Unsupported/absent choices are documented, not fabricated.
- **AC5.5:** Any context-use indicator appears only when the pinned API provides a documented, trustworthy value; otherwise it is omitted rather than estimated.

### S6 — Permission and question requests

Server permission and question requests are visible and actionable only through routes/events verified in the pinned API.

- **AC6.1:** A pending permission request displays server-supplied context and exposes only supported response actions.
- **AC6.2:** A pending question is displayed and can be answered or dismissed only as the pinned contract allows.
- **AC6.3:** Pending/resolved state is refreshed from server events or queries; local optimistic UI state is reconciled with the server.

### S7 — Tool cards and file-change display

Tool cards and change summaries represent real OpenCode events and returned data, never inferred or decorative behavior.

- **AC7.1:** Cards appear from actual tool/message events. Known types receive suitable rendering; newly encountered types remain recognizable through a safe generic representation rather than being dropped or mislabelled.
- **AC7.2:** Pending, running, completed, failed, and cancelled states map to actual event/status data. A state is shown only when supported by the event/API; unknown remains unknown.
- **AC7.3:** Duration, input, output, and error details appear only when supplied by the server/API and are not synthesized.
- **AC7.4:** File-change summaries and native VS Code diff/editor navigation are shown only when pinned OpenCode data and VS Code APIs provide the necessary files/ranges; otherwise the limitation is documented and no nonfunctional action is presented.
- **AC7.5:** Visual controls alone do not imply behavior: an action is enabled only after its connected, supported behavior has been tested against the pinned contract.

### S8 — Editor files, selection, references, attachments, and diffs

The extension can use current VS Code editor context where supported, and clearly distinguishes references from uploaded/sent content.

- **AC8.1:** A user can add an active file reference and selected text with a verified line range to a prompt using VS Code editor/document APIs.
- **AC8.2:** File attachments are offered only where the pinned OpenCode request/API supports the attachment form; unsupported attachments are explicitly documented rather than represented by a fake upload control.
- **AC8.3:** Reference paths, selected content, and ranges are validated and associated with the intended workspace/document; paths with spaces and Unicode are preserved.
- **AC8.4:** File-change summaries, diff views, and editor navigation are available only when event/API payloads and VS Code APIs support them and are verified end to end.

### S9 — MCP servers, tools, skills, and subagents

MCP/configuration, skills, and child-session visibility is capability-gated by pinned 1.19.0 endpoints and events.

- **AC9.1:** The UI lists connected/configured servers, tools, and skills only when the pinned API returns those facts, and indicates their actual returned state.
- **AC9.2:** Child sessions/subagents are displayed only when pinned session/event data establishes the parent-child relationship.
- **AC9.3:** Connect, configure, enable, disable, invoke, or administrative actions are exposed only after the exact endpoint, permission, and behavior are verified.
- **AC9.4:** If an endpoint/state/action is absent or unsupported, the limitation is documented and no fake button, connected state, tool, skill, or subagent is shown.

### S10 — Security, reliability, platform behavior, and resource observations

Server ownership, workspace boundaries, credentials, inputs, failures, and resource use are handled explicitly and verifiably.

- **AC10.1:** Cancellation invokes a supported OpenCode cancellation operation and reflects its actual outcome; without a verified route, cancellation is documented as unsupported rather than simulated.
- **AC10.2:** Shutdown/disposal terminates only an extension-owned child process. No TUI, attached server, or foreign process is stopped.
- **AC10.3:** Multiple VS Code windows/workspaces are exercised; connections, sessions, and process ownership do not leak or cross between unrelated workspaces.
- **AC10.4:** Windows paths containing spaces and Unicode pass through without shell interpolation; process arguments and cwd are handled using a validated safe invocation strategy.
- **AC10.5:** Workspace trust is respected; credentials stay in the extension host/VS Code secret storage and never enter Webview markup or messages.
- **AC10.6:** Inputs and Webview messages are validated; Webview CSP, `localResourceRoots`, and `asWebviewUri` boundaries are checked.
- **AC10.7:** Real disconnect, reconnect, startup failure, version mismatch, and API errors produce truthful state and actionable diagnostics.
- **AC10.8:** Performance and memory are measured on representative use and recorded as observations (scenario, environment, result); no threshold is invented before a baseline is agreed.
- **AC10.9:** Tests use isolated workspaces/fixtures. Provider-cost end-to-end runs are optional and require explicit authorization; no paid-provider request is implicit in verification.

### S11 — Verification, documentation, VSIX, and final report

Verification and delivery are reproducible, and all project/user documentation matches tested behavior.

- **AC11.1:** Once the toolchain exists, record and run applicable unit, integration, contract, Extension Host/UI, and real-OpenCode-v1.19.0 checks. Optional provider-cost E2E is separately authorized.
- **AC11.2:** Record exact commands and pass/fail/blocked outcomes. Do not list a test command before it is established; do not claim a check passed until it runs.
- **AC11.3:** README and supporting docs cover architecture, development, testing, troubleshooting, security, compatibility, and changelog/release notes.
- **AC11.4:** Inspect VSIX metadata and contents, verify version/identity, confirm `upstream-opencode-v1.19.0/` is excluded, and check a clean installation alongside the official extension in an isolated VS Code profile when available.
- **AC11.5:** Final report identifies the VSIX, checks and exact outcomes, known limitations, compatibility baseline, and any unverified or blocked areas.

## Milestones and verification

Milestone IDs are stable; update status and evidence here rather than maintaining a second task tracker. “Planned checks” are not evidence that a check has passed.

| ID | Work and linked specs | Route / planned checks | Status and evidence |
|---|---|---|---|
| M0 | Research and architecture. S1, S3, S4. | Pin release/source and environment facts; record design and compatibility limits; keep source-level evidence separate from runtime verification; verify the isolated sparse reference clone and its commit. | **Complete — source-level/reference-only.** Parent-verified research and architecture are recorded. The clean sparse reference checkout is pinned to `733b2c627e5aec39cb33cc22373bdce33053ef2c`; no product code, live check, or test result is implied. |
| M1 | Minimal Extension Host + React Webview scaffold. S1, S2, S4, S10.6, S11. | Establish provisional identity, sidebar and expanded Webview, restrictive CSP, and a validated message protocol. Verify platform invocation, workspace cwd, fixed argv, reported URL, process ownership, and bounded cleanup before managed startup. | **Partial —** scaffold, focused tests, typecheck, and production build pass. Current direct-executable verification is 2 focused files / 18 tests passed / 1 gated smoke skipped; the earlier 5-file run and real smoke predate this process correction. VS Code Extension Host, visual/theme/keyboard, and coexistence checks remain pending. Publisher/extension identity remains provisional and Marketplace ownership unverified. |
| M2 | Real OpenCode connection and server health. S3, S4, S10. | Verify explicit attach and the single default `127.0.0.1:4096` endpoint, pinned health/version behavior, managed startup on a reported loopback URL, timeout/auth/error handling, state updates, and ownership-aware disconnect. | **Partial —** the Extension Host uses pinned `@opencode-ai/sdk/v2/client` `/global/health`, a 4-second bound, redirect rejection, no credentials, and exact `1.19.0` compatibility reporting. A configured URL remains attach-only. Without one, Connect probes only `127.0.0.1:4096`; a no-response result may start a manager-owned process only from a trusted workspace. Windows resolves the real `.ps1` from PATH, derives and validates adjacent `node_modules/opencode-ai/bin/opencode.exe`, and spawns that direct child with fixed argv (`serve`, loopback, port `0`, `--pure`), explicit workspace cwd, a 15-second startup bound, and strict stdout URL parsing. Shutdown first requests SDK `instance.dispose()` and waits for both child exit and endpoint unavailability; bounded `/T /F` taskkill is fallback-only for the exact still-live lease-owned root. Current focused tests: 2 files / 18 passed / 1 gated smoke skipped; `pnpm run typecheck` and `pnpm run build` pass. The parent-observed direct-binary `--version` probe exited 0 with `1.19.0`; it is version-only evidence. The previous real smoke used the PowerShell wrapper and does not verify this direct path; no real server smoke was run after the correction. A second same-workspace manager is rejected as busy rather than attached, and unknown stale-lease liveness fails closed. Configured-URL live attach and Extension Host UI behavior remain unverified. Chat, sessions, streaming, tools, permissions, models, MCP, skills, and subagents are not implemented. |
| M3 | Real chat, basic sessions, and event-backed streaming. S2–S5. | Implement prompt and assistant message flow from real 1.19.0 events; test new/open/resume session operations and sidebar/expanded UI behavior. | **Pending.** Depends on M2. |
| M4 | Tool cards and tool-result display. S3, S7. | Map actual tool events/types and truthful state; show only event-supplied duration/input/output/error and verified file-change data. | **Pending.** Depends on M3 and exact event contract. |
| M5 | Permission and question requests. S6. | Exercise pinned request/response routes and server-confirmed state transitions. | **Pending.** Depends on M3 event/state handling. |
| M6 | Session history and model/provider/agent/mode choices. S5. | Verify list/open/resume/create/delete-confirm and recovery from server-returned history; populate choices only from verified APIs and avoid unsupported persistence claims. | **Pending.** Depends on M2–M3 and route verification. |
| M7 | Editor files, references, supported attachments, and diffs. S7–S8. | Use VS Code editor/document context for file/selection/line-range references; gate attachments, file changes, native diffs, and navigation on verified OpenCode payloads. | **Pending.** Depends on M3–M4 and API capability mapping. |
| M8 | MCP servers, skills, tools, and subagents. S9. | Display configured/connected state, skills, tools, and child sessions only where pinned endpoints/events establish them; verify each admin/action endpoint before exposing controls. | **Pending.** Depends on M2–M4 and route verification. |
| M9 | Security, reliability, tests, and performance observations. S2, S4–S11. | Verify trust/credentials/CSP/input boundaries, cancellation, multi-window/workspace isolation, failure recovery, isolated tests, and observed resource use. Build unit/integration/contract/Extension Host/UI checks; optional cost-bearing E2E requires explicit authorization. | **Pending.** The broader security, multi-window, performance, recovery, and host-verification work remains. |
| M10 | Documentation, VSIX, clean install, and report. S1, S3, S10–S11. | Deliver README plus architecture/development/testing/troubleshooting/security/compatibility/changelog docs; inspect VSIX metadata/content and verify the reference checkout is excluded; test clean side-by-side installation; report exact evidence and limitations. | **Pending.** `vsce` was not found in the audit; packaging setup and all deliverables remain undone. |

## Verification evidence and current progress

- Environment facts and tool availability are recorded in [`../../docs/environment-audit.md`](../../docs/environment-audit.md).
- Static, version-pinned source research and its limitations are in [`../../docs/research.md`](../../docs/research.md).
- Accepted decisions and pending implementation choices are in [`../../docs/architecture-decisions.md`](../../docs/architecture-decisions.md).
- The milestone sequence and gates are in [`../../docs/implementation-plan.md`](../../docs/implementation-plan.md); current state is summarized in [`../../docs/progress.md`](../../docs/progress.md).
- M0 evidence remains source/document-level. M1 provides the provisional extension manifest, sidebar and expanded Webviews, validated messages, and assets under ignored `dist/`. M2 adds an ownership-aware SDK health/version path and direct-executable managed-server lifecycle. The current focused run passed 18 tests across 2 files (1 separately gated smoke skipped); typecheck and build pass. The earlier real-CLI smoke used the previous PowerShell-wrapper launch and is not evidence for the direct-executable correction. VS Code Extension Host, visual/theme/keyboard behavior, configured-URL live attach, co-installation, and VSIX remain unverified.
- Clone-local receipt-driven development is off (`clone_local`) following the user's explicit selection. No review receipt, approval, or acknowledgement was produced; ordinary verification is the path. This is not review approval or delivery permission.
- The official-source reference checkout is separate from product files and remains unmodified. Its clone and verification details are recorded in [`../../docs/research.md`](../../docs/research.md); it must be excluded from the future VSIX.
- Details for model/provider discovery, cancellation, attachments, tool/change payloads, MCP/skills/subagents, and persistence semantics remain capability questions until checked against the pinned release. Unsupported capabilities must be documented, not simulated.
- **Next step:** Keep M2 partial until the direct-executable path receives a separately authorized real process smoke, configured-URL live attach, and Extension Host/coexistence checks. Any cleanup failure must remain visible and must not trigger process discovery or taskkill after the owned root exits.

## References

- OpenCode v1.19.0 source, pinned commit `733b2c627e5aec39cb33cc22373bdce33053ef2c`: <https://github.com/anomalyco/opencode/tree/733b2c627e5aec39cb33cc22373bdce33053ef2c>
- Official VS Code extension source at that commit: [`sdks/vscode/src/extension.ts`](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/sdks/vscode/src/extension.ts) and [`sdks/vscode/package.json`](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/sdks/vscode/package.json).
- SDK source: [`packages/sdk/js/src/server.ts`](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/sdk/js/src/server.ts), [`packages/sdk/js/src/v2/index.ts`](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/sdk/js/src/v2/index.ts), and [`packages/sdk/openapi.json`](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/sdk/openapi.json).
- Official documentation: [OpenCode SDK](https://docs.opencode.ai/docs/sdk/), [OpenCode server](https://docs.opencode.ai/docs/server/), [VS Code Extension API](https://code.visualstudio.com/api), and [VS Code Webview guide](https://code.visualstudio.com/api/extension-guides/webview). Current OpenCode docs may reflect v2 and must not override the pinned baseline without compatibility evidence.

## Log

- 2026-10-11 — Created the initial canonical ODD feature record from parent-verified environment and pinned-source research; companion project records and the full Engram mirror are part of M0 verification.
- 2026-10-11 — Corrected scope drift from the master prompt: expanded acceptance coverage for UI/chat, tools/changes, sessions/models, MCP/skills/subagents, platform/security/reliability, verification/delivery; restored the requested M0–M10 sequence. No implementation or test status changed.
- 2026-10-11 — Recorded the parent-verified, clean sparse v1.19.0 reference clone at `upstream-opencode-v1.19.0/`; documented that the product root had no Git metadata at that time and added the future VSIX exclusion check. No product code or tests were added/run.
- 2026-10-11 — Recorded parent-verified Go 1.26.1 Windows/amd64 and version-only Node process-invocation results. Direct `opencode` and extensionless executable probes returned `ENOENT`; explicit PowerShell `-File` returned CLI version 1.19.0. M1 server/lifecycle validation remains pending; no server, tests, or builds were run.
- 2026-10-11 — Implemented the M1 scaffold with a provisional independent identity, Explorer sidebar WebviewView, expanded editor-tab action, React/Vite/Tailwind build, restrictive Webview CSP, and strict Zod message validation. Pinned local dependencies, deterministic tests (2 files/5 passing tests), typecheck, and final production build are recorded in `docs/environment-audit.md`. The M1 status remains partial: no Extension Host/coexistence or visual test was run, and the managed-server Windows lifecycle gate remains unresolved; M2 is not started.
- 2026-10-12 — Implemented the M2 health-only attach path using `@opencode-ai/sdk@1.19.0`, explicit `opencodeVisual.serverUrl`, the sole default `127.0.0.1:4096` endpoint, a bounded `global.health()` request, and truthful health/version/auth/error UI states. Focused/full tests passed (4 files/23 tests), as did typecheck/build. Live smoke was blocked because no server answered at the default endpoint. The pinned Windows cleanup uses forced process-tree termination; managed startup remains blocked because graceful shutdown is unverified. Clone-local receipt-driven development was disabled by explicit user selection; no review receipt or approval exists, and ordinary verification is the path.
- 2026-10-12 — Added managed startup only after the one default loopback probe receives no response. The manager launches the installed CLI with loopback binding, port `0`, `--pure`, and explicit workspace cwd; Windows resolves and invokes the `.ps1` shim using fixed argv and `shell:false`. It parses and validates the actual URL, checks `/global/health` plus exact version, and terminates only its tracked process tree with bounded wait. Focused changed-file tests passed (5 files / 44 passed / 1 gated smoke skipped); typecheck and build passed. The health-only smoke using the installed CLI passed at `1.19.0`, verified shutdown by child exit and endpoint unavailability, and removed its temporary workspace. M2 remains partial pending configured-URL live attach and Extension Host/coexistence checks. RDD remains off for this clone by explicit user choice; no review receipt/approval or delivery action was authorized.
- 2026-10-13 — Corrected Windows ownership to the directly spawned executable. The installed shim was read-only inspected; it invokes its adjacent `node_modules/opencode-ai/bin/opencode.exe`. The manager now resolves the `.ps1` through PATH, realpaths it, derives and validates the adjacent executable, and spawns it directly without a PowerShell child. SDK `instance.dispose()` is attempted first; successful shutdown requires both process exit and endpoint unavailability, with bounded taskkill only for the exact still-live lease-owned root. Focused tests passed (2 files / 18 passed / 1 gated smoke skipped); `pnpm run typecheck` and `pnpm run build` passed. The parent-observed direct executable `--version` probe exited 0 with `1.19.0`. No real server smoke was run after this correction. The earlier wrapper-based smoke left two matching processes; after explicit authorization, PIDs 20696 and 11100 were revalidated, stopped, and confirmed exited; PID 13256 did not match and was left untouched. Same-workspace contention returns busy rather than safely attaching, and unknown stale-lease liveness fails closed. Clone-local RDD remains off by user choice; no review authority or delivery permission exists.
