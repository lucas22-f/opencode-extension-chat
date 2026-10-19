import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CommandMenu } from "../src/webview/command-menu";

describe("command catalog menu", () => {
  it("renders searchable sanitized commands and an explicit run control for a prepared command", () => {
    const markup = renderToStaticMarkup(createElement(CommandMenu, {
      commands: [{ name: "review", description: "Review changes." }],
      status: "ready",
      error: null,
      draft: "/review inspect this",
      onDraftChange: vi.fn(),
      onLoad: vi.fn(),
      onRun: vi.fn(),
      disabled: false,
    }));
    expect(markup).toContain('aria-label="OpenCode commands"');
    expect(markup).toContain('placeholder="Search commands"');
    expect(markup).toContain("Review changes.");
    expect(markup).toContain("Run /review");
  });

  it("does not offer execution for an unrecognized slash command", () => {
    const markup = renderToStaticMarkup(createElement(CommandMenu, {
      commands: [{ name: "review" }],
      status: "ready",
      error: null,
      draft: "/private-command argument",
      onDraftChange: vi.fn(),
      onLoad: vi.fn(),
      onRun: vi.fn(),
      disabled: false,
    }));
    expect(markup).not.toContain("Run /private-command");
  });
});
