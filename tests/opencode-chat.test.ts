import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { TextEditor, WorkspaceFolder } from "vscode";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUPPORTED_OPENCODE_VERSION } from "../src/shared/connection-state";
import { chatStateSchema } from "../src/shared/chat-state";
import {
  appendEditorContextToPromptDraft,
  createEditorContextBlock,
} from "../src/shared/editor-context";
import { captureActiveEditorContext } from "../src/extension/editor-context";
import { OpenCodeChat } from "../src/extension/opencode-chat";
import {
  OpenCodeConnection,
  type HealthProbeResult,
} from "../src/extension/opencode-connection";
import {
  DiagnosticsRecorder,
  type DiagnosticsSink,
} from "../src/extension/diagnostics";

const SERVER_URL = "http://opencode.test:4096";
const WORKSPACE = "C:\\workspace with spaces\\opencode-ñ";
const FIRST_SESSION_ID = "ses_first123";
const SECOND_SESSION_ID = "ses_second123";
const PROMPT_REQUEST_ID = "550e8400-e29b-41d4-a716-446655440000";
const PROMPT_ATTEMPT_ID = "550e8400-e29b-41d4-a716-446655440001";
const PROMPT_RETRY_ATTEMPT_ID = "550e8400-e29b-41d4-a716-446655440002";

const sessions = [
  createServerSession(FIRST_SESSION_ID, "First session"),
  createServerSession(SECOND_SESSION_ID, "Second session"),
];

const messagesBySession = new Map<string, unknown[]>([
  [
    FIRST_SESSION_ID,
    [
      { id: "msg-user", type: "user", text: "Previous prompt" },
      {
        id: "msg-assistant",
        type: "assistant",
        content: [
          { id: "text-1", type: "text", text: "Previous answer." },
          { id: "reason-1", type: "reasoning", text: "Not displayed." },
          {
            id: "tool-1",
            type: "tool",
            name: "bash",
            state: {
              status: "completed",
              input: { command: "pwd" },
              structured: { directory: "/workspace" },
              content: [{ type: "text", text: "/workspace" }],
              result: "/workspace",
            },
            time: { created: 10, ran: 11, completed: 18 },
          },
        ],
      },
    ],
  ],
  [SECOND_SESSION_ID, []],
]);

describe("OpenCode v1.19.0 session chat adapter", () => {
  const resources: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of resources.splice(0)) await cleanup();
  });

  it("uses v2 session routes and maps text and tool history while omitting reasoning", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);

    expect(setup.chat.state.sessions.map((session) => session.id)).toEqual([
      FIRST_SESSION_ID,
      SECOND_SESSION_ID,
    ]);
    expect(setup.chat.state.selectedSessionID).toBe(FIRST_SESSION_ID);
    expect(setup.chat.state.messages).toHaveLength(2);
    expect(setup.chat.state.messages[0]).toEqual({
      id: "msg-user",
      role: "user",
      text: "Previous prompt",
    });
    expect(setup.chat.state.messages[1]).toMatchObject({
      id: "msg-assistant",
      role: "assistant",
      text: "Previous answer.",
      parts: [
        { id: "text-1", type: "text", text: "Previous answer." },
        {
          id: "tool-1",
          type: "tool",
          name: "bash",
          status: "completed",
          input: '{\n  "command": "pwd"\n}',
          result: "/workspace",
          durationMs: 7,
        },
      ],
    });

    const requests = setup.transport.requests;
    expect(requests.some((request) => new URL(request.url).pathname === "/session")).toBe(
      false,
    );
    expect(
      requests.some((request) => new URL(request.url).pathname === "/api/session"),
    ).toBe(true);
    expect(
      requests.some(
        (request) =>
          new URL(request.url).pathname ===
          `/api/session/${FIRST_SESSION_ID}/message`,
      ),
    ).toBe(true);
    expect(
      requests.some((request) => new URL(request.url).pathname === "/api/event"),
    ).toBe(true);
    expect(
      requests.some((request) => new URL(request.url).pathname === "/event"),
    ).toBe(false);
  });

  it("maps pinned text-bearing system, synthetic, shell, compaction, and switch records neutrally", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    setup.transport.setMessages(FIRST_SESSION_ID, [
      { id: "msg-user", type: "user", text: "Prompt" },
      { id: "msg-synthetic", type: "synthetic", sessionID: FIRST_SESSION_ID, text: "Synthetic context" },
      { id: "msg-system", type: "system", text: "System context" },
      { id: "msg-shell", type: "shell", callID: "call-shell", command: "npm test", output: "passed", time: { created: 1 } },
      { id: "msg-compaction", type: "compaction", reason: "auto", summary: "Summary text", recent: "Recent text" },
      { id: "msg-agent-switch", type: "agent-switched", agent: "build" },
      { id: "msg-model-switch", type: "model-switched", model: { providerID: "provider", id: "model" } },
    ]);

    await setup.chat.reviewSelectedSessionHistory();

    expect(setup.chat.state.messages).toEqual(expect.arrayContaining([
      { id: "msg-synthetic", role: "system", text: "Synthetic context" },
      { id: "msg-system", role: "system", text: "System context" },
      { id: "msg-shell", role: "system", text: "Shell command: npm test\nOutput:\npassed" },
      { id: "msg-compaction", role: "system", text: "Summary text\n\nRecent text" },
      { id: "msg-agent-switch", role: "system", text: "Agent switched to build" },
      { id: "msg-model-switch", role: "system", text: "Model switched to provider/model" },
    ]));
  });

  it("unwraps selected-session activity from the nested v2 active response body", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    setup.transport.setActiveSessionIDs([FIRST_SESSION_ID]);

    await setup.chat.refreshSessionActivity(FIRST_SESSION_ID);

    expect(setup.chat.state.sessionActivityErrorCategory).toBeNull();
    expect(setup.chat.state.sessionActivityError).toBeNull();
    expect(setup.chat.state.sessionActivity).toBe("active");
    const request = setup.transport.activeRequests.at(-1);
    expect(request?.method).toBe("GET");
    expect(new URL(request!.url).pathname).toBe("/api/session/active");

    await setup.chat.selectSession(SECOND_SESSION_ID);
    await waitFor(
      () =>
        setup.chat.state.sessionActivity === "inactive" &&
        !setup.chat.state.sessionActivityRefreshing,
    );
    expect(setup.chat.state.selectedSessionID).toBe(SECOND_SESSION_ID);
    expect(setup.chat.state.sessionActivityErrorCategory).toBeNull();
    expect(setup.chat.state.sessionActivityError).toBeNull();
  });

  it.each([401, 403, 404, 405, 503])(
    "retains HTTP %i from an active-session SDK error envelope without exposing its body",
    async (status) => {
      const diagnostics = new DiagnosticsRecorder();
      const setup = await createConnectedChat({ diagnostics });
      resources.push(setup.cleanup);
      setup.transport.setActiveSessionIDs([FIRST_SESSION_ID]);
      await setup.chat.refreshSessionActivity(FIRST_SESSION_ID);
      setup.transport.failNextActiveRequest(status, "PRIVATE_ACTIVITY_BODY");

      await setup.chat.refreshSessionActivity(FIRST_SESSION_ID);

      expect(setup.chat.state.sessionActivity).toBe("active");
      expect(setup.chat.state.sessionActivityErrorCategory).toBe("http-error");
      expect(setup.chat.state.sessionActivityHttpStatus).toBe(status);
      expect(diagnostics.getTranscript()).toContain(`"httpStatus":${status}`);
      expect(diagnostics.getTranscript()).not.toContain("PRIVATE_ACTIVITY_BODY");
      setup.transport.setActiveSessionIDs([]);
      setup.transport.emit({
        id: `activity-recovered-${status}`,
        type: "session.status",
        data: { sessionID: FIRST_SESSION_ID, status: "idle" },
      });
      await waitFor(() => setup.chat.state.sessionActivityError === null);
    },
  );

  it("distinguishes malformed successful activity data, transport failure, and missing SDK method", async () => {
    const diagnostics = new DiagnosticsRecorder();
    const setup = await createConnectedChat({ diagnostics });
    resources.push(setup.cleanup);

    setup.transport.returnMalformedNextActiveResponse();
    await setup.chat.refreshSessionActivity(FIRST_SESSION_ID);
    expect(setup.chat.state.sessionActivityErrorCategory).toBe("invalid-shape");

    setup.transport.throwNextActiveRequest("PRIVATE_NETWORK_ERROR");
    await setup.chat.refreshSessionActivity(FIRST_SESSION_ID);
    expect(setup.chat.state.sessionActivityErrorCategory).toBe("request-failed");
    expect(diagnostics.getTranscript()).not.toContain("PRIVATE_NETWORK_ERROR");

    const missingSDK = await createConnectedChat({ omitActiveMethod: true });
    resources.push(missingSDK.cleanup);
    await missingSDK.chat.refreshSessionActivity(FIRST_SESSION_ID);
    expect(missingSDK.chat.state.sessionActivityErrorCategory).toBe("sdk-unavailable");
  });

  it("retains the prior activity failure while a refresh is pending", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    setup.transport.returnMalformedNextActiveResponse();
    await setup.chat.refreshSessionActivity(FIRST_SESSION_ID);
    const priorError = setup.chat.state.sessionActivityError;
    setup.transport.holdNextActiveResponse();
    const refresh = setup.chat.refreshSessionActivity(FIRST_SESSION_ID);
    await waitFor(() => setup.transport.activeRequests.length >= 3);

    expect(setup.chat.state.sessionActivityError).toBe(priorError);
    setup.transport.releaseHeldActiveResponse({});
    await refresh;
    expect(setup.chat.state.sessionActivityError).toBeNull();
  });

  it("rejects overlong agent and model switch metadata without rendering a truncated record", async () => {
    const diagnostics = new DiagnosticsRecorder();
    const setup = await createConnectedChat({ diagnostics });
    resources.push(setup.cleanup);
    setup.transport.setMessages(FIRST_SESSION_ID, [
      { id: "msg-agent-switch-long", type: "agent-switched", agent: "a".repeat(257) },
      { id: "msg-model-switch-long", type: "model-switched", model: { providerID: "p".repeat(257), id: "model" } },
    ]);

    await setup.chat.reviewSelectedSessionHistory();

    expect(setup.chat.state.messages.some((message) => message.id.endsWith("-long"))).toBe(false);
    expect(diagnostics.getTranscript()).not.toContain("a".repeat(257));
    expect(diagnostics.getTranscript()).not.toContain("p".repeat(257));
  });

  it("maps native busy and retry events to active and reconciles idle events", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    setup.transport.setActiveSessionIDs([]);
    await setup.chat.refreshSessionActivity(FIRST_SESSION_ID);
    expect(setup.chat.state.sessionActivity).toBe("inactive");
    let activeStateUpdates = 0;
    const unsubscribe = setup.chat.subscribe((state) => {
      if (state.sessionActivity === "active") activeStateUpdates += 1;
    });
    resources.push(async () => unsubscribe());

    setup.transport.emit({
      id: "evt-status-busy-selected",
      type: "session.status",
      data: { sessionID: FIRST_SESSION_ID, status: "busy" },
    });
    await waitFor(() => activeStateUpdates > 0);
    const busyUpdates = activeStateUpdates;
    setup.transport.emit({
      id: "evt-status-retry-selected",
      type: "session.status",
      data: { sessionID: FIRST_SESSION_ID, status: "retry" },
    });
    await waitFor(() => activeStateUpdates > busyUpdates);

    setup.transport.setActiveSessionIDs([]);
    setup.transport.emit({
      id: "evt-status-idle-selected",
      type: "session.status",
      data: { sessionID: FIRST_SESSION_ID, status: "idle" },
    });
    await waitFor(
      () =>
        setup.chat.state.sessionActivity === "inactive" &&
        !setup.chat.state.sessionActivityRefreshing,
    );

    setup.transport.setActiveSessionIDs([FIRST_SESSION_ID]);
    setup.transport.emit({
      id: "evt-session-idle-still-active",
      type: "session.idle",
      data: { sessionID: FIRST_SESSION_ID },
    });
    await waitFor(
      () =>
        setup.chat.state.sessionActivity === "active" &&
        !setup.chat.state.sessionActivityRefreshing,
    );
  });

  it("treats interrupt 204 as an acknowledgement until idle is confirmed", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    setup.transport.setActiveSessionIDs([FIRST_SESSION_ID]);
    await setup.chat.refreshSessionActivity(FIRST_SESSION_ID);

    await setup.chat.interruptSession(FIRST_SESSION_ID);

    expect(setup.transport.interruptRequests).toHaveLength(1);
    const request = setup.transport.interruptRequests[0]!;
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe(
      `/api/session/${FIRST_SESSION_ID}/interrupt`,
    );
    expect(request.body).toBeNull();
    expect(setup.chat.state.sessionActivity).toBe("active");
    expect(setup.chat.state.interruptStatus).toBe("waiting");

    setup.transport.setActiveSessionIDs([]);
    setup.transport.emit({
      id: "evt-interrupt-confirmed-idle",
      type: "session.idle",
      data: { sessionID: FIRST_SESSION_ID },
    });
    await waitFor(
      () =>
        setup.chat.state.sessionActivity === "inactive" &&
        setup.chat.state.interruptStatus === "idle",
    );
  });

  it("keeps active state and offers a retry when the interrupt request fails", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    setup.transport.setActiveSessionIDs([FIRST_SESSION_ID]);
    await setup.chat.refreshSessionActivity(FIRST_SESSION_ID);
    setup.transport.setNextInterruptStatus(503);

    await setup.chat.interruptSession(FIRST_SESSION_ID);

    expect(setup.transport.interruptRequests).toHaveLength(1);
    expect(setup.chat.state.sessionActivity).toBe("active");
    expect(setup.chat.state.interruptStatus).toBe("error");
    expect(setup.chat.state.interruptError).toContain("Check the connection and retry");
  });

  it("ignores other-session status and idle events", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    await setup.chat.refreshSessionActivity(FIRST_SESSION_ID);
    expect(setup.chat.state.sessionActivity).toBe("inactive");
    const requestsBefore = setup.transport.activeRequests.length;

    setup.transport.emit({
      id: "evt-status-busy-other-session",
      type: "session.status",
      data: { sessionID: SECOND_SESSION_ID, status: "busy" },
    });
    setup.transport.emit({
      id: "evt-session-idle-other-session",
      type: "session.idle",
      data: { sessionID: SECOND_SESSION_ID },
    });
    setup.transport.emit({
      id: "evt-status-idle-selected-barrier",
      type: "session.status",
      data: { sessionID: FIRST_SESSION_ID, status: "idle" },
    });

    await waitFor(
      () =>
        setup.transport.activeRequests.length === requestsBefore + 1 &&
        !setup.chat.state.sessionActivityRefreshing,
    );
    expect(setup.chat.state.sessionActivity).toBe("inactive");
  });

  it("rejects stale activity snapshots after a newer busy event or session selection", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    setup.transport.setActiveSessionIDs([FIRST_SESSION_ID]);
    await setup.chat.refreshSessionActivity(FIRST_SESSION_ID);
    setup.transport.holdNextActiveResponse();
    setup.transport.setActiveSessionIDs([]);
    const activityRequestCount = setup.transport.activeRequests.length;

    setup.transport.emit({
      id: "evt-delayed-idle-starts-snapshot",
      type: "session.idle",
      data: { sessionID: FIRST_SESSION_ID },
    });
    await waitFor(
      () => setup.transport.activeRequests.length === activityRequestCount + 1,
    );
    setup.transport.emit({
      id: "evt-newer-busy-invalidates-idle-snapshot",
      type: "session.status",
      data: { sessionID: FIRST_SESSION_ID, status: "busy" },
    });
    await waitFor(() => setup.chat.state.sessionActivity === "active");
    setup.transport.releaseHeldActiveResponse({});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setup.chat.state.sessionActivity).toBe("active");

    const staleSetup = await createConnectedChat({ holdInitialActivity: true });
    resources.push(staleSetup.cleanup);
    await waitFor(() => staleSetup.transport.activeRequests.length === 1);
    await staleSetup.chat.selectSession(SECOND_SESSION_ID);
    await waitFor(
      () =>
        staleSetup.chat.state.selectedSessionID === SECOND_SESSION_ID &&
        staleSetup.transport.activeRequests.length >= 2 &&
        staleSetup.chat.state.sessionActivity === "inactive" &&
        !staleSetup.chat.state.sessionActivityRefreshing,
    );
    staleSetup.transport.releaseHeldActiveResponse({
      [FIRST_SESSION_ID]: { type: "running" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(staleSetup.chat.state.selectedSessionID).toBe(SECOND_SESSION_ID);
    expect(staleSetup.chat.state.sessionActivity).toBe("inactive");
  });

  it("refreshes selected-session activity after the event stream reconnects", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    setup.transport.setActiveSessionIDs([FIRST_SESSION_ID]);
    await setup.chat.refreshSessionActivity(FIRST_SESSION_ID);
    expect(setup.chat.state.sessionActivity).toBe("active");
    const activeRequestsBeforeReconnect = setup.transport.activeRequests.length;
    setup.transport.setActiveSessionIDs([]);

    setup.transport.dropEventStream(0);

    await waitFor(
      () =>
        setup.transport.eventRequests.length >= 2 &&
        setup.transport.activeRequests.length > activeRequestsBeforeReconnect &&
        setup.chat.state.sessionActivity === "inactive" &&
        !setup.chat.state.sessionActivityRefreshing,
      10_000,
    );
  });

  it("loads provider, model, and agent choices from workspace-scoped server routes", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);

    expect(setup.chat.state.providers).toEqual([
      { id: "provider-test", name: "Test Provider" },
    ]);
    expect(setup.chat.state.models).toEqual([
      {
        id: "model-test",
        providerID: "provider-test",
        name: "Test Model",
        enabled: true,
        variants: [],
      },
    ]);
    expect(setup.chat.state.agents).toEqual([
      { id: "build", description: "Build changes." },
    ]);
    expect(setup.chat.state.agentChoicesStatus).toBe("ready");

    for (const request of [
      setup.transport.providerRequests[0],
      setup.transport.modelRequests[0],
      setup.transport.agentRequests[0],
    ]) {
      expect(request).toBeDefined();
      expect(new URL(request!.url).searchParams.get("directory")).toBe(WORKSPACE);
    }
    expect(new URL(setup.transport.providerRequests[0]!.url).pathname).toBe(
      "/api/provider",
    );
    expect(new URL(setup.transport.modelRequests[0]!.url).pathname).toBe(
      "/api/model",
    );
    expect(new URL(setup.transport.agentRequests[0]!.url).pathname).toBe(
      "/api/agent",
    );
  });

  it("paginates and searches server sessions without duplicates or selected-session loss", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    const serverSessions = Array.from({ length: 112 }, (_, index) =>
      createServerSession(`ses_search_${index}`, `Needle session ${index}`),
    );
    serverSessions[50] = serverSessions[49]!;
    setup.transport.setSessions(serverSessions);

    await setup.chat.searchSessions("Needle");
    expect(setup.chat.state.sessionSearch).toBe("Needle");
    expect(setup.chat.state.sessions).toHaveLength(50);
    expect(setup.chat.state.sessionNextCursor).toBeTruthy();
    expect(setup.chat.state.selectedSessionID).toBe(FIRST_SESSION_ID);
    expect(setup.chat.state.activeSession?.id).toBe(FIRST_SESSION_ID);
    await setup.chat.loadMoreSessions();
    expect(setup.chat.state.sessions).toHaveLength(99);
    await setup.chat.loadMoreSessions();

    expect(setup.chat.state.sessions).toHaveLength(111);
    expect(setup.chat.state.sessionNextCursor).toBeTruthy();
    expect(new Set(setup.chat.state.sessions.map((session) => session.id)).size).toBe(111);
    expect(setup.chat.state.sessions[0]?.id).toBe("ses_search_0");
    expect(setup.chat.state.sessions[50]?.id).toBe("ses_search_51");
    await setup.chat.loadMoreSessions();
    expect(setup.chat.state.sessions).toHaveLength(111);
    expect(setup.chat.state.sessionNextCursor).toBeNull();
    const sessionRequests = setup.transport.requests.filter(
      (request) =>
        request.method === "GET" && new URL(request.url).pathname === "/api/session",
    );
    const searchRequest = sessionRequests.at(-4)!;
    expect(new URL(searchRequest.url).searchParams.get("search")).toBe("Needle");
    expect(sessionRequests.at(-3)!.url).toContain("cursor=");
    expect(sessionRequests.at(-2)!.url).toContain("cursor=");
    expect(sessionRequests.at(-1)!.url).toContain("cursor=");
  });

  it("loads older history using server-default pages and merges cursor pages in server order", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    const messages = Array.from({ length: 165 }, (_, index) => ({
      id: `msg_user_${String(index).padStart(3, "0")}`,
      type: "user",
      text: `Message ${index}`,
    }));
    setup.transport.setMessages(FIRST_SESSION_ID, messages);

    await setup.chat.selectSession(FIRST_SESSION_ID);
    expect(setup.chat.state.messages).toHaveLength(100);
    expect(setup.chat.state.messages[0]?.id).toBe("msg_user_065");
    expect(setup.chat.state.historyNextCursor).toBeTruthy();
    const olderCursor = setup.chat.state.historyNextCursor;

    await setup.chat.loadOlderHistory();

    expect(setup.chat.state.messages).toHaveLength(150);
    expect(setup.chat.state.messages[0]?.id).toBe("msg_user_015");
    expect(setup.chat.state.messages.at(-1)?.id).toBe("msg_user_164");
    expect(setup.chat.state.historyNextCursor).toBeTruthy();
    const secondOlderCursor = setup.chat.state.historyNextCursor;

    await setup.chat.loadOlderHistory();

    expect(setup.chat.state.messages).toHaveLength(165);
    expect(setup.chat.state.messages[0]?.id).toBe("msg_user_000");
    expect(setup.chat.state.messages.at(-1)?.id).toBe("msg_user_164");
    expect(setup.chat.state.historyNextCursor).toBeTruthy();
    expect(new Set(setup.chat.state.messages.map((message) => message.id)).size).toBe(165);
    const finalNonemptyCursor = setup.chat.state.historyNextCursor;
    await setup.chat.loadOlderHistory();
    expect(setup.chat.state.messages).toHaveLength(165);
    expect(setup.chat.state.historyNextCursor).toBeNull();
    const [latestPage, olderPage, nextOlderPage, emptyPage] =
      setup.transport.historyRequests.slice(-4);
    const latestUrl = new URL(latestPage!.url);
    const olderUrl = new URL(olderPage!.url);
    const nextOlderUrl = new URL(nextOlderPage!.url);
    const emptyUrl = new URL(emptyPage!.url);
    expect(latestUrl.searchParams.get("limit")).toBe("100");
    expect(latestUrl.searchParams.get("order")).toBe("desc");
    expect(olderUrl.searchParams.get("cursor")).toBe(olderCursor);
    expect(olderUrl.searchParams.has("order")).toBe(false);
    expect(olderUrl.searchParams.has("limit")).toBe(false);
    expect(nextOlderUrl.searchParams.get("cursor")).toBe(secondOlderCursor);
    expect(nextOlderUrl.searchParams.has("order")).toBe(false);
    expect(nextOlderUrl.searchParams.has("limit")).toBe(false);
    expect(emptyUrl.searchParams.get("cursor")).toBe(finalNonemptyCursor);
  });

  it("loads pending v2 requests and correlates request events by session and request IDs", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    setup.transport.setPermissionRequests(FIRST_SESSION_ID, [
      {
        id: "permission-from-list",
        sessionID: FIRST_SESSION_ID,
        action: "file.write",
        resources: ["src/main.ts"],
      },
    ]);
    setup.transport.setQuestionRequests(FIRST_SESSION_ID, [
      {
        id: "question-from-list",
        sessionID: FIRST_SESSION_ID,
        questions: [
          {
            header: "Next step",
            question: "How should this proceed?",
            options: [{ label: "Continue", description: "Apply the change." }],
          },
        ],
      },
    ]);
    await setup.chat.refreshSelectedRequests();

    expect(setup.transport.permissionListRequests.some(
      (request) => new URL(request.url).pathname ===
        `/api/session/${FIRST_SESSION_ID}/permission`,
    )).toBe(true);
    expect(setup.transport.questionListRequests.some(
      (request) => new URL(request.url).pathname ===
        `/api/session/${FIRST_SESSION_ID}/question`,
    )).toBe(true);
    expect(setup.chat.state.permissionRequests.map((request) => request.id)).toEqual([
      "permission-from-list",
    ]);
    expect(setup.chat.state.questionRequests.map((request) => request.id)).toEqual([
      "question-from-list",
    ]);

    setup.transport.emit({
      id: "event-envelope-permission-ask",
      type: "permission.v2.asked",
      data: {
        id: "permission-event-request",
        sessionID: FIRST_SESSION_ID,
        action: "file.write",
        resources: ["src/changed.ts"],
        save: ["src/*.ts"],
        metadata: { reason: "Update the implementation" },
        source: {
          type: "tool",
          messageID: "msg-assistant",
          callID: "call-permission",
        },
      },
    });
    await waitFor(() =>
      setup.chat.state.permissionRequests.some(
        (request) => request.id === "permission-event-request",
      ),
    );
    expect(setup.chat.state.permissionRequests.find(
      (request) => request.id === "permission-event-request",
    )).toMatchObject({
      resources: ["src/changed.ts"],
      metadata: '{\n  "reason": "Update the implementation"\n}',
      source: { type: "tool", callID: "call-permission" },
    });

    setup.transport.emit({
      id: "event-envelope-question-ask",
      type: "question.v2.asked",
      data: {
        id: "question-event-request",
        sessionID: FIRST_SESSION_ID,
        questions: [
          {
            header: "Decision",
            question: "Continue?",
            options: [{ label: "Yes", description: "Continue the operation." }],
          },
        ],
        tool: { messageID: "msg-assistant", callID: "call-question" },
      },
    });
    await waitFor(() =>
      setup.chat.state.questionRequests.some(
        (request) => request.id === "question-event-request",
      ),
    );

    setup.transport.emit({
      id: "event-envelope-wrong-session-reply",
      type: "permission.v2.replied",
      data: {
        sessionID: SECOND_SESSION_ID,
        requestID: "permission-event-request",
        reply: "once",
      },
    });
    setup.transport.emit({
      id: "event-envelope-question-reply",
      type: "question.v2.replied",
      data: {
        sessionID: FIRST_SESSION_ID,
        requestID: "question-event-request",
        answers: [["Yes"]],
      },
    });
    await waitFor(() =>
      !setup.chat.state.questionRequests.some(
        (request) => request.id === "question-event-request",
      ),
    );
    expect(setup.chat.state.permissionRequests.some(
      (request) => request.id === "permission-event-request",
    )).toBe(true);

    setup.transport.emit({
      id: "event-envelope-permission-reply",
      type: "permission.v2.replied",
      data: {
        sessionID: FIRST_SESSION_ID,
        requestID: "permission-event-request",
        reply: "always",
      },
    });
    await waitFor(() =>
      !setup.chat.state.permissionRequests.some(
        (request) => request.id === "permission-event-request",
      ),
    );

    setup.transport.emit({
      id: "event-envelope-question-ask-reject",
      type: "question.v2.asked",
      data: {
        id: "question-rejected-event",
        sessionID: FIRST_SESSION_ID,
        questions: [
          {
            header: "Confirm",
            question: "Proceed?",
            options: [{ label: "Yes", description: "Proceed." }],
          },
        ],
      },
    });
    await waitFor(() =>
      setup.chat.state.questionRequests.some(
        (request) => request.id === "question-rejected-event",
      ),
    );
    setup.transport.emit({
      id: "event-envelope-question-reject",
      type: "question.v2.rejected",
      data: {
        sessionID: FIRST_SESSION_ID,
        requestID: "question-rejected-event",
      },
    });
    await waitFor(() =>
      !setup.chat.state.questionRequests.some(
        (request) => request.id === "question-rejected-event",
      ),
    );
  });

  it("sends pinned permission and question replies and reconciles from pending-list responses", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    setup.transport.setPermissionRequests(FIRST_SESSION_ID, [
      {
        id: "permission-to-reply",
        sessionID: FIRST_SESSION_ID,
        action: "file.write",
        resources: ["src/main.ts"],
      },
    ]);
    setup.transport.setQuestionRequests(FIRST_SESSION_ID, [
      {
        id: "question-to-answer",
        sessionID: FIRST_SESSION_ID,
        questions: [
          {
            header: "Choice",
            question: "Continue?",
            options: [{ label: "Yes", description: "Continue." }],
          },
        ],
      },
      {
        id: "question-to-reject",
        sessionID: FIRST_SESSION_ID,
        questions: [
          {
            header: "Choice",
            question: "Run the second operation?",
            options: [{ label: "No", description: "Do not run it." }],
          },
        ],
      },
    ]);
    await setup.chat.refreshSelectedRequests();

    await setup.chat.replyToPermission(
      FIRST_SESSION_ID,
      "permission-to-reply",
      "always",
    );
    await waitFor(() =>
      !setup.chat.state.loadingRequests &&
      setup.chat.state.permissionRequests.length === 0 &&
      setup.chat.state.activeRequestAction === null,
    );
    const permissionReply = setup.transport.permissionReplyRequests[0];
    expect(new URL(permissionReply!.url).pathname).toBe(
      `/api/session/${FIRST_SESSION_ID}/permission/permission-to-reply/reply`,
    );
    expect(setup.transport.requestBodies.get(permissionReply!)).toEqual({
      reply: "always",
    });

    await setup.chat.replyToQuestion(
      FIRST_SESSION_ID,
      "question-to-answer",
      [["Yes"]],
    );
    await waitFor(() =>
      !setup.chat.state.loadingRequests &&
      setup.chat.state.questionRequests.length === 1 &&
      setup.chat.state.activeRequestAction === null,
    );
    const questionReply = setup.transport.questionReplyRequests[0];
    expect(new URL(questionReply!.url).pathname).toBe(
      `/api/session/${FIRST_SESSION_ID}/question/question-to-answer/reply`,
    );
    expect(setup.transport.requestBodies.get(questionReply!)).toEqual({
      answers: [["Yes"]],
    });

    await setup.chat.rejectQuestion(FIRST_SESSION_ID, "question-to-reject");
    await waitFor(() =>
      !setup.chat.state.loadingRequests &&
      setup.chat.state.questionRequests.length === 0 &&
      setup.chat.state.activeRequestAction === null,
    );
    expect(new URL(setup.transport.questionRejectRequests[0]!.url).pathname).toBe(
      `/api/session/${FIRST_SESSION_ID}/question/question-to-reject/reject`,
    );
  });

  it("replays v2 request events that arrive while pending-request lists are loading", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    setup.transport.setPermissionRequests(FIRST_SESSION_ID, []);
    setup.transport.holdNextPermissionListResponse();
    const refresh = setup.chat.refreshSelectedRequests();
    await waitFor(() => setup.transport.hasHeldPermissionListResponse());

    setup.transport.emit({
      id: "event-during-request-snapshot",
      type: "permission.v2.asked",
      data: {
        id: "permission-during-snapshot",
        sessionID: FIRST_SESSION_ID,
        action: "file.write",
        resources: ["src/new.ts"],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setup.chat.state.permissionRequests).toEqual([]);

    setup.transport.releaseHeldPermissionListResponse([]);
    await refresh;
    expect(setup.chat.state.permissionRequests.map((request) => request.id)).toEqual([
      "permission-during-snapshot",
    ]);
    expect(setup.chat.state.loadingRequests).toBe(false);
  });

  it.each(["question.v2.replied", "question.v2.rejected"] as const)(
    "keeps a question removed when %s arrives during a reconnect list snapshot",
    async (type) => {
      const setup = await createConnectedChat();
      resources.push(setup.cleanup);
      const question = {
        id: "question-resolved-during-reconnect",
        sessionID: FIRST_SESSION_ID,
        questions: [
          {
            header: "Decision",
            question: "Continue?",
            options: [{ label: "Yes", description: "Continue the operation." }],
          },
        ],
      };
      setup.transport.setQuestionRequests(FIRST_SESSION_ID, [question]);
      await setup.chat.refreshSelectedRequests();
      expect(setup.chat.state.questionRequests.map((request) => request.id)).toEqual([
        question.id,
      ]);

      setup.transport.holdNextQuestionListResponse();
      setup.transport.dropEventStream(0);
      await waitFor(() => setup.transport.eventRequests.length === 2, 10_000);
      await waitFor(() => setup.transport.hasHeldQuestionListResponse());

      let stateUpdates = 0;
      const unsubscribe = setup.chat.subscribe(() => {
        stateUpdates += 1;
      });
      resources.push(async () => unsubscribe());
      const beforeResolution = stateUpdates;
      setup.transport.emit(
        type === "question.v2.replied"
          ? {
              id: "question-resolved-by-reply",
              type,
              data: {
                sessionID: FIRST_SESSION_ID,
                requestID: question.id,
                answers: [["Yes"]],
              },
            }
          : {
              id: "question-resolved-by-reject",
              type,
              data: {
                sessionID: FIRST_SESSION_ID,
                requestID: question.id,
              },
            },
        1,
      );
      await waitFor(() => stateUpdates > beforeResolution);

      expect(setup.chat.state.questionRequests.map((request) => request.id)).toEqual([
        question.id,
      ]);
      setup.transport.releaseHeldQuestionListResponse([question]);
      await waitFor(
        () =>
          !setup.chat.state.loadingRequests &&
          !setup.chat.state.questionRequests.some((request) => request.id === question.id),
      );

      expect(setup.chat.state.questionRequests).toEqual([]);
    },
  );

  it("creates a session at the host-selected workspace location and selects its history", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    const created = createServerSession("ses_created123", "Created session");
    setup.transport.setCreatedSession(created);

    await setup.chat.createSession();

    const createRequest = setup.transport.requests.find(
      (request) =>
        request.method === "POST" && new URL(request.url).pathname === "/api/session",
    );
    expect(createRequest).toBeDefined();
    expect(setup.transport.requestBodies.get(createRequest!)).toEqual({
      location: { directory: WORKSPACE },
    });
    expect(setup.chat.state.selectedSessionID).toBe("ses_created123");
    expect(setup.chat.state.sessions[0]?.title).toBe("Created session");
    expect(
      setup.transport.requests.some(
        (request) =>
          new URL(request.url).pathname ===
          "/api/session/ses_created123/message",
      ),
    ).toBe(true);
    await waitFor(() => setup.chat.state.streamStatus === "connected");
  });

  it("switches only server-listed models and agents and carries them into session creation", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);

    await setup.chat.selectModel("provider-test", "model-test");
    await setup.chat.selectAgent("build");

    const modelSwitch = setup.transport.requests.find(
      (request) =>
        request.method === "POST" &&
        new URL(request.url).pathname === `/api/session/${FIRST_SESSION_ID}/model`,
    );
    const agentSwitch = setup.transport.requests.find(
      (request) =>
        request.method === "POST" &&
        new URL(request.url).pathname === `/api/session/${FIRST_SESSION_ID}/agent`,
    );
    expect(modelSwitch).toBeDefined();
    expect(setup.transport.requestBodies.get(modelSwitch!)).toEqual({
      model: { id: "model-test", providerID: "provider-test" },
    });
    expect(agentSwitch).toBeDefined();
    expect(setup.transport.requestBodies.get(agentSwitch!)).toEqual({ agent: "build" });
    expect(setup.chat.state.activeSession?.model).toEqual({
      id: "model-test",
      providerID: "provider-test",
    });
    expect(setup.chat.state.activeSession?.agent).toBe("build");

    await setup.chat.createSession();
    const createRequest = setup.transport.requests.filter(
      (request) =>
        request.method === "POST" && new URL(request.url).pathname === "/api/session",
    ).at(-1);
    expect(setup.transport.requestBodies.get(createRequest!)).toEqual({
      location: { directory: WORKSPACE },
      model: { id: "model-test", providerID: "provider-test" },
      agent: "build",
    });
  });

  it("shows experimental model discovery as unavailable and never fabricates choices", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    setup.transport.failNextChoiceRequest("/api/model", 404);

    await setup.chat.refreshChoices();

    expect(setup.chat.state.modelChoicesStatus).toBe("unavailable");
    expect(setup.chat.state.modelChoicesError).toContain("experimental endpoint");
    expect(setup.chat.state.models).toEqual([]);
    expect(setup.chat.state.providerChoicesStatus).toBe("ready");
    expect(setup.chat.state.agentChoicesStatus).toBe("ready");
  });

  it("requires a host-started explicit delete confirmation and uses the root legacy route", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);

    await setup.chat.deleteSession(FIRST_SESSION_ID);
    expect(setup.transport.deleteRequests).toHaveLength(0);
    const firstConfirmation = setup.chat.beginSessionDeletionConfirmation(FIRST_SESSION_ID);
    expect(firstConfirmation?.title).toBe("First session");
    setup.chat.cancelSessionDeletionConfirmation(FIRST_SESSION_ID);
    await setup.chat.deleteSession(FIRST_SESSION_ID);
    expect(setup.transport.deleteRequests).toHaveLength(0);

    expect(setup.chat.beginSessionDeletionConfirmation(FIRST_SESSION_ID)).toBeDefined();
    await setup.chat.deleteSession(FIRST_SESSION_ID);

    const deletion = setup.transport.deleteRequests[0];
    expect(new URL(deletion!.url).pathname).toBe(`/session/${FIRST_SESSION_ID}`);
    expect(deletion!.method).toBe("DELETE");
    expect(new URL(deletion!.url).searchParams.get("directory")).toBe(WORKSPACE);
    expect(setup.transport.requests.some(
      (request) => new URL(request.url).pathname === `/api/session/${FIRST_SESSION_ID}` &&
        request.method === "DELETE",
    )).toBe(false);
    expect(setup.chat.state.selectedSessionID).toBe(SECOND_SESSION_ID);
    expect(setup.chat.state.sessions.some((session) => session.id === FIRST_SESSION_ID)).toBe(
      false,
    );
  });

  it("submits only bounded text through the v2 prompt route after the event stream is ready", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);

    await setup.chat.sendPrompt(
      PROMPT_REQUEST_ID,
      PROMPT_ATTEMPT_ID,
      "Summarize the selected session.",
      FIRST_SESSION_ID,
    );

    const promptRequest = setup.transport.requests.find(
      (request) =>
        request.method === "POST" &&
        new URL(request.url).pathname ===
          `/api/session/${FIRST_SESSION_ID}/prompt`,
    );
    expect(promptRequest).toBeDefined();
    expect(setup.transport.requestBodies.get(promptRequest!)).toEqual({
      id: `msg_${PROMPT_REQUEST_ID}`,
      prompt: { text: "Summarize the selected session." },
      delivery: "steer",
    });
    expect(setup.chat.state.promptResult).toEqual({
      requestID: PROMPT_REQUEST_ID,
      attemptID: PROMPT_ATTEMPT_ID,
      sessionID: FIRST_SESSION_ID,
      status: "accepted",
    });
    expect(setup.chat.state.messages.at(-1)).toEqual({
      id: `msg_${PROMPT_REQUEST_ID}`,
      role: "user",
      text: "Summarize the selected session.",
    });

    const promptCount = setup.transport.requests.filter(
      (request) => new URL(request.url).pathname.endsWith("/prompt"),
    ).length;
    await setup.chat.sendPrompt(
      "550e8400-e29b-41d4-a716-446655440003",
      "550e8400-e29b-41d4-a716-446655440004",
      "x".repeat(20_001),
      FIRST_SESSION_ID,
    );
    expect(
      setup.transport.requests.filter((request) =>
        new URL(request.url).pathname.endsWith("/prompt"),
      ),
    ).toHaveLength(promptCount);
  });

  it("retries an unknown prompt with the same server ID and admits it only once", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    const text = [
      "Retry the exact prompt after the response was lost.",
      createEditorContextBlock("src/feature.ts", {
        text: "selected editor buffer text",
        startLine: 7,
        endLine: 8,
      }),
    ].join("\n\n");
    const serverMessageID = `msg_${PROMPT_REQUEST_ID}`;
    setup.transport.setPromptMode("ambiguous-after-admission");

    await setup.chat.sendPrompt(
      PROMPT_REQUEST_ID,
      PROMPT_ATTEMPT_ID,
      text,
      FIRST_SESSION_ID,
    );

    expect(setup.chat.state.promptResult).toMatchObject({
      requestID: PROMPT_REQUEST_ID,
      attemptID: PROMPT_ATTEMPT_ID,
      sessionID: FIRST_SESSION_ID,
      status: "outcome-unknown",
    });
    expect(setup.transport.admittedPromptCount()).toBe(1);

    setup.transport.setPromptMode("accepted");
    await setup.chat.sendPrompt(
      PROMPT_REQUEST_ID,
      PROMPT_RETRY_ATTEMPT_ID,
      text,
      FIRST_SESSION_ID,
    );

    expect(setup.transport.promptRequests).toHaveLength(2);
    expect(
      setup.transport.promptRequests.map((request) =>
        setup.transport.requestBodies.get(request),
      ),
    ).toEqual([
      { id: serverMessageID, prompt: { text }, delivery: "steer" },
      { id: serverMessageID, prompt: { text }, delivery: "steer" },
    ]);
    expect(
      setup.transport.promptRequests.map(
        (request) => new URL(request.url).pathname,
      ),
    ).toEqual([
      `/api/session/${FIRST_SESSION_ID}/prompt`,
      `/api/session/${FIRST_SESSION_ID}/prompt`,
    ]);
    expect(setup.transport.admittedPromptCount()).toBe(1);
    expect(setup.chat.state.promptResult).toMatchObject({
      requestID: PROMPT_REQUEST_ID,
      attemptID: PROMPT_RETRY_ATTEMPT_ID,
      sessionID: FIRST_SESSION_ID,
      status: "accepted",
    });
    expect(
      setup.chat.state.messages.filter((message) => message.id === serverMessageID),
    ).toEqual([{ id: serverMessageID, role: "user", text }]);
  });

  it("rejects a retry for its original target if selection changes before host handling", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    const text = "Retry only in the original session.";
    setup.transport.setPromptMode("ambiguous");
    await setup.chat.sendPrompt(
      PROMPT_REQUEST_ID,
      PROMPT_ATTEMPT_ID,
      text,
      FIRST_SESSION_ID,
    );

    await setup.chat.selectSession(SECOND_SESSION_ID);
    await setup.chat.sendPrompt(
      PROMPT_REQUEST_ID,
      PROMPT_RETRY_ATTEMPT_ID,
      text,
      FIRST_SESSION_ID,
    );

    expect(setup.chat.state.selectedSessionID).toBe(SECOND_SESSION_ID);
    expect(setup.transport.promptRequests).toHaveLength(1);
    expect(setup.chat.state.promptResult).toEqual({
      requestID: PROMPT_REQUEST_ID,
      attemptID: PROMPT_RETRY_ATTEMPT_ID,
      sessionID: FIRST_SESSION_ID,
      status: "rejected",
    });
    expect(setup.chat.state.error).toBe(
      "The selected session changed before submission. The prompt was not sent.",
    );
  });

  it("rejects an invalid target without sending and returns a rejected attempt result", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);

    await setup.chat.sendPrompt(
      PROMPT_REQUEST_ID,
      PROMPT_ATTEMPT_ID,
      "Do not send with an invalid target.",
      "../invalid",
    );

    expect(setup.transport.promptRequests).toHaveLength(0);
    expect(setup.chat.state.promptResult).toEqual({
      requestID: PROMPT_REQUEST_ID,
      attemptID: PROMPT_ATTEMPT_ID,
      sessionID: null,
      status: "rejected",
    });
    expect(setup.chat.state.error).toBe(
      "The target session is invalid. The prompt was not sent.",
    );
  });

  it("reviews only the selected session history without resending an unknown prompt", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    const text = "Keep the original prompt while reviewing history.";
    setup.transport.setPromptMode("ambiguous");

    await setup.chat.sendPrompt(
      PROMPT_REQUEST_ID,
      PROMPT_ATTEMPT_ID,
      text,
      FIRST_SESSION_ID,
    );

    const priorPromptResult = setup.chat.state.promptResult;
    const promptRequestCount = setup.transport.promptRequests.length;
    const historyRequestCount = setup.transport.historyRequests.length;
    const sessionListRequestCount = setup.transport.requests.filter(
      (request) =>
        request.method === "GET" && new URL(request.url).pathname === "/api/session",
    ).length;
    setup.transport.setMessages(FIRST_SESSION_ID, [
      ...messagesBySession.get(FIRST_SESSION_ID)!,
      { id: `msg_${PROMPT_REQUEST_ID}`, type: "user", text },
    ]);

    await setup.chat.reviewSelectedSessionHistory();

    expect(setup.transport.historyRequests).toHaveLength(historyRequestCount + 1);
    expect(new URL(setup.transport.historyRequests.at(-1)!.url).pathname).toBe(
      `/api/session/${FIRST_SESSION_ID}/message`,
    );
    expect(
      setup.transport.requests.filter(
        (request) =>
          request.method === "GET" && new URL(request.url).pathname === "/api/session",
      ),
    ).toHaveLength(sessionListRequestCount);
    expect(setup.transport.promptRequests).toHaveLength(promptRequestCount);
    expect(setup.chat.state.selectedSessionID).toBe(FIRST_SESSION_ID);
    expect(setup.chat.state.promptResult).toEqual(priorPromptResult);
    expect(setup.chat.state.messages).toContainEqual({
      id: `msg_${PROMPT_REQUEST_ID}`,
      role: "user",
      text,
    });
    expect(setup.chat.state.historyError).toBeNull();
  });

  it("retains an unknown prompt result and exposes a sanitized history error", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    setup.transport.setPromptMode("ambiguous");

    await setup.chat.sendPrompt(
      PROMPT_REQUEST_ID,
      PROMPT_ATTEMPT_ID,
      "Do not lose this draft.",
      FIRST_SESSION_ID,
    );

    const priorPromptResult = setup.chat.state.promptResult;
    setup.transport.failNextHistoryRequest();
    await setup.chat.reviewSelectedSessionHistory();

    expect(setup.chat.state.loadingMessages).toBe(false);
    expect(setup.chat.state.historyError).toBe(
      "Could not load the selected OpenCode session history. Try reviewing it again.",
    );
    expect(setup.chat.state.error).toContain("The prompt outcome is unknown");
    expect(setup.chat.state.promptResult).toEqual(priorPromptResult);
    expect(setup.transport.promptRequests).toHaveLength(1);
  });

  it("preserves the active session while keeping the visible session list capped at 50", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    setup.transport.setSessions(
      Array.from({ length: 50 }, (_, index) =>
        createServerSession(`ses_recent_${index}`, `Recent ${index}`),
      ),
    );

    await setup.chat.refreshSessions();

    expect(setup.chat.state.sessions).toHaveLength(50);
    expect(setup.chat.state.sessions.some((session) => session.id === FIRST_SESSION_ID)).toBe(
      false,
    );
    expect(setup.chat.state.selectedSessionID).toBe(FIRST_SESSION_ID);
    expect(setup.chat.state.activeSession).toMatchObject({
      id: FIRST_SESSION_ID,
      title: "First session",
    });
    expect(chatStateSchema.safeParse(setup.chat.state).success).toBe(true);
    await setup.chat.selectSession(FIRST_SESSION_ID);
    expect(setup.chat.state.selectedSessionID).toBe(FIRST_SESSION_ID);
  });

  it("subscribes before loading history and merges deltas that overlap the history snapshot", async () => {
    const setup = await createConnectedChat({
      holdInitialHistory: true,
      waitForHistory: false,
    });
    resources.push(setup.cleanup);
    let stateUpdates = 0;
    const unsubscribe = setup.chat.subscribe(() => {
      stateUpdates += 1;
    });
    resources.push(async () => unsubscribe());

    const eventIndex = setup.transport.requests.findIndex(
      (request) => new URL(request.url).pathname === "/api/event",
    );
    const historyIndex = setup.transport.requests.findIndex(
      (request) =>
        new URL(request.url).pathname ===
        `/api/session/${FIRST_SESSION_ID}/message`,
    );
    expect(eventIndex).toBeGreaterThanOrEqual(0);
    expect(historyIndex).toBeGreaterThan(eventIndex);

    const beforeDelta = stateUpdates;
    setup.transport.emit({
      id: "evt-during-initial-snapshot",
      type: "session.next.text.delta",
      data: {
        timestamp: 30,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: "msg-buffered",
        textID: "part-buffered",
        delta: "Recovered ",
      },
    });
    await waitFor(() => stateUpdates > beforeDelta);
    setup.transport.releaseHeldHistory([
      { id: "msg-user", type: "user", text: "Previous prompt" },
      {
        id: "msg-buffered",
        type: "assistant",
        content: [{ id: "part-buffered", type: "text", text: "Recovered " }],
      },
    ]);

    await waitFor(() => !setup.chat.state.loadingMessages);
    expect(
      setup.chat.state.messages.find((message) => message.id === "msg-buffered"),
    ).toEqual({ id: "msg-buffered", role: "assistant", text: "Recovered " });

    setup.transport.emit({
      id: "evt-after-initial-snapshot",
      type: "session.next.text.delta",
      data: {
        timestamp: 31,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: "msg-buffered",
        textID: "part-buffered",
        delta: "answer",
      },
    });
    await waitFor(() =>
      setup.chat.state.messages.some(
        (message) => message.id === "msg-buffered" && message.text === "Recovered answer",
      ),
    );
  });

  it("replays equal-timestamp text and tool input deltas in arrival order", async () => {
    const setup = await createConnectedChat({
      holdInitialHistory: true,
      waitForHistory: false,
    });
    resources.push(setup.cleanup);
    await waitFor(() => setup.transport.historyRequests.length === 1);

    setup.transport.emit({
      id: "z-text-delta-arrived-first",
      type: "session.next.text.delta",
      data: {
        timestamp: 80,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: "msg-order",
        textID: "part-order-text",
        delta: "first-",
      },
    });
    setup.transport.emit({
      id: "a-text-delta-arrived-second",
      type: "session.next.text.delta",
      data: {
        timestamp: 80,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: "msg-order",
        textID: "part-order-text",
        delta: "second",
      },
    });
    setup.transport.emit({
      id: "tool-start-order",
      type: "session.next.tool.input.started",
      data: {
        timestamp: 80,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: "msg-order",
        callID: "call-order",
        name: "order-tool",
      },
    });
    setup.transport.emit({
      id: "z-tool-delta-arrived-first",
      type: "session.next.tool.input.delta",
      data: {
        timestamp: 80,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: "msg-order",
        callID: "call-order",
        delta: '{"order":"first-',
      },
    });
    setup.transport.emit({
      id: "a-tool-delta-arrived-second",
      type: "session.next.tool.input.delta",
      data: {
        timestamp: 80,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: "msg-order",
        callID: "call-order",
        delta: 'second"}',
      },
    });

    setup.transport.releaseHeldHistory([
      { id: "msg-user", type: "user", text: "Previous prompt" },
    ]);
    await waitFor(() => {
      const message = setup.chat.state.messages.find((item) => item.id === "msg-order");
      return (
        !setup.chat.state.loadingMessages &&
        message?.text === "first-second" &&
        message?.parts?.some(
          (part) => part.type === "tool" && part.input === '{"order":"first-second"}',
        ) === true
      );
    });

    const message = setup.chat.state.messages.find((item) => item.id === "msg-order");
    expect(message?.text).toBe("first-second");
    expect(message?.parts?.map((part) => part.type)).toEqual(["text", "tool"]);
    expect(
      message?.parts?.find((part) => part.type === "tool" && part.callID === "call-order"),
    ).toMatchObject({
      name: "order-tool",
      input: '{"order":"first-second"}',
    });
  });

  it("preserves equal-timestamp text part arrival order after history refresh", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);

    setup.transport.emit({
      id: "evt-z-part-arrived-first",
      type: "session.next.text.delta",
      data: {
        timestamp: 90,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: "msg-refresh-order",
        textID: "text-z-first",
        delta: "first",
      },
    });
    setup.transport.emit({
      id: "evt-a-part-arrived-second",
      type: "session.next.text.delta",
      data: {
        timestamp: 90,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: "msg-refresh-order",
        textID: "text-a-second",
        delta: "second",
      },
    });
    await waitFor(() =>
      setup.chat.state.messages.some(
        (message) =>
          message.id === "msg-refresh-order" && message.text === "firstsecond",
      ),
    );

    setup.transport.setMessages(FIRST_SESSION_ID, [
      ...messagesBySession.get(FIRST_SESSION_ID)!,
      {
        id: "msg-refresh-order",
        type: "assistant",
        time: { created: 90, completed: 100 },
        content: [
          {
            id: "reasoning-only-refresh-part",
            type: "reasoning",
            text: "The refreshed projection omitted the streamed text parts.",
          },
        ],
      },
    ]);
    await setup.chat.reviewSelectedSessionHistory();

    expect(
      setup.chat.state.messages.find((message) => message.id === "msg-refresh-order"),
    ).toEqual({
      id: "msg-refresh-order",
      role: "assistant",
      text: "firstsecond",
    });
  });

  it("preserves durable sequence ordering for equal-timestamp text parts after history refresh", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);

    setup.transport.emit({
      id: "evt-durable-seq-later-arrives-first",
      durable: { seq: 2 },
      type: "session.next.text.delta",
      data: {
        timestamp: 90,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: "msg-durable-order",
        textID: "text-seq-two",
        delta: "second",
      },
    });
    setup.transport.emit({
      id: "evt-durable-seq-first-arrives-second",
      durable: { seq: 1 },
      type: "session.next.text.delta",
      data: {
        timestamp: 90,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: "msg-durable-order",
        textID: "text-seq-one",
        delta: "first",
      },
    });
    await waitFor(() =>
      setup.chat.state.messages.some(
        (message) => message.id === "msg-durable-order" && message.text === "firstsecond",
      ),
    );

    setup.transport.setMessages(FIRST_SESSION_ID, [
      ...messagesBySession.get(FIRST_SESSION_ID)!,
      {
        id: "msg-durable-order",
        type: "assistant",
        time: { created: 90, completed: 100 },
        content: [],
      },
    ]);
    await setup.chat.reviewSelectedSessionHistory();

    expect(
      setup.chat.state.messages.find((message) => message.id === "msg-durable-order")?.text,
    ).toBe("firstsecond");
  });

  it("keeps history part order authoritative when stream sequence evidence conflicts", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    const messageID = "msg-history-order-authority";
    setup.transport.setMessages(FIRST_SESSION_ID, [
      ...messagesBySession.get(FIRST_SESSION_ID)!,
      {
        id: messageID,
        type: "assistant",
        content: [
          { id: "part-seq-two", type: "text", text: "A" },
          { id: "part-no-seq", type: "text", text: "B" },
          {
            id: "part-history-tool",
            type: "tool",
            name: "bash",
            state: { status: "completed", input: {}, result: "done" },
          },
          { id: "part-seq-one", type: "text", text: "C" },
        ],
      },
    ]);
    await setup.chat.reviewSelectedSessionHistory();

    setup.transport.emit({
      id: "history-conflict-seq-two",
      durable: { seq: 2 },
      type: "session.next.text.ended",
      data: {
        timestamp: 90,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: messageID,
        textID: "part-seq-two",
        text: "A",
      },
    });
    setup.transport.emit({
      id: "history-conflict-seq-one",
      durable: { seq: 1 },
      type: "session.next.text.ended",
      data: {
        timestamp: 90,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: messageID,
        textID: "part-seq-one",
        text: "C",
      },
    });
    await setup.chat.reviewSelectedSessionHistory();

    expect(
      setup.chat.state.messages.find((message) => message.id === messageID)?.text,
    ).toBe("ABC");
    expect(
      setup.chat.state.messages.find((message) => message.id === messageID)?.parts?.map((part) => part.id),
    ).toEqual([
      "part-seq-two",
      "part-no-seq",
      "part-history-tool",
      "part-seq-one",
    ]);
  });

  it("keeps historical parts ordered when a new streamed text part coexists", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    const messageID = "msg-mixed-history-live-order";
    setup.transport.setMessages(FIRST_SESSION_ID, [
      ...messagesBySession.get(FIRST_SESSION_ID)!,
      {
        id: messageID,
        type: "assistant",
        content: [
          { id: "history-z", type: "text", text: "first" },
          {
            id: "history-tool",
            type: "tool",
            name: "bash",
            state: { status: "completed", input: {}, result: "done" },
          },
          { id: "history-a", type: "text", text: "second" },
        ],
      },
    ]);
    await setup.chat.reviewSelectedSessionHistory();

    setup.transport.emit({
      id: "evt-new-live-part",
      type: "session.next.text.delta",
      data: {
        timestamp: 1,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: messageID,
        textID: "live-text",
        delta: "new",
      },
    });

    await waitFor(() =>
      setup.chat.state.messages.some(
        (message) => message.id === messageID && message.text.includes("new"),
      ),
    );
    expect(
      setup.chat.state.messages.find((message) => message.id === messageID)?.parts?.map((part) => part.id),
    ).toEqual(["live-text", "history-z", "history-tool", "history-a"]);
  });

  it("keeps history order authoritative when mixed streamed parts have durable sequences", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    const messageID = "msg-mixed-history-durable-order";
    setup.transport.setMessages(FIRST_SESSION_ID, [
      ...messagesBySession.get(FIRST_SESSION_ID)!,
      {
        id: messageID,
        type: "assistant",
        content: [
          { id: "history-z", type: "text", text: "A" },
          { id: "history-a", type: "text", text: "B" },
        ],
      },
    ]);
    await setup.chat.reviewSelectedSessionHistory();

    setup.transport.emit({
      id: "evt-history-a-sequence-two",
      durable: { seq: 2 },
      type: "session.next.text.ended",
      data: {
        timestamp: 200,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: messageID,
        textID: "history-z",
        text: "A",
      },
    });
    setup.transport.emit({
      id: "evt-history-b-sequence-one",
      durable: { seq: 1 },
      type: "session.next.text.ended",
      data: {
        timestamp: 100,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: messageID,
        textID: "history-a",
        text: "B",
      },
    });
    setup.transport.emit({
      id: "evt-live-c-sequence-three",
      durable: { seq: 3 },
      type: "session.next.text.ended",
      data: {
        timestamp: 300,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: messageID,
        textID: "live-c",
        text: "C",
      },
    });
    setup.transport.emit({
      id: "evt-live-d-sequence-four",
      durable: { seq: 4 },
      type: "session.next.text.ended",
      data: {
        timestamp: 400,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: messageID,
        textID: "live-d",
        text: "D",
      },
    });

    await waitFor(() =>
      setup.chat.state.messages.some(
        (message) => message.id === messageID && message.text.length === 4,
      ),
    );
    expect(
      setup.chat.state.messages.find((message) => message.id === messageID)?.text,
    ).toBe("ABCD");
  });

  it("uses durable sequence from live text.ended events as ordering evidence", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    const messageID = "msg-ended-sequence-order";
    setup.transport.emit({
      id: "ended-seq-two-delta",
      durable: { seq: 201 },
      type: "session.next.text.delta",
      data: {
        timestamp: 150,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: messageID,
        textID: "ended-seq-two",
        delta: "second",
      },
    });
    setup.transport.emit({
      id: "ended-seq-one-complete",
      durable: { seq: 200 },
      type: "session.next.text.ended",
      data: {
        timestamp: 100,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: messageID,
        textID: "ended-seq-one",
        text: "first",
      },
    });

    await waitFor(() =>
      setup.chat.state.messages.some(
        (message) => message.id === messageID && message.text === "firstsecond",
      ),
    );
  });

  it("streams v2 text deltas by session, assistant message, and part; drops duplicate and older fragments", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);

    setup.transport.emit({
      id: "evt-other-session",
      type: "session.next.text.delta",
      data: {
        timestamp: 10,
        sessionID: SECOND_SESSION_ID,
        assistantMessageID: "msg-other",
        textID: "text-other",
        delta: "Wrong session",
      },
    });
    setup.transport.emit({
      id: "evt-part-a",
      type: "session.next.text.delta",
      data: {
        timestamp: 20,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: "msg-live",
        textID: "text-a",
        delta: "Hello ",
      },
    });
    setup.transport.emit({
      id: "evt-part-a",
      type: "session.next.text.delta",
      data: {
        timestamp: 20,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: "msg-live",
        textID: "text-a",
        delta: "Hello ",
      },
    });
    setup.transport.emit({
      id: "evt-older-part-a",
      type: "session.next.text.delta",
      data: {
        timestamp: 19,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: "msg-live",
        textID: "text-a",
        delta: "Out of order",
      },
    });
    setup.transport.emit({
      id: "evt-part-b",
      type: "session.next.text.delta",
      data: {
        timestamp: 21,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: "msg-live",
        textID: "text-b",
        delta: "world",
      },
    });
    setup.transport.emit({
      id: "evt-other-message",
      type: "session.next.text.delta",
      data: {
        timestamp: 22,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: "msg-next",
        textID: "text-c",
        delta: "Separate message",
      },
    });
    setup.transport.emit({
      id: "legacy-envelope",
      type: "session.next.text.delta",
      properties: {
        timestamp: 23,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: "msg-live",
        textID: "text-a",
        delta: "Legacy envelope ignored",
      },
    });

    await waitFor(() =>
      setup.chat.state.messages.some((message) => message.id === "msg-next"),
    );
    expect(
      setup.chat.state.messages.find((message) => message.id === "msg-live"),
    ).toEqual({ id: "msg-live", role: "assistant", text: "Hello world" });
    expect(
      setup.chat.state.messages.find((message) => message.id === "msg-next"),
    ).toEqual({ id: "msg-next", role: "assistant", text: "Separate message" });
  });

  it("reconciles tool lifecycle details by session, assistant message, and call ID", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);

    const toolIdentity = {
      sessionID: FIRST_SESSION_ID,
      assistantMessageID: "msg-tools",
      callID: "call-success",
    };
    setup.transport.emit({
      id: "evt-tool-text",
      type: "session.next.text.delta",
      data: {
        timestamp: 39,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: "msg-tools",
        textID: "text-tools",
        delta: "Running tools.",
      },
    });
    setup.transport.emit({
      id: "evt-tool-input-delta",
      type: "session.next.tool.input.delta",
      data: { ...toolIdentity, timestamp: 41, delta: '{"command":"echo ' },
    });
    setup.transport.emit({
      id: "evt-tool-input-started",
      type: "session.next.tool.input.started",
      data: { ...toolIdentity, timestamp: 40, name: "bash" },
    });
    setup.transport.emit({
      id: "evt-tool-input-ended",
      type: "session.next.tool.input.ended",
      data: {
        ...toolIdentity,
        timestamp: 43,
        text: '{"command":"echo M4"}',
      },
    });
    setup.transport.emit({
      id: "evt-tool-called",
      type: "session.next.tool.called",
      data: {
        ...toolIdentity,
        timestamp: 44,
        tool: "bash",
        input: { command: "echo M4" },
        provider: { executed: true },
      },
    });
    setup.transport.emit({
      id: "evt-tool-progress",
      type: "session.next.tool.progress",
      data: {
        ...toolIdentity,
        timestamp: 45,
        structured: { phase: "running" },
        content: [{ type: "text", text: "working" }],
      },
    });
    const successEvent = {
      id: "evt-tool-success",
      type: "session.next.tool.success",
      data: {
        ...toolIdentity,
        timestamp: 47,
        structured: { exitCode: 0 },
        content: [{ type: "text", text: "hello" }],
        result: { exitCode: 0 },
        outputPaths: ["src/generated.ts"],
        provider: { executed: true },
      },
    };
    setup.transport.emit(successEvent);
    setup.transport.emit({
      ...successEvent,
      data: { ...successEvent.data, result: "duplicate event ID" },
    });
    setup.transport.emit({
      id: "evt-tool-canonical",
      type: "message.part.updated",
      data: {
        sessionID: FIRST_SESSION_ID,
        time: 48,
        part: {
          id: "part-tool-success",
          sessionID: FIRST_SESSION_ID,
          messageID: "msg-tools",
          type: "tool",
          callID: "call-success",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "echo M4" },
            output: "hello",
            time: { start: 40, end: 47 },
          },
        },
      },
    });
    setup.transport.emit({
      id: "evt-tool-failed-start",
      type: "session.next.tool.input.started",
      data: {
        timestamp: 50,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: "msg-tools",
        callID: "call-failed",
        name: "future-tool",
      },
    });
    setup.transport.emit({
      id: "evt-tool-failed",
      type: "session.next.tool.failed",
      data: {
        timestamp: 52,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: "msg-tools",
        callID: "call-failed",
        error: { _tag: "UnknownError", message: "Tool failed." },
        provider: { executed: true },
      },
    });
    setup.transport.emit({
      id: "evt-tool-other-session",
      type: "session.next.tool.called",
      data: {
        timestamp: 53,
        sessionID: SECOND_SESSION_ID,
        assistantMessageID: "msg-tools",
        callID: "call-other-session",
        tool: "should-not-appear",
        input: {},
        provider: { executed: true },
      },
    });
    setup.transport.emit({
      id: "evt-session-diff",
      type: "session.diff",
      data: {
        sessionID: FIRST_SESSION_ID,
        diff: [
          {
            file: "src/app.ts",
            patch: "@@ -1 +1 @@",
            additions: 4,
            deletions: 1,
            status: "modified",
          },
        ],
      },
    });
    setup.transport.emit({
      id: "evt-file-edited-without-session",
      type: "file.edited",
      data: { file: "src/unrelated.ts" },
    });

    await waitFor(() =>
      setup.chat.state.messages
        .find((message) => message.id === "msg-tools")
        ?.parts?.filter((part) => part.type === "tool").length === 2,
    );
    const message = setup.chat.state.messages.find((item) => item.id === "msg-tools");
    expect(message?.text).toBe("Running tools.");
    expect(message?.parts).toMatchObject([
      { id: "text-tools", type: "text", text: "Running tools." },
      {
        id: "part-tool-success",
        type: "tool",
        callID: "call-success",
        name: "bash",
        status: "completed",
        input: '{\n  "command": "echo M4"\n}',
        output: "hello",
        result: '{\n  "exitCode": 0\n}',
        reportedPaths: ["src/generated.ts"],
        durationMs: 7,
      },
      {
        id: "call-failed",
        type: "tool",
        callID: "call-failed",
        name: "future-tool",
        error: '{\n  "_tag": "UnknownError",\n  "message": "Tool failed."\n}',
      },
    ]);
    expect(message?.parts?.filter((part) => part.type === "tool")).toHaveLength(2);
    const failedPart = message?.parts?.find(
      (part) => part.type === "tool" && part.callID === "call-failed",
    );
    expect(failedPart?.type === "tool" ? failedPart.status : undefined).toBe("error");
    expect(message?.parts?.some(
      (part) => part.type === "tool" && part.name === "should-not-appear",
    )).toBe(false);
    expect(setup.chat.state.sessionDiffs).toEqual([
      {
        file: "src/app.ts",
        patch: "@@ -1 +1 @@",
        additions: 4,
        deletions: 1,
        status: "modified",
      },
    ]);
    expect(JSON.stringify(setup.chat.state.sessionDiffs)).not.toContain("generated.ts");
    expect(chatStateSchema.safeParse(setup.chat.state).success).toBe(true);
  });

  it("converges lifecycle and stale canonical tool state with terminal reconnect history", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    const messageID = "msg-tool-reconnect";
    const callID = "call-tool-reconnect";

    setup.transport.emit({
      id: "evt-reconnect-tool-called",
      type: "session.next.tool.called",
      data: {
        timestamp: 120,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: messageID,
        callID,
        tool: "bash",
        input: { command: "echo terminal" },
        provider: { executed: true },
      },
    });
    await waitFor(() =>
      setup.chat.state.messages
        .find((message) => message.id === messageID)
        ?.parts?.some((part) => part.type === "tool") === true,
    );
    const calledPart = setup.chat.state.messages
      .find((message) => message.id === messageID)
      ?.parts?.find((part) => part.type === "tool");
    expect(calledPart?.type === "tool" ? calledPart.status : undefined).toBeUndefined();

    setup.transport.emit({
      id: "evt-reconnect-tool-success",
      type: "session.next.tool.success",
      data: {
        timestamp: 140,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: messageID,
        callID,
        structured: { done: true },
        content: [{ type: "text", text: "provisional" }],
        result: "provisional result",
        provider: { executed: true },
      },
    });
    await waitFor(() => {
      const tools = setup.chat.state.messages
        .find((message) => message.id === messageID)
        ?.parts?.filter((part) => part.type === "tool");
      return tools?.length === 1 && tools[0]?.type === "tool" && tools[0].status === "completed";
    });

    setup.transport.setMessages(FIRST_SESSION_ID, [
      ...messagesBySession.get(FIRST_SESSION_ID)!,
      {
        id: messageID,
        type: "assistant",
        content: [
          {
            id: "part-history-tool-reconnect",
            type: "tool",
            name: "bash",
            state: {
              status: "completed",
              input: { command: "echo terminal" },
              structured: { done: true },
              content: [{ type: "text", text: "terminal" }],
              result: "terminal result",
            },
            time: { created: 90, ran: 100, completed: 200 },
          },
        ],
      },
    ]);
    setup.transport.holdNextHistoryResponse();
    setup.transport.dropEventStream(0);
    await waitFor(() => setup.transport.eventRequests.length === 2, 10_000);
    await waitFor(() => setup.transport.historyRequests.length === 2);

    let stateUpdates = 0;
    const unsubscribe = setup.chat.subscribe(() => {
      stateUpdates += 1;
    });
    resources.push(async () => unsubscribe());
    const beforeCanonical = stateUpdates;
    setup.transport.emit({
      id: "evt-reconnect-stale-canonical",
      type: "message.part.updated",
      data: {
        sessionID: FIRST_SESSION_ID,
        time: 150,
        part: {
          id: "part-history-tool-reconnect",
          sessionID: FIRST_SESSION_ID,
          messageID,
          type: "tool",
          callID,
          tool: "bash",
          state: {
            status: "pending",
            input: { command: "echo terminal" },
            raw: '{"command":"echo terminal"}',
          },
        },
      },
    }, 1);
    await waitFor(() => stateUpdates > beforeCanonical);
    setup.transport.releaseHeldHistory([
      ...messagesBySession.get(FIRST_SESSION_ID)!,
      {
        id: messageID,
        type: "assistant",
        content: [
          {
            id: "part-history-tool-reconnect",
            type: "tool",
            name: "bash",
            state: {
              status: "completed",
              input: { command: "echo terminal" },
              structured: { done: true },
              content: [{ type: "text", text: "terminal" }],
              result: "terminal result",
            },
            time: { created: 90, ran: 100, completed: 200 },
          },
        ],
      },
    ]);

    await waitFor(() => !setup.chat.state.loadingMessages);
    const message = setup.chat.state.messages.find((item) => item.id === messageID);
    const tools = message?.parts?.filter((part) => part.type === "tool") ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      id: "part-history-tool-reconnect",
      callID,
      name: "bash",
      status: "completed",
      result: "terminal result",
      durationMs: 100,
    });
    expect(chatStateSchema.safeParse(setup.chat.state).success).toBe(true);
  });

  it("aborts event listeners when switching sessions, closing the last view, and disconnecting", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    const firstEventRequest = setup.transport.eventRequests[0];
    expect(firstEventRequest?.signal.aborted).toBe(false);

    await setup.chat.selectSession(SECOND_SESSION_ID);
    await waitFor(() => setup.transport.eventRequests.length === 2);
    expect(firstEventRequest?.signal.aborted).toBe(true);
    await waitFor(() => setup.chat.state.streamStatus === "connected");

    setup.transport.emit({
      id: "evt-late-previous-session",
      type: "session.next.text.delta",
      data: {
        timestamp: 30,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: "msg-late",
        textID: "part-late",
        delta: "Must not leak",
      },
    });
    setup.transport.emit({
      id: "evt-selected-session-marker",
      type: "session.next.text.delta",
      data: {
        timestamp: 31,
        sessionID: SECOND_SESSION_ID,
        assistantMessageID: "msg-marker",
        textID: "part-marker",
        delta: "Current session",
      },
    });
    await waitFor(() =>
      setup.chat.state.messages.some((message) => message.id === "msg-marker"),
    );
    expect(setup.chat.state.messages.some((message) => message.id === "msg-late")).toBe(false);

    setup.releaseView();
    expect(setup.transport.eventRequests[1]?.signal.aborted).toBe(true);

    const unsubscribe = setup.chat.subscribe(() => undefined);
    await waitFor(() => setup.transport.eventRequests.length === 3);
    const resumedRequest = setup.transport.eventRequests[2];
    await setup.connection.disconnect();
    expect(resumedRequest?.signal.aborted).toBe(true);
    unsubscribe();
  });

  it("aborts the active event request when the Extension Host disposes the chat service", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    const activeRequest = setup.transport.eventRequests[0];

    await setup.chat.dispose();

    expect(activeRequest?.signal.aborted).toBe(true);
  });

  it("surfaces a stream that ends unexpectedly instead of leaving live status connected", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    setup.transport.endEventStream();

    await waitFor(() => setup.chat.state.streamStatus === "error");
    expect(setup.chat.state.error).toContain("event stream ended");
  });

  it("reconciles a history snapshot after the native event stream reconnects", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    let stateUpdates = 0;
    const unsubscribe = setup.chat.subscribe(() => {
      stateUpdates += 1;
    });
    resources.push(async () => unsubscribe());
    const beforeReconnectDelta = stateUpdates;
    setup.transport.emit({
      id: "evt-before-reconnect",
      type: "session.next.text.delta",
      data: {
        timestamp: 40,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: "msg-reconnect",
        textID: "part-reconnect",
        delta: "Partial",
      },
    });
    await waitFor(() =>
      setup.chat.state.messages.some((message) => message.id === "msg-reconnect"),
    );
    setup.transport.setMessages(FIRST_SESSION_ID, [
      ...messagesBySession.get(FIRST_SESSION_ID)!,
      {
        id: "msg-reconnect",
        type: "assistant",
        content: [
          { id: "part-reconnect", type: "text", text: "Partial recovered" },
        ],
      },
    ]);
    setup.transport.holdNextHistoryResponse();
    setup.transport.dropEventStream(0);
    expect(
      setup.transport.emit(
        {
          id: "evt-missed-during-disconnect",
          type: "session.next.text.delta",
          data: {
            timestamp: 41,
            sessionID: FIRST_SESSION_ID,
            assistantMessageID: "msg-reconnect",
            textID: "part-reconnect",
            delta: " recovered",
          },
        },
        0,
      ),
    ).toBe(false);

    await waitFor(() => setup.transport.eventRequests.length === 2, 10_000);
    await waitFor(() => setup.transport.historyRequests.length === 2, 2_000);
    setup.transport.emit({
      id: "evt-during-reconnect-snapshot",
      type: "session.next.text.delta",
      data: {
        timestamp: 41,
        sessionID: FIRST_SESSION_ID,
        assistantMessageID: "msg-reconnect",
        textID: "part-reconnect",
        delta: " recovered",
      },
    }, 1);
    await waitFor(() => stateUpdates > beforeReconnectDelta);
    setup.transport.releaseHeldHistory([
      ...messagesBySession.get(FIRST_SESSION_ID)!,
      {
        id: "msg-reconnect",
        type: "assistant",
        content: [
          { id: "part-reconnect", type: "text", text: "Partial recovered" },
        ],
      },
    ]);

    await waitFor(() => !setup.chat.state.loadingMessages && setup.chat.state.streamStatus === "connected");
    expect(
      setup.chat.state.messages.find((message) => message.id === "msg-reconnect"),
    ).toEqual({ id: "msg-reconnect", role: "assistant", text: "Partial recovered" });

    setup.transport.emit(
      {
        id: "evt-other-session-after-reconnect",
        type: "session.next.text.delta",
        data: {
          timestamp: 42,
          sessionID: SECOND_SESSION_ID,
          assistantMessageID: "msg-cross-session",
          textID: "part-cross-session",
          delta: "Must stay isolated",
        },
      },
      1,
    );
    setup.transport.emit(
      {
        id: "evt-selected-session-after-reconnect",
        type: "session.next.text.delta",
        data: {
          timestamp: 43,
          sessionID: FIRST_SESSION_ID,
          assistantMessageID: "msg-after-reconnect",
          textID: "part-after-reconnect",
          delta: "Selected session remains live",
        },
      },
      1,
    );
    await waitFor(() =>
      setup.chat.state.messages.some(
        (message) => message.id === "msg-after-reconnect",
      ),
    );
    expect(
      setup.chat.state.messages.filter((message) => message.id === "msg-reconnect"),
    ).toEqual([
      { id: "msg-reconnect", role: "assistant", text: "Partial recovered" },
    ]);
    expect(
      setup.chat.state.messages.some((message) => message.id === "msg-cross-session"),
    ).toBe(false);
  }, 15_000);

  it("does not reappend a late delta already present in completed history", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    const historyText = "A saved fragment remains exactly once.";
    setup.transport.setMessages(FIRST_SESSION_ID, [
      ...messagesBySession.get(FIRST_SESSION_ID)!,
      createAssistantHistoryMessage(
        "msg-late-completed",
        "part-late-completed",
        historyText,
        true,
      ),
    ]);

    await setup.chat.selectSession(FIRST_SESSION_ID);
    const eventStreamIndex = setup.transport.eventRequests.length - 1;
    expect(
      setup.chat.state.messages.find((message) => message.id === "msg-late-completed"),
    ).toEqual({ id: "msg-late-completed", role: "assistant", text: historyText });

    setup.transport.emit(
      {
        id: "evt-late-delta-in-completed-history",
        type: "session.next.text.delta",
        data: {
          timestamp: 20,
          sessionID: FIRST_SESSION_ID,
          assistantMessageID: "msg-late-completed",
          textID: "part-late-completed",
          delta: "saved fragment",
        },
      },
      eventStreamIndex,
    );
    setup.transport.emit(
      {
        id: "evt-flush-after-completed-late-delta",
        type: "session.next.text.delta",
        data: {
          timestamp: 21,
          sessionID: FIRST_SESSION_ID,
          assistantMessageID: "msg-late-flush-completed",
          textID: "part-late-flush-completed",
          delta: "processed",
        },
      },
      eventStreamIndex,
    );
    await waitFor(() =>
      setup.chat.state.messages.some(
        (message) => message.id === "msg-late-flush-completed",
      ),
    );

    expect(
      setup.chat.state.messages.find((message) => message.id === "msg-late-completed"),
    ).toEqual({ id: "msg-late-completed", role: "assistant", text: historyText });
  });

  it("keeps an ambiguous repeated late delta best-effort until text.ended provides the full value", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    setup.transport.setMessages(FIRST_SESSION_ID, [
      ...messagesBySession.get(FIRST_SESSION_ID)!,
      createAssistantHistoryMessage(
        "msg-repeated-late",
        "part-repeated-late",
        "haha",
        true,
      ),
    ]);

    await setup.chat.selectSession(FIRST_SESSION_ID);
    const eventStreamIndex = setup.transport.eventRequests.length - 1;
    // The test knows this is a new "ha", but v1.19 history has no part sequence to prove it.
    // Conservatively keep the visible snapshot rather than risking a duplicate "hahaha".
    setup.transport.emit(
      {
        id: "evt-new-repeated-ha",
        type: "session.next.text.delta",
        data: {
          timestamp: 50,
          sessionID: FIRST_SESSION_ID,
          assistantMessageID: "msg-repeated-late",
          textID: "part-repeated-late",
          delta: "ha",
        },
      },
      eventStreamIndex,
    );
    setup.transport.emit(
      {
        id: "evt-flush-after-ambiguous-repeat",
        type: "session.next.text.delta",
        data: {
          timestamp: 51,
          sessionID: FIRST_SESSION_ID,
          assistantMessageID: "msg-late-flush-repeat",
          textID: "part-late-flush-repeat",
          delta: "processed",
        },
      },
      eventStreamIndex,
    );
    await waitFor(() =>
      setup.chat.state.messages.some(
        (message) => message.id === "msg-late-flush-repeat",
      ),
    );
    expect(
      setup.chat.state.messages.find((message) => message.id === "msg-repeated-late"),
    ).toEqual({ id: "msg-repeated-late", role: "assistant", text: "haha" });

    setup.transport.emit(
      {
        id: "evt-ended-resolves-ambiguous-repeat",
        type: "session.next.text.ended",
        data: {
          timestamp: 52,
          sessionID: FIRST_SESSION_ID,
          assistantMessageID: "msg-repeated-late",
          textID: "part-repeated-late",
          text: "hahaha",
        },
      },
      eventStreamIndex,
    );
    await waitFor(() =>
      setup.chat.state.messages.some(
        (message) =>
          message.id === "msg-repeated-late" && message.text === "hahaha",
      ),
    );
  });

  it("appends a genuinely new late delta after the completed history snapshot", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    setup.transport.setMessages(FIRST_SESSION_ID, [
      ...messagesBySession.get(FIRST_SESSION_ID)!,
      createAssistantHistoryMessage(
        "msg-late-incomplete",
        "part-late-incomplete",
        "Current partial",
      ),
    ]);

    await setup.chat.selectSession(FIRST_SESSION_ID);
    const eventStreamIndex = setup.transport.eventRequests.length - 1;
    setup.transport.emit(
      {
        id: "evt-genuinely-new-late-delta",
        type: "session.next.text.delta",
        data: {
          timestamp: 30,
          sessionID: FIRST_SESSION_ID,
          assistantMessageID: "msg-late-incomplete",
          textID: "part-late-incomplete",
          delta: " suffix",
        },
      },
      eventStreamIndex,
    );
    setup.transport.emit(
      {
        id: "evt-flush-after-new-late-delta",
        type: "session.next.text.delta",
        data: {
          timestamp: 31,
          sessionID: FIRST_SESSION_ID,
          assistantMessageID: "msg-late-flush-new",
          textID: "part-late-flush-new",
          delta: "processed",
        },
      },
      eventStreamIndex,
    );
    await waitFor(() =>
      setup.chat.state.messages.some(
        (message) => message.id === "msg-late-flush-new",
      ),
    );

    expect(
      setup.chat.state.messages.find((message) => message.id === "msg-late-incomplete"),
    ).toEqual({
      id: "msg-late-incomplete",
      role: "assistant",
      text: "Current partial suffix",
    });
  });

  it("lets the replayable ended event replace a partial history value", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    setup.transport.setMessages(FIRST_SESSION_ID, [
      ...messagesBySession.get(FIRST_SESSION_ID)!,
      createAssistantHistoryMessage(
        "msg-ended-history",
        "part-ended-history",
        "Partial text",
      ),
    ]);

    await setup.chat.selectSession(FIRST_SESSION_ID);
    const eventStreamIndex = setup.transport.eventRequests.length - 1;
    setup.transport.emit(
      {
        id: "evt-ended-authoritative-value",
        type: "session.next.text.ended",
        data: {
          timestamp: 40,
          sessionID: FIRST_SESSION_ID,
          assistantMessageID: "msg-ended-history",
          textID: "part-ended-history",
          text: "Final authoritative text",
        },
      },
      eventStreamIndex,
    );

    await waitFor(() =>
      setup.chat.state.messages.some(
        (message) =>
          message.id === "msg-ended-history" &&
          message.text === "Final authoritative text",
      ),
    );
  });

  it("marks typed v1.19 server prompt errors rejected and ambiguous transport failures unknown", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    setup.transport.setPromptMode("rejected");

    await setup.chat.sendPrompt(
      PROMPT_REQUEST_ID,
      PROMPT_ATTEMPT_ID,
      "Keep this draft after rejection.",
      FIRST_SESSION_ID,
    );

    expect(setup.chat.state.promptResult).toEqual({
      requestID: PROMPT_REQUEST_ID,
      attemptID: PROMPT_ATTEMPT_ID,
      sessionID: FIRST_SESSION_ID,
      status: "rejected",
    });
    expect(setup.chat.state.error).toContain("rejected");
    expect(setup.chat.state.messages.some((message) => message.role === "user" && message.text.includes("Keep this draft"))).toBe(false);

    setup.transport.setPromptMode("ambiguous");
    await setup.chat.sendPrompt(
      "550e8400-e29b-41d4-a716-446655440002",
      "550e8400-e29b-41d4-a716-446655440005",
      "The server may have accepted this.",
      FIRST_SESSION_ID,
    );
    expect(setup.chat.state.promptResult).toEqual({
      requestID: "550e8400-e29b-41d4-a716-446655440002",
      attemptID: "550e8400-e29b-41d4-a716-446655440005",
      sessionID: FIRST_SESSION_ID,
      status: "outcome-unknown",
    });
    expect(setup.chat.state.error).toContain("may have accepted it");
    expect(setup.transport.promptRequests).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setup.transport.promptRequests).toHaveLength(2);
  });

  it("shows only a validated HTTP status for an unknown prompt response", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    setup.transport.setPromptMode("ambiguous-server-error");

    await setup.chat.sendPrompt(
      PROMPT_REQUEST_ID,
      PROMPT_ATTEMPT_ID,
      "Do not expose this private prompt.",
      FIRST_SESSION_ID,
    );

    expect(setup.chat.state.promptResult).toEqual({
      requestID: PROMPT_REQUEST_ID,
      attemptID: PROMPT_ATTEMPT_ID,
      sessionID: FIRST_SESSION_ID,
      status: "outcome-unknown",
      httpStatus: 503,
    });
    expect(setup.chat.state.error).toContain("HTTP 503");
    expect(setup.chat.state.error).not.toContain("private prompt");
    expect(setup.chat.state.error).not.toContain("response-body-secret");
    expect(setup.chat.state.error).not.toContain(SERVER_URL);
    expect(chatStateSchema.safeParse(setup.chat.state).success).toBe(true);
  });

  it("records privacy-safe prompt outcomes and history counts, separating empty from failed history", async () => {
    const diagnostics = new DiagnosticsRecorder();
    const setup = await createConnectedChat({ diagnostics });
    resources.push(setup.cleanup);

    const privatePath = String.raw`src\private workspace\budget.ts`;
    const privateSelection = "DIAGNOSTIC_PRIVATE_EDITOR_SELECTION";
    const privateEditorContext = createEditorContextBlock(privatePath, {
      text: privateSelection,
      startLine: 12,
      endLine: 12,
    });
    const privatePrompt = `DIAGNOSTIC_PRIVATE_PROMPT_CONTENT\n\n${privateEditorContext}`;
    await setup.chat.sendPrompt(
      PROMPT_REQUEST_ID,
      PROMPT_ATTEMPT_ID,
      privatePrompt,
      FIRST_SESSION_ID,
    );
    setup.transport.setPromptMode("rejected");
    await setup.chat.sendPrompt(
      "550e8400-e29b-41d4-a716-446655440003",
      "550e8400-e29b-41d4-a716-446655440004",
      "DIAGNOSTIC_REJECTED_PROMPT_CONTENT",
      FIRST_SESSION_ID,
    );
    setup.transport.setPromptMode("ambiguous-server-error");
    await setup.chat.sendPrompt(
      "550e8400-e29b-41d4-a716-446655440005",
      "550e8400-e29b-41d4-a716-446655440006",
      "DIAGNOSTIC_UNKNOWN_PROMPT_CONTENT",
      FIRST_SESSION_ID,
    );

    setup.transport.setMessages(FIRST_SESSION_ID, [
      { id: "history-user", type: "user", text: "DIAGNOSTIC_HISTORY_PRIVATE_TEXT" },
      { id: "", type: "user", text: "DIAGNOSTIC_INVALID_ID_TEXT" },
      {
        id: "history-tool",
        type: "tool",
        payload: { text: "DIAGNOSTIC_TOOL_PRIVATE_PAYLOAD" },
      },
      {
        id: "history-reasoning",
        type: "assistant",
        content: [
          {
            id: "history-reasoning-part",
            type: "reasoning",
            text: "DIAGNOSTIC_ASSISTANT_PRIVATE_TEXT",
          },
        ],
      },
    ]);
    await setup.chat.reviewSelectedSessionHistory();
    const mappedHistory = setup.chat.state.messages;

    await setup.chat.createSession();
    expect(setup.chat.state.messages).toEqual([]);
    expect(setup.chat.state.historyError).toBeNull();
    setup.transport.failNextHistoryRequest();
    await setup.chat.reviewSelectedSessionHistory();
    expect(setup.chat.state.historyError).not.toBeNull();

    const records = diagnostics
      .getTranscript()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const promptResults = records.filter(
      (record) => record.event === "prompt.submission.finished",
    );
    expect(promptResults.map((record) => record.outcome)).toEqual([
      "accepted",
      "rejected",
      "unknown",
    ]);
    expect(promptResults.at(-1)).toMatchObject({ httpStatus: 503 });
    expect(
      records.filter((record) => record.event === "prompt.submission.started"),
    ).toContainEqual(
      expect.objectContaining({
        characterCount: privatePrompt.length,
        delivery: "steer",
      }),
    );

    const historyResults = records.filter(
      (record) => record.event === "history.reload.finished",
    );
    expect(historyResults).toContainEqual(
      expect.objectContaining({
        outcome: "success",
        rawCount: 4,
        mappedCount: 1,
        droppedCount: 3,
        droppedReasons: {
          "invalid-id": 1,
          "unsupported-shape": 1,
          "no-renderable-text": 1,
        },
      }),
    );
    expect(historyResults).toContainEqual(
      expect.objectContaining({ outcome: "empty", rawCount: 0, mappedCount: 0 }),
    );
    expect(historyResults.at(-1)).toMatchObject({
      outcome: "failure",
      failureReason: "request",
    });
    expect(mappedHistory).toContainEqual({
      id: "history-user",
      role: "user",
      text: "DIAGNOSTIC_HISTORY_PRIVATE_TEXT",
    });

    const transcript = diagnostics.getTranscript();
    for (const privateValue of [
      privatePrompt,
      privatePath,
      privateSelection,
      "DIAGNOSTIC_REJECTED_PROMPT_CONTENT",
      "DIAGNOSTIC_UNKNOWN_PROMPT_CONTENT",
      "DIAGNOSTIC_HISTORY_PRIVATE_TEXT",
      "DIAGNOSTIC_INVALID_ID_TEXT",
      "DIAGNOSTIC_TOOL_PRIVATE_PAYLOAD",
      "DIAGNOSTIC_ASSISTANT_PRIVATE_TEXT",
      "response-body-secret",
      FIRST_SESSION_ID,
      PROMPT_REQUEST_ID,
      PROMPT_ATTEMPT_ID,
      "msg-user",
      "history-tool",
    ]) {
      expect(transcript).not.toContain(privateValue);
    }
    expect(transcript.length).toBeLessThanOrEqual(32_768);
  });

  it("keeps editor context bound to the workspace captured by the connected chat", async () => {
    const setup = await createConnectedChat();
    resources.push(setup.cleanup);
    const connectedDirectory = setup.chat.connectedWorkspaceDirectory;
    expect(connectedDirectory).toBe(WORKSPACE);

    const otherWorkspace = String.raw`C:\different workspace\private project`;
    const otherPath = `${otherWorkspace}\\secret.ts`;
    const selectedText = "M7_OTHER_WORKSPACE_PRIVATE_TEXT";
    const selection = {
      isEmpty: false,
      start: { line: 0, character: 0 },
      end: { line: 0, character: selectedText.length },
    };
    const getText = vi.fn(() => selectedText);
    const editor = {
      document: {
        version: 1,
        uri: { scheme: "file", fsPath: otherPath },
        getText,
      },
      selection,
    } as unknown as TextEditor;
    const currentWorkspaceFolders = [
      { uri: { scheme: "file", fsPath: otherWorkspace } } as unknown as WorkspaceFolder,
    ];

    const contextResult = await captureActiveEditorContext(
      editor,
      setup.chat.connectedWorkspaceDirectory,
      currentWorkspaceFolders,
      () => true,
      {
        canonicalizePath: async (path) => path,
        pathFlavor: "win32",
        getConnectedWorkspaceDirectory: () => setup.chat.connectedWorkspaceDirectory,
        getWorkspaceFolders: () => currentWorkspaceFolders,
        getActiveTextEditor: () => editor,
      },
    );
    expect(contextResult).toMatchObject({
      kind: "error",
      message: expect.stringContaining("no longer the active first folder"),
    });
    expect(getText).not.toHaveBeenCalled();

    const initialDraft = "Explain the connected session.";
    const draftAfterContext = contextResult.kind === "ready"
      ? appendEditorContextToPromptDraft(initialDraft, contextResult.context)
      : { kind: "inserted" as const, draft: initialDraft };
    expect(draftAfterContext).toEqual({ kind: "inserted", draft: initialDraft });
    if (draftAfterContext.kind !== "inserted") return;

    await setup.chat.sendPrompt(
      PROMPT_REQUEST_ID,
      PROMPT_ATTEMPT_ID,
      draftAfterContext.draft,
      FIRST_SESSION_ID,
    );

    const promptRequest = setup.transport.promptRequests[0];
    const promptBody = setup.transport.requestBodies.get(promptRequest!);
    expect(promptBody).toEqual({
      id: `msg_${PROMPT_REQUEST_ID}`,
      prompt: { text: initialDraft },
      delivery: "steer",
    });
    expect(JSON.stringify(promptBody)).not.toContain(otherWorkspace);
    expect(JSON.stringify(promptBody)).not.toContain(selectedText);
    expect(setup.chat.connectedWorkspaceDirectory).toBe(WORKSPACE);
    expect(
      setup.transport.providerRequests.every(
        (request) => new URL(request.url).searchParams.get("directory") === WORKSPACE,
      ),
    ).toBe(true);
  });

  it("keeps the connection-attempt root when workspace folders change before health completes", async () => {
    let resolveHealth: ((result: HealthProbeResult) => void) | undefined;
    const connection = new OpenCodeConnection(
      () => new Promise<HealthProbeResult>((resolve) => {
        resolveHealth = resolve;
      }),
    );
    const transport = createTransport();
    const clientDirectories: Array<string | undefined> = [];
    const chat = new OpenCodeChat(
      connection,
      () => connection.connectedWorkspaceDirectory,
      (_serverUrl, directory) => {
        clientDirectories.push(directory);
        return createOpencodeClient({
          baseUrl: SERVER_URL,
          directory,
          redirect: "error",
          fetch: transport.fetch,
        });
      },
      () => true,
    );
    const unsubscribe = chat.subscribe(() => undefined);
    resources.push(async () => {
      unsubscribe();
      await chat.dispose();
      await connection.dispose();
    });

    let currentWorkspaceFolders: readonly WorkspaceFolder[] = [
      { uri: { scheme: "file", fsPath: WORKSPACE } } as unknown as WorkspaceFolder,
    ];
    const connectedRoot = currentWorkspaceFolders[0]!.uri.fsPath;
    const connectionAttempt = connection.connect(SERVER_URL, {
      directory: currentWorkspaceFolders[0]!.uri.fsPath,
      trusted: true,
    });
    await waitFor(() => resolveHealth !== undefined);

    const otherWorkspace = String.raw`C:\different workspace\private project`;
    currentWorkspaceFolders = [
      { uri: { scheme: "file", fsPath: otherWorkspace } } as unknown as WorkspaceFolder,
    ];
    resolveHealth?.({ kind: "healthy", version: SUPPORTED_OPENCODE_VERSION });
    await connectionAttempt;
    await waitFor(() =>
      chat.state.selectedSessionID === FIRST_SESSION_ID &&
      chat.state.streamStatus === "connected" &&
      !chat.state.loadingMessages,
    );

    expect(connection.connectedWorkspaceDirectory).toBe(connectedRoot);
    expect(chat.connectedWorkspaceDirectory).toBe(connectedRoot);
    expect(clientDirectories).toEqual([connectedRoot]);

    const selectedText = "M7_PENDING_CONNECT_OTHER_ROOT_TEXT";
    const selection = {
      isEmpty: false,
      start: { line: 0, character: 0 },
      end: { line: 0, character: selectedText.length },
    };
    const getText = vi.fn(() => selectedText);
    const editor = {
      document: {
        version: 1,
        uri: { scheme: "file", fsPath: `${otherWorkspace}\\secret.ts` },
        getText,
      },
      selection,
    } as unknown as TextEditor;
    const result = await captureActiveEditorContext(
      editor,
      chat.connectedWorkspaceDirectory,
      currentWorkspaceFolders,
      () => true,
      {
        canonicalizePath: async (path) => path,
        pathFlavor: "win32",
        getConnectedWorkspaceDirectory: () => chat.connectedWorkspaceDirectory,
        getWorkspaceFolders: () => currentWorkspaceFolders,
        getActiveTextEditor: () => editor,
      },
    );
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("no longer the active first folder"),
    });
    expect(getText).not.toHaveBeenCalled();

    const initialDraft = "Explain the connected session.";
    const draftAfterContext = result.kind === "ready"
      ? appendEditorContextToPromptDraft(initialDraft, result.context)
      : { kind: "inserted" as const, draft: initialDraft };
    if (draftAfterContext.kind !== "inserted") throw new Error("Unexpected prompt overflow.");
    await chat.sendPrompt(
      PROMPT_REQUEST_ID,
      PROMPT_ATTEMPT_ID,
      draftAfterContext.draft,
      FIRST_SESSION_ID,
    );

    const promptRequest = transport.promptRequests[0];
    const promptBody = transport.requestBodies.get(promptRequest!);
    expect(promptBody).toEqual({
      id: `msg_${PROMPT_REQUEST_ID}`,
      prompt: { text: initialDraft },
      delivery: "steer",
    });
    expect(JSON.stringify(promptBody)).not.toContain(otherWorkspace);
    expect(JSON.stringify(promptBody)).not.toContain(selectedText);
    expect(connection.connectedWorkspaceDirectory).toBe(connectedRoot);
    expect(clientDirectories).toEqual([connectedRoot]);
  });

  it("does not create a session client for an untrusted workspace", async () => {
    const connection = new OpenCodeConnection(async () => ({
      kind: "healthy",
      version: SUPPORTED_OPENCODE_VERSION,
    }));
    const clientFactory = vi.fn(() =>
      createOpencodeClient({ baseUrl: SERVER_URL, directory: WORKSPACE }),
    );
    const chat = new OpenCodeChat(
      connection,
      () => WORKSPACE,
      clientFactory,
      () => false,
    );
    const unsubscribe = chat.subscribe(() => undefined);

    await connection.connect(SERVER_URL);
    await waitFor(() => chat.state.error !== null);

    expect(chat.state.error).toContain("Trust this workspace");
    expect(clientFactory).not.toHaveBeenCalled();
    unsubscribe();
    await chat.dispose();
    await connection.dispose();
  });
});

async function createConnectedChat(options: {
  holdInitialHistory?: boolean;
  holdInitialActivity?: boolean;
  waitForHistory?: boolean;
  diagnostics?: DiagnosticsSink;
  omitActiveMethod?: boolean;
} = {}) {
  const transport = createTransport();
  if (options.holdInitialHistory) transport.holdNextHistoryResponse();
  if (options.holdInitialActivity) transport.holdNextActiveResponse();
  const connection = new OpenCodeConnection(async () => ({
    kind: "healthy",
    version: SUPPORTED_OPENCODE_VERSION,
  }), undefined, options.diagnostics);
  const chat = new OpenCodeChat(
    connection,
    () => WORKSPACE,
    (_serverUrl, directory) => {
      const client = createOpencodeClient({
        baseUrl: SERVER_URL,
        directory,
        redirect: "error",
        fetch: transport.fetch,
      });
      if (options.omitActiveMethod) {
        Object.defineProperty(client.v2.session, "active", { value: undefined });
      }
      return client;
    },
    undefined,
    options.diagnostics,
  );
  const unsubscribe = chat.subscribe(() => undefined);
  await connection.connect(SERVER_URL);
  await waitFor(() =>
    chat.state.selectedSessionID === FIRST_SESSION_ID &&
    chat.state.streamStatus === "connected" &&
    chat.state.providerChoicesStatus !== "loading" &&
    chat.state.modelChoicesStatus !== "loading" &&
    chat.state.agentChoicesStatus !== "loading" &&
    !chat.state.loadingRequests &&
    (options.waitForHistory === false || !chat.state.loadingMessages),
  );

  let isReleased = false;
  const cleanup = async (): Promise<void> => {
    if (!isReleased) unsubscribe();
    await chat.dispose();
    await connection.dispose();
  };

  return {
    chat,
    connection,
    transport,
    unsubscribe,
    cleanup,
    releaseView: () => {
      if (isReleased) return;
      isReleased = true;
      unsubscribe();
    },
  };
}

function createTransport() {
  const requests: Request[] = [];
  const eventRequests: Request[] = [];
  const historyRequests: Request[] = [];
  const promptRequests: Request[] = [];
  const permissionListRequests: Request[] = [];
  const questionListRequests: Request[] = [];
  const permissionReplyRequests: Request[] = [];
  const questionReplyRequests: Request[] = [];
  const questionRejectRequests: Request[] = [];
  const deleteRequests: Request[] = [];
  const activeRequests: Request[] = [];
  const interruptRequests: Request[] = [];
  const providerRequests: Request[] = [];
  const modelRequests: Request[] = [];
  const agentRequests: Request[] = [];
  const requestBodies = new Map<Request, unknown>();
  const streamControllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const encoder = new TextEncoder();
  let createdSession: Record<string, unknown> | undefined;
  let activeSessionIDs = new Set<string>();
  let holdNextActive = false;
  let nextActiveFailure: { status: number; body: string } | undefined;
  let nextActiveTransportError: string | undefined;
  let nextActiveMalformed = false;
  let resolveHeldActive: ((response: Response) => void) | undefined;
  let nextInterruptStatus = 204;
  let listedSessions = [...sessions];
  let providers: unknown[] = [
    { id: "provider-test", name: "Test Provider", api: { type: "native", settings: {} }, request: {} },
  ];
  let models: unknown[] = [
    {
      id: "model-test",
      providerID: "provider-test",
      name: "Test Model",
      enabled: true,
      variants: [],
    },
  ];
  let agents: unknown[] = [
    { id: "build", description: "Build changes.", mode: "primary", hidden: false },
  ];
  const choiceFailureStatuses = new Map<string, number[]>();
  const sessionCursorTargets = new Map<
    string,
    { sessions: Record<string, unknown>[]; offset: number }
  >();
  const historyCursorTargets = new Map<
    string,
    { sessionID: string; messages: unknown[]; offset: number }
  >();
  let nextSessionCursor = 0;
  let nextHistoryCursor = 0;
  let histories = new Map(
    Array.from(messagesBySession, ([sessionID, messages]) => [sessionID, [...messages]]),
  );
  let holdNextHistory = false;
  let failNextHistory = false;
  let resolveHeldHistory: ((response: Response) => void) | undefined;
  let heldHistorySessionID: string | undefined;
  let holdNextPermissionList = false;
  let resolveHeldPermissionList: ((response: Response) => void) | undefined;
  let holdNextQuestionList = false;
  let resolveHeldQuestionList: ((response: Response) => void) | undefined;
  let pendingPermissions = new Map<string, unknown[]>();
  let pendingQuestions = new Map<string, unknown[]>();
  let promptMode:
    | "accepted"
    | "rejected"
    | "ambiguous"
    | "ambiguous-server-error"
    | "ambiguous-after-admission" = "accepted";
  const admittedPrompts = new Map<
    string,
    {
      sessionID: string;
      text: string;
      delivery: "steer" | "queue";
      response: Record<string, unknown>;
    }
  >();

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);

    if (url.pathname === "/api/event") {
      eventRequests.push(request);
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          controller = streamController;
          streamControllers.push(streamController);
          streamController.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: `evt-connected-${eventRequests.length}`,
                type: "server.connected",
                data: {},
              })}\n\n`,
            ),
          );
        },
      });
      request.signal.addEventListener(
        "abort",
        () => {
          try {
            controller?.close();
          } catch {
            // The SDK reader may have cancelled the stream already.
          }
        },
        { once: true },
      );
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }

    if (url.pathname === "/api/session/active" && request.method === "GET") {
      activeRequests.push(request);
      if (nextActiveTransportError !== undefined) {
        const message = nextActiveTransportError;
        nextActiveTransportError = undefined;
        throw new TypeError(message);
      }
      if (nextActiveFailure !== undefined) {
        const failure = nextActiveFailure;
        nextActiveFailure = undefined;
        return new Response(failure.body, { status: failure.status });
      }
      if (nextActiveMalformed) {
        nextActiveMalformed = false;
        return jsonResponse({ unexpected: true });
      }
      const response = jsonResponse({
        data: Object.fromEntries(
          Array.from(activeSessionIDs, (sessionID) => [
            sessionID,
            { type: "running" },
          ]),
        ),
      });
      if (holdNextActive) {
        holdNextActive = false;
        return new Promise<Response>((resolve) => {
          resolveHeldActive = resolve;
        });
      }
      return response;
    }

    const interruptPath = url.pathname.match(
      /^\/api\/session\/([^/]+)\/interrupt$/,
    );
    if (interruptPath && request.method === "POST") {
      interruptRequests.push(request);
      const status = nextInterruptStatus;
      nextInterruptStatus = 204;
      return new Response(status === 204 ? null : "interrupt failed", { status });
    }

    if (url.pathname === "/api/session" && request.method === "GET") {
      const cursor = url.searchParams.get("cursor");
      const cursorTarget = cursor ? sessionCursorTargets.get(cursor) : undefined;
      const search = url.searchParams.get("search")?.toLocaleLowerCase() ?? "";
      const sourceSessions = cursorTarget?.sessions ??
        (createdSession ? [createdSession, ...listedSessions] : listedSessions)
          .filter((session) =>
            typeof session.title === "string" &&
            session.title.toLocaleLowerCase().includes(search),
          );
      const offset = cursorTarget?.offset ?? 0;
      const requestedLimit = Number(url.searchParams.get("limit")) || 50;
      const data = sourceSessions.slice(offset, offset + requestedLimit);
      const nextOffset = offset + requestedLimit;
      const next = data.length > 0
        ? `sessions-cursor-${++nextSessionCursor}`
        : undefined;
      if (next) {
        sessionCursorTargets.set(next, {
          sessions: sourceSessions,
          offset: nextOffset,
        });
      }
      return jsonResponse({
        data,
        cursor: next ? { next } : {},
      });
    }

    if (url.pathname === "/api/session" && request.method === "POST") {
      const body = (await request.json()) as {
        location?: { directory?: string };
        model?: { id: string; providerID: string; variant?: string };
        agent?: string;
      };
      requestBodies.set(request, body);
      const directory = body.location?.directory ?? WORKSPACE;
      createdSession = createServerSession("ses_created123", "Created session", directory);
      if (body.model !== undefined) createdSession.model = body.model;
      if (body.agent !== undefined) createdSession.agent = body.agent;
      listedSessions = [createdSession, ...listedSessions];
      return jsonResponse({ data: createdSession });
    }

    const modelSwitchPath = url.pathname.match(/^\/api\/session\/([^/]+)\/model$/);
    if (modelSwitchPath && request.method === "POST") {
      requestBodies.set(request, await request.json());
      return new Response(null, { status: 204 });
    }

    const agentSwitchPath = url.pathname.match(/^\/api\/session\/([^/]+)\/agent$/);
    if (agentSwitchPath && request.method === "POST") {
      requestBodies.set(request, await request.json());
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/api/provider" && request.method === "GET") {
      providerRequests.push(request);
      const statuses = choiceFailureStatuses.get(url.pathname);
      const status = statuses?.shift();
      if (status !== undefined) {
        return new Response("provider endpoint unavailable", { status });
      }
      return jsonResponse({ location: { directory: WORKSPACE }, data: providers });
    }

    if (url.pathname === "/api/model" && request.method === "GET") {
      modelRequests.push(request);
      const statuses = choiceFailureStatuses.get(url.pathname);
      const status = statuses?.shift();
      if (status !== undefined) {
        return new Response("model endpoint unavailable", { status });
      }
      return jsonResponse({ location: { directory: WORKSPACE }, data: models });
    }

    if (url.pathname === "/api/agent" && request.method === "GET") {
      agentRequests.push(request);
      const statuses = choiceFailureStatuses.get(url.pathname);
      const status = statuses?.shift();
      if (status !== undefined) {
        return new Response("agent endpoint unavailable", { status });
      }
      return jsonResponse({ location: { directory: WORKSPACE }, data: agents });
    }

    const deletePath = url.pathname.match(/^\/session\/([^/]+)$/);
    if (deletePath && request.method === "DELETE") {
      deleteRequests.push(request);
      const sessionID = decodeURIComponent(deletePath[1] ?? "");
      listedSessions = listedSessions.filter((session) => session.id !== sessionID);
      if (createdSession?.id === sessionID) createdSession = undefined;
      histories.delete(sessionID);
      return jsonResponse(true);
    }

    const permissionListPath = url.pathname.match(
      /^\/api\/session\/([^/]+)\/permission$/,
    );
    if (permissionListPath && request.method === "GET") {
      permissionListRequests.push(request);
      const sessionID = decodeURIComponent(permissionListPath[1] ?? "");
      const response = jsonResponse({ data: pendingPermissions.get(sessionID) ?? [] });
      if (holdNextPermissionList) {
        holdNextPermissionList = false;
        return new Promise<Response>((resolve) => {
          resolveHeldPermissionList = resolve;
        });
      }
      return response;
    }

    const permissionReplyPath = url.pathname.match(
      /^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/,
    );
    if (permissionReplyPath && request.method === "POST") {
      permissionReplyRequests.push(request);
      const sessionID = decodeURIComponent(permissionReplyPath[1] ?? "");
      const requestID = decodeURIComponent(permissionReplyPath[2] ?? "");
      requestBodies.set(request, await request.json());
      pendingPermissions.set(
        sessionID,
        (pendingPermissions.get(sessionID) ?? []).filter(
          (item) =>
            typeof item !== "object" ||
            item === null ||
            Reflect.get(item, "id") !== requestID,
        ),
      );
      return new Response(null, { status: 204 });
    }

    const questionListPath = url.pathname.match(
      /^\/api\/session\/([^/]+)\/question$/,
    );
    if (questionListPath && request.method === "GET") {
      questionListRequests.push(request);
      const sessionID = decodeURIComponent(questionListPath[1] ?? "");
      const response = jsonResponse({ data: pendingQuestions.get(sessionID) ?? [] });
      if (holdNextQuestionList) {
        holdNextQuestionList = false;
        return new Promise<Response>((resolve) => {
          resolveHeldQuestionList = resolve;
        });
      }
      return response;
    }

    const questionReplyPath = url.pathname.match(
      /^\/api\/session\/([^/]+)\/question\/([^/]+)\/reply$/,
    );
    if (questionReplyPath && request.method === "POST") {
      questionReplyRequests.push(request);
      const sessionID = decodeURIComponent(questionReplyPath[1] ?? "");
      const requestID = decodeURIComponent(questionReplyPath[2] ?? "");
      requestBodies.set(request, await request.json());
      pendingQuestions.set(
        sessionID,
        (pendingQuestions.get(sessionID) ?? []).filter(
          (item) =>
            typeof item !== "object" ||
            item === null ||
            Reflect.get(item, "id") !== requestID,
        ),
      );
      return new Response(null, { status: 204 });
    }

    const questionRejectPath = url.pathname.match(
      /^\/api\/session\/([^/]+)\/question\/([^/]+)\/reject$/,
    );
    if (questionRejectPath && request.method === "POST") {
      questionRejectRequests.push(request);
      const sessionID = decodeURIComponent(questionRejectPath[1] ?? "");
      const requestID = decodeURIComponent(questionRejectPath[2] ?? "");
      pendingQuestions.set(
        sessionID,
        (pendingQuestions.get(sessionID) ?? []).filter(
          (item) =>
            typeof item !== "object" ||
            item === null ||
            Reflect.get(item, "id") !== requestID,
        ),
      );
      return new Response(null, { status: 204 });
    }

    const messagePath = url.pathname.match(/^\/api\/session\/([^/]+)\/message$/);
    if (messagePath && request.method === "GET") {
      historyRequests.push(request);
      const sessionID = decodeURIComponent(messagePath[1] ?? "");
      const cursor = url.searchParams.get("cursor");
      const cursorTarget = cursor ? historyCursorTargets.get(cursor) : undefined;
      const orderedMessages = cursorTarget?.messages ??
        [...(histories.get(sessionID) ?? [])].reverse();
      const offset = cursorTarget?.offset ?? 0;
      const requestedLimit = Number(url.searchParams.get("limit")) || 50;
      const data = orderedMessages.slice(offset, offset + requestedLimit);
      const nextOffset = offset + requestedLimit;
      const next = data.length > 0
        ? `history-cursor-${++nextHistoryCursor}`
        : undefined;
      if (next) {
        historyCursorTargets.set(next, {
          sessionID,
          messages: orderedMessages,
          offset: nextOffset,
        });
      }
      if (failNextHistory) {
        failNextHistory = false;
        return new Response("response-body-secret", {
          status: 503,
          headers: { "content-type": "text/plain" },
        });
      }
      if (holdNextHistory) {
        holdNextHistory = false;
        heldHistorySessionID = sessionID;
        return new Promise<Response>((resolve) => {
          resolveHeldHistory = resolve;
        });
      }
      return jsonResponse({ data, cursor: next ? { next } : {} });
    }

    const promptPath = url.pathname.match(/^\/api\/session\/([^/]+)\/prompt$/);
    if (promptPath && request.method === "POST") {
      promptRequests.push(request);
      const sessionID = decodeURIComponent(promptPath[1] ?? "");
      const body = (await request.json()) as {
        id?: string;
        prompt?: { text?: string };
        delivery?: "steer" | "queue";
      };
      requestBodies.set(request, body);
      if (promptMode === "rejected") {
        return new Response(
          JSON.stringify({ _tag: "ConflictError", message: "Prompt was rejected." }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }
      if (promptMode === "ambiguous") {
        throw new TypeError("Connection was lost after dispatch.");
      }
      if (promptMode === "ambiguous-server-error") {
        return new Response("response-body-secret", {
          status: 503,
          headers: { "content-type": "text/plain" },
        });
      }

      const id = body.id ?? "missing_prompt_id";
      const text = body.prompt?.text ?? "";
      const delivery = body.delivery ?? "steer";
      const existing = admittedPrompts.get(id);
      if (
        existing &&
        (existing.sessionID !== sessionID ||
          existing.text !== text ||
          existing.delivery !== delivery)
      ) {
        return new Response(
          JSON.stringify({ _tag: "ConflictError", message: "Prompt ID conflict." }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }
      const admission = existing?.response ?? {
        id,
        sessionID,
        prompt: { text },
        delivery,
        admittedSeq: 1,
        timeCreated: 1_760_000_000_000,
      };
      if (!existing) {
        admittedPrompts.set(id, { sessionID, text, delivery, response: admission });
      }
      if (promptMode === "ambiguous-after-admission") {
        promptMode = "accepted";
        throw new TypeError("Connection was lost after durable admission.");
      }
      return jsonResponse({ data: admission });
    }

    return new Response("Not found", { status: 404 });
  };

  return {
    fetch,
    requests,
    eventRequests,
    historyRequests,
    promptRequests,
    permissionListRequests,
    questionListRequests,
    permissionReplyRequests,
    questionReplyRequests,
    questionRejectRequests,
    deleteRequests,
    activeRequests,
    interruptRequests,
    providerRequests,
    modelRequests,
    agentRequests,
    requestBodies,
    admittedPromptCount: () => admittedPrompts.size,
    emit(event: unknown, streamIndex = streamControllers.length - 1): boolean {
      try {
        streamControllers[streamIndex]?.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
        return true;
      } catch {
        // The selected stream may already have closed or been aborted.
        return false;
      }
    },
    endEventStream(): void {
      streamControllers.at(-1)?.close();
    },
    dropEventStream(streamIndex = streamControllers.length - 1): void {
      streamControllers[streamIndex]?.error(new Error("Simulated SSE connection loss."));
    },
    holdNextHistoryResponse(): void {
      holdNextHistory = true;
    },
    failNextHistoryRequest(): void {
      failNextHistory = true;
    },
    setPermissionRequests(sessionID: string, requests: unknown[]): void {
      pendingPermissions.set(sessionID, [...requests]);
    },
    setQuestionRequests(sessionID: string, requests: unknown[]): void {
      pendingQuestions.set(sessionID, [...requests]);
    },
    holdNextPermissionListResponse(): void {
      holdNextPermissionList = true;
    },
    hasHeldPermissionListResponse(): boolean {
      return resolveHeldPermissionList !== undefined;
    },
    releaseHeldPermissionListResponse(requests: unknown[]): void {
      if (!resolveHeldPermissionList) {
        throw new Error("No permission list response is being held.");
      }
      const resolve = resolveHeldPermissionList;
      resolveHeldPermissionList = undefined;
      resolve(jsonResponse({ data: [...requests] }));
    },
    holdNextQuestionListResponse(): void {
      holdNextQuestionList = true;
    },
    hasHeldQuestionListResponse(): boolean {
      return resolveHeldQuestionList !== undefined;
    },
    releaseHeldQuestionListResponse(requests: unknown[]): void {
      if (!resolveHeldQuestionList) {
        throw new Error("No question list response is being held.");
      }
      const resolve = resolveHeldQuestionList;
      resolveHeldQuestionList = undefined;
      resolve(jsonResponse({ data: [...requests] }));
    },
    releaseHeldHistory(messages: unknown[]): void {
      if (!resolveHeldHistory) throw new Error("No history response is being held.");
      const resolve = resolveHeldHistory;
      resolveHeldHistory = undefined;
      const data = [...messages].reverse();
      const next = data.length ? `history-cursor-${++nextHistoryCursor}` : undefined;
      if (next) {
        historyCursorTargets.set(next, {
          sessionID: heldHistorySessionID ?? "",
          messages: data,
          offset: data.length,
        });
      }
      heldHistorySessionID = undefined;
      resolve(jsonResponse({ data, cursor: next ? { next } : {} }));
    },
    setMessages(sessionID: string, messages: unknown[]): void {
      histories.set(sessionID, [...messages]);
    },
    setSessions(value: Record<string, unknown>[]): void {
      listedSessions = [...value];
    },
    setProviders(value: unknown[]): void {
      providers = [...value];
    },
    setModels(value: unknown[]): void {
      models = [...value];
    },
    setAgents(value: unknown[]): void {
      agents = [...value];
    },
    failNextChoiceRequest(path: string, status = 404): void {
      const statuses = choiceFailureStatuses.get(path) ?? [];
      statuses.push(status);
      choiceFailureStatuses.set(path, statuses);
    },
    setPromptMode(
      mode:
        | "accepted"
        | "rejected"
        | "ambiguous"
        | "ambiguous-server-error"
        | "ambiguous-after-admission",
    ): void {
      promptMode = mode;
    },
    setActiveSessionIDs(sessionIDs: string[]): void {
      activeSessionIDs = new Set(sessionIDs);
    },
    failNextActiveRequest(status: number, body: string): void {
      nextActiveFailure = { status, body };
    },
    throwNextActiveRequest(message: string): void {
      nextActiveTransportError = message;
    },
    returnMalformedNextActiveResponse(): void {
      nextActiveMalformed = true;
    },
    holdNextActiveResponse(): void {
      holdNextActive = true;
    },
    releaseHeldActiveResponse(
      activeSessions: Record<string, { type: "running" }>,
    ): void {
      if (!resolveHeldActive) throw new Error("No active-session response is being held.");
      const resolve = resolveHeldActive;
      resolveHeldActive = undefined;
      resolve(jsonResponse({ data: activeSessions }));
    },
    setNextInterruptStatus(status: number): void {
      nextInterruptStatus = status;
    },
    setCreatedSession(session: Record<string, unknown>): void {
      createdSession = session;
    },
  };
}

function createServerSession(
  id: string,
  title: string,
  directory = WORKSPACE,
): Record<string, unknown> {
  return {
    id,
    title,
    projectID: "project-test",
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: { created: 1_760_000_000_000, updated: 1_760_000_000_000 },
    location: { directory },
  };
}

function createAssistantHistoryMessage(
  id: string,
  partID: string,
  text: string,
  completed = false,
): Record<string, unknown> {
  return {
    id,
    type: "assistant",
    time: { created: 10, ...(completed ? { completed: 20 } : {}) },
    content: [{ id: partID, type: "text", text }],
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const timeoutAt = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= timeoutAt) throw new Error("Timed out waiting for test state.");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
