import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SERVER_URL,
  SUPPORTED_OPENCODE_VERSION,
} from "../src/shared/connection-state";
import {
  OpenCodeConnection,
  type HealthProbe,
  type HealthProbeResult,
} from "../src/extension/opencode-connection";
import type { ManagedServerHandle } from "../src/extension/managed-opencode-server";
import { ManagedServerLeaseError } from "../src/extension/managed-server-lease";
import { DiagnosticsRecorder } from "../src/extension/diagnostics";

const WORKSPACE = "C:\\workspace with spaces\\opencode-ñ";
const MANAGED_URL = "http://127.0.0.1:43123";

describe("OpenCode health connection", () => {
  it("runs an isolated health-only check without starting or changing connection state", async () => {
    const diagnostics = new DiagnosticsRecorder();
    const probe: HealthProbe = vi.fn(async (): Promise<HealthProbeResult> => ({
      kind: "healthy",
      version: SUPPORTED_OPENCODE_VERSION,
    }));
    const managedFactory = vi.fn(() => createManagedServer());
    const connection = new OpenCodeConnection(probe, managedFactory, diagnostics);

    await expect(connection.checkHealth("https://opencode.example:4096")).resolves.toEqual({
      kind: "healthy",
      version: SUPPORTED_OPENCODE_VERSION,
    });

    expect(probe).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledWith(
      "https://opencode.example:4096",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(managedFactory).not.toHaveBeenCalled();
    expect(connection.state).toEqual({ status: "disconnected" });
    expect(diagnostics.getTranscript()).toContain('"mode":"health-only"');
    expect(diagnostics.getTranscript()).toContain('"outcome":"healthy"');
  });

  it("attaches to the explicitly configured URL without acquiring shutdown authority", async () => {
    const probe: HealthProbe = vi.fn(
      async (): Promise<HealthProbeResult> => ({
        kind: "healthy",
        version: SUPPORTED_OPENCODE_VERSION,
      }),
    );
    const managedFactory = vi.fn(() => createManagedServer());
    const connection = new OpenCodeConnection(probe, managedFactory);
    const states: string[] = [];
    connection.subscribe((state) => states.push(state.status));

    const state = await connection.connect("http://opencode.example:4096/");

    expect(probe).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledWith(
      "http://opencode.example:4096",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(managedFactory).not.toHaveBeenCalled();
    expect(state).toEqual({
      status: "connected",
      serverUrl: "http://opencode.example:4096",
      version: "1.19.0",
      owner: "attached",
    });
    expect(states).toEqual(["disconnected", "connecting", "connected"]);

    await connection.disconnect();
    expect(connection.state).toEqual({ status: "disconnected" });
  });

  it("starts a managed server only after the single default loopback probe has no response", async () => {
    const probe: HealthProbe = vi.fn(async (url): Promise<HealthProbeResult> =>
      url === DEFAULT_SERVER_URL
        ? { kind: "unreachable" }
        : { kind: "healthy", version: SUPPORTED_OPENCODE_VERSION },
    );
    const managedServer = createManagedServer();
    const managedFactory = vi.fn(() => managedServer);
    const connection = new OpenCodeConnection(probe, managedFactory);

    const state = await connection.connect("", {
      directory: WORKSPACE,
      trusted: true,
    });

    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenNthCalledWith(
      1,
      DEFAULT_SERVER_URL,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(managedFactory).toHaveBeenCalledWith(WORKSPACE);
    expect(managedServer.start).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenNthCalledWith(
      2,
      MANAGED_URL,
      expect.objectContaining({ directory: WORKSPACE }),
    );
    expect(state).toEqual({
      status: "connected",
      serverUrl: MANAGED_URL,
      version: SUPPORTED_OPENCODE_VERSION,
      owner: "managed",
    });

    await connection.disconnect();
    expect(managedServer.dispose).toHaveBeenCalledOnce();
    expect(connection.state).toEqual({ status: "disconnected" });
  });

  it("surfaces a workspace lease conflict instead of a generic startup error", async () => {
    const busyMessage =
      "Another extension host is starting or owns a managed OpenCode server for this workspace.";
    const managedServer = createManagedServer();
    managedServer.start.mockRejectedValue(new ManagedServerLeaseError(busyMessage));
    managedServer.isRunning = () => false;
    const connection = new OpenCodeConnection(
      async () => ({ kind: "unreachable" }),
      () => managedServer,
    );

    const state = await connection.connect("", {
      directory: WORKSPACE,
      trusted: true,
    });

    expect(state).toMatchObject({
      status: "error",
      reason: "server-start",
      message: busyMessage,
    });
    expect(managedServer.start).toHaveBeenCalledOnce();
  });

  it("attaches to a healthy default loopback server without starting or owning it", async () => {
    const probe = vi.fn(async (): Promise<HealthProbeResult> => ({
      kind: "healthy",
      version: SUPPORTED_OPENCODE_VERSION,
    }));
    const managedFactory = vi.fn(() => createManagedServer());
    const connection = new OpenCodeConnection(probe, managedFactory);

    const state = await connection.connect("", {
      directory: WORKSPACE,
      trusted: true,
    });
    await connection.disconnect();

    expect(probe).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledWith(
      DEFAULT_SERVER_URL,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(managedFactory).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      status: "connected",
      owner: "attached",
      serverUrl: DEFAULT_SERVER_URL,
    });
  });

  it("does not start a managed server for an unreachable configured URL", async () => {
    const managedFactory = vi.fn(() => createManagedServer());
    const connection = new OpenCodeConnection(
      async () => ({ kind: "unreachable" }),
      managedFactory,
    );

    const state = await connection.connect("https://opencode.example");

    expect(state).toMatchObject({
      status: "error",
      reason: "unreachable",
      serverUrl: "https://opencode.example",
    });
    expect(managedFactory).not.toHaveBeenCalled();
  });

  it("refuses managed startup in an untrusted workspace", async () => {
    const managedFactory = vi.fn(() => createManagedServer());
    const connection = new OpenCodeConnection(
      async () => ({ kind: "unreachable" }),
      managedFactory,
    );

    const state = await connection.connect("", {
      directory: WORKSPACE,
      trusted: false,
    });

    expect(state).toMatchObject({ status: "error", reason: "workspace-untrusted" });
    expect(managedFactory).not.toHaveBeenCalled();
  });

  it("requires a workspace directory before managed startup", async () => {
    const managedFactory = vi.fn(() => createManagedServer());
    const connection = new OpenCodeConnection(
      async () => ({ kind: "unreachable" }),
      managedFactory,
    );

    const state = await connection.connect("", { trusted: true });

    expect(state).toMatchObject({ status: "error", reason: "workspace-required" });
    expect(managedFactory).not.toHaveBeenCalled();
  });

  it("does not start a managed server when the default endpoint responds unexpectedly", async () => {
    const managedFactory = vi.fn(() => createManagedServer());
    const connection = new OpenCodeConnection(
      async () => ({ kind: "unexpected-response", status: 503 }),
      managedFactory,
    );

    const state = await connection.connect("", {
      directory: WORKSPACE,
      trusted: true,
    });

    expect(state).toMatchObject({
      status: "error",
      reason: "unexpected-response",
    });
    expect(managedFactory).not.toHaveBeenCalled();
  });

  it("reports a healthy but unsupported attached server version", async () => {
    const connection = new OpenCodeConnection(
      async () => ({ kind: "healthy", version: "2.0.0" }),
    );

    await expect(connection.connect("https://opencode.example")).resolves.toEqual(
      {
        status: "version-mismatch",
        serverUrl: "https://opencode.example",
        actualVersion: "2.0.0",
        expectedVersion: SUPPORTED_OPENCODE_VERSION,
        owner: "attached",
      },
    );
  });

  it("stops a managed process when its health validation fails", async () => {
    const managedServer = createManagedServer();
    const probe: HealthProbe = vi.fn(async (url): Promise<HealthProbeResult> =>
      url === DEFAULT_SERVER_URL
        ? { kind: "unreachable" }
        : { kind: "authentication-required" },
    );
    const connection = new OpenCodeConnection(probe, () => managedServer);

    const state = await connection.connect("", {
      directory: WORKSPACE,
      trusted: true,
    });

    expect(managedServer.dispose).toHaveBeenCalledOnce();
    expect(state).toMatchObject({
      status: "error",
      reason: "authentication-required",
    });
    expect(connection.state).toEqual(state);
  });

  it("retains a stop action when managed-process cleanup cannot be confirmed", async () => {
    const managedServer = createManagedServer();
    managedServer.dispose.mockRejectedValue(new Error("stop failed"));
    const probe: HealthProbe = vi.fn(async (url): Promise<HealthProbeResult> =>
      url === DEFAULT_SERVER_URL
        ? { kind: "unreachable" }
        : { kind: "healthy", version: SUPPORTED_OPENCODE_VERSION },
    );
    const connection = new OpenCodeConnection(probe, () => managedServer);

    await connection.connect("", { directory: WORKSPACE, trusted: true });
    await connection.disconnect();

    expect(connection.state).toMatchObject({
      status: "error",
      reason: "server-stop",
      owner: "managed",
    });
    expect(connection.state.status === "error" && connection.state.message).toContain(
      "Retry stopping",
    );
    await expect(connection.dispose()).rejects.toThrow("Retry stopping");
    expect(managedServer.dispose).toHaveBeenCalledTimes(2);
  });

  it("stops on an authentication challenge without requesting credentials", async () => {
    const probe: HealthProbe = vi.fn(
      async (): Promise<HealthProbeResult> => ({
        kind: "authentication-required",
      }),
    );
    const connection = new OpenCodeConnection(probe);

    const state = await connection.connect("http://127.0.0.1:9000");

    expect(probe).toHaveBeenCalledOnce();
    expect(state).toMatchObject({
      status: "error",
      reason: "authentication-required",
    });
    expect(state.status === "error" && state.message).toContain(
      "does not collect or send credentials",
    );
  });

  it("surfaces bounded health timeouts as an actionable connection state", async () => {
    const connection = new OpenCodeConnection(
      async () => ({ kind: "timeout" }),
    );

    const state = await connection.connect("http://127.0.0.1:4096");

    expect(state).toMatchObject({ status: "error", reason: "timeout" });
    expect(state.status === "error" && state.message).toContain("4 seconds");
  });

  it("rejects credential-bearing and non-root URLs before making a request", async () => {
    const probe: HealthProbe = vi.fn(
      async (): Promise<HealthProbeResult> => ({ kind: "unreachable" }),
    );
    const connection = new OpenCodeConnection(probe);

    const state = await connection.connect("http://user:placeholder@localhost:4096/api");

    expect(state).toMatchObject({ status: "error", reason: "configuration" });
    expect(probe).not.toHaveBeenCalled();
  });

  it("detaches from an attached server without attempting a shutdown", async () => {
    const probe: HealthProbe = vi.fn(
      async (): Promise<HealthProbeResult> => ({
        kind: "healthy",
        version: SUPPORTED_OPENCODE_VERSION,
      }),
    );
    const managedServer = createManagedServer();
    const managedFactory = vi.fn(() => managedServer);
    const connection = new OpenCodeConnection(probe, managedFactory);

    await connection.connect("http://127.0.0.1:4096");
    await connection.disconnect();

    expect(connection.state).toEqual({ status: "disconnected" });
    expect(probe).toHaveBeenCalledOnce();
    expect(managedFactory).not.toHaveBeenCalled();
    expect(managedServer.dispose).not.toHaveBeenCalled();
  });

  it("does not let an older in-flight health response overwrite a disconnect", async () => {
    let completeProbe!: (result: HealthProbeResult) => void;
    const probe: HealthProbe = vi.fn(
      () =>
        new Promise<HealthProbeResult>((resolve) => {
          completeProbe = resolve;
        }),
    );
    const connection = new OpenCodeConnection(probe);
    const pending = connection.connect();

    await connection.disconnect();
    completeProbe({ kind: "healthy", version: SUPPORTED_OPENCODE_VERSION });
    await pending;

    expect(connection.state).toEqual({ status: "disconnected" });
  });
});

function createManagedServer(): ManagedServerHandle & {
  start: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
} {
  return {
    url: MANAGED_URL,
    isRunning: () => true,
    start: vi.fn(async () => MANAGED_URL),
    dispose: vi.fn(async () => undefined),
  };
}
