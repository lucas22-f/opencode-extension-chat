import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/webview/App";
import { initialChatState, type ChatState } from "../src/shared/chat-state";
import { initialCapabilityState } from "../src/shared/capability-state";
import { type ConnectionState } from "../src/shared/connection-state";

const connected: ConnectionState = {
  status: "connected",
  serverUrl: "http://127.0.0.1:4096",
  version: "1.19.0",
  owner: "attached",
};

function renderWithDiffs(sessionDiffs: ChatState["sessionDiffs"]): {
  markup: string;
  onCopyText: ReturnType<typeof vi.fn>;
} {
  const onCopyText = vi.fn();
  const markup = renderToStaticMarkup(
    createElement(App, {
      chatState: {
        ...initialChatState,
        selectedSessionID: "ses_diff",
        sessionDiffs,
        streamStatus: "connected",
      },
      connectionState: connected,
      capabilityState: initialCapabilityState,
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
      onLoadSessions: vi.fn(),
      onLoadMoreSessions: vi.fn(),
      onSearchSessions: vi.fn(),
      onLoadOlderHistory: vi.fn(),
      onRefreshChoices: vi.fn(),
      onLoadMcpStatus: vi.fn(),
      onSetMcpServerConnection: vi.fn(),
      onLoadToolMetadata: vi.fn(),
      onLoadSkills: vi.fn(),
      onLoadCommands: vi.fn(),
      onRunCommand: vi.fn(),
      onLoadChildSessions: vi.fn(),
      onReviewSessionHistory: vi.fn(),
      onRefreshRequests: vi.fn(),
      onRefreshSessionActivity: vi.fn(),
      onCreateSession: vi.fn(),
      onCopyText,
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
  return { markup, onCopyText };
}

describe("SessionDiffView compact renderer", () => {
  it("renders multiple hunks with numbered gutters, markers, and hunk headers", () => {
    const { markup, onCopyText } = renderWithDiffs([
      {
        file: "src/app.ts",
        patch:
          [
            "@@ -1,4 +1,5 @@ existing section",
            " const a0 = 0;",
            " const a = 1;",
            " const keep = 1;",
            "-const b = 2;",
            "+const b = 3;",
            "+const c = 4;",
            "@@ -10,3 +11,4 @@",
            " const tail = true;",
            " const still = true;",
            "-const gone = false;",
            "+const here = true;",
            "+const also = true;",
          ].join("\n") + "\n",
        additions: 3,
        deletions: 1,
        status: "modified",
      },
    ]);

    // Honest server-reported header: file name, status, and reported counts.
    expect(markup).toContain("Session file changes (1)");
    expect(markup).toContain("src/app.ts");
    expect(markup).toContain("modified");
    expect(markup).toContain("+3");
    expect(markup).toContain("−1");

    // Hunk headers are shown with their section titles.
    expect(markup).toContain("@@ -1,4 +1,5 @@ existing section");
    expect(markup).toContain("@@ -10,3 +11,4 @@");

    // Row kinds get distinct classes so CSS can tint additions/deletions.
    expect(markup).toContain('class="session-diff-line session-diff-context"');
    expect(markup).toContain('class="session-diff-line session-diff-addition"');
    expect(markup).toContain('class="session-diff-line session-diff-deletion"');
    expect(markup).toContain('class="session-diff-hunk-header"');

    // Explicit +/- markers in a dedicated element.
    expect(markup).toContain('class="session-diff-marker">+</span>');
    expect(markup).toContain('class="session-diff-marker">-</span>');

    // Numbered old/new gutters exist for numbered rows.
    expect(markup).toContain('class="session-diff-gutter session-diff-gutter-old"');
    expect(markup).toContain('class="session-diff-gutter session-diff-gutter-new"');
    expect(markup).toContain(">1</span>");
    expect(markup).toContain(">11</span>");
    expect(markup).toContain("const b = 3;");
    expect(markup).toContain("const tail = true;");

    // Rendering a diff never triggers callbacks on its own.
    expect(onCopyText).not.toHaveBeenCalled();
  });

  it("handles zero-count hunk starts and no-newline markers truthfully", () => {
    const { markup } = renderWithDiffs([
      {
        file: "src/new-file.ts",
        patch: [
          "@@ -0,0 +1,2 @@",
          "+first line",
          "+second line",
          "@@ -2 +2 @@",
          " unchanged tail",
          "\\ No newline at end of file",
        ].join("\n"),
        additions: 3,
        deletions: 1,
      },
    ]);

    expect(markup).toContain("@@ -0,0 +1,2 @@");
    expect(markup).toContain("@@ -2 +2 @@");
    expect(markup).toContain("first line");
    expect(markup).toContain("second line");

    // Zero-count old side has no old line numbers: the old gutter stays blank.
    const firstAddition = markup.slice(
      markup.indexOf('class="session-diff-line session-diff-addition"'),
      markup.indexOf("</li>", markup.indexOf('class="session-diff-line session-diff-addition"')),
    );
    expect(firstAddition).toContain(
      '<span class="session-diff-gutter session-diff-gutter-old"></span>',
    );

    // The no-newline marker is rendered as its own row with the literal text.
    expect(markup).toContain("No newline at end of file");
  });

  it("escapes patch content and keeps horizontal overflow local to the code", () => {
    const { markup } = renderWithDiffs([
      {
        file: "src/unsafe.ts",
        patch: "@@ -0,0 +1 @@\n+<img src=x onerror=\"alert(1)\">",
        additions: 1,
        deletions: 0,
      },
    ]);

    expect(markup).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(markup).not.toContain("<img src=x");
    expect(markup).toContain("session-diff-content");
  });

  it("falls back to a safe escaped block for malformed patches without invented numbers", () => {
    const { markup } = renderWithDiffs([
      {
        file: "src/broken.ts",
        patch: "not a unified diff at all\njust some text",
        additions: 9,
        deletions: 9,
      },
    ]);

    expect(markup).toContain('class="session-diff-raw"');
    expect(markup).toContain("not a unified diff at all");
    // The raw fallback carries no per-line gutters or invented line numbering.
    expect(markup).not.toContain("session-diff-line");
    expect(markup).not.toContain("session-diff-gutter");
    // Header still reports only what the server reported.
    expect(markup).toContain("+9 −9");
  });

  it("falls back safely for inconsistent, unsafe, or misplaced patch payloads", () => {
    const malformedPatches = [
      // Declared ranges larger than the rows actually present (truncated).
      "@@ -1,3 +1,3 @@\n+only one row",
      // Unsafe integer start (above Number.MAX_SAFE_INTEGER).
      "@@ -9007199254740993 +1 @@\n+row",
      // Unknown backslash marker text.
      "@@ -1 +1 @@\n context\n\\ No newline at end of the file",
      // No-newline marker before any content row in the hunk.
      "@@ -1 +1 @@\n\\ No newline at end of file\n context",
      // Malformed empty payload line interior to the hunk.
      "@@ -1,2 +1,2 @@\n ctx\n\n+add",
    ];
    for (const patch of malformedPatches) {
      const { markup } = renderWithDiffs([
        { file: "src/broken.ts", patch, additions: 1, deletions: 1 },
      ]);
      expect(markup).toContain('class="session-diff-raw"');
      expect(markup).not.toContain("session-diff-gutter");
      expect(markup).not.toContain("session-diff-line ");
    }
  });

  it("keeps an absent patch honestly unavailable instead of inventing content", () => {
    const { markup } = renderWithDiffs([
      { file: "src/absent.ts", additions: 2, deletions: 1, status: "added" },
    ]);

    expect(markup).toContain("src/absent.ts");
    expect(markup).toContain("Patch not provided");
    expect(markup).not.toContain("session-diff-line");
    expect(markup).not.toContain("session-diff-raw");
  });
});
