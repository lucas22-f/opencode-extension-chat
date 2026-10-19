import { createOpencodeClient as createLegacyOpencodeClient } from "@opencode-ai/sdk/client";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { afterEach, describe, expect, it } from "vitest";
import { OpenCodeCapabilities } from "../src/extension/opencode-capabilities";
import { OpenCodeConnection } from "../src/extension/opencode-connection";
import { SUPPORTED_OPENCODE_VERSION } from "../src/shared/connection-state";

const SERVER_URL = "http://opencode.test:4096";
const WORKSPACE = String.raw`C:\workspace with spaces\opencode-ñ`;
const PARENT_SESSION_ID = "ses_parent123";
const OTHER_SESSION_ID = "ses_other123";

describe("OpenCode v1.19.0 read-only capability inventory", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it("loads independent server metadata and filters children by exact parentID", async () => {
    const setup = await createConnectedCapabilities();
    cleanups.push(setup.cleanup);
    setup.capabilities.setSelectedSessionID(PARENT_SESSION_ID);

    await Promise.all([
      setup.capabilities.refreshMcpStatus(),
      setup.capabilities.refreshToolMetadata({
        id: "model-test",
        providerID: "provider-test",
      }),
      setup.capabilities.refreshSkills(),
      setup.capabilities.refreshCommands(),
      setup.capabilities.refreshChildSessions(PARENT_SESSION_ID),
    ]);

    expect(setup.capabilities.state.mcp).toMatchObject({
      status: "ready",
      servers: [
        { name: "attached-mcp", status: "connected" },
        { name: "waiting-mcp", status: "needs_auth" },
        { name: "failed-mcp", status: "failed" },
      ],
    });
    expect(setup.capabilities.state.tools).toMatchObject({
      status: "ready",
      providerID: "provider-test",
      modelID: "model-test",
      tools: [
        {
          id: "read_file",
          description: "Read a workspace-relative file.",
          parameters: expect.stringContaining('"path"'),
        },
      ],
    });
    expect(setup.capabilities.state.skills).toEqual({
      status: "ready",
      skills: [
        {
          name: "release-notes",
          description: "Summarize release changes.",
        },
      ],
      error: null,
    });
    expect(setup.capabilities.state.commands).toEqual({
      status: "ready",
      commands: [{ name: "review", description: "Review changes." }],
      error: null,
    });
    const commandRequest = setup.transport.requests.find(
      (request) => new URL(request.url).pathname === "/api/command",
    );
    expect(new URL(commandRequest!.url).searchParams.get("location[directory]")).toBe(WORKSPACE);
    expect(setup.capabilities.state.children).toMatchObject({
      status: "ready",
      parentSessionID: PARENT_SESSION_ID,
      scannedSessionCount: 53,
      truncated: false,
      agentModesAvailable: true,
      sessions: [
        {
          id: "ses_child_worker",
          title: "Worker session",
          agent: "worker",
          subagent: true,
        },
        {
          id: "ses_child_build",
          title: "Worker session",
          agent: "build",
        },
      ],
    });
    expect(setup.capabilities.state.children.sessions).toHaveLength(2);

    const mcpRequest = setup.transport.requests.find(
      (request) => new URL(request.url).pathname === "/mcp",
    );
    expect(mcpRequest).toBeDefined();
    const toolRequest = setup.transport.requests.find(
      (request) => new URL(request.url).pathname === "/experimental/tool",
    );
    expect(new URL(toolRequest!.url).searchParams.get("provider")).toBe(
      "provider-test",
    );
    expect(new URL(toolRequest!.url).searchParams.get("model")).toBe("model-test");
    expect(
      setup.transport.requests.filter(
        (request) => new URL(request.url).pathname === "/api/session",
      ),
    ).toHaveLength(2);
    expect(
      setup.transport.requests.some(
        (request) => new URL(request.url).pathname === "/api/agent",
      ),
    ).toBe(true);

    const serializedState = JSON.stringify(setup.capabilities.state);
    expect(serializedState).not.toContain("SKILL_CONTENT_MUST_NOT_ESCAPE");
    expect(serializedState).not.toContain("PRIVATE_TEMPLATE");
    expect(serializedState).not.toContain("reviewer");
    expect(serializedState).not.toContain("secret");
    expect(serializedState).not.toContain("private");
    expect(serializedState).not.toContain("MCP_SECRET_MUST_NOT_ESCAPE");
    expect(serializedState).not.toContain(WORKSPACE);
  });

  it("runs only a discovered command through the legacy session command route", async () => {
    const setup = await createConnectedCapabilities();
    cleanups.push(setup.cleanup);
    setup.capabilities.setSelectedSessionID(PARENT_SESSION_ID);
    await setup.capabilities.refreshCommands();
    expect(await setup.capabilities.runCommand({
      name: "unknown", arguments: "safe", sessionID: PARENT_SESSION_ID,
      model: "provider-test/model-test", agent: "reviewer",
    })).toBe(false);
    expect(await setup.capabilities.runCommand({
      name: "review", arguments: "safe", sessionID: OTHER_SESSION_ID,
      model: "provider-test/model-test", agent: "reviewer",
    })).toBe(false);
    expect(await setup.capabilities.runCommand({
      name: "review", arguments: "safe", sessionID: PARENT_SESSION_ID,
      model: "", agent: "reviewer",
    })).toBe(false);
    expect(setup.transport.requests.filter((request) => request.method === "POST")).toHaveLength(0);
    expect(await setup.capabilities.runCommand({
      name: "review", arguments: "inspect this", sessionID: PARENT_SESSION_ID,
      model: "provider-test/model-test", agent: "reviewer",
    })).toBe(true);
    const requests = setup.transport.requests.filter((request) => request.method === "POST");
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).pathname).toBe(`/session/${PARENT_SESSION_ID}/command`);
    expect(new URL(requests[0]!.url).searchParams.get("directory")).toBe(WORKSPACE);
    expect(await requests[0]!.json()).toMatchObject({
      command: "review", arguments: "inspect this", model: "provider-test/model-test", agent: "reviewer",
    });
  });

  it("blocks duplicate execution and ignores a result after session selection changes", async () => {
    const setup = await createConnectedCapabilities();
    cleanups.push(setup.cleanup);
    setup.capabilities.setSelectedSessionID(PARENT_SESSION_ID);
    await setup.capabilities.refreshCommands();
    setup.transport.holdNextCommand();
    const first = setup.capabilities.runCommand({
      name: "review", arguments: "inspect", sessionID: PARENT_SESSION_ID,
      model: "provider-test/model-test", agent: null,
    });
    await waitFor(() => setup.transport.hasHeldCommand());
    expect(await setup.capabilities.runCommand({
      name: "review", arguments: "inspect", sessionID: PARENT_SESSION_ID,
      model: "provider-test/model-test", agent: null,
    })).toBe(false);
    setup.capabilities.setSelectedSessionID(OTHER_SESSION_ID);
    setup.transport.releaseHeldCommand();
    expect(await first).toBe(false);
    expect(setup.transport.requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  it("keeps the execution lock closed when catalog refresh completes during a command", async () => {
    const setup = await createConnectedCapabilities();
    cleanups.push(setup.cleanup);
    setup.capabilities.setSelectedSessionID(PARENT_SESSION_ID);
    await setup.capabilities.refreshCommands();
    setup.transport.holdNextCommand();
    const input = {
      name: "review", arguments: "inspect unchanged", sessionID: PARENT_SESSION_ID,
      model: "provider-test/model-test", agent: "reviewer",
    };
    const first = setup.capabilities.runCommand(input);
    await waitFor(() => setup.transport.hasHeldCommand());
    await setup.capabilities.refreshCommands();
    expect(setup.capabilities.state.commands.status).toBe("loading");
    expect(setup.capabilities.state.commands.commands).toEqual([{ name: "review", description: "Review changes." }]);
    const secondResult = await setup.capabilities.runCommand(input);
    setup.transport.releaseHeldCommand();
    const firstResult = await first;
    const posts = setup.transport.requests.filter((request) => request.method === "POST");
    expect(secondResult).toBe(false);
    expect(posts).toHaveLength(1);
    expect(await posts[0]!.json()).toMatchObject({
      command: "review", arguments: "inspect unchanged", model: "provider-test/model-test", agent: "reviewer",
    });
    expect(firstResult).toBe(true);
    expect(setup.capabilities.state.commands.status).toBe("ready");
  });

  it("releases the execution guard after a command failure without retrying it", async () => {
    const setup = await createConnectedCapabilities();
    cleanups.push(setup.cleanup);
    setup.capabilities.setSelectedSessionID(PARENT_SESSION_ID);
    await setup.capabilities.refreshCommands();
    setup.transport.failNext(`/session/${PARENT_SESSION_ID}/command`, 500);
    const input = {
      name: "review", arguments: "explicit retry only", sessionID: PARENT_SESSION_ID,
      model: "provider-test/model-test", agent: null,
    };
    expect(await setup.capabilities.runCommand(input)).toBe(false);
    expect(setup.transport.requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(setup.capabilities.state.commands.status).toBe("ready");
    expect(await setup.capabilities.runCommand(input)).toBe(true);
    expect(setup.transport.requests.filter((request) => request.method === "POST")).toHaveLength(2);
  });

  it("does not query tool metadata until a server-reported model is known", async () => {
    const setup = await createConnectedCapabilities();
    cleanups.push(setup.cleanup);

    await setup.capabilities.refreshToolMetadata(null);

    expect(setup.capabilities.state.tools.status).toBe("idle");
    expect(
      setup.transport.requests.some(
        (request) => new URL(request.url).pathname === "/experimental/tool",
      ),
    ).toBe(false);
  });

  it.each([
    { path: "/experimental/tool", section: "tools", status: 404 },
    { path: "/experimental/tool", section: "tools", status: 405 },
    { path: "/experimental/tool", section: "tools", status: 501 },
    { path: "/api/skill", section: "skills", status: 404 },
    { path: "/api/skill", section: "skills", status: 405 },
    { path: "/api/skill", section: "skills", status: 501 },
  ] as const)(
    "$path HTTP $status shows $section unavailable independently",
    async ({ path, section, status }) => {
      const setup = await createConnectedCapabilities();
      cleanups.push(setup.cleanup);
      setup.transport.failNext(path, status);

      await Promise.all([
        setup.capabilities.refreshMcpStatus(),
        setup.capabilities.refreshToolMetadata({
          id: "model-test",
          providerID: "provider-test",
        }),
        setup.capabilities.refreshSkills(),
      ]);

      expect(setup.capabilities.state.mcp.status).toBe("ready");
      expect(setup.capabilities.state.tools.status).toBe(
        section === "tools" ? "unavailable" : "ready",
      );
      expect(setup.capabilities.state.skills.status).toBe(
        section === "skills" ? "unavailable" : "ready",
      );
      const failure = section === "tools"
        ? setup.capabilities.state.tools
        : setup.capabilities.state.skills;
      expect(failure.error).toContain("experimental endpoint");
    },
  );

  it("discards a child-session response after the selected parent changes", async () => {
    const setup = await createConnectedCapabilities();
    cleanups.push(setup.cleanup);
    setup.transport.holdNextSessionList();
    setup.capabilities.setSelectedSessionID(PARENT_SESSION_ID);

    const loading = setup.capabilities.refreshChildSessions(PARENT_SESSION_ID);
    await waitFor(() => setup.transport.hasHeldSessionList());
    setup.capabilities.setSelectedSessionID(OTHER_SESSION_ID);
    setup.transport.releaseHeldSessionList();
    await loading;

    expect(setup.capabilities.state.children).toMatchObject({
      status: "idle",
      parentSessionID: OTHER_SESSION_ID,
      sessions: [],
    });
  });
});

async function createConnectedCapabilities() {
  const transport = createTransport();
  const connection = new OpenCodeConnection(async () => ({
    kind: "healthy",
    version: SUPPORTED_OPENCODE_VERSION,
  }));
  const capabilities = new OpenCodeCapabilities(
    connection,
    () => WORKSPACE,
    () => true,
    (_serverUrl, directory) =>
      createOpencodeClient({
        baseUrl: SERVER_URL,
        directory,
        redirect: "error",
        fetch: transport.fetch,
      }),
    (_serverUrl, directory) => createLegacyOpencodeClient({
      baseUrl: SERVER_URL, directory, redirect: "error", fetch: transport.fetch,
    }),
  );
  await connection.connect(SERVER_URL, { directory: WORKSPACE, trusted: true });

  return {
    capabilities,
    transport,
    cleanup: async () => {
      capabilities.dispose();
      await connection.dispose();
    },
  };
}

function createTransport() {
  const requests: Request[] = [];
  const failures = new Map<string, number>();
  const sessions = [
    {
      id: "ses_title_decoy",
      title: "Worker session",
      time: { updated: 1_760_000_000_000 },
    },
    ...Array.from({ length: 49 }, (_, index) => ({
      id: `ses_unrelated_${index}`,
      title: `Unrelated ${index}`,
      time: { updated: 1_760_000_000_000 - index },
    })),
    {
      id: "ses_child_worker",
      parentID: PARENT_SESSION_ID,
      title: "Worker session",
      agent: "worker",
      time: { updated: 1_760_000_000_001 },
    },
    {
      id: "ses_child_build",
      parentID: PARENT_SESSION_ID,
      title: "Worker session",
      agent: "build",
      time: { updated: 1_760_000_000_002 },
    },
    {
      id: "ses_child_other_parent",
      parentID: OTHER_SESSION_ID,
      title: "Different parent",
      agent: "worker",
      time: { updated: 1_760_000_000_003 },
    },
  ];
  let shouldHoldSessionList = false;
  let releaseHeldSessionList: (() => void) | undefined;
  let shouldHoldCommand = false;
  let releaseHeldCommand: (() => void) | undefined;

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);
    const failStatus = failures.get(url.pathname);
    if (failStatus !== undefined) {
      failures.delete(url.pathname);
      return jsonResponse({ error: "Private server response" }, failStatus);
    }

    if (url.pathname === `/session/${PARENT_SESSION_ID}/command` && request.method === "POST") {
      if (shouldHoldCommand) {
        shouldHoldCommand = false;
        return new Promise((resolve) => {
          releaseHeldCommand = () => resolve(jsonResponse({ accepted: true }));
        });
      }
      return jsonResponse({ accepted: true });
    }
    if (url.pathname === "/mcp") {
      return jsonResponse({
        "attached-mcp": { status: "connected" },
        "waiting-mcp": { status: "needs_auth" },
        "failed-mcp": { status: "failed", error: "MCP_SECRET_MUST_NOT_ESCAPE" },
      });
    }
    if (url.pathname === "/experimental/tool") {
      return jsonResponse([
        {
          id: "read_file",
          description: "Read a workspace-relative file.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      ]);
    }
    if (url.pathname === "/api/command") {
      return jsonResponse({
        location: { directory: WORKSPACE },
        data: [{ name: "review", template: "PRIVATE_TEMPLATE", description: "Review changes.", agent: "reviewer", model: { providerID: "secret", modelID: "secret" }, subtask: true }],
      });
    }
    if (url.pathname === "/api/skill") {
      return jsonResponse({
        location: { directory: WORKSPACE },
        data: [
          {
            name: "release-notes",
            description: "Summarize release changes.",
            location: String.raw`C:\private\skills\release-notes.md`,
            content: "SKILL_CONTENT_MUST_NOT_ESCAPE",
          },
        ],
      });
    }
    if (url.pathname === "/api/session") {
      if (shouldHoldSessionList) {
        shouldHoldSessionList = false;
        return new Promise((resolve) => {
          releaseHeldSessionList = () => resolve(jsonResponse({
            data: sessions.slice(0, 1),
            cursor: {},
          }));
        });
      }
      const offset = Number(url.searchParams.get("cursor")?.replace("cursor-", "") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const page = sessions.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      return jsonResponse({
        data: page,
        cursor: nextOffset < sessions.length ? { next: `cursor-${nextOffset}` } : {},
      });
    }
    if (url.pathname === "/api/agent") {
      return jsonResponse({
        location: { directory: WORKSPACE },
        data: [
          { id: "worker", mode: "subagent" },
          { id: "build", mode: "primary" },
        ],
      });
    }
    return jsonResponse({ error: "Not found" }, 404);
  };

  return {
    requests,
    fetch,
    failNext(path: string, status: number) {
      failures.set(path, status);
    },
    holdNextSessionList() {
      shouldHoldSessionList = true;
    },
    hasHeldSessionList() {
      return releaseHeldSessionList !== undefined;
    },
    releaseHeldSessionList() {
      releaseHeldSessionList?.();
    },
    holdNextCommand() { shouldHoldCommand = true; },
    hasHeldCommand() { return releaseHeldCommand !== undefined; },
    releaseHeldCommand() { releaseHeldCommand?.(); },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for test transport.");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
