# Environment audit

**Snapshot date:** 2026-10-13  
**Scope:** Target Windows environment, version-only process probes, product-local dependency installation, focused M1/M2 tests/build, and the history/limits of the managed-process smoke. The earlier real smoke used the PowerShell wrapper; no real server smoke was run after the direct-executable correction. No global tools were installed; no credential values were read/logged and no provider prompt/model request was made.

## Verified environment

| Item | Verified value | Evidence / note |
|---|---|---|
| Operating system | Microsoft Windows 10.0.26200, x64 | Parent's environment audit. |
| Workspace | `C:\Users\lucas\OneDrive\Desktop\Workspace C 2026\opencode-extension-chat` | The workspace was initially empty and non-Git. It now resolves as the product Git root with no commits; product files are untracked. `.atl/` is unrelated runtime-generated state and is ignored by `.gitignore`/`.vscodeignore`. |
| OpenCode source reference | `upstream-opencode-v1.19.0/` | Parent-verified shallow/sparse clone of the official repository at commit `733b2c627e5aec39cb33cc22373bdce33053ef2c`; read-only reference, not extension/product source. Verification details are in [`research.md`](research.md). |
| Node.js | v24.15.0 at `C:\nvm4w\nodejs\node.exe` | Read-only version and executable resolution checks. |
| npm | 11.12.1 | Read-only version check. |
| pnpm | 10.18.0 | Read-only version check. |
| yarn | Not found | Command lookup. |
| VS Code | 1.138.0, x64 | Read-only version check. `code` resolves to `C:\Users\lucas\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd`. |
| OpenCode CLI | v1.19.0 | Read-only version check. PowerShell resolves `opencode` to `C:\nvm4w\nodejs\opencode.ps1`. |
| OpenCode serve defaults | Hostname `127.0.0.1`; port `0` | Reported by `opencode serve --help`. This is CLI help, not a live server result. |
| Git | 2.43.0.windows.1 | Git is installed; `git rev-parse --show-toplevel` resolves to the product root. |
| `vsce` | Not found | Command lookup; package toolchain is not installed/verified. |
| `@opencode-ai/sdk@1.19.0` | Installed as an exact local runtime dependency | Added with pnpm and imported via `@opencode-ai/sdk/v2/client`. |
| Go | `go version go1.26.1 windows/amd64` | Parent-reported `go version` output. |
| Project package manager | pnpm 10.18.0 | The product manifest pins `packageManager` to `pnpm@10.18.0`. |
| Product dependencies | Exact versions in `package.json` | Installed locally by `pnpm install --store-dir .pnpm-store`; no global install. Includes React/React DOM 19.3.0, Vite 8.3.4, React Vite plugin 6.1.2, Tailwind CSS/plugin 4.3.3, TypeScript 5.9.3, Vitest 5.0.3, Zod 4.6.6, `@types/vscode` 1.138.0, `@types/node` 24.19.2, and `@types/react`/`@types/react-dom` 19.3.0. |

## M1 Windows process-invocation probes

The parent ran version-only Node.js `spawn` probes with the product workspace as cwd. These establish command-resolution outcomes for `--version` only; they are not server-startup or lifecycle tests.

| Invocation | Result | What it establishes |
|---|---|---|
| `spawn('opencode', ['--version'], { cwd: workspace, stdio: ... })` | `ENOENT` | This bare command name was not launchable through that Node invocation on this host. |
| `spawn('C:\\nvm4w\\nodejs\\opencode', ['--version'], { cwd: workspace, stdio: ... })` | `ENOENT` | This extensionless resolved path was not launchable through that Node invocation. |
| `spawn('powershell.exe', ['-NoProfile', '-File', 'C:\\nvm4w\\nodejs\\opencode.ps1', '--version'], { cwd: workspace, stdio: ... })` | Exit 0; stdout `1.19.0` | Explicit PowerShell `-File` invocation successfully ran the version command. It does not prove the same invocation can start or manage `opencode serve`. |
| `spawnSync(<absolute executable derived from the real shim path>, ['--version'], { cwd: workspace, ... })` | Parent-observed exit 0; stdout `1.19.0` | Direct-executable version evidence only; it does not prove server startup or lifecycle. |

## M1/M2 implementation verification

Commands were run in the product workspace. Test output was filtered in PowerShell before inspection.

| Command | Observed result |
|---|---|
| `pnpm install --store-dir .pnpm-store` | Passed with pnpm 10.18.0; 61 packages installed into the project-local store. |
| `pnpm add --save-exact @opencode-ai/sdk@1.19.0 --store-dir .pnpm-store` | Passed; installed the pinned SDK and 7 packages into the project-local store. |
| `pnpm install --store-dir .pnpm-store` after SDK addition | Passed; lockfile was up to date and dependencies were already installed. |
| `pnpm exec vitest run --config vitest.config.ts tests/opencode-connection.test.ts tests/opencode-health.test.ts tests/managed-opencode-server.test.ts tests/webview.test.tsx tests/webview-message.test.ts` | Historical result before the direct-executable correction: 5 files, 44 tests passed; 1 gated real-CLI smoke skipped by default. Output was filtered in PowerShell. |
| `$env:OPENCODE_VISUAL_MANAGED_SMOKE='1'; pnpm exec vitest run --config vitest.config.ts tests/managed-opencode-server.test.ts -t 'real installed CLI smoke'` | Historical result before the direct-executable correction: 1 smoke test passed; the installed `opencode.ps1` started `serve --hostname=127.0.0.1 --port=0 --pure` from an isolated temp workspace; health returned `1.19.0`, the owned root exited, the endpoint became unavailable, and the workspace was removed. This does not verify the current direct-executable path. No provider/model request was made. |
| `pnpm exec vitest run --config vitest.config.ts tests/managed-opencode-server.test.ts tests/managed-server-lease.test.ts` | Current focused run: 2 files passed, 18 tests passed, 1 gated smoke skipped (19 total). Output was filtered in PowerShell. |
| `pnpm run typecheck` | Current run passed with no TypeScript diagnostics. |
| `pnpm run build` | Current run passed; typecheck, Webview Vite build, and Extension Vite build completed. |
| Earlier `pnpm run smoke:opencode-health` | **Blocked (exit 2):** no server answered at `127.0.0.1:4096`. This earlier attach-only check made one bounded SDK `GET /global/health` request and cleaned its temporary workspace; it did not launch a server. The later managed smoke is recorded above. |
| `pnpm run lint` | Not configured in `package.json`; not run. |

The product-local toolchain is pinned in `package.json` and locked in `pnpm-lock.yaml`. `.gitignore` excludes local dependencies, store, tests/build output, and the nested reference checkout. `.vscodeignore` excludes the nested checkout, local dependencies/store, tests, source, docs, and build configuration while retaining compiled `dist/` assets. No VSIX was produced or inspected because `vsce` is not installed and VSIX packaging is M10.

## Project and verification capabilities

- Product source, manifest, scripts, tests, and React Webview now exist. The pinned nested OpenCode checkout remains read-only and separate. `.gitignore` excludes the local store, tests/build output, smoke temp directories, and reference clone; `.vscodeignore` excludes development files and the reference clone while keeping `dist/` assets.
- Focused tests include deterministic fake loopback/process tests and a separately gated real CLI smoke. The earlier real smoke confirmed the installed OpenCode 1.19.0 wrapper's argument forwarding, actual URL output, health response, and shutdown on this host; it predates the direct-executable correction and does not validate the current process path. Current unit tests cover PATH shim realpath/adjacent executable resolution, path spaces and Unicode, graceful disposal without taskkill, live-root-only bounded fallback, same-workspace exclusion, and stale-lease fail-closed behavior.
- Managed startup uses only explicit Connect, one default endpoint probe, a trusted workspace, loopback binding, a sanitized allowlist environment, and fixed argv. Windows now spawns the validated adjacent executable directly with `shell:false`; shutdown attempts SDK `instance.dispose()` and waits for both process exit and endpoint unavailability. Bounded forced `taskkill /T /F` is fallback-only for the exact still-live lease-owned root. Extension Host/UI/coexistence/visual checks and VSIX packaging have not run. No VS Code host harness is configured, and the VS Code user profile was not changed.

## Source of observations

Environment identity and version-only process probes came from read-only exploration; the direct executable `--version` result was parent-observed. Current focused unit tests, typecheck, and build were run in this implementation session. The real health-only process smoke predates the direct-executable change. Pinned source findings are in [`research.md`](research.md); configured-URL live attach and Extension Host behavior remain unverified. Clone-local RDD/review mode is off by explicit user selection; no review receipt or approval was produced.

The earlier canceled managed smoke left two matching OpenCode processes. After explicit user authorization, the parent revalidated and stopped only PIDs 20696 and 11100; both were confirmed exited. PID 13256 did not match and was left untouched. No real server process was started during the 2026-10-13 direct-executable correction.
