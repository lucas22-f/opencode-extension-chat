# OpenCode and VS Code research

## Executive finding

The inspected OpenCode v1.19.0 VS Code extension is a terminal launcher/context bridge, while the requested product is a separate chat-first UI. Use an independent extension identity and pin the initial compatibility target to OpenCode 1.19.0. Treat current OpenCode 2.x docs and source as version drift, not as a verified contract for the installed CLI.

The M0 entries below record static research and the parent-verified local reference checkout. The M2 addendum records the locally installed SDK, managed-server implementation, the earlier wrapper-based health-only smoke, and the later direct-executable correction. That earlier smoke does not verify the corrected process path. The checkout is official OpenCode source for inspection only; it is not product code or a fork.

## Version and source pins

| Source | Pin | Relevance |
|---|---|---|
| OpenCode release | Tag `v1.19.0`, commit `733b2c627e5aec39cb33cc22373bdce33053ef2c` | Implementation facts for the installed CLI baseline. [Pinned repository tree](https://github.com/anomalyco/opencode/tree/733b2c627e5aec39cb33cc22373bdce33053ef2c). |
| OpenCode development source | Commit `d21b0790a6c146815f28fea604e41e922f009590`; package version 2.0.26 | Comparison only; not declared compatible with 1.19.0. [Current development tree](https://github.com/anomalyco/opencode/tree/d21b0790a6c146815f28fea604e41e922f009590). |
| Published JavaScript SDK | `@opencode-ai/sdk@1.19.0` | Installed locally with pnpm and used through the pinned `@opencode-ai/sdk/v2/client` export. |

## Local pinned reference checkout

The parent cloned the official source into `upstream-opencode-v1.19.0/` directly under the product workspace root with:

```sh
git clone --filter=blob:none --depth 1 --branch v1.19.0 --sparse https://github.com/anomalyco/opencode.git upstream-opencode-v1.19.0
```

The sparse checkout contains these six directory prefixes:

- `sdks/vscode`
- `packages/sdk`
- `packages/opencode/src/cli/cmd`
- `packages/opencode/src/server`
- `packages/protocol/src/groups`
- `packages/server/src`

**Verification supplied by the parent:** `git -C upstream-opencode-v1.19.0 rev-parse HEAD` returned `733b2c627e5aec39cb33cc22373bdce33053ef2c`; `git status --short` in the clone returned no changes; the sparse-checkout list contained the six prefixes above; `Test-Path` confirmed the official VS Code entry point, pinned SDK v2 entry, question protocol group, and server implementation.

**Non-blocking checkout note:** The first sparse-checkout set included the file path `packages/server/src/api.ts`, and Git rejected it with `fatal: 'packages/server/src/api.ts' is not a directory`. The parent reran sparse checkout using the containing directory `packages/server/src`, which succeeded.

The product root now resolves as a Git repository with no commits; product files currently appear untracked in `git status`. `.atl/` is unrelated runtime-generated state and is excluded by `.gitignore` and `.vscodeignore`. The nested reference clone has its own Git metadata and working tree. It is a pinned, clean, read-only reference and was not modified. Do not treat it as product source or as a fork. Future VSIX packaging must exclude `upstream-opencode-v1.19.0/**` and verify that no content from the reference clone is present in the package.

## Official extension behavior

At the pinned release, the official extension manifest is `sdks/vscode/package.json` and its entry point is `sdks/vscode/src/extension.ts`:

- Manifest identity is `sst-dev.opencode`; version is 1.19.0; license is MIT; VS Code engine is `^1.94.0`.
- The extension provides terminal-related commands and context bridging. It does not provide the requested chat-first graphical UI.
- The distinct product goal therefore supports an independent extension rather than changing or impersonating the official extension. The inspected source's MIT license does not remove the obligation to preserve applicable copyright and license notices if code is later reused; API/SDK reuse is preferred.

Pinned references: [`package.json`](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/sdks/vscode/package.json), [`extension.ts`](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/sdks/vscode/src/extension.ts), and the [extension README](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/sdks/vscode/README.md).

## SDK surfaces and API contract

The pinned SDK package exposes a package-root client/server API and a separate `./v2` subpath. They must not be treated as synonymous with OpenCode CLI v2:

- `packages/sdk/js/src/index.ts` implements package-root `createOpencode`: it starts a server using `createOpencodeServer`, creates a package-root client, and returns `{ client, server }`.
- The package's `./v2` export is separately defined in `packages/sdk/js/src/v2/index.ts` and `packages/sdk/js/src/v2/client.ts`. It exposes the v2 API client for the newer `/api/*` routes mounted in the 1.19.0 server.
- The legacy root client is incomplete for some v2 questions, permissions, and event surfaces. Select the correct generated client/types for each route rather than assuming a root-client method exists.
- The pinned OpenAPI snapshot is `packages/sdk/openapi.json`; generated root and v2 clients/types are under `packages/sdk/js/src/gen/*` and `packages/sdk/js/src/v2/gen/*`.

Pinned sources: [`sdk/js/src/index.ts`](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/sdk/js/src/index.ts), [`sdk/js/src/client.ts`](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/sdk/js/src/client.ts), [`sdk/js/src/server.ts`](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/sdk/js/src/server.ts), [`sdk/js/src/v2/index.ts`](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/sdk/js/src/v2/index.ts), and [`sdk/openapi.json`](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/sdk/openapi.json).

## Sessions, events, permissions, and questions

- Pinned protocol groups define session, permission, question, and event shapes in `packages/protocol/src/groups/{session,permission,question,event}.ts`.
- The server mounts v2 API routes through `packages/opencode/src/server/routes/instance/httpapi/server.ts` and `packages/server/src/api.ts`; pinned route definitions are also represented in `packages/protocol/src/groups/{health,event,session,permission,question}.ts`.
- Legacy HTTP API routes are in `packages/opencode/src/server/routes/instance/httpapi/groups/{global,event,session,permission,question}.ts`.
- Legacy SSE and v2 SSE wire envelopes differ. A v2 event includes fields such as `id`, `type`, and `data`; an implementation must decode one selected surface consistently and not mix envelope assumptions.
- The v1.19.0 v2 API includes permission and question routes. Exact request/response behavior must be implemented from pinned types and verified against the server before it is reported as working.

Pinned source links: [protocol groups](https://github.com/anomalyco/opencode/tree/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/protocol/src/groups), [server HTTP API routes](https://github.com/anomalyco/opencode/tree/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/opencode/src/server/routes/instance/httpapi), and [server API mounting](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/server/src/api.ts).

## Additional feature-scope capability boundary

The parent-supplied source map establishes that the pinned release has session, permission, question, event, and health API/protocol surfaces, with distinct legacy and v2 event formats. It does **not** document a complete route/schema audit for every requested feature below. This is a research boundary, not evidence that an API is absent:

| Feature family | What the supplied pinned map establishes | What remains to verify against v1.19.0 before exposing UI behavior |
|---|---|---|
| Provider/model/agent/mode selection | The SDK has generated root/v2 clients and an OpenAPI snapshot. | Exact list endpoints, eligible values, selection fields, mode/agent semantics, and error behavior. Populate only from verified server data. |
| Streaming and cancellation | Legacy/v2 SSE exist and their envelopes differ. | Which events represent partial assistant output, tool transitions, cancellation, and terminal states; the exact supported cancellation operation and outcome. Do not simulate these states. |
| Tools and file changes | Event groups exist. | Tool event variants, dynamic tool identifiers, supplied duration/input/output/error fields, file-change payloads, and links to source ranges. Render only fields present in verified payloads. |
| Editor context and attachments | VS Code provides editor/document APIs; the OpenCode source map identifies session/message surfaces. | Whether the v1.19.0 request schema accepts file, selection, line-range, or attachment content and how it expects those values. |
| Context-use indicator | No trustworthy token/context-usage field was identified in the supplied map. | Whether the pinned API provides a documented value and its scope/units. Omit the indicator unless verified. |
| MCP servers, skills, and subagents | Session/event source paths are identified. | Whether there are 1.19.0 list/status/configuration/action routes and event relationships for configured servers, tools, skills, and child sessions. Do not invent states or administrative controls. |
| Session persistence and history | Session route/type families exist. | Exact list/create/open/resume/delete behavior and server persistence semantics. Recovery must be based on server-returned data, not an assumed local persistence promise. |

When the pinned OpenAPI/protocol/source review establishes that an operation is absent or unsupported, document that limitation and omit the corresponding action. A research gap alone must be recorded as “not yet verified,” not mislabeled “unsupported.” A visible control is not evidence of functional support; only a connected and tested operation is.

## Editor and Webview scope

The product requirements call for a sidebar view plus an expanded panel/tab, Markdown and code rendering/copy, a multiline composer, keyboard behavior, light/dark VS Code themes, accessibility, file/selection/line-range references, and supported attachments. These are product requirements, not claims about existing OpenCode behavior. Verify OpenCode payload requirements against the pinned release and use VS Code editor and Webview APIs for host-owned editor context and a restrictive Webview boundary. VS Code guidance is at [Extension API](https://code.visualstudio.com/api) and [Webview guide](https://code.visualstudio.com/api/extension-guides/webview).

The host owns connection/process/credential functions. Validate Webview messages, use restrictive CSP and `localResourceRoots`, use `asWebviewUri` for local assets, and keep VS Code API acquisition private to Webview bootstrap code. Respect workspace trust and isolate multiple windows/workspaces.

## Server startup, health, and discovery

- In the pinned SDK, `createOpencode` starts an `opencode serve` child and returns the client and server handle. The helper defaults to host `127.0.0.1` and port `4096`, parses the actual listening URL from output, and supports closing the launched server. It is not used because it hardcodes the executable, inherits cwd, cannot supply `--pure` or the required arguments, and its close path does not await process exit.
- The pinned server tries port 4096 before falling back to port 0. The actual URL must therefore come from startup output rather than a hardcoded port.
- `createOpencodeTui` is a different helper that inherits stdio. The server process helper and process-stop/abort bindings are in `packages/sdk/js/src/server.ts` and `packages/sdk/js/src/process.ts`.
- The convenience `createOpencode` helper hardcodes the executable name `opencode`, inherits the parent cwd, and does not expose executable-path or cwd options. The read-only inspected Windows `.ps1` shim invokes `"$basedir/node_modules/opencode-ai/bin/opencode.exe"` directly and forwards `$args`. The manager now realpaths the shim found on PATH, derives and validates that adjacent executable, and spawns the executable directly; no PowerShell child is used for managed startup.
- The pinned `packages/opencode/package.json` is version `1.19.0` and declares its package bin as `./bin/opencode`. The installed Windows shim layout observed on this host resolves the packaged `opencode-ai/bin/opencode.exe` separately; runtime version compatibility is still checked through `/global/health` after startup.
- Direct `opencode serve --help` reports hostname default `127.0.0.1` and port default `0`. This CLI help default and the SDK helper's port 4096 default are different configuration layers, not contradictory runtime observations.
- `packages/opencode/src/cli/cmd/serve.ts` logs `opencode server listening on http://<hostname>:<actual-port>`; `packages/opencode/src/server/server.ts` owns port fallback behavior.
- `/global/health` returns health and version. `/api/health` returns only `{ healthy: true }`; use the version-bearing route when a version check is required.
- There is no typed route for discovering arbitrary existing TUI/server processes. Optional `--mdns` is DNS-SD, not a process-discovery API, and can affect bind behavior. On an explicit Connect action, the extension attaches to a configured URL without ownership, or probes only `127.0.0.1:4096`. It starts a managed server only if that probe receives no HTTP response; a responding non-OpenCode endpoint, timeout, auth challenge, or version mismatch does not trigger startup. No port/process scan occurs.

### Parent-verified Windows version-invocation probes

The parent also verified `go version go1.26.1 windows/amd64`. The following Node.js `spawn` probes used the product workspace as cwd and invoked only `--version`:

| Invocation | Result |
|---|---|
| `spawn('opencode', ['--version'], { cwd: workspace, stdio: ... })` | `ENOENT` |
| `spawn('C:\\nvm4w\\nodejs\\opencode', ['--version'], { cwd: workspace, stdio: ... })` | `ENOENT` |
| `spawn('powershell.exe', ['-NoProfile', '-File', 'C:\\nvm4w\\nodejs\\opencode.ps1', '--version'], { cwd: workspace, stdio: ... })` | Exit 0; stdout `1.19.0` |
| `spawnSync(<absolute executable derived from the real shim path>, ['--version'], { cwd: workspace, ... })` | Parent-observed exit 0; stdout `1.19.0` |

The SDK convenience helper's hardcoded `spawn('opencode', ...)` invocation cannot be assumed to work in this host. Managed Windows startup resolves the real `.ps1` shim from absolute PATH entries, derives and validates adjacent `node_modules/opencode-ai/bin/opencode.exe`, and starts that executable directly with `['serve', '--hostname=127.0.0.1', '--port=0', '--pure']`, the trusted workspace cwd, and `shell:false`. The manager accepts only the actual `127.0.0.1` URL printed by the process, with a 15-second startup bound, and verifies `/global/health` and version before reporting success.

The manager first requests the pinned SDK `instance.dispose()` operation and waits for both the tracked executable child to exit and its endpoint to become unavailable. Only after that bounded attempt fails may it use bounded `taskkill /PID <owned executable pid> /T /F`, after confirming the child is still live and the workspace lease still owns it. It never invokes taskkill for an attached server, an exited process, or an unowned root. If cleanup is not confirmed, the error remains visible and no process discovery or retry against another PID is attempted. The earlier installed-CLI health-only smoke passed using the PowerShell wrapper, before this direct-executable correction; it is not evidence for the current process path. The parent-observed direct executable `--version` probe only verifies CLI version `1.19.0`, not server startup or lifecycle. No real server smoke was run after the correction.

Pinned references: [`sdk/js/src/server.ts`](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/sdk/js/src/server.ts), [`sdk/js/src/process.ts`](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/sdk/js/src/process.ts), [`cli/cmd/serve.ts`](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/opencode/src/cli/cmd/serve.ts), and [`server/server.ts`](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/opencode/src/server/server.ts).

### M2 health-only client and runtime result

- The Extension Host imports `createOpencodeClient` and `GlobalHealthResponse` from `@opencode-ai/sdk/v2/client`; the selected endpoint is the pinned `/global/health` method, whose v1.19.0 response includes `{ healthy: true, version: string }`.
- The request has a 4-second abort bound and rejects redirects. The extension sends no credentials, never prompts for them, and treats HTTP 401/403 as an authentication stop. The supported version is exactly `1.19.0`; other healthy versions render as a mismatch.
- `opencodeVisual.serverUrl` is an explicit HTTP(S) setting. If empty, a user-triggered Connect checks only `http://127.0.0.1:4096`. A network-level no-response result may start the managed process described above, and only in a trusted workspace with an absolute workspace directory. The actual URL is parsed from stdout; no adjacent port is probed.
- Connection and process tests verify attached versus managed ownership, no launch after any HTTP response, auth/mismatch/timeout handling, URL parsing, startup timeout/refusal, exact process-tree targeting, and bounded cleanup. Focused changed-file run: 5 files / 44 passed / 1 gated smoke skipped. `pnpm run typecheck` and `pnpm run build` pass.
- The earlier `pnpm run smoke:opencode-health` result was **BLOCKED (exit 2)** because nothing answered at `127.0.0.1:4096`. The subsequent managed smoke ran the real installed CLI in a temporary product-root workspace and checked only `/global/health`: **passed**, version `1.19.0`, owned process exited, endpoint unavailable after shutdown, and temporary workspace removed. No prompt, provider request, model call, credentials, or paid service was used.

## Authentication and VS Code Webview boundaries

- Pinned OpenCode authentication and authorization code is in `packages/opencode/src/server/auth.ts` and `packages/opencode/src/server/middleware/authorization.ts`.
- If Basic authentication is needed, credentials belong in the extension host and appropriate VS Code secret storage, never in Webview markup, scripts, or messages.
- VS Code's Webview guidance recommends restrictive CSP and `localResourceRoots`, `asWebviewUri` for local resources, validating messages, retaining extension APIs/processes in the host, and using `getState`/`setState` rather than hidden contexts for state where applicable.

References: [OpenCode v1.19.0 auth source](https://github.com/anomalyco/opencode/tree/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/opencode/src/server), [VS Code Extension API](https://code.visualstudio.com/api), and [VS Code Webview guide](https://code.visualstudio.com/api/extension-guides/webview).

## Facts, assumptions, and verification limits

| Category | Statement |
|---|---|
| Pinned source fact | The official v1.19.0 VS Code extension is terminal-focused; the v1.19 SDK has a distinct `./v2` subpath and v2 server routes. |
| Environment fact | The target has OpenCode CLI v1.19.0 and Go 1.26.1 (`windows/amd64`); PowerShell resolves `opencode` to a `.ps1` shim; `@opencode-ai/sdk@1.19.0` is installed locally. |
| Version-only process evidence | Node `spawn('opencode', ...)` and spawn of `C:\\nvm4w\\nodejs\\opencode` both returned `ENOENT` for `--version`; explicit PowerShell `-File ... --version` returned exit 0 and `1.19.0`. |
| Design recommendation | Build an independently identified chat extension, start with the v1.19.0 contract, keep credentials and process control in the extension host, and make server attachment explicit. |
| Process lifecycle evidence and limit | Current direct-executable resolution, graceful-dispose ordering, bounded fallback, and lease checks are covered by focused unit tests. A prior wrapper-based real smoke predates the correction; there has been no real server smoke for the direct executable path. |
| Pending static contract review | Model/agent/mode enumeration, attachments, context usage, cancellation, tool/file-change fields, MCP/skills/subagent routes, and precise persistence semantics need endpoint/schema verification in the pinned source. The supplied map does not prove absence or availability. |
| Runtime verification | Current focused tests (2 files / 18 passed / 1 gated smoke skipped), typecheck, and build passed. The parent-observed direct executable `--version` probe exited 0 with `1.19.0`. The earlier real server smoke used the previous PowerShell-wrapper path and does not verify this correction. Configured-URL live attach and Extension Host/coexistence checks remain unverified. |
| Explicit non-claim | No process discovery, provider E2E, VSIX packaging, clean-install/coexistence test, or OpenCode 2.x compatibility check has occurred. |

## Current official documentation and version drift

Official OpenCode documentation currently presents v2, and the development source inspected was at commit `d21b0790a6c146815f28fea604e41e922f009590` / package 2.0.26. Those docs and source are useful for future comparison, but are not proof that APIs or SDK behaviors apply to installed CLI 1.19.0. The implementation baseline remains the pinned release source plus the published `@opencode-ai/sdk@1.19.0` package, verified through an M1 compatibility spike and subsequent feature-specific contract checks. Current 2.x remains unsupported until a separate compatibility change is verified.

Official references: [OpenCode SDK docs](https://docs.opencode.ai/docs/sdk/) and [OpenCode server docs](https://docs.opencode.ai/docs/server/).
