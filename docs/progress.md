# Progress snapshot

**As of:** 2026-10-13  
**Overall:** M0 is complete; M1 and M2 are partial. The pinned health/version path and direct-executable managed startup are implemented and pass focused checks. An earlier real smoke used the PowerShell wrapper and does not verify the direct-executable correction; no real server smoke was run after that change. Configured-URL live attach and VS Code Extension Host/coexistence checks remain pending.  
**Authoritative status and milestone sequence:** [`../odd/tasks/opencode-visual-extension.md`](../odd/tasks/opencode-visual-extension.md).

## Current state

- The requested UI/chat, tools/change display, sessions/models, MCP/skills/subagents, platform/security/reliability, verification/delivery scope is now explicitly represented by ODD specs and observable acceptance checks.
- The authoritative milestone sequence is restored to the requested intent: M0 research/architecture; M1 Extension Host + React Webview; M2 connection/health; M3 chat/sessions/streaming; M4 tools; M5 permissions/questions; M6 history/models; M7 editor context/diffs; M8 MCP/skills/subagents; M9 security/reliability/tests/performance; M10 docs/VSIX/clean install/report.
- The five supporting records are aligned to that scope. The implementation plan mirrors sequence only; the ODD feature document remains the sole milestone/status tracker.
- M1 provides an independent provisional VS Code extension identity, an Explorer sidebar WebviewView, an expanded editor tab, and a bundled React + Tailwind v4 Webview.
- M2 uses exact `@opencode-ai/sdk@1.19.0`, `@opencode-ai/sdk/v2/client`, and the pinned version-bearing `global.health()` method. A configured `opencodeVisual.serverUrl` is always attached without shutdown authority. With no URL, Connect probes only `http://127.0.0.1:4096`; only a no-HTTP-response result may start a managed server.
- Managed startup requires a trusted workspace and uses its absolute directory as cwd. Windows resolves the real `opencode.ps1` path from an absolute PATH entry, derives and validates the adjacent `node_modules/opencode-ai/bin/opencode.exe`, then spawns that executable directly with fixed argv and `shell:false`. Other platforms invoke `opencode` directly. The process binds to `127.0.0.1`, uses `--port=0 --pure`, and its URL must be parsed from stdout and pass health/version validation.
- The manager owns the direct child it starts. Shutdown first requests pinned SDK `instance.dispose()`, then awaits both child exit and endpoint unavailability. Only if that bounded graceful wait fails may bounded `taskkill /T /F` target the exact still-live child PID after lease ownership is confirmed. Cleanup failure is surfaced; attached servers and exited/unowned processes are never taskkilled. No process discovery or arbitrary port scan occurs.
- Health requests are bounded to 4 seconds, do not follow redirects, send no credentials, and report exact `1.19.0` compatibility or mismatch. The Webview reports attach/managed ownership and the correct disconnect/stop action; it remains health/version only. Chat, sessions, streaming, tools, permissions, models, MCP, skills, and subagents are not implemented.
- The Webview uses a restrictive CSP with a per-render nonce, a narrow built-assets root, `asWebviewUri`, and private `acquireVsCodeApi` access. Webview actions and host-published connection-state messages are Zod-validated; invalid/extra-field messages do not dispatch.
- Exact local package pins and verification outcomes are recorded in [`environment-audit.md`](environment-audit.md). Current focused verification passed: 2 files / 18 tests passed / 1 gated smoke skipped; `pnpm run typecheck` and `pnpm run build` pass. The prior 5-file run and real smoke predate the direct-executable correction. There is no configured lint script.
- The canonical ODD document is fully mirrored and verified in explicit product project `opencode-extension-chat` at `odd/opencode-visual-extension/tasks`; its current observation ID is recorded in the implementation report.
- The official source reference is a clean shallow/sparse checkout at `upstream-opencode-v1.19.0/`, verified at commit `733b2c627e5aec39cb33cc22373bdce33053ef2c`. It is isolated reference source, not a fork or product code. The product root is a Git repository with no commits; product files remain untracked. `.atl/` is unrelated and ignored. Future VSIX packaging must exclude the reference directory and `.atl/`.
- Parent-verified environment update: Go is `go1.26.1 windows/amd64`. A direct Node `spawnSync` of the absolute executable derived from the resolved shim with `--version` exited 0 and printed `1.19.0`. This is version-only evidence; it does not verify server launch or lifecycle.

## Not yet done

- The extension has not been launched in an isolated VS Code Extension Host. Sidebar/expanded view behavior in VS Code, light/dark appearance, keyboard interaction, and side-by-side installation with the official extension are not yet host-verified.
- The earlier `pnpm run smoke:opencode-health` check was blocked because no server answered at `127.0.0.1:4096`. A previous managed smoke passed before the direct-executable change, but it used the PowerShell wrapper and is not evidence for the current process path. A canceled smoke left two matching OpenCode processes; after explicit authorization, only revalidated PIDs 20696 and 11100 were stopped and confirmed exited. PID 13256 did not match and was left untouched. No server smoke has run since the direct-executable change.
- Focused lease tests confirm unknown process or endpoint status prevents stale-lease reclamation. A second manager for the same workspace is rejected as busy; it does not safely attach to the existing server.
- Extension Host/UI/coexistence and live configured-URL connection remain unverified. Sessions/chat/tools/permissions/models/MCP/skills/subagents are outside this work unit.
- OpenCode 2.x compatibility is not claimed.

## Review mode

Clone-local receipt-driven development was disabled only after the user's explicit selection. No review receipt, approval, or acknowledgement was produced. Ordinary verification is the path; this does not grant review approval or delivery permission.

## Next step

The direct-executable path has not had a real process smoke. Continue with the isolated Extension Host/coexistence checks and a live configured-URL attachment before advancing to M3. Keep process-ownership and bounded-cleanup restrictions; do not claim the direct path has passed a real server smoke.
