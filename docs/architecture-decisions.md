# Architecture decisions

These decisions establish the first implementation baseline. “Accepted” records a design direction; it does not claim implementation or runtime verification. The canonical task and acceptance checks remain in [`../odd/tasks/opencode-visual-extension.md`](../odd/tasks/opencode-visual-extension.md).

## ADR-001 — Build an independent extension identity

**Status:** Accepted  
**Decision:** Create a separate VS Code extension with a unique publisher, extension ID, command namespace, and visual identity. Do not modify or impersonate the official OpenCode extension.

**Context:** The official v1.19.0 extension is a terminal launcher/context bridge, while this project targets a chat-first GUI. It is installed separately under `sst-dev.opencode`.

**Alternatives considered:**

- **Modify the official extension:** rejected because it changes the upstream product and does not meet the distinct, side-by-side installation goal.
- **Fork/rebrand or copy upstream UI:** rejected because it increases maintenance and identity confusion; no upstream branding or code reuse is necessary for the initial design.
- **Use a distinct extension:** selected; it preserves coexistence and makes product ownership clear.

**Consequences:** Choose and verify a unique publisher/ID before publishing or packaging. If code is later reused, preserve required MIT copyright/license notices and prefer the public SDK/API.

**Evidence:** [Pinned official manifest](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/sdks/vscode/package.json) and [entry point](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/sdks/vscode/src/extension.ts).

## ADR-002 — Pin the first compatibility target to OpenCode 1.19.0

**Status:** Accepted; health-only client implemented, live OpenCode verification pending  
**Decision:** The initial compatibility baseline is the target machine's OpenCode CLI 1.19.0 and the matching `@opencode-ai/sdk@1.19.0`. Use the package-root SDK or its `./v2` subpath according to the pinned route/types needed; do not equate package subpath `./v2` with CLI version 2.x.

**Context:** The pinned v1.19 SDK contains separate root and v2 clients. The root surface is incomplete for some v2 permission, question, and event operations. Current official docs and current development source are on a newer v2 line.

**Alternatives considered:**

- **Target current OpenCode 2.x immediately:** rejected for the first baseline because no compatibility evidence exists for the installed 1.19.0 CLI.
- **Use only the legacy SDK root client:** rejected because it does not cover every required v2 operation.
- **Use pinned v1.19.0 root and `./v2` surfaces selectively:** selected; the health-only slice uses `./v2/client` and is covered by focused tests. Other routes remain unverified.

**Consequences:** User documentation must state the baseline and limitations. Future OpenCode versions require a separate compatibility change with explicit tests.

**Evidence:** [Pinned SDK entry](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/sdk/js/src/index.ts), [v2 SDK export](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/sdk/js/src/v2/index.ts), and [OpenAPI snapshot](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/sdk/openapi.json).

## ADR-003 — Bound process ownership and make attachment explicit

**Status:** Attachment policy accepted; direct-executable Windows startup and graceful-first owned cleanup implemented and unit-tested; real process smoke for this path is pending  
**Decision:** A managed server is an extension-owned child bound only to `127.0.0.1`, started from an explicit Connect action in a trusted workspace. A configured URL or healthy default loopback server is attachment-only. The extension must not search arbitrary processes/ports or stop processes it did not start and own.

**Context:** The pinned SDK's convenience helper hardcodes the executable, inherits cwd, and cannot express the required workspace, `--pure`, and port-0 launch arguments. Direct Node probes of the shim returned `ENOENT`. The installed `.ps1` shim's read-only inspected body invokes its adjacent `node_modules/opencode-ai/bin/opencode.exe`; the manager now derives and validates that path and spawns the executable directly. The pinned SDK exposes `instance.dispose()`; shutdown must still confirm both child exit and endpoint unavailability. No typed process-discovery route exists. The server may select a port different from 4096 and prints its actual URL.

**Alternatives considered:**

- **Blindly use the convenience helper as the manager:** rejected because it cannot provide the required cwd/argv and does not await exit.
- **Scan ports/processes to find an existing TUI/server:** rejected due to ambiguous ownership and lack of a typed discovery API.
- **Make the user configure a server URL:** accepted as the explicit attachment path; attachment must never imply ownership or shutdown authority.
- **Resolve the shim and spawn its adjacent executable directly:** selected; the shim path is realpathed from PATH, the adjacent executable is validated, and fixed CLI arguments are passed as argv with `shell:false` and the workspace as explicit cwd. The actual reported listener is health/version checked.
- **Use graceful SDK disposal with bounded Windows tree termination as fallback:** selected; `instance.dispose()` is requested first, then the exact child and endpoint are both awaited. `taskkill.exe` is resolved before startup and `/T /F` targets only the exact still-live, lease-owned executable root when graceful shutdown cannot be confirmed. The fallback call and subsequent wait are bounded. The previous real smoke used the PowerShell wrapper and does not verify the direct-executable path.

**Consequences:** Start managed servers only after one no-response default probe, from explicit user action, with a trusted workspace and an absolute cwd. A responding non-OpenCode listener, timeout, auth challenge, or version mismatch does not trigger managed startup. Attachment disconnect only detaches; managed disconnect/disposal awaits both manager-owned child exit and endpoint unavailability. If cleanup cannot be confirmed, surface the error and do not discover or kill any other process. A second manager contending for the same workspace currently receives a busy error rather than attaching to the existing server.

**Evidence:** [Pinned SDK server helper](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/sdk/js/src/server.ts), [server startup](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/opencode/src/cli/cmd/serve.ts), and [server bind/port behavior](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/opencode/src/server/server.ts).

## ADR-004 — Keep the Webview as a UI boundary

**Status:** Accepted  
**Decision:** A minimal Extension Host plus React Webview is the M1 scaffold. The Webview renders the chat experience in a sidebar and an expanded panel/tab; the extension host owns VS Code APIs, server clients, child processes, editor context, and credentials. Webview-to-host messages must be schema-validated and limited to required user actions.

**Context:** The accepted product scope requires sidebar and expanded chat surfaces, editor/file references where supported, and host-only capabilities and secret handling. This is a project requirement, not a claim that the UI or integration already exists.

**Alternatives considered:**

- **Run server/client logic inside the Webview:** rejected because it exposes privileged capabilities and credentials to a less-trusted rendering context.
- **Keep privileged operations in the extension host and communicate through validated messages:** selected; this matches VS Code's Webview guidance.

**Consequences:** Apply restrictive CSP, narrow `localResourceRoots`, `asWebviewUri` for local assets, validated messages, and `getState`/`setState` for persisted Webview state where appropriate. Keep `acquireVsCodeApi` private to the Webview bootstrap. Use VS Code theme tokens for light/dark modes, provide keyboard/accessibility behavior, respect workspace trust, and isolate state across windows/workspaces.

**Evidence:** [VS Code Webview guide](https://code.visualstudio.com/api/extension-guides/webview) and pinned OpenCode [auth](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/opencode/src/server/auth.ts) and [authorization middleware](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/opencode/src/server/middleware/authorization.ts).

## ADR-005 — Establish tests after choosing the project toolchain

**Status:** Accepted  
**Decision:** Do not invent or report an existing test runner. During M1, choose the extension toolchain and define deterministic checks; then add unit, integration, contract, Extension Host/UI, and real OpenCode v1.19.0 checks before or alongside the relevant implementation. Provider-cost end-to-end tests remain optional and require explicit authorization.

**Context:** The workspace is empty and has no manifest, scripts, test framework, or source code. ODD test-first applies where a deterministic test and outcome exist; strict TDD is recorded as disabled for the empty-workspace preflight.

**Alternatives considered:**

- **Assume a standard runner or claim tests exist:** rejected because the environment audit found none.
- **Defer all verification until packaging:** rejected because startup, versioned API mapping, and lifecycle have deterministic failure cases that should be checked earlier.
- **Choose checks with the scaffold and add focused coverage:** selected.

**Consequences:** Isolate test workspaces/fixtures from user workspaces. Progress remains “no tests/build run” until commands exist and execute. Record exact commands, versions, and pass/fail/blocked outcomes in the canonical ODD tracker and progress report. Measure performance and memory as observations against stated scenarios; do not invent targets before a baseline is available. Do not run paid-provider E2E implicitly.

**Evidence:** [`environment-audit.md`](environment-audit.md); no source project or tests were present at audit time.

## ADR-006 — Gate UI affordances on the pinned API contract

**Status:** Accepted  
**Decision:** Only display values, statuses, and actions supported by the connected OpenCode v1.19.0 API/events and verified in implementation. Do not imply behavior through a button, card, indicator, or simulated state before the operation is connected and tested.

**Context:** The requested scope includes dynamic tool cards and states, model/provider/agent/mode choices, context-use indication, file changes/diffs, cancellation, attachments, and MCP/skills/subagents. The parent-supplied static map does not settle every corresponding endpoint or payload.

**Alternatives considered:**

- **Render the full feature surface with placeholder states:** rejected because it would misrepresent unsupported or unverified behavior.
- **Gate presentation on source/API evidence and actual connection behavior:** selected. If an endpoint is absent, document the limitation and omit the control; if its status is not yet verified, keep it out of the enabled product surface until verified.

**Consequences:** Perform feature-specific route/schema review against the pinned OpenAPI/protocol/source and confirm behavior with appropriate contract/integration checks. Show context usage only if a trustworthy value is supplied; show tool metadata only when supplied; map pending/running/completed/failed/cancelled only to actual server data; native diffs/actions require both OpenCode payloads and VS Code APIs.

**Evidence:** [`research.md`](research.md) identifies the known pinned route families and the feature-specific endpoint/payload questions not established by the supplied map.

## ADR-007 — Keep one authoritative milestone tracker

**Status:** Accepted  
**Decision:** `odd/tasks/opencode-visual-extension.md` is the only authoritative source for feature acceptance, milestone status, verification evidence, and next step. The implementation plan and progress snapshot are concise companion records that point to it and do not maintain competing task statuses.

**Context:** Scope correction restores the user's M0–M10 order, with M0 source-level research/architecture, M1 Extension Host + React Webview scaffold and process-lifecycle gate, and M10 documentation/VSIX/clean-install/report delivery.

**Consequences:** Update the canonical ODD milestone row when work changes; keep companion documents aligned without introducing a second task table or conflicting status. M0 research completion does not imply implementation or runtime verification.

## ADR-008 — Keep the upstream checkout as an isolated source reference

**Status:** Accepted; clone and cleanliness verified by parent  
**Decision:** Keep the official OpenCode v1.19.0 source in the shallow/sparse nested checkout `upstream-opencode-v1.19.0/` solely as a read-only reference. It is not a fork or product source.

**Context:** The user explicitly authorized and requested a pinned local source reference. The clone's HEAD is `733b2c627e5aec39cb33cc22373bdce33053ef2c`, the sparse set contains only the documented source directories, and its `git status --short` is empty. The product root is a Git repository with no commits and untracked product files; `.atl/` is ignored runtime-generated state.

**Consequences:** Do not modify files in the reference clone or treat them as extension implementation. Future VSIX packaging must exclude `upstream-opencode-v1.19.0/**` and inspect package contents to confirm no reference source is shipped. This records the authorized research setup; it does not change the independent-extension identity or compatibility decisions above.

**Evidence:** [Pinned OpenCode v1.19.0 source](https://github.com/anomalyco/opencode/tree/733b2c627e5aec39cb33cc22373bdce33053ef2c); verification details in [`research.md`](research.md).

## ADR-009 — Keep the first server connection health-only

**Status:** Health-only attach and direct-executable managed start are implemented; focused checks pass, but real server smoke for the direct path and configured live attach are pending  
**Decision:** Use `@opencode-ai/sdk@1.19.0` through `@opencode-ai/sdk/v2/client` and call only the pinned version-bearing `global.health()` endpoint in this milestone. A user-triggered Connect attaches to an explicit `opencodeVisual.serverUrl`; otherwise it probes exactly `http://127.0.0.1:4096` and may start a managed server only after no HTTP response, in a trusted workspace. Bound health requests to four seconds, reject redirects, send no credentials, and report only verified health/version/ownership state.

**Context:** OpenCode v1.19.0 exposes `/global/health` with `{ healthy: true, version }`; `/api/health` does not return a version. The default endpoint is the only local endpoint probed. The earlier attach-only smoke found no listener there. A subsequent managed smoke started the CLI through the PowerShell wrapper, verified version `1.19.0`, and confirmed the owned endpoint stopped responding; this predates the direct-executable correction. A parent-observed `--version` invocation of the derived executable reports `1.19.0`, but does not test server lifecycle.

**Consequences:** Disconnecting an attached server only clears local state; it never stops that endpoint. Disconnecting a managed server asks the pinned instance API to dispose, then awaits both process exit and endpoint unavailability; bounded taskkill is a lease-verified fallback only. Authentication challenges stop with a message and no credential prompt. Chat, sessions, streaming, tools, permissions, models, MCP, skills, and subagents remain outside this implementation.

**Evidence:** Pinned [`v2/client.ts`](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/sdk/js/src/v2/client.ts), [global health method](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/sdk/js/src/v2/gen/sdk.gen.ts), [health response type](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/sdk/js/src/v2/gen/types.gen.ts), and local smoke outcome in [`environment-audit.md`](environment-audit.md).
