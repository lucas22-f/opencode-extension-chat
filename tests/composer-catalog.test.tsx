import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { App } from "../src/webview/App";
import { initialChatState, type ChatState } from "../src/shared/chat-state";
import {
  initialCapabilityState,
  type CapabilityState,
  type CapabilityState as CapabilityStateType,
} from "../src/shared/capability-state";
import type { ConnectionState } from "../src/shared/connection-state";

type ComposerCatalogModule = typeof import("../src/webview/composer-catalog");

const connected: ConnectionState = {
  status: "connected",
  serverUrl: "http://127.0.0.1:4096",
  version: "1.19.0",
  owner: "attached",
};

let catalog: ComposerCatalogModule;

function renderApp(
  chatState: ChatState = initialChatState,
  capabilityState: CapabilityState = initialCapabilityState,
): string {
  return renderToStaticMarkup(
    createElement(App, {
      chatState,
      connectionState: connected,
      capabilityState,
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

describe("composer catalog on the public App surface", () => {
  it("exposes a visible composer-anchored trigger outside the Options disclosures", () => {
    const markup = renderApp({
      ...initialChatState,
      selectedSessionID: "ses_catalog",
      streamStatus: "connected",
    });

    const trigger = markup.indexOf("composer-catalog-trigger");
    expect(trigger).toBeGreaterThan(-1);
    expect(markup).toContain("Tools &amp; skills");
    expect(markup).toContain('aria-expanded="false"');

    // The trigger lives in the composer dock, not in a header toolbar and not
    // hidden only inside the closed Options disclosure.
    const optionsStart = markup.indexOf('<details class="composer-options">');
    const composerFooter = markup.indexOf('class="composer-footer"');
    expect(optionsStart).toBeGreaterThan(trigger);
    expect(trigger).toBeGreaterThan(composerFooter);

    // The searchable catalog panel is mounted outside the prompt form so its
    // search field can never nest forms or submit the prompt, and it starts closed.
    const formEnd = markup.indexOf("</form>", markup.indexOf('class="composer"'));
    const popoverStart = markup.indexOf('class="composer-catalog-popover"');
    expect(popoverStart).toBeGreaterThan(formEnd);
    expect(markup).toContain('class="composer-catalog-popover" hidden=""');
    expect(markup).toContain('id="composer-catalog-panel"');
    expect(markup).toContain('aria-label="Tools and skills catalog"');
  });

  it("keeps the composer footer trigger a plain button that cannot submit the prompt", () => {
    const markup = renderApp({
      ...initialChatState,
      selectedSessionID: "ses_catalog",
      streamStatus: "connected",
    });
    const triggerStart = markup.lastIndexOf("<button", markup.indexOf("composer-catalog-trigger"));
    const tagEnd = markup.indexOf(">", triggerStart);
    const tag = markup.slice(triggerStart, tagEnd);
    expect(tag).toContain('type="button"');
  });
});

describe("ComposerCatalog panel", () => {
  beforeAll(async () => {
    catalog = await import("../src/webview/composer-catalog");
  });

  const readyCatalog: CapabilityStateType = {
    ...initialCapabilityState,
    tools: {
      status: "ready",
      providerID: "anthropic",
      modelID: "claude-sonnet",
      tools: [
        {
          id: "read_file",
          description: "Read a file from the workspace.",
          parameters: "{}",
        },
        {
          id: "grep",
          description: "Search workspace files.",
          parameters: "{}",
        },
      ],
      error: null,
    },
    skills: {
      status: "ready",
      skills: [
        { name: "review", description: "Review recent changes." },
        { name: "refactor" },
      ],
      error: null,
    },
  };

  function renderCatalog({
    capabilityState = readyCatalog,
    selectedModel = { providerID: "anthropic", id: "claude-sonnet" },
    open = true,
  }: {
    capabilityState?: CapabilityStateType;
    selectedModel?: ChatState["selectedModel"];
    open?: boolean;
  } = {}): string {
    return renderToStaticMarkup(
      createElement(catalog.ComposerCatalog, {
        capabilityState,
        selectedModel,
        open,
        onOpenChange: vi.fn(),
        onLoadToolMetadata: vi.fn(),
        onLoadSkills: vi.fn(),
        onPrepareSkillReference: vi.fn(),
      }),
    );
  }

  it("renders one searchable metadata-only catalog for tools and skills", () => {
    const markup = renderCatalog();

    expect(markup).toContain('id="composer-catalog-search"');
    expect(markup).toContain('placeholder="Search tools and skills"');
    expect(markup).toContain('<label class="visually-hidden" for="composer-catalog-search">');

    // Tools render as metadata with no execution control of any kind.
    expect(markup).toContain("read_file");
    expect(markup).toContain("Read a file from the workspace.");
    expect(markup).not.toContain("Run /");
    expect(markup).not.toContain("Execute");

    // Skills render explicit prepare-reference buttons, never a run control.
    expect(markup).toContain("Prepare skill reference");
    expect(markup).toContain("Prepares an editable skill-reference note");
    expect(markup).toContain("does not run the skill");
  });

  it("shows honest selected-model scope and default-agent limitation for matching tool metadata", () => {
    const markup = renderCatalog();
    expect(markup).toContain("Scope:");
    expect(markup).toContain("anthropic/claude-sonnet");
    expect(markup).toContain("default agent");
  });

  it("never presents stale tool metadata as the current model scope", () => {
    const markup = renderCatalog({
      capabilityState: readyCatalog,
      selectedModel: { providerID: "openai", id: "gpx-4" },
    });
    expect(markup).toContain("Stored tool metadata is for anthropic/claude-sonnet");
    expect(markup).not.toContain(">read_file</code>");
    expect(markup).not.toContain("Scope: <code>anthropic/claude-sonnet</code>");
  });

  it("labels idle, loading, empty, and error tool states without pretending data exists", () => {
    const idle = renderCatalog({
      capabilityState: initialCapabilityState,
      selectedModel: { providerID: "anthropic", id: "claude-sonnet" },
    });
    expect(idle).toContain("Load tool metadata for anthropic/claude-sonnet");
    expect(idle).toContain("Load tools");

    const noModel = renderCatalog({
      capabilityState: initialCapabilityState,
      selectedModel: null,
    });
    expect(noModel).toContain("Select a server-reported model before loading tool metadata");

    const loading = renderCatalog({
      capabilityState: {
        ...readyCatalog,
        tools: { ...readyCatalog.tools, status: "loading" },
        skills: { ...readyCatalog.skills, status: "loading" },
      },
    });
    expect(loading).toContain("Loading tool metadata…");
    expect(loading).toContain("Loading skill metadata…");
    expect(loading).toContain("disabled");

    const empty = renderCatalog({
      capabilityState: {
        ...readyCatalog,
        tools: { ...readyCatalog.tools, tools: [] },
        skills: { ...readyCatalog.skills, skills: [] },
      },
    });
    expect(empty).toContain("OpenCode returned no tool metadata for this provider/model.");
    expect(empty).toContain("OpenCode returned no registered skills.");

    const failing = renderCatalog({
      capabilityState: {
        ...readyCatalog,
        tools: { ...readyCatalog.tools, status: "error", error: "Tool metadata request failed." },
        skills: { ...readyCatalog.skills, status: "error", error: "Skill request failed." },
      },
    });
    expect(failing).toContain('role="alert"');
    expect(failing).toContain("Tool metadata request failed.");
    expect(failing).toContain("Skill request failed.");
  });

  it("filters both tool and skill entries by name and description, case-insensitively", () => {
    const entries = [
      { name: "read_file", description: "Read a file from the workspace." },
      { name: "grep", description: "Search workspace files." },
      { name: "review", description: undefined },
    ];
    expect(catalog.filterCatalogEntries("", entries)).toHaveLength(3);
    expect(catalog.filterCatalogEntries("WORKSPACE", entries).map((entry) => entry.name)).toEqual([
      "read_file",
      "grep",
    ]);
    expect(catalog.filterCatalogEntries("review", entries).map((entry) => entry.name)).toEqual([
      "review",
    ]);
    expect(catalog.filterCatalogEntries("nothing-matches", entries)).toEqual([]);
  });
});
