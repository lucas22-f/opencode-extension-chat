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

**Status:** Accepted; health-only client implemented and its managed path smoke-tested; configured live attach and graceful shutdown remain pending
**Decision:** The initial compatibility baseline is the target machine's OpenCode CLI 1.19.0 and the matching `@opencode-ai/sdk@1.19.0`. Use the package-root SDK or its `./v2` subpath according to the pinned route/types needed; do not equate package subpath `./v2` with CLI version 2.x.

**Context:** The pinned v1.19 SDK contains separate root and v2 clients. The root surface is incomplete for some v2 permission, question, and event operations. Current official docs and current development source are on a newer v2 line.

**Alternatives considered:**

- **Target current OpenCode 2.x immediately:** rejected for the first baseline because no compatibility evidence exists for the installed 1.19.0 CLI.
- **Use only the legacy SDK root client:** rejected because it does not cover every required v2 operation.
- **Use pinned v1.19.0 root and `./v2` surfaces selectively:** selected; the health-only slice uses `./v2/client` and is covered by focused tests. Other routes remain unverified.

**Consequences:** User documentation must state the baseline and limitations. Future OpenCode versions require a separate compatibility change with explicit tests.

**Evidence:** [Pinned SDK entry](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/sdk/js/src/index.ts), [v2 SDK export](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/sdk/js/src/v2/index.ts), and [OpenAPI snapshot](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/sdk/openapi.json).

## ADR-003 — Bound process ownership and make attachment explicit

**Status:** Attachment policy accepted; direct-executable Windows startup and graceful-first owned cleanup implemented and unit-tested; user-run health-only managed smoke passed with owned-tree fallback, so graceful shutdown remains unverified
**Decision:** A managed server is an extension-owned child bound only to `127.0.0.1`, started from an explicit Connect action in a trusted workspace. A configured URL or healthy default loopback server is attachment-only. The extension must not search arbitrary processes/ports or stop processes it did not start and own.

**Context:** The pinned SDK's convenience helper hardcodes the executable, inherits cwd, and cannot express the required workspace, `--pure`, and port-0 launch arguments. Direct Node probes of the shim returned `ENOENT`. The installed `.ps1` shim's read-only inspected body invokes its adjacent `node_modules/opencode-ai/bin/opencode.exe`; the manager now derives and validates that path and spawns the executable directly. The pinned SDK exposes `instance.dispose()`; shutdown must still confirm both child exit and endpoint unavailability. A cancellation guard after lease acquisition prevents spawn and releases the acquired lease; a lease conflict is surfaced with its specific busy message. No typed process-discovery route exists. The server may select a port different from 4096 and prints its actual URL.

**Alternatives considered:**

- **Blindly use the convenience helper as the manager:** rejected because it cannot provide the required cwd/argv and does not await exit.
- **Scan ports/processes to find an existing TUI/server:** rejected due to ambiguous ownership and lack of a typed discovery API.
- **Make the user configure a server URL:** accepted as the explicit attachment path; attachment must never imply ownership or shutdown authority.
- **Resolve the shim and spawn its adjacent executable directly:** selected; the shim path is realpathed from PATH, the adjacent executable is validated, and fixed CLI arguments are passed as argv with `shell:false` and the workspace as explicit cwd. The actual reported listener is health/version checked.
- **Use graceful SDK disposal with bounded Windows tree termination as fallback:** selected; `instance.dispose()` is requested first, then the exact child and endpoint are both awaited. `taskkill.exe` is resolved before startup and `/T /F` targets only the exact still-live, lease-owned executable root when graceful shutdown cannot be confirmed. The fallback call and subsequent wait are bounded. Earlier cancelled/hung smoke attempts left two OpenCode processes; after explicit user authorization, PIDs 20696 and 11100 were revalidated, stopped, and confirmed exited; unrelated PID 13256 was left untouched. A later user-run smoke passed its health and cleanup assertions with `SMOKE_SHUTDOWN=owned-tree-fallback`: graceful SDK disposal did not stop the process within the grace window, and the bounded fallback forcibly terminated only the owned process tree. This is cleanup evidence, not graceful-shutdown evidence.

**Consequences:** Start managed servers only after one no-response default probe, from explicit user action, with a trusted workspace and an absolute cwd. A responding non-OpenCode listener, timeout, auth challenge, or version mismatch does not trigger managed startup. Attachment disconnect only detaches; managed disconnect/disposal awaits both manager-owned child exit and endpoint unavailability. If cleanup cannot be confirmed, surface the error and do not discover or kill any other process. A second manager contending for the same workspace receives the specific busy error and cannot spawn a duplicate. No cross-window auto-attach path exists. Clone-local RDD is off by explicit user choice; no review receipt, approval, or delivery permission exists.

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

**Context:** The requested scope includes dynamic tool cards and states, provider/model/agent choices, context-use indication, file changes/diffs, cancellation, attachments, and MCP/skills/subagents. The parent-supplied static map does not settle every corresponding endpoint or payload.

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

**Context:** The user explicitly authorized and requested a pinned local source reference. The clone's HEAD is `733b2c627e5aec39cb33cc22373bdce33053ef2c`, the sparse set contains only the documented source directories, and its `git status --short` is empty. The product root has initial commit `ff009af` (`first commit`) with current task changes tracked on `main`; `.atl/` is ignored runtime-generated state.

**Consequences:** Do not modify files in the reference clone or treat them as extension implementation. Future VSIX packaging must exclude `upstream-opencode-v1.19.0/**` and inspect package contents to confirm no reference source is shipped. This records the authorized research setup; it does not change the independent-extension identity or compatibility decisions above.

**Evidence:** [Pinned OpenCode v1.19.0 source](https://github.com/anomalyco/opencode/tree/733b2c627e5aec39cb33cc22373bdce33053ef2c); verification details in [`research.md`](research.md).

## ADR-009 — Keep the first server connection health-only

**Status:** The M2 health route and direct-executable managed start are implemented; the user-run health-only managed smoke passed with owned-tree fallback. The user manually observed Connected to OpenCode 1.19.0 in the Extension Development Host. Graceful shutdown, configured live attach, and automated Extension Host/coexistence checks remain pending.
**Decision:** Use `@opencode-ai/sdk@1.19.0` through `@opencode-ai/sdk/v2/client` and call only the pinned version-bearing `global.health()` endpoint in this milestone. A user-triggered Connect attaches to an explicit `opencodeVisual.serverUrl`; otherwise it probes exactly `http://127.0.0.1:4096` and may start a managed server only after no HTTP response, in a trusted workspace. Bound health requests to four seconds, reject redirects, send no credentials, and report only verified health/version/ownership state.

**Context:** OpenCode v1.19.0 exposes `/global/health` with `{ healthy: true, version }`; `/api/health` does not return a version. The default endpoint is the only local endpoint probed. The earlier attach-only smoke found no listener there. Earlier cancelled/hung managed smoke attempts left PIDs 20696 and 11100, later revalidated and stopped only after explicit user authorization; unrelated PID 13256 was left untouched. The latest user-run health-only smoke verified a loopback listener, `{healthy:true,version:'1.19.0'}`, owned-process stop, endpoint unavailability, and empty lease directory. It used no provider prompt or credential, and its product-root temp workspace was removed in `finally`.

**Consequences:** Disconnecting an attached server only clears local state; it never stops that endpoint. Disconnecting a managed server asks the pinned instance API to dispose, then awaits both process exit and endpoint unavailability; bounded taskkill is a lease-verified fallback only. The completed smoke reported `SMOKE_SHUTDOWN=owned-tree-fallback`: graceful SDK disposal did not stop the process within the grace window, and bounded fallback forcibly terminated only the owned process tree. This verifies the health-only managed path and cleanup for the tested Windows/CLI version, not graceful shutdown. Configured live attach and automated Extension Host/coexistence checks remain pending. Authentication challenges stop with a message and no credential prompt. M3 chat/session work is implemented and deterministically mocked but has not been exercised against a real OpenCode prompt. M8 is separately implemented as a read-only capability inventory with mocked transport; no live capability request has been made. M4 tool cards and live M5/M6/M8 operations remain unverified. Clone-local RDD is off by user choice; no review receipt, approval, or delivery permission exists.

**Evidence:** Pinned [`v2/client.ts`](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/sdk/js/src/v2/client.ts), [global health method](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/sdk/js/src/v2/gen/sdk.gen.ts), [health response type](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/sdk/js/src/v2/gen/types.gen.ts), and local smoke outcome in [`environment-audit.md`](environment-audit.md).

## ADR-010 — Use the pinned v2 session and native event surface

**Status:** Implemented with deterministic mocked-transport tests; exact durable-admission retry semantics are source-verified at the pinned 1.19.0 commit, while real prompt/session/assistant-stream behavior remains unverified. M6 pagination and session-list visibility supersede the earlier 50-visible-session consequence below; see ADR-011.
**Decision:** Implement M3 using `client.v2.session.list/create/messages/prompt` and `client.v2.event.subscribe()` from the exact `@opencode-ai/sdk@1.19.0` package. Decode the v2 `{ id, type, data }` event envelope; render assistant text only from actual `session.next.text.delta` and `session.next.text.ended` payloads. Map a Webview request UUID deterministically to `msg_${requestID}` for the optional server prompt ID.

**Context:** The package-root client and its `./v2` subclient are distinct. Root `client.session` and `client.event` use legacy routes/envelopes. The v2 session-specific durable event route excludes text-delta events, while native `/api/event` emits them and begins with `server.connected` after listener installation. The native stream has no replay cursor for those deltas. Pinned `SessionMessage.AssistantText` history parts and text events share a part ID (`AssistantText.id` / event `textID`), but the schema stores only ID and text—not a per-part event timestamp or delta sequence. The history handler returns projected messages directly; the projector maps events to parts by that shared ID, appending deltas and replacing text on the replayable ended event. Therefore event timestamps cannot establish whether a late delta is already represented in history. The pinned `SessionMessage.ID` schema requires the `msg_` prefix. `SessionV2.prompt` passes an ID to `SessionInput.admit`, compares the returned record against session/prompt/delivery, and reports conflict on mismatched reuse; core tests verify exact and concurrent retries create one durable admission.

**Consequences:** Session access is initialized only for a trusted workspace; the host derives its directory and accepts bounded text/session IDs from the Webview. Visible sessions are capped at 50 while the active session ID is retained separately and displayed in a separately labeled sidebar entry when outside the newest 50. The event listener is installed before history fetch; text events are buffered through the snapshot and history is reloaded on reconnect. A stable request UUID determines the server `msg_` ID; each send attempt has a fresh Webview/host `attemptID` so a stale outcome cannot complete a later manual retry with the same request UUID. For a late delta targeting a history-mapped part with no event timestamp, suppress it if its text is already contained in the snapshot; otherwise merge its overlap before updating the message. A text-ended event replaces partial text with its full value. This avoids verbatim duplication while retaining new suffixes, but repeated substrings may make a genuinely new fragment indistinguishable from one already represented, so no lossless claim is made. Known route 4xx errors are rejection; ambiguous transport outcomes preserve the draft, surface “outcome unknown,” and are never automatically retried. A user can explicitly retry only with the same session and unchanged text, reusing the same `msg_` server ID; changing either creates a new prompt ID. Drafts clear only after validated accepted admission for the current attempt. This prevents duplicate durable admission for an exact retry, but does not claim exactly-once execution/provider effects because `SessionV2.prompt` may request an execution wake for each call. Stream updates are filtered by session ID, keyed by assistant-message/text-part IDs, deduplicated by event ID, and processed in SSE order while dropping strictly older timestamps where those are available. The event controller is aborted on session switch, last-view close, disconnect, and extension shutdown. There is no delta replay cursor or sequence in projected history, and events before listener installation cannot be replayed. No tool, reasoning, cancellation, provider/model, or permission affordance is added in M3. Real assistant streaming is not claimed until an explicitly authorized prompt is observed.

**Evidence:** Pinned [v2 session routes](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/protocol/src/groups/session.ts), [v2 message route](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/protocol/src/groups/message.ts), [SessionMessage schema](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/schema/src/session-message.ts), [SessionEvent schema](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/schema/src/session-event.ts), [message history handler](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/server/src/handlers/message.ts), [SessionMessageUpdater](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/core/src/session/message-updater.ts), [native event handler](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/server/src/handlers/event.ts), and [pinned generated v2 message types](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/sdk/js/src/v2/gen/types.gen.ts). Prompt ID/dedup evidence remains in pinned [core SessionV2](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/core/src/session.ts), [SessionInput](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/core/src/session/input.ts), and [exact-retry tests](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/core/test/session-prompt.test.ts). Product regressions are in `tests/opencode-chat.test.ts`, `tests/prompt-composer.test.ts`, and `tests/webview.test.tsx`.

## ADR-011 — Use server cursors and explicit server-returned choices for M6

**Status:** Implemented with deterministic mocked-transport/UI tests; live OpenCode 1.19.0 behavior remains unverified.

**Decision:** Page session lists through `client.v2.session.list` with server search/cursors and page history through `client.v2.session.messages`. Use only location-scoped provider/model/agent list results; expose model and agent changes through the pinned create/switch fields. Do not expose `Agent.Info.mode` as a selector. Use root `client.session.delete` only because the exact pinned SDK route is available, and gate every request behind a native modal where Cancel is first and marked as the close/Escape action.

**Rationale:** The v2 session endpoints provide cursor pagination and supported model/agent switches, but no v2 delete method or independent provider/mode switch. Provider/model discovery is experimental, so the UI must show a truthful unavailable/error state when those server calls fail rather than presenting local defaults. The legacy root client method is still present on the installed v2 client and maps specifically to `DELETE /session/{sessionID}`; deletion permanently removes messages/history, making host-native explicit confirmation mandatory.

**Consequences:** Session pages remain in server order, and page merges preserve one row per session ID while retaining the selected session outside current results. History pages are ordered and deduplicated similarly; pinned v1.19.0 prohibits combining a message `cursor` with `order`, but permits combining `cursor` with `limit`. The current client omits `limit` on older-page requests and therefore receives the server default of 50. A non-empty final page may still return `cursor.next`, so pagination performs one final empty-page request before hiding the control. Provider filtering only narrows returned models; it does not claim an independent provider switch. Delete cancellation never calls OpenCode. Focused mocked verification passed 90 tests across three files; no live list/history/choice/switch/delete request was sent.

**Evidence:** Pinned SDK declarations in `node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts` and `types.gen.d.ts` (`@opencode-ai/sdk@1.19.0`); route/search/history/choice/delete regressions in `tests/opencode-chat.test.ts`; rendered controls in `tests/webview.test.tsx`; Webview action validation in `tests/webview-message.test.ts`.

## ADR-012 — Keep editor context explicit and inside prompt text

**Status:** Implemented with deterministic tests; live VS Code host and OpenCode prompt behavior remain unverified.

**Decision:** Add editor context only after an explicit composer action or command. The Extension Host captures only the trusted active editor’s workspace-relative file reference and, when selected, the exact selected buffer text plus its inclusive 1-based line range. Insert the bounded result as a visible editable block in the prompt draft and send it through the pinned v1.19.0 v2 `PromptInput.text` field only.

**Rationale:** A visible full-text draft keeps user review/editing explicit and binds exact retries to the same canonical text without hidden payload or session side channel. The Webview must never choose paths or supply editor data. A path hint cannot promise that an external or remote server can read a local workspace.

**Consequences:** `OpenCodeConnection.connect` snapshots the directory argument before asynchronous health/startup and publishes that exact root only on successful supported connection. `OpenCodeChat` builds its client from that snapshot; it does not sample mutable `workspaceFolders[0]` after the await. Capture uses `OpenCodeChat.connectedWorkspaceDirectory` and verifies that the canonical root is still the active first workspace folder. After realpath checks it re-reads workspace folders and active editor immediately before producing the block; changes to the root, folder order, or active editor fail closed. A missing/disconnected root, removed/reordered folder, out-of-root document, or different owning folder fails with a visible message; workspace changes do not refresh or switch the client. Capture also requires workspace trust and a `file:` document; lexical and canonical realpath containment reject traversal and symlink escapes, with Windows path semantics for case handling. `TextDocument.getText(selection)` is the only document-content read, so no selection emits a reference without file contents. The selection is capped at 8,000 characters and the resulting context block at 10,000; overflow is rejected, never truncated. The pinned SDK type declares optional `PromptInput.files`, but this implementation does not send it, legacy `parts`, or expose an upload control because remote attachment processing is not established. `session.diff` stays separate; native diff navigation and associations from `file.edited` or tool output paths are not implemented.

**Evidence:** Pinned [v2 session prompt route](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/protocol/src/groups/session.ts), generated [`PromptInput`](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/sdk/js/src/v2/gen/types.gen.ts), and M7 regressions in `tests/editor-context.test.ts`, `tests/opencode-chat.test.ts`, `tests/prompt-composer.test.ts`, and Webview protocol/render tests. The in-flight connected-root correction’s focused tests passed 2 files / 55 tests; typecheck/build passed.

## ADR-013 — Isolate M8 as a read-only capability inventory

**Status:** Implemented with deterministic mocked adapter/protocol/Webview tests; live capability requests remain unverified.

**Decision:** Keep M8 in a separate Extension Host `OpenCodeCapabilities` adapter and separate Webview capability state. Load MCP status, provider/model tool metadata, skill metadata, and child sessions independently; expose only load/refresh controls. Do not change M4 tool-event cards or add MCP, skill, tool-invocation, or session-mutation operations.

**Rationale:** The pinned endpoints return different facts and have different scopes. Separating capability loading prevents an unavailable experimental route from blocking chat and keeps metadata distinct from execution. A separate state boundary also makes it possible to strip skill content/locations and invalidate child results when the selected parent changes.

**Consequences:** `GET /mcp` provides only server-name/status pairs, not per-server tool ownership; `POST/PATCH /mcp` mutate configuration and no separate enable endpoint is available. `GET /experimental/tool` requires a known provider/model and describes the server default agent, not necessarily the selected agent. `GET /api/skill` returns content/location but the Webview receives only name/description; no source-state field is returned. The v2 session list does not accept a parentID filter, so bounded pages are scanned and filtered by exact `parentID === selectedSessionID`; “Subagent” is shown only for a matching `/api/agent` result with `mode: subagent`. The legacy children route is not used, and `backgroundSubagents` is not an inference source. No active execution or unsupported administrative state is implied.

**Evidence:** Pinned `@opencode-ai/sdk@1.19.0` v2 declarations in `upstream-opencode-v1.19.0/packages/sdk/js/src/v2/gen/{sdk.gen,types.gen}.ts`; implementation in `src/extension/opencode-capabilities.ts` and `src/shared/capability-state.ts`; mocked adapter and Webview/protocol coverage in `tests/opencode-capabilities.test.ts`, `tests/webview.test.tsx`, and `tests/webview-message.test.ts`.
