import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/webview/App";
import {
  initialConnectionState,
  type ConnectionState,
} from "../src/shared/connection-state";
import { dispatchExtensionMessage } from "../src/shared/webview-message";

describe("the health-only connection Webview", () => {
  it("starts disconnected and exposes the real connect action without fake product controls", () => {
    const markup = render(initialConnectionState);

    expect(markup).toContain("Not connected");
    expect(markup).toContain("Connect to an OpenCode server");
    expect(markup).toContain('aria-label="Connect to OpenCode"');
    expect(markup).toContain("Open expanded view");
    expect(markup).toContain("127.0.0.1:4096");
    expect(markup).toContain("Chat, sessions, tools, and other operations are not available yet.");
    expect(markup).not.toMatch(/New chat|History|Send message|Select model|Run tool/);
  });

  it("renders a host-published health and version update", () => {
    let connectionState: ConnectionState = initialConnectionState;
    const updated = dispatchExtensionMessage(
      {
        type: "connection-state",
        state: {
          status: "connected",
          serverUrl: "http://127.0.0.1:4096",
          version: "1.19.0",
          owner: "attached",
        },
      },
      (state) => {
        connectionState = state;
      },
    );

    expect(updated).toBe(true);
    expect(render(connectionState)).toContain(
      "OpenCode 1.19.0 is healthy at http://127.0.0.1:4096.",
    );
    expect(render(connectionState)).toContain(
      "This is an attached server; disconnect only detaches.",
    );
  });

  it("renders server version mismatches as a distinct state", () => {
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

  it("shows managed startup progress and a stop action only for an owned process", () => {
    const markup = render({
      status: "connecting",
      serverUrl: "http://127.0.0.1:4096",
      phase: "starting-managed",
    });

    expect(markup).toContain("Starting a managed OpenCode server");
    expect(markup).toContain("Starting managed server…");
  });

  it("offers a stop action when cleanup of an owned process needs attention", () => {
    const markup = render({
      status: "error",
      serverUrl: "http://127.0.0.1:43123",
      reason: "server-stop",
      message: "Retry stopping the managed server.",
      owner: "managed",
    });

    expect(markup).toContain("Stop managed server");
    expect(markup).toContain("Managed server shutdown needs attention");
  });
});

function render(connectionState: ConnectionState): string {
  return renderToStaticMarkup(
    createElement(App, {
      connectionState,
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
      onOpenExpanded: vi.fn(),
    }),
  );
}
