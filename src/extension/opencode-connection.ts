import {
  createOpencodeClient,
  type GlobalHealthResponse,
} from "@opencode-ai/sdk/v2/client";
import {
  DEFAULT_SERVER_URL,
  SUPPORTED_OPENCODE_VERSION,
  type ConnectionState,
} from "../shared/connection-state";
import {
  ManagedOpenCodeServer,
  ManagedServerError,
  type ManagedServerHandle,
} from "./managed-opencode-server";

export const HEALTH_CHECK_TIMEOUT_MS = 4_000;

type SupportedHealthResponse = Extract<
  GlobalHealthResponse,
  { healthy: true }
>;

export type HealthProbeResult =
  | { kind: "healthy"; version: string }
  | { kind: "authentication-required" }
  | { kind: "unreachable" }
  | { kind: "timeout" }
  | { kind: "invalid-response" }
  | { kind: "unexpected-response"; status?: number };

export interface HealthProbeOptions {
  timeoutMs?: number;
  directory?: string;
  signal?: AbortSignal;
}

export type HealthProbe = (
  serverUrl: string,
  options?: HealthProbeOptions,
) => Promise<HealthProbeResult>;

export async function probeOpenCodeHealth(
  serverUrl: string,
  options: HealthProbeOptions = {},
): Promise<HealthProbeResult> {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([timeoutSignal, options.signal])
    : timeoutSignal;
  let responseStatus: number | undefined;
  const client = createOpencodeClient({
    baseUrl: serverUrl,
    redirect: "error",
    ...(options.directory ? { directory: options.directory } : {}),
    fetch: async (request) => {
      const response = await fetch(new Request(request, { redirect: "manual" }));
      responseStatus = response.status;
      return response;
    },
  });

  try {
    const result = await client.global.health({ signal });
    const status = result.response?.status;

    if (status === 401 || status === 403) {
      return { kind: "authentication-required" };
    }
    if (signal.aborted) {
      return { kind: "timeout" };
    }
    if (!result.response) {
      return responseStatus === undefined
        ? { kind: "unreachable" }
        : { kind: "unexpected-response", status: responseStatus };
    }
    if (status !== 200 || result.error !== undefined) {
      return { kind: "unexpected-response", status };
    }
    if (!isSupportedHealthResponse(result.data)) {
      return { kind: "invalid-response" };
    }

    return { kind: "healthy", version: result.data.version };
  } catch {
    if (signal.aborted) return { kind: "timeout" };
    if (responseStatus === 401 || responseStatus === 403) {
      return { kind: "authentication-required" };
    }
    return responseStatus === undefined
      ? { kind: "unreachable" }
      : { kind: "unexpected-response", status: responseStatus };
  }
}

export interface ConnectionWorkspace {
  directory?: string;
  trusted?: boolean;
}

export type ManagedServerFactory = (directory: string) => ManagedServerHandle;

export class OpenCodeConnection {
  private currentState: ConnectionState = { status: "disconnected" };
  private attempt = 0;
  private readonly listeners = new Set<(state: ConnectionState) => void>();
  private activeAbortController: AbortController | undefined;
  private managedServer: ManagedServerHandle | undefined;

  constructor(
    private readonly healthProbe: HealthProbe = probeOpenCodeHealth,
    private readonly managedServerFactory: ManagedServerFactory = (directory) =>
      new ManagedOpenCodeServer(directory),
  ) {}

  get state(): ConnectionState {
    return this.currentState;
  }

  subscribe(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.currentState);
    return () => this.listeners.delete(listener);
  }

  async connect(
    configuredServerUrl?: unknown,
    workspace: ConnectionWorkspace = {},
  ): Promise<ConnectionState> {
    if (this.managedServer) return this.currentState;

    const attempt = ++this.attempt;
    this.activeAbortController?.abort();
    const controller = new AbortController();
    this.activeAbortController = controller;
    let target: ConnectionTarget;

    try {
      target = resolveConnectionTarget(configuredServerUrl);
    } catch {
      const state: ConnectionState = {
        status: "error",
        reason: "configuration",
        message:
          "Set opencodeVisual.serverUrl to an HTTP(S) server URL without credentials, path, query, or fragment.",
      };
      this.setState(state);
      if (this.activeAbortController === controller) {
        this.activeAbortController = undefined;
      }
      return state;
    }

    try {
      this.setState({
        status: "connecting",
        serverUrl: target.serverUrl,
        phase: "checking",
      });

      let result = await this.probe(target.serverUrl, controller.signal);
      if (attempt !== this.attempt) return this.currentState;

      if (target.source === "local-default" && result.kind === "unreachable") {
        if (workspace.trusted !== true) {
          const state: ConnectionState = {
            status: "error",
            serverUrl: target.serverUrl,
            reason: "workspace-untrusted",
            message:
              "No server responded at the local endpoint. Trust the workspace before starting a managed OpenCode server.",
          };
          this.setState(state);
          return state;
        }
        if (!workspace.directory) {
          const state: ConnectionState = {
            status: "error",
            serverUrl: target.serverUrl,
            reason: "workspace-required",
            message:
              "No server responded at the local endpoint. Open a workspace before starting a managed OpenCode server.",
          };
          this.setState(state);
          return state;
        }

        const managedServer = this.managedServerFactory(workspace.directory);
        this.managedServer = managedServer;
        this.setState({
          status: "connecting",
          serverUrl: target.serverUrl,
          phase: "starting-managed",
        });

        let managedUrl: string;
        try {
          managedUrl = await managedServer.start(controller.signal);
        } catch (error) {
          if (attempt !== this.attempt) return this.currentState;
          const processStillOwned = managedServer.isRunning();
          if (!processStillOwned) this.managedServer = undefined;
          const state: ConnectionState = {
            status: "error",
            serverUrl: managedServer.url ?? target.serverUrl,
            reason: "server-start",
            message: processStillOwned
              ? "Managed OpenCode startup failed, and its extension-owned process is still running. Stop it before retrying."
              : error instanceof ManagedServerError
                ? error.message
                : "Managed OpenCode could not be started safely.",
            ...(processStillOwned ? { owner: "managed" as const } : {}),
          };
          this.setState(state);
          return state;
        }

        if (attempt !== this.attempt) return this.currentState;
        this.setState({
          status: "connecting",
          serverUrl: managedUrl,
          phase: "verifying-managed",
        });
        result = await this.probe(managedUrl, controller.signal, workspace.directory);
        if (attempt !== this.attempt) return this.currentState;

        if (result.kind !== "healthy") {
          try {
            await managedServer.dispose();
            this.managedServer = undefined;
          } catch {
            const state: ConnectionState = {
              status: "error",
              serverUrl: managedUrl,
              reason: "server-stop",
              message:
                "The managed server did not pass health validation, and cleanup of its extension-owned process could not be confirmed.",
              ...(managedServer.isRunning() ? { owner: "managed" as const } : {}),
            };
            if (!managedServer.isRunning()) this.managedServer = undefined;
            this.setState(state);
            return state;
          }
          const state = resultToError(result, managedUrl);
          this.setState(state);
          return state;
        }

        const state = healthyConnectionState(result.version, managedUrl, "managed");
        this.setState(state);
        return state;
      }

      if (result.kind !== "healthy") {
        const state = resultToError(result, target.serverUrl, target.source);
        this.setState(state);
        return state;
      }

      const state = healthyConnectionState(
        result.version,
        target.serverUrl,
        "attached",
      );
      this.setState(state);
      return state;
    } catch {
      if (attempt !== this.attempt) return this.currentState;
      const state: ConnectionState = {
        status: "error",
        serverUrl: target.serverUrl,
        reason: "unreachable",
        message: `No OpenCode health response came from ${target.serverUrl}.`,
      };
      this.setState(state);
      return state;
    } finally {
      if (this.activeAbortController === controller) {
        this.activeAbortController = undefined;
      }
    }
  }

  async disconnect(): Promise<void> {
    const attempt = ++this.attempt;
    this.activeAbortController?.abort();
    this.activeAbortController = undefined;
    const managedServer = this.managedServer;
    if (!managedServer) {
      this.setState({ status: "disconnected" });
      return;
    }

    const serverUrl = managedServer.url ?? getStateServerUrl(this.currentState);
    this.setState({ status: "disconnecting", serverUrl, owner: "managed" });
    try {
      await managedServer.dispose();
    } catch {
      const processStillOwned = managedServer.isRunning();
      if (!processStillOwned) this.managedServer = undefined;
      this.setState({
        status: "error",
        serverUrl,
        reason: "server-stop",
        message: processStillOwned
          ? "Could not confirm that the extension-owned OpenCode process stopped. Retry stopping the managed server."
          : "The owned process exited, but its process-tree shutdown could not be confirmed.",
        ...(processStillOwned ? { owner: "managed" } : {}),
      });
      return;
    }

    if (this.managedServer === managedServer) this.managedServer = undefined;
    if (attempt === this.attempt) this.setState({ status: "disconnected" });
  }

  async dispose(): Promise<void> {
    await this.disconnect();
    if (
      this.currentState.status === "error" &&
      this.currentState.reason === "server-stop"
    ) {
      throw new ManagedServerError(this.currentState.message);
    }
  }

  private async probe(
    serverUrl: string,
    signal: AbortSignal,
    directory?: string,
  ): Promise<HealthProbeResult> {
    try {
      return await this.healthProbe(serverUrl, {
        signal,
        ...(directory ? { directory } : {}),
      });
    } catch {
      return { kind: "unreachable" };
    }
  }

  private setState(state: ConnectionState): void {
    this.currentState = state;
    for (const listener of this.listeners) listener(state);
  }
}

function healthyConnectionState(
  version: string,
  serverUrl: string,
  owner: "attached" | "managed",
): ConnectionState {
  return version === SUPPORTED_OPENCODE_VERSION
    ? { status: "connected", serverUrl, version, owner }
    : {
        status: "version-mismatch",
        serverUrl,
        actualVersion: version,
        expectedVersion: SUPPORTED_OPENCODE_VERSION,
        owner,
      };
}

function resultToError(
  result: Exclude<HealthProbeResult, { kind: "healthy" }>,
  serverUrl: string,
  source?: ConnectionTarget["source"],
): ConnectionState {
  switch (result.kind) {
    case "authentication-required":
      return {
        status: "error",
        serverUrl,
        reason: "authentication-required",
        message:
          "The server requires authentication. This health-only connection does not collect or send credentials.",
      };
    case "timeout":
      return {
        status: "error",
        serverUrl,
        reason: "timeout",
        message: `The health check timed out after ${HEALTH_CHECK_TIMEOUT_MS / 1_000} seconds.`,
      };
    case "unreachable":
      return {
        status: "error",
        serverUrl,
        reason: "unreachable",
        message:
          source === "configured"
            ? `No OpenCode health response came from ${serverUrl}. Check the configured server URL.`
            : `No OpenCode health response came from ${serverUrl}.`,
      };
    case "invalid-response":
      return {
        status: "error",
        serverUrl,
        reason: "invalid-response",
        message: `The server at ${serverUrl} did not return the pinned OpenCode health response.`,
      };
    case "unexpected-response":
      return {
        status: "error",
        serverUrl,
        reason: "unexpected-response",
        message: result.status
          ? `The server at ${serverUrl} returned HTTP ${result.status}, not a successful OpenCode health response.`
          : `The server at ${serverUrl} returned an unexpected OpenCode health response.`,
      };
  }
}

function getStateServerUrl(state: ConnectionState): string {
  return "serverUrl" in state
    ? state.serverUrl ?? DEFAULT_SERVER_URL
    : DEFAULT_SERVER_URL;
}

interface ConnectionTarget {
  serverUrl: string;
  source: "configured" | "local-default";
}

function resolveConnectionTarget(configuredServerUrl: unknown): ConnectionTarget {
  if (configuredServerUrl === undefined || configuredServerUrl === "") {
    return { serverUrl: DEFAULT_SERVER_URL, source: "local-default" };
  }
  if (typeof configuredServerUrl !== "string") {
    throw new Error("Invalid server URL setting.");
  }

  const value = configuredServerUrl.trim();
  if (!value || value !== configuredServerUrl) {
    throw new Error("Invalid server URL setting.");
  }

  const parsed = new URL(value);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new Error("Invalid server URL setting.");
  }

  return { serverUrl: parsed.origin, source: "configured" };
}

function isSupportedHealthResponse(
  value: unknown,
): value is SupportedHealthResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "healthy" in value &&
    value.healthy === true &&
    "version" in value &&
    typeof value.version === "string"
  );
}
