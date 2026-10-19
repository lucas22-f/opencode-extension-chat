# OpenCode Visual for VS Code

OpenCode Visual is an independent, chat-first VS Code extension targeting the OpenCode CLI and SDK **1.19.0**. It is an experimental development snapshot, not an official OpenCode extension or a published release.

> **Identity and release status:** The manifest's publisher value is provisional. Publisher and Marketplace ownership have not been verified. A local VSIX is for inspection only; this project has not been published.

## Current scope

The extension provides an Explorer chat view and expanded editor view, connection and health state, sessions and message history, event-backed chat, permission/question cards, model/agent choices, editor-context insertion, tool activity, a searchable server command catalog with explicit editable session-command execution, configured MCP server connect/disconnect actions, skill/tool/child-session inventory, and user-triggered interruption controls. Feature availability is capability-gated to the pinned OpenCode 1.19.0 contract.

Milestones M1–M10 remain **partial**. See the [canonical ODD tracker](odd/tasks/opencode-visual-extension.md) for acceptance status and evidence. Important limits:

- OpenCode 2.x compatibility is not claimed.
- The M4 history-refresh path can still order equal-timestamp text parts incorrectly when durable sequence conflicts with SSE arrival order.
- Editor context is sent as visible prompt text. Remote file upload and native diff navigation are not implemented.
- M5–M9 routes and UI are covered by deterministic mocks, but live permission/question handling, provider/model selection, session deletion, editor-context execution, MCP inventory or configured-server mutations, skill inventory, and interruption have not been exercised by the agent.
- Multi-window/coexistence and performance/resource observations are pending; no performance thresholds have been measured.
- A separate clean-profile install and side-by-side coexistence check have not been performed.

## Chat layout

The chat uses a distinct teal accent on VS Code theme surfaces, with a conversation-first layout and a compact bordered composer at the bottom. The transcript follows new and streamed content; loading older history does not intentionally reset the reading position. Expand **Options** in the composer for session settings, workspace capability inventory, expanded-view/disconnect actions, and the server command catalog. Assistant messages offer **Copy response** for visible text when the session is not known to be active; fenced code keeps its separate **Copy code** action. **New session** stays in the header; expand composer **Options** and then **Past conversations** for history/search, or **Session settings** for model/agent choices and workspace server inventory. MCP Connect/Disconnect actions are available only for names returned by the connected workspace's status endpoint; they require a trusted workspace and an explicit click. A confirmed server change triggers a status refresh. Authentication and client-registration requirements are shown as guidance; OpenCode Visual does not start OAuth automatically. Typing `/provider` or `/model` reveals the choice controls. In the composer, refresh the command catalog, choose a command to insert its slash name, edit its arguments, then use **Run /name** to send it through OpenCode's session-command endpoint. Discovery and selection never execute a command. Ordinary text—including unknown slash commands—remains available to send as a prompt. Pending permissions/questions stay visible outside these disclosures. This is an independent interface inspired by documented chat patterns, not a Claude Code integration or a claim of feature parity. See the [UX reference and capability boundaries](docs/research.md#claude-code-vs-code-ux-reference).

### Automatic session names

After the first confirmed prompt in an empty default-named root session, OpenCode Visual saves a title from the first nonblank message line (normalized spacing, at most 80 Unicode characters). It makes no extra model request. Custom titles, child sessions and established conversations are left unchanged. An unconfirmed title update does not resend the prompt; refresh history to check the saved name. The pinned API has no atomic compare-and-swap protection against another client renaming the session between the title read and write.

## Connecting and data isolation

With `opencodeVisual.serverUrl` set, Connect attaches to that explicit HTTP(S) URL and does not own or stop that server. When it is empty, Connect probes only `http://127.0.0.1:4096`; if there is no HTTP response, the extension may start an owned server in a trusted workspace. Managed startup binds to loopback and uses a separate database under the extension's VS Code `globalStorageUri` through `OPENCODE_DB`. It does not open or migrate the CLI's default database, so Managed mode starts with separate session history.

The user reported observing a healthy Managed OpenCode 1.19.0 connection, a prompt accepted with HTTP 200 and rendered in the view, and the new Managed session/messages still present after an Extension Development Host reload. This is **user-observed evidence**, not an agent-run live test. The agent-run feature verification remains mocked except for the separately recorded health-only managed CLI smoke.

## Requirements

- VS Code 1.138 or later.
- OpenCode CLI 1.19.0 for the managed-server path; configured server connections are also limited to the pinned 1.19.0 compatibility baseline.
- A trusted workspace to use workspace-scoped chat/editor functionality or start a Managed server.

## Development and verification

The repository uses pnpm 10.18.0. From the repository root:

```sh
pnpm install --frozen-lockfile --store-dir .pnpm-store
pnpm run typecheck
pnpm run test
pnpm run build
```

`pnpm run build` typechecks and creates the bundled Extension Host and Webview assets under `dist/`. The normal unit suite uses deterministic fixtures; the real installed-CLI health smoke is separately gated. There is no configured lint script. See the [environment audit](docs/environment-audit.md) for exact historical results and the [implementation plan](docs/implementation-plan.md) for remaining verification boundaries.

To inspect or create a local VSIX after building, use the project-local ephemeral VSCE command:

```sh
pnpm dlx @vscode/vsce ls --no-dependencies
pnpm dlx @vscode/vsce package --no-dependencies
```

The Vite builds bundle runtime dependencies into `dist`; `--no-dependencies` therefore omits `node_modules` from the VSIX. Secret scanning remains enabled. Review the `vsce ls` output and `.vscodeignore` before packaging. Do not treat a local VSIX as a release or install it into a normal user profile without a separate verification plan.

## Project records

- [Progress snapshot](docs/progress.md)
- [Architecture decisions](docs/architecture-decisions.md)
- [Pinned API research and compatibility limits](docs/research.md)
- [Environment and verification audit](docs/environment-audit.md)
- [Optional local REA analysis tooling](docs/rea-setup.md)
- [Implementation sequence](docs/implementation-plan.md)
- [Changelog](CHANGELOG.md)
- [Canonical ODD feature and milestone tracker](odd/tasks/opencode-visual-extension.md)
