import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/webview/App";
import {
  initialChatState,
  questionAnswersSchema,
  type ChatQuestionRequest,
  type ChatState,
} from "../src/shared/chat-state";
import {
  initialCapabilityState,
  type CapabilityState,
} from "../src/shared/capability-state";
import { composeQuestionAnswers } from "../src/webview/question-answers";
import {
  initialConnectionState,
  type ConnectionState,
} from "../src/shared/connection-state";
import { dispatchExtensionMessage } from "../src/shared/webview-message";

describe("OpenCode chat Webview", () => {
  it("shows truthful connection actions before a server is connected", () => {
    const markup = render(initialConnectionState);

    expect(markup).toContain("Not connected");
    expect(markup).toContain("Connect to an OpenCode server");
    expect(markup).toContain('aria-label="Connect to OpenCode"');
    expect(markup).toContain("Open expanded view");
    expect(markup).toContain("127.0.0.1:4096");
    expect(markup).not.toMatch(/New session|Send message|Select model|Run tool/);
  });

  it("renders server-returned sessions, history, and the multiline composer", () => {
    const state: ConnectionState = {
      status: "connected",
      serverUrl: "http://127.0.0.1:4096",
      version: "1.19.0",
      owner: "attached",
    };
    const chatState: ChatState = {
      ...initialChatState,
      sessions: [
        {
          id: "ses_123abc",
          title: "Investigate stream handling",
          updatedAt: 1_760_000_000_000,
        },
      ],
      selectedSessionID: "ses_123abc",
      messages: [
        { id: "msg-user", role: "user", text: "Explain the event contract." },
        {
          id: "msg-assistant",
          role: "assistant",
          text: "Use the pinned `session.next.text.delta` event.",
        },
      ],
      streamStatus: "connected",
    };
    const markup = render(state, chatState);

    expect(markup).toContain("Investigate stream handling");
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain("Explain the event contract.");
    expect(markup).toContain("session.next.text.delta");
    expect(markup).toContain("Live updates connected.");
    expect(markup).toContain('id="prompt-composer"');
    expect(markup).toContain('aria-label="Add editor context to prompt"');
    expect(markup).toContain("Add editor context");
    expect(markup).not.toMatch(/upload attachment|attach file/i);
    expect(markup).toContain("Shift+Enter for a new line");
    expect(markup).toContain("Send");
  });

  it("shows an accessible session stop control only for known active state", () => {
    const state: ConnectionState = {
      status: "connected",
      serverUrl: "http://127.0.0.1:4096",
      version: "1.19.0",
      owner: "attached",
    };
    const selectedSession = {
      ...initialChatState,
      selectedSessionID: "ses_123abc",
      streamStatus: "connected" as const,
    };

    const unknownMarkup = render(state, selectedSession);
    expect(unknownMarkup).not.toContain("Request stop for the selected session");

    const activeMarkup = render(state, {
      ...selectedSession,
      sessionActivity: "active",
    });
    expect(activeMarkup).toContain(
      'aria-label="Request stop for the selected session"',
    );
    expect(activeMarkup).toContain(">Stop session</button>");

    const waitingMarkup = render(state, {
      ...selectedSession,
      sessionActivity: "active",
      interruptStatus: "waiting",
    });
    expect(waitingMarkup).toContain("Stop requested — waiting for OpenCode");
    expect(waitingMarkup).not.toContain(">Stopped</button>");
    expect(waitingMarkup).toContain(
      'aria-label="Stop requested; waiting for OpenCode to confirm the session is idle"',
    );

    const failedMarkup = render(state, {
      ...selectedSession,
      sessionActivity: "active",
      interruptStatus: "error",
      interruptError: "OpenCode could not confirm the stop request.",
    });
    expect(failedMarkup).toContain('role="alert"');
    expect(failedMarkup).toContain("Retry stop request</button>");
    expect(failedMarkup).toContain(
      'aria-label="Retry stop request for the selected session"',
    );

    const inactiveMarkup = render(state, {
      ...selectedSession,
      sessionActivity: "inactive",
    });
    expect(inactiveMarkup).not.toContain("Request stop for the selected session");
  });

  it("renders only server-returned provider, model, and agent choices", () => {
    const session = {
      id: "ses_123abc",
      title: "Current session",
      updatedAt: 1_760_000_000_000,
      model: { id: "claude-test", providerID: "anthropic" },
      agent: "build",
    };
    const markup = render(
      {
        status: "connected",
        serverUrl: "http://127.0.0.1:4096",
        version: "1.19.0",
        owner: "attached",
      },
      {
        ...initialChatState,
        sessions: [session],
        activeSession: session,
        selectedSessionID: session.id,
        providers: [{ id: "anthropic", name: "Anthropic" }],
        providerChoicesStatus: "ready",
        models: [
          {
            id: "claude-test",
            providerID: "anthropic",
            name: "Claude Test",
            enabled: true,
            variants: [],
          },
        ],
        modelChoicesStatus: "ready",
        agents: [{ id: "build", description: "Build changes." }],
        agentChoicesStatus: "ready",
        selectedModel: { id: "claude-test", providerID: "anthropic" },
        selectedAgent: "build",
        streamStatus: "connected",
      },
    );

    expect(markup).toContain('aria-label="Session model and agent choices"');
    expect(markup).toContain("Anthropic");
    expect(markup).toContain("claude-test");
    expect(markup).not.toContain('id="provider-filter"');
    expect(markup).not.toContain('id="session-model"');
    expect(markup).toContain("/provider");
    expect(markup).toContain("/model");
    expect(markup).toContain('value="build"');
    expect(markup).toContain("server-returned options");
    expect(markup).not.toContain('aria-label="Mode"');
    expect(markup).toContain('aria-label="Delete session Current session"');
  });

  it("shows choice loading and unavailable states without placeholder choices", () => {
    const loadingMarkup = render(
      {
        status: "connected",
        serverUrl: "http://127.0.0.1:4096",
        version: "1.19.0",
        owner: "attached",
      },
      {
        ...initialChatState,
        providerChoicesStatus: "loading",
        modelChoicesStatus: "loading",
        agentChoicesStatus: "loading",
      },
    );
    expect(loadingMarkup).toContain("Loading provider, model, and agent choices");

    const unavailableMarkup = render(
      {
        status: "connected",
        serverUrl: "http://127.0.0.1:4096",
        version: "1.19.0",
        owner: "attached",
      },
      {
        ...initialChatState,
        providerChoicesStatus: "unavailable",
        providerChoicesError: "Provider choices are unavailable. Retry choices.",
        modelChoicesStatus: "unavailable",
        modelChoicesError: "Model choices are unavailable. Retry choices.",
        agentChoicesStatus: "unavailable",
        agentChoicesError: "Agent choices are unavailable. Retry choices.",
      },
    );
    expect(unavailableMarkup).toContain("Provider choices are unavailable");
    expect(unavailableMarkup).toContain("Model choices are unavailable");
    expect(unavailableMarkup).toContain("Agent choices are unavailable");
    expect(unavailableMarkup).not.toContain('value="anthropic"');
    expect(unavailableMarkup).not.toContain('value="build"');
  });

  it("renders independently loadable read-only capability sections", () => {
    const markup = render(
      {
        status: "connected",
        serverUrl: "http://127.0.0.1:4096",
        version: "1.19.0",
        owner: "attached",
      },
      {
        ...initialChatState,
        selectedSessionID: "ses_123abc",
        selectedModel: { id: "model-test", providerID: "provider-test" },
      },
      {
        ...initialCapabilityState,
        mcp: {
          status: "ready",
          servers: [{ name: "attached-mcp", status: "connected" }],
          error: null,
        },
      },
    );

    expect(markup).toContain('class="capability-inventory"');
    expect(markup).toContain("MCP server status");
    expect(markup).toContain(">Connected</span>");
    expect(markup).toContain("Tool metadata");
    expect(markup).toContain("Registered skills");
    expect(markup).toContain("Child sessions");
    expect(markup).toContain("server default agent");
    expect(markup).toContain("experimental endpoint");
    expect(markup).toContain("server-reported parentID");
    expect(markup).not.toMatch(/Add MCP|Connect MCP|Enable skill|Invoke tool|Disconnect MCP/);
  });

  it("renders capability loading, empty, unavailable, and error states truthfully", () => {
    const state: CapabilityState = {
      mcp: { status: "ready", servers: [], error: null },
      tools: {
        status: "unavailable",
        providerID: "provider-test",
        modelID: "model-test",
        tools: [],
        error: "Tool metadata uses an experimental endpoint that is unavailable on this server.",
      },
      skills: {
        status: "error",
        skills: [],
        error: "Could not load skill metadata. Check the connection and retry.",
      },
      children: {
        status: "loading",
        parentSessionID: "ses_123abc",
        sessions: [],
        scannedSessionCount: 0,
        truncated: false,
        agentModesAvailable: null,
        error: null,
      },
    };
    const markup = render(
      {
        status: "connected",
        serverUrl: "http://127.0.0.1:4096",
        version: "1.19.0",
        owner: "attached",
      },
      {
        ...initialChatState,
        selectedSessionID: "ses_123abc",
        selectedModel: { id: "model-test", providerID: "provider-test" },
      },
      state,
    );

    expect(markup).toContain("OpenCode returned no MCP server statuses.");
    expect(markup).toContain("Loading server-returned metadata");
    expect(markup).toContain("experimental endpoint that is unavailable");
    expect(markup).toContain("Could not load skill metadata");
  });

  it("shows subagent classification only when the host supplies that returned mode", () => {
    const state: CapabilityState = {
      ...initialCapabilityState,
      children: {
        status: "ready",
        parentSessionID: "ses_parent123",
        sessions: [
          {
            id: "ses_child123",
            title: "Background worker",
            updatedAt: 1_760_000_000_000,
            agent: "worker",
            subagent: true,
          },
          {
            id: "ses_child456",
            title: "Regular child",
            updatedAt: 1_760_000_000_001,
            agent: "build",
          },
        ],
        scannedSessionCount: 2,
        truncated: false,
        agentModesAvailable: true,
        error: null,
      },
    };
    const markup = render(
      {
        status: "connected",
        serverUrl: "http://127.0.0.1:4096",
        version: "1.19.0",
        owner: "attached",
      },
      { ...initialChatState, selectedSessionID: "ses_parent123" },
      state,
    );

    expect(markup.match(/>Subagent</g)).toHaveLength(1);
    expect(markup.match(/>Child session</g)).toHaveLength(2);
  });

  it("distinguishes successful empty choice lists from unavailable endpoints", () => {
    const markup = render(
      {
        status: "connected",
        serverUrl: "http://127.0.0.1:4096",
        version: "1.19.0",
        owner: "attached",
      },
      {
        ...initialChatState,
        providerChoicesStatus: "ready",
        modelChoicesStatus: "ready",
        agentChoicesStatus: "ready",
      },
    );

    expect(markup).toContain("OpenCode returned no providers");
    expect(markup).toContain("OpenCode returned no models for this workspace");
    expect(markup).toContain("OpenCode returned no visible agents");
  });

  it("shows pagination controls only when the server returns cursors", () => {
    const connectionState: ConnectionState = {
      status: "connected",
      serverUrl: "http://127.0.0.1:4096",
      version: "1.19.0",
      owner: "attached",
    };
    const withoutCursors = render(connectionState, {
      ...initialChatState,
      sessions: [
        { id: "ses_123abc", title: "Current session", updatedAt: 1_760_000_000_000 },
      ],
      activeSession: {
        id: "ses_123abc",
        title: "Current session",
        updatedAt: 1_760_000_000_000,
      },
      selectedSessionID: "ses_123abc",
      streamStatus: "connected",
    });
    expect(withoutCursors).not.toContain("Load more sessions");
    expect(withoutCursors).not.toContain("Load older messages");

    const withCursors = render(connectionState, {
      ...initialChatState,
      sessions: [
        { id: "ses_123abc", title: "Current session", updatedAt: 1_760_000_000_000 },
      ],
      activeSession: {
        id: "ses_123abc",
        title: "Current session",
        updatedAt: 1_760_000_000_000,
      },
      selectedSessionID: "ses_123abc",
      sessionNextCursor: "sessions-next",
      historyNextCursor: "history-older",
      streamStatus: "connected",
    });
    expect(withCursors).toContain("Load more sessions");
    expect(withCursors).toContain("Load older messages");
  });

  it("renders server-supplied permission and question requests with supported actions", () => {
    const session = {
      id: "ses_123abc",
      title: "Current session",
      updatedAt: 1_760_000_000_000,
    };
    const markup = render(
      {
        status: "connected",
        serverUrl: "http://127.0.0.1:4096",
        version: "1.19.0",
        owner: "attached",
      },
      {
        ...initialChatState,
        sessions: [session],
        activeSession: session,
        selectedSessionID: session.id,
        streamStatus: "connected",
        permissionRequests: [
          {
            id: "permission-123",
            sessionID: session.id,
            action: "file.write",
            resources: ["src/main.ts"],
            save: ["src/*.ts"],
            metadata: '{\n  "reason": "Update the implementation"\n}',
            source: {
              type: "tool",
              messageID: "msg-assistant",
              callID: "call-write",
            },
          },
        ],
        questionRequests: [
          {
            id: "question-123",
            sessionID: session.id,
            questions: [
              {
                header: "Next step",
                question: "How should this change proceed?",
                options: [
                  { label: "Continue", description: "Apply the proposed change." },
                ],
                custom: true,
              },
            ],
            tool: { messageID: "msg-assistant", callID: "call-question" },
          },
        ],
      },
    );

    expect(markup).toContain("Pending requests");
    expect(markup).toContain("Permission required: file.write");
    expect(markup).toContain("src/main.ts");
    expect(markup).toContain("Update the implementation");
    expect(markup).toContain("Allow once");
    expect(markup).toContain("Always allow");
    expect(markup).toContain("Reject");
    expect(markup).toContain("How should this change proceed?");
    expect(markup).toContain("Continue");
    expect(markup).toContain("Submit answers");
    expect(markup).toContain("Reject question");
    const requestRegion = markup.match(
      /<section aria-label="Pending permission and question requests"[^>]*>/,
    )?.[0];
    expect(requestRegion).toContain('aria-live="polite"');
    expect(requestRegion).toContain('aria-relevant="additions"');
    expect(requestRegion).toContain('aria-atomic="false"');
    expect(markup.indexOf(requestRegion ?? "")).toBeLessThan(
      markup.indexOf('<div aria-live="polite" class="messages-region" role="log">'),
    );
  });

  it("accepts 64 selected options plus one custom answer within the bounded schema", () => {
    const options = Array.from({ length: 64 }, (_, index) => `Option ${index + 1}`);
    const questions: ChatQuestionRequest["questions"] = [
      {
        header: "Choices",
        question: "Select any number of options.",
        options: options.map((label) => ({ label, description: "" })),
        multiple: true,
        custom: true,
      },
    ];
    const answers = composeQuestionAnswers(
      questions,
      [options],
      ["Custom choice"],
      [false],
    );

    expect(answers?.[0]).toHaveLength(65);
    expect(answers?.[0]?.slice(0, 64)).toEqual(options);
    expect(answers?.[0]?.[64]).toBe("Custom choice");
    expect(questionAnswersSchema.safeParse(answers).success).toBe(true);
    expect(
      questionAnswersSchema.safeParse([[...options, "Custom choice", "Extra"]]).success,
    ).toBe(false);
  });

  it("preserves meaningful custom-answer whitespace and rejects whitespace-only input", () => {
    const questions: ChatQuestionRequest["questions"] = [
      {
        header: "Answer",
        question: "Enter a custom answer.",
        options: [],
        custom: true,
      },
    ];
    const meaningful = "  keep these spaces  ";

    expect(
      composeQuestionAnswers(questions, [[]], [meaningful], [true]),
    ).toEqual([[meaningful]]);
    expect(
      composeQuestionAnswers(questions, [[]], [" \t  \n"], [true]),
    ).toBeUndefined();
  });

  it("keeps a selected session discoverable outside the newest 50 session rows", () => {
    const connectionState: ConnectionState = {
      status: "connected",
      serverUrl: "http://127.0.0.1:4096",
      version: "1.19.0",
      owner: "attached",
    };
    const recentSessions = Array.from({ length: 50 }, (_, index) => ({
      id: `ses_recent_${index}`,
      title: `Recent session ${index}`,
      updatedAt: 1_760_000_000_000 - index,
    }));
    const selectedSession = {
      id: "ses_older_selected",
      title: "Older selected session",
      updatedAt: 1_700_000_000_000,
    };
    const chatState: ChatState = {
      ...initialChatState,
      sessions: recentSessions,
      selectedSessionID: selectedSession.id,
      activeSession: selectedSession,
      streamStatus: "connected",
    };
    const markup = render(connectionState, chatState);

    expect(chatState.sessions).toHaveLength(50);
    expect(markup).toContain("Selected session · outside loaded pages");
    expect(markup).toContain(
      'aria-label="Open selected session Older selected session"',
    );
    expect(markup.indexOf("Selected session · outside loaded pages")).toBeLessThan(
      markup.indexOf("Recent session 0"),
    );
  });

  it("explains when and under what conditions an unknown prompt can be retried", () => {
    const markup = render(
      {
        status: "connected",
        serverUrl: "http://127.0.0.1:4096",
        version: "1.19.0",
        owner: "attached",
      },
      {
        ...initialChatState,
        sessions: [
          {
            id: "ses_123abc",
            title: "Current session",
            updatedAt: 1_760_000_000_000,
          },
        ],
        selectedSessionID: "ses_123abc",
        activeSession: {
          id: "ses_123abc",
          title: "Current session",
          updatedAt: 1_760_000_000_000,
        },
        promptResult: {
          requestID: "550e8400-e29b-41d4-a716-446655440000",
          attemptID: "550e8400-e29b-41d4-a716-446655440001",
          sessionID: "ses_123abc",
          status: "outcome-unknown",
        },
        streamStatus: "connected",
      },
    );

    expect(markup).toContain("Review this session before retrying.");
    expect(markup).toContain(
      "deduplicates an exact retry only when the session, prompt, and delivery match",
    );
  });

  it("shows history failures alongside unknown outcomes and hides the empty state", () => {
    const session = {
      id: "ses_123abc",
      title: "Current session",
      updatedAt: 1_760_000_000_000,
    };
    const markup = render(
      {
        status: "connected",
        serverUrl: "http://127.0.0.1:4096",
        version: "1.19.0",
        owner: "attached",
      },
      {
        ...initialChatState,
        sessions: [session],
        activeSession: session,
        selectedSessionID: session.id,
        promptResult: {
          requestID: "550e8400-e29b-41d4-a716-446655440000",
          attemptID: "550e8400-e29b-41d4-a716-446655440001",
          sessionID: session.id,
          status: "outcome-unknown",
          httpStatus: 503,
        },
        historyError:
          "Could not load the selected OpenCode session history. Try reviewing it again.",
        streamStatus: "connected",
      },
    );

    expect(markup).toContain("The prompt outcome is unknown");
    expect(markup).toContain("The server returned HTTP 503.");
    expect(markup).toContain("Could not load the selected OpenCode session history.");
    expect(markup).toContain('aria-label="Review session history"');
    expect(markup).not.toContain("No messages yet");
    expect(markup.match(/role="alert"/g)).toHaveLength(2);
  });

  it("shows the empty-history state after a successful empty history load", () => {
    const session = {
      id: "ses_empty123",
      title: "Empty session",
      updatedAt: 1_760_000_000_000,
    };
    const markup = render(
      {
        status: "connected",
        serverUrl: "http://127.0.0.1:4096",
        version: "1.19.0",
        owner: "attached",
      },
      {
        ...initialChatState,
        sessions: [session],
        activeSession: session,
        selectedSessionID: session.id,
        loadingMessages: false,
        messages: [],
        historyError: null,
        streamStatus: "connected",
      },
    );

    expect(markup).toContain("No messages yet");
    expect(markup).not.toContain("Could not load the selected OpenCode session history.");
  });

  it("renders code blocks with copy and ignores raw HTML and unsafe link protocols", () => {
    const state: ConnectionState = {
      status: "connected",
      serverUrl: "http://127.0.0.1:4096",
      version: "1.19.0",
      owner: "attached",
    };
    const chatState: ChatState = {
      ...initialChatState,
      messages: [
        {
          id: "msg-assistant",
          role: "assistant",
          text: [
            "```ts",
            "const answer = 42;",
            "```",
            "<img src=x onerror=alert(1)>",
            "[unsafe](javascript:alert(1))",
          ].join("\n"),
        },
      ],
    };
    const markup = render(state, chatState);

    expect(markup).toContain("const answer = 42;");
    expect(markup).toContain("Copy code");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain('href="javascript:');
  });

  it("renders tool activity and session diffs as separate accessible disclosures", () => {
    const markup = render(
      {
        status: "connected",
        serverUrl: "http://127.0.0.1:4096",
        version: "1.19.0",
        owner: "attached",
      },
      {
        ...initialChatState,
        selectedSessionID: "ses_123abc",
        messages: [
          {
            id: "msg-tools",
            role: "assistant",
            text: "The command completed.",
            parts: [
              {
                id: "text-1",
                type: "text",
                text: "The command completed.",
              },
              {
                id: "tool-1",
                type: "tool",
                callID: "call-1",
                name: "bash",
                status: "completed",
                input: '<img src=x onerror="alert(1)">',
                output: "Command output",
                result: "Success",
                durationMs: 7,
              },
              {
                id: "tool-unknown",
                type: "tool",
                callID: "call-unknown",
                name: "future-tool",
                generic: '{"newField":"visible as text"}',
              },
            ],
          },
        ],
        sessionDiffs: [
          {
            file: "src/app.ts",
            patch: "@@ -1 +1 @@",
            additions: 2,
            deletions: 1,
            status: "modified",
          },
        ],
        streamStatus: "connected",
      },
    );

    expect(markup).toContain('<details aria-label="Tool call: bash"');
    expect(markup).toContain("Status not provided");
    expect(markup).toContain("completed");
    expect(markup).toContain("7 ms");
    expect(markup).toContain("Input");
    expect(markup).toContain("&lt;img");
    expect(markup).not.toContain('<img src=x');
    expect(markup).toContain("Command output");
    expect(markup).toContain("future-tool");
    expect(markup).toContain("Status not provided");
    expect(markup).toContain("visible as text");
    expect(markup).toContain("Session file changes (1)");
    expect(markup).toContain("src/app.ts");
    expect(markup).toContain("@@ -1 +1 @@");
  });

  it("applies host-published connection and chat state updates", () => {
    let connectionState: ConnectionState = initialConnectionState;
    let chatState = initialChatState;
    const updatedConnection = dispatchExtensionMessage(
      {
        type: "connection-state",
        state: {
          status: "connected",
          serverUrl: "http://127.0.0.1:4096",
          version: "1.19.0",
          owner: "attached",
        },
      },
      {
          updateConnectionState: (state) => {
            connectionState = state;
          },
          updateChatState: (state) => {
            chatState = state;
          },
          updateCapabilityState: vi.fn(),
          updateEditorContextResult: vi.fn(),
      },
    );
    const updatedChat = dispatchExtensionMessage(
      {
        type: "chat-state",
        state: {
          ...initialChatState,
          selectedSessionID: "ses_123abc",
          streamStatus: "connected",
        },
      },
      {
          updateConnectionState: (state) => {
            connectionState = state;
          },
          updateChatState: (state) => {
            chatState = state;
          },
          updateCapabilityState: vi.fn(),
          updateEditorContextResult: vi.fn(),
      },
    );

    expect(updatedConnection).toBe(true);
    expect(updatedChat).toBe(true);
    expect(render(connectionState, chatState)).toContain("Live updates connected.");
    expect(render(connectionState, chatState)).toContain("OpenCode 1.19.0");
  });

  it("renders version mismatch separately and keeps attached disconnect action", () => {
    const markup = render({
      status: "version-mismatch",
      serverUrl: "http://127.0.0.1:4096",
      actualVersion: "2.0.0",
      expectedVersion: "1.19.0",
      owner: "attached",
    });

    expect(markup).toContain("Version mismatch");
    expect(markup).toContain("reports 2.0.0");
    expect(markup).toContain("targets 1.19.0");
    expect(markup).toContain("Disconnect");
  });
});

function render(
  connectionState: ConnectionState,
  chatState: ChatState = initialChatState,
  capabilityState: CapabilityState = initialCapabilityState,
): string {
  return renderToStaticMarkup(
    createElement(App, {
      chatState,
      connectionState,
      capabilityState,
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
      onLoadSessions: vi.fn(),
      onLoadMoreSessions: vi.fn(),
      onSearchSessions: vi.fn(),
      onLoadOlderHistory: vi.fn(),
      onRefreshChoices: vi.fn(),
      onLoadMcpStatus: vi.fn(),
      onLoadToolMetadata: vi.fn(),
      onLoadSkills: vi.fn(),
      onLoadChildSessions: vi.fn(),
      onReviewSessionHistory: vi.fn(),
      onRefreshRequests: vi.fn(),
      onRefreshSessionActivity: vi.fn(),
      onCreateSession: vi.fn(),
      onCopyText: vi.fn(),
      onSelectSession: vi.fn(),
      onInterruptSession: vi.fn(),
      onSelectModel: vi.fn(),
      onSelectAgent: vi.fn(),
      onDeleteSession: vi.fn(),
      onReplyToPermission: vi.fn(),
      onReplyToQuestion: vi.fn(),
      onRejectQuestion: vi.fn(),
      onSendPrompt: vi.fn(),
      onAddEditorContext: vi.fn(),
      onClearEditorContextResult: vi.fn(),
      editorContextResult: null,
      onOpenExpanded: vi.fn(),
    }),
  );
}
