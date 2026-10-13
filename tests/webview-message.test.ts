import { describe, expect, it, vi } from "vitest";
import {
  dispatchExtensionMessage,
  dispatchWebviewMessage,
} from "../src/shared/webview-message";

describe("webview action protocol", () => {
  it.each([
    ["open-expanded", "openExpanded"],
    ["webview-ready", "webviewReady"],
    ["connect", "connect"],
    ["disconnect", "disconnect"],
  ] as const)("dispatches the supported %s action", (type, actionName) => {
    const actions = {
      openExpanded: vi.fn(),
      webviewReady: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    };

    expect(dispatchWebviewMessage({ type }, actions)).toBe(true);
    expect(actions[actionName]).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    { type: "run-command", command: "workbench.action.openSettings" },
    { type: "connect", extra: true },
  ])("rejects malformed actions without dispatching: %j", (message) => {
    const actions = {
      openExpanded: vi.fn(),
      webviewReady: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
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
        updateConnectionState,
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
        updateConnectionState,
      ),
    ).toBe(false);
    expect(updateConnectionState).not.toHaveBeenCalled();
  });
});
