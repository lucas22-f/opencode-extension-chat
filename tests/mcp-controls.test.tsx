import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { McpControls, createMcpActionCallback } from "../src/webview/mcp-controls";

const servers = [
  { name: "connected-mcp", status: "connected" as const },
  { name: "login-mcp", status: "needs_auth" as const },
];

describe("MCP controls", () => {
  it("shows explicit controls and honest authentication guidance", () => {
    const markup = renderToStaticMarkup(createElement(McpControls, {
      actionError: null,
      connectionGeneration: 3,
      onChange: vi.fn(),
      pendingServer: null,
      servers,
      status: "ready",
    }));
    expect(markup).toContain("connected-mcp");
    expect(markup).toContain("Disconnect");
    expect(markup).toContain('aria-label="Disconnect MCP server connected-mcp"');
    expect(markup).toContain('aria-label="Connect MCP server login-mcp"');
    expect(markup).toContain("Connect");
    expect(markup).toContain("Authentication is required");
    expect(markup).toContain("does not start OAuth automatically");
  });

  it("disables all actions while a mutation is pending and exposes sanitized errors", () => {
    const markup = renderToStaticMarkup(createElement(McpControls, {
      actionError: "Could not confirm the MCP server change.",
      connectionGeneration: 3,
      onChange: vi.fn(),
      pendingServer: "login-mcp",
      servers,
      status: "ready",
    }));
    expect(markup.match(/disabled=""/g)).toHaveLength(4);
    expect(markup).toContain('role="alert"');
    expect(markup).not.toContain("raw");
  });

  it("invokes the same named-server callback supplied to the visible action", () => {
    const onChange = vi.fn();
    createMcpActionCallback(onChange, "server/with space", false, 3)();
    expect(onChange).toHaveBeenCalledExactlyOnceWith("server/with space", false, 3);
  });
});
