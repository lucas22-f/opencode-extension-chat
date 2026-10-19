import { describe, expect, it, vi } from "vitest";
import {
  dispatchExtensionMessage,
  dispatchWebviewMessage,
} from "../src/shared/webview-message";
import { initialChatState } from "../src/shared/chat-state";
import { initialCapabilityState } from "../src/shared/capability-state";

describe("webview action protocol", () => {
  it.each([
    ["open-expanded", "openExpanded"],
    ["webview-ready", "webviewReady"],
      ["connect", "connect"],
      ["disconnect", "disconnect"],
      ["load-sessions", "loadSessions"],
      ["load-more-sessions", "loadMoreSessions"],
      ["search-sessions", "searchSessions"],
      ["load-older-history", "loadOlderHistory"],
    ["refresh-choices", "refreshChoices"],
    ["load-mcp-status", "loadMcpStatus"],
    ["set-mcp-server-connection", "setMcpServerConnection"],
    ["load-tool-metadata", "loadToolMetadata"],
    ["load-skills", "loadSkills"],
    ["load-commands", "loadCommands"],
    ["run-command", "runCommand"],
    ["load-child-sessions", "loadChildSessions"],
      ["review-session-history", "reviewSessionHistory"],
      ["refresh-requests", "refreshRequests"],
      ["refresh-session-activity", "refreshSessionActivity"],
      ["create-session", "createSession"],
      ["add-editor-context", "addEditorContext"],
      ["copy-text", "copyText"],
      ["select-session", "selectSession"],
      ["interrupt-session", "interruptSession"],
      ["select-model", "selectModel"],
      ["select-agent", "selectAgent"],
      ["delete-session", "deleteSession"],
      ["reply-permission", "replyToPermission"],
      ["reply-question", "replyToQuestion"],
      ["reject-question", "rejectQuestion"],
      ["send-prompt", "sendPrompt"],
    ] as const)("dispatches the supported %s action", (type, actionName) => {
    const message =
      type === "select-session" ||
      type === "interrupt-session" ||
      type === "refresh-session-activity"
        ? { type, sessionID: "ses_123abc" }
        : type === "run-command"
          ? { type, name: "review", arguments: "fix typo" }
          : type === "set-mcp-server-connection"
            ? { type, name: "server name/ñ", connect: true, generation: 7 }
        : type === "send-prompt"
          ? {
              type,
              requestID: "550e8400-e29b-41d4-a716-446655440000",
              attemptID: "550e8400-e29b-41d4-a716-446655440001",
              text: "Hello",
              sessionID: "ses_123abc",
            }
        : type === "search-sessions"
          ? { type, query: "stream" }
        : type === "reply-permission"
            ? {
                type,
                sessionID: "ses_123abc",
                requestID: "permission-123",
                reply: "once",
              }
            : type === "reply-question"
              ? {
                  type,
                  sessionID: "ses_123abc",
                  requestID: "question-123",
                  answers: [["Continue"]],
                }
              : type === "reject-question"
                ? {
                    type,
                    sessionID: "ses_123abc",
                    requestID: "question-123",
                  }
            : type === "copy-text"
              ? { type, text: "rendered code" }
              : type === "delete-session"
                ? { type, sessionID: "ses_123abc" }
                : type === "select-model"
                  ? { type, providerID: "provider-test", modelID: "model-test" }
                  : type === "select-agent"
                    ? { type, agentID: "build" }
            : { type };
    const actions = {
      openExpanded: vi.fn(),
      webviewReady: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      loadSessions: vi.fn(),
      loadMoreSessions: vi.fn(),
      searchSessions: vi.fn(),
      loadOlderHistory: vi.fn(),
      refreshChoices: vi.fn(),
      loadMcpStatus: vi.fn(),
      setMcpServerConnection: vi.fn(),
      loadToolMetadata: vi.fn(),
      loadSkills: vi.fn(),
      loadCommands: vi.fn(),
      runCommand: vi.fn(),
      loadChildSessions: vi.fn(),
      reviewSessionHistory: vi.fn(),
      refreshRequests: vi.fn(),
      refreshSessionActivity: vi.fn(),
      createSession: vi.fn(),
      addEditorContext: vi.fn(),
      copyText: vi.fn(),
      selectSession: vi.fn(),
      interruptSession: vi.fn(),
      selectModel: vi.fn(),
      selectAgent: vi.fn(),
      deleteSession: vi.fn(),
      replyToPermission: vi.fn(),
      replyToQuestion: vi.fn(),
      rejectQuestion: vi.fn(),
      sendPrompt: vi.fn(),
    };

    expect(dispatchWebviewMessage(message, actions)).toBe(true);
    expect(actions[actionName]).toHaveBeenCalledOnce();
    if (type === "run-command") {
      expect(actions.runCommand).toHaveBeenCalledWith("review", "fix typo");
    }
    if (type === "set-mcp-server-connection") {
      expect(actions.setMcpServerConnection).toHaveBeenCalledWith("server name/ñ", true, 7);
    }
    if (type === "send-prompt") {
      expect(actions.sendPrompt).toHaveBeenCalledWith(
        "550e8400-e29b-41d4-a716-446655440000",
        "550e8400-e29b-41d4-a716-446655440001",
        "Hello",
        "ses_123abc",
      );
    }
    if (type === "add-editor-context") {
      expect(actions.addEditorContext).toHaveBeenCalledWith();
    }
    if (type === "search-sessions") {
      expect(actions.searchSessions).toHaveBeenCalledWith("stream");
    }
    if (type === "select-model") {
      expect(actions.selectModel).toHaveBeenCalledWith("provider-test", "model-test");
    }
    if (type === "select-agent") {
      expect(actions.selectAgent).toHaveBeenCalledWith("build");
    }
    if (type === "delete-session") {
      expect(actions.deleteSession).toHaveBeenCalledWith("ses_123abc");
    }
    if (type === "interrupt-session") {
      expect(actions.interruptSession).toHaveBeenCalledWith("ses_123abc");
    }
    if (type === "refresh-session-activity") {
      expect(actions.refreshSessionActivity).toHaveBeenCalledWith("ses_123abc");
    }
    if (type === "reply-permission") {
      expect(actions.replyToPermission).toHaveBeenCalledWith(
        "ses_123abc",
        "permission-123",
        "once",
      );
    }
    if (type === "reply-question") {
      expect(actions.replyToQuestion).toHaveBeenCalledWith(
        "ses_123abc",
        "question-123",
        [["Continue"]],
      );
    }
    if (type === "reject-question") {
      expect(actions.rejectQuestion).toHaveBeenCalledWith(
        "ses_123abc",
        "question-123",
      );
    }
  });

  it("forwards a bounded but invalid target for host-side rejection", () => {
    const sendPrompt = vi.fn();
    const actions = {
      openExpanded: vi.fn(),
      webviewReady: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      loadSessions: vi.fn(),
      loadMoreSessions: vi.fn(),
      searchSessions: vi.fn(),
      loadOlderHistory: vi.fn(),
      refreshChoices: vi.fn(),
      loadMcpStatus: vi.fn(),
      setMcpServerConnection: vi.fn(),
      loadToolMetadata: vi.fn(),
      loadSkills: vi.fn(),
      loadCommands: vi.fn(),
      runCommand: vi.fn(),
      loadChildSessions: vi.fn(),
      reviewSessionHistory: vi.fn(),
      refreshRequests: vi.fn(),
      refreshSessionActivity: vi.fn(),
      createSession: vi.fn(),
      addEditorContext: vi.fn(),
      copyText: vi.fn(),
      selectSession: vi.fn(),
      interruptSession: vi.fn(),
      selectModel: vi.fn(),
      selectAgent: vi.fn(),
      deleteSession: vi.fn(),
      replyToPermission: vi.fn(),
      replyToQuestion: vi.fn(),
      rejectQuestion: vi.fn(),
      sendPrompt,
    };

    expect(
      dispatchWebviewMessage(
        {
          type: "send-prompt",
          requestID: "550e8400-e29b-41d4-a716-446655440000",
          attemptID: "550e8400-e29b-41d4-a716-446655440001",
          text: "Hello",
          sessionID: "../outside",
        },
        actions,
      ),
    ).toBe(true);
    expect(sendPrompt).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
      "550e8400-e29b-41d4-a716-446655440001",
      "Hello",
      "../outside",
    );
  });

  it.each([
      null,
      { type: "run-command", command: "workbench.action.openSettings" },
      { type: "set-mcp-server-connection", name: "known", connect: "yes", generation: 7 },
      { type: "set-mcp-server-connection", name: "", connect: true, generation: 7 },
      { type: "connect", extra: true },
      { type: "add-editor-context", path: "C:\\private\\source.ts" },
      { type: "select-session", sessionID: "../outside" },
      { type: "interrupt-session", sessionID: "../outside" },
      { type: "refresh-session-activity", sessionID: "../outside" },
      {
        type: "send-prompt",
        requestID: "550e8400-e29b-41d4-a716-446655440000",
        attemptID: "550e8400-e29b-41d4-a716-446655440001",
        text: "   ",
      },
      {
        type: "send-prompt",
        requestID: "550e8400-e29b-41d4-a716-446655440000",
        attemptID: "550e8400-e29b-41d4-a716-446655440001",
        text: "x".repeat(20_001),
      },
      {
        type: "send-prompt",
        requestID: "not-a-uuid",
        attemptID: "550e8400-e29b-41d4-a716-446655440001",
        text: "Hello",
      },
      {
        type: "send-prompt",
        requestID: "550e8400-e29b-41d4-a716-446655440000",
        attemptID: "not-a-uuid",
        text: "Hello",
      },
      {
        type: "reply-permission",
        sessionID: "ses_123abc",
        requestID: "permission-123",
        reply: "later",
      },
      {
        type: "reply-question",
        sessionID: "ses_123abc",
        requestID: "question-123",
        answers: [["x".repeat(8_001)]],
      },
      {
        type: "reject-question",
        sessionID: "../outside",
        requestID: "question-123",
      },
      { type: "copy-text", text: "x".repeat(1_000_001) },
    ])("rejects malformed actions without dispatching: %j", (message) => {
      const actions = {
        openExpanded: vi.fn(),
        webviewReady: vi.fn(),
        connect: vi.fn(),
      disconnect: vi.fn(),
      loadSessions: vi.fn(),
      loadMoreSessions: vi.fn(),
      searchSessions: vi.fn(),
      loadOlderHistory: vi.fn(),
      refreshChoices: vi.fn(),
      loadMcpStatus: vi.fn(),
      setMcpServerConnection: vi.fn(),
      loadToolMetadata: vi.fn(),
      loadSkills: vi.fn(),
      loadCommands: vi.fn(),
      runCommand: vi.fn(),
      loadChildSessions: vi.fn(),
      reviewSessionHistory: vi.fn(),
      refreshRequests: vi.fn(),
      refreshSessionActivity: vi.fn(),
        createSession: vi.fn(),
        addEditorContext: vi.fn(),
        copyText: vi.fn(),
      selectSession: vi.fn(),
      interruptSession: vi.fn(),
      selectModel: vi.fn(),
      selectAgent: vi.fn(),
      deleteSession: vi.fn(),
        replyToPermission: vi.fn(),
        replyToQuestion: vi.fn(),
        rejectQuestion: vi.fn(),
        sendPrompt: vi.fn(),
      };

    expect(dispatchWebviewMessage(message, actions)).toBe(false);
    expect(Object.values(actions).every((action) => !action.mock.calls.length)).toBe(
      true,
    );
  });
});

describe("extension-to-webview connection state protocol", () => {
  it("updates the Webview from a validated host state message", () => {
    const updateConnectionState = vi.fn();
      const state = {
        status: "connected",
        serverUrl: "http://127.0.0.1:4096",
        version: "1.19.0",
        owner: "attached",
      };

    expect(
      dispatchExtensionMessage(
        { type: "connection-state", state },
        {
          updateConnectionState,
          updateChatState: vi.fn(),
          updateCapabilityState: vi.fn(),
          updateEditorContextResult: vi.fn(),
        },
      ),
    ).toBe(true);
    expect(updateConnectionState).toHaveBeenCalledWith(state);
  });

  it("ignores invalid host messages", () => {
    const updateConnectionState = vi.fn();

    expect(
      dispatchExtensionMessage(
        {
          type: "connection-state",
          state: { status: "connected", serverUrl: "not a URL" },
        },
        {
          updateConnectionState,
          updateChatState: vi.fn(),
          updateCapabilityState: vi.fn(),
          updateEditorContextResult: vi.fn(),
        },
      ),
    ).toBe(false);
    expect(updateConnectionState).not.toHaveBeenCalled();
  });

  it("updates the Webview from a validated chat-state message", () => {
    const updateChatState = vi.fn();

    expect(
      dispatchExtensionMessage(
        { type: "chat-state", state: initialChatState },
        {
          updateConnectionState: vi.fn(),
          updateChatState,
          updateCapabilityState: vi.fn(),
          updateEditorContextResult: vi.fn(),
        },
      ),
    ).toBe(true);
    expect(updateChatState).toHaveBeenCalledWith(initialChatState);
  });

  it("rejects host chat state with unexpected fields", () => {
    const updateChatState = vi.fn();

    expect(
      dispatchExtensionMessage(
        {
          type: "chat-state",
          state: { ...initialChatState, arbitrary: "value" },
        },
        {
          updateConnectionState: vi.fn(),
          updateChatState,
          updateCapabilityState: vi.fn(),
          updateEditorContextResult: vi.fn(),
        },
      ),
    ).toBe(false);
    expect(updateChatState).not.toHaveBeenCalled();
  });

  it("updates the Webview from validated read-only capability state", () => {
    const updateCapabilityState = vi.fn();

    expect(
      dispatchExtensionMessage(
        { type: "capability-state", state: initialCapabilityState },
        {
          updateConnectionState: vi.fn(),
          updateChatState: vi.fn(),
          updateCapabilityState,
          updateEditorContextResult: vi.fn(),
        },
      ),
    ).toBe(true);
    expect(updateCapabilityState).toHaveBeenCalledWith(initialCapabilityState);
  });

  it("rejects capability state containing unapproved server payload fields", () => {
    const updateCapabilityState = vi.fn();

    expect(
      dispatchExtensionMessage(
        {
          type: "capability-state",
          state: {
            ...initialCapabilityState,
            skills: {
              ...initialCapabilityState.skills,
              content: "skill file contents",
            },
          },
        },
        {
          updateConnectionState: vi.fn(),
          updateChatState: vi.fn(),
          updateCapabilityState,
          updateEditorContextResult: vi.fn(),
        },
      ),
    ).toBe(false);
    expect(updateCapabilityState).not.toHaveBeenCalled();
  });

  it("dispatches a bounded editor-context result from the Extension Host", () => {
    const updateEditorContextResult = vi.fn();
    const result = {
      kind: "ready" as const,
      context:
        "[OpenCode Visual editor context]\nFile reference (workspace-relative): `src/main.ts`\n[End OpenCode Visual editor context]",
    };

    expect(
      dispatchExtensionMessage(
        { type: "editor-context-result", result },
        {
          updateConnectionState: vi.fn(),
          updateChatState: vi.fn(),
          updateCapabilityState: vi.fn(),
          updateEditorContextResult,
        },
      ),
    ).toBe(true);
    expect(updateEditorContextResult).toHaveBeenCalledWith(result);
  });
});
