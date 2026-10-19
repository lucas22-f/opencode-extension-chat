# REA local analysis tooling

REA **6.7.0** is installed for this workspace, not as an extension dependency or a global agent setting. Use it only on explicitly authorized targets. This does not add REA to the OpenCode server or ship it in the VSIX.

## Use it

```sh
node .tools/rea/run.cjs --version
node .tools/rea/run.cjs analyze-javascript-application <authorized-absolute-directory> --format json
```

Pi's local `.pi/mcp.json` registers `rea` using `node .tools/rea/run.cjs mcp`, `cwd: "."`, and `codemode` exposure. Run **`/reload`**, then **`/mcp`** in this workspace to load/check the new registration. The already-running conversation is not claimed to have loaded the server merely because the config file exists.

For MCP analysis, use the server-published input schema: `analyze_javascript_application` requires **`input_path`**, not the CLI's positional `path`. `detail: "summary"` retains full evidence in the server session and returns a compact view.

## Installation boundaries

- Source: [morluto/rea](https://github.com/morluto/rea), npm package `rea-agents@6.7.0` with pinned lockfile/integrity in `.tools/rea`.
- Installation used `--ignore-scripts --omit=optional`; optional Frida and native analysis engines were not installed. Static JavaScript analysis does not require Hopper/Ghidra/Wakaru.
- `.tools/rea/run.cjs` scopes its process home, cache and temporary locations under `.tools/rea/home`. This is state isolation, **not a filesystem/network sandbox**.
- `.tools/` and `.pi/mcp.json` are local, ignored artifacts. They are not provisioned by cloning the Git repository. Both tool state and `.pi/` are excluded from VSIX packaging.
- Product `package.json` and `pnpm-lock.yaml`, global OpenCode configuration, other MCP clients and provider credentials were not changed.

The initial install command was:

```sh
npm install --prefix .tools/rea --save-exact --ignore-scripts --omit=optional --no-audit --no-fund --cache .tools/npm-cache rea-agents@6.7.0
```

The local launcher and MCP registration are workspace setup artifacts, not an instruction to run upstream's global `setup` wizard.

## Verification scope

A synthetic two-module application under `.tools/rea-fixture` is the only analysis target used. CLI analysis, stdio initialization/tool discovery and a real MCP tool call are separate checks; their exact outcomes are recorded in `odd/tasks/session-topic-titles.md`. Reports stay under `.tools/rea-smoke` and are not packaged. No Claude extension, personal application or production service was inspected.

The tool's native binary, live Electron, browser capture and source-recovery capabilities are not verified by this static JavaScript smoke. Their prerequisites and target permissions must be assessed separately.
