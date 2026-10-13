import type { ConnectionState } from "../shared/connection-state";

interface AppProps {
  connectionState: ConnectionState;
  onConnect: () => void;
  onDisconnect: () => void;
  onOpenExpanded: () => void;
}

export function App({
  connectionState,
  onConnect,
  onDisconnect,
  onOpenExpanded,
}: AppProps) {
  const status = getStatus(connectionState);
  const isConnected =
    connectionState.status === "connected" ||
    connectionState.status === "version-mismatch";
  const isConnecting = connectionState.status === "connecting";
  const isDisconnecting = connectionState.status === "disconnecting";
  const canStopManagedServer =
    connectionState.status === "error" && connectionState.owner === "managed";

  return (
    <main className="flex min-h-screen flex-col bg-canvas px-5 py-5 text-foreground sm:px-6">
      <header className="flex items-start justify-between gap-4 border-b border-divider pb-5">
        <div>
          <p className="mb-1 text-xs font-medium tracking-[0.14em] text-description uppercase">
            OpenCode Visual
          </p>
          <h1 className="m-0 text-xl font-semibold tracking-tight">OpenCode</h1>
        </div>

        <span
          aria-label={`Connection status: ${status.label}`}
          className="inline-flex items-center gap-2 rounded-full border border-divider px-3 py-1.5 text-xs text-description"
          role="status"
        >
          <span
            aria-hidden="true"
            className={`h-2 w-2 rounded-full ${status.indicatorClass}`}
          />
          {status.label}
        </span>
      </header>

      <section
        aria-labelledby="connection-title"
        className="flex flex-1 flex-col items-start justify-center gap-5 py-10"
      >
        <div
          aria-hidden="true"
          className="grid h-11 w-11 place-items-center rounded-md border border-divider text-description"
        >
          <svg fill="none" height="22" viewBox="0 0 22 22" width="22">
            <rect
              height="15"
              rx="2.5"
              stroke="currentColor"
              strokeWidth="1.5"
              width="18"
              x="2"
              y="3.5"
            />
            <path
              d="M2.75 7.5h16.5M7.5 8v10"
              stroke="currentColor"
              strokeWidth="1.5"
            />
          </svg>
        </div>

        <div className="max-w-md space-y-2">
          <h2
            className="m-0 text-base font-semibold leading-6"
            id="connection-title"
          >
            {status.title}
          </h2>
          <p className="m-0 text-sm leading-6 text-description">
            {status.message}
          </p>
          {connectionState.status === "disconnected" && (
            <p className="m-0 text-xs leading-5 text-description">
              Connect attaches to the configured URL. Otherwise it checks
              {" "}http://127.0.0.1:4096 and may start a managed server in a trusted workspace.
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {!isConnected && !isDisconnecting && !canStopManagedServer && (
            <button
              aria-label={isConnecting ? "Connecting to OpenCode" : "Connect to OpenCode"}
              className="inline-flex min-h-9 items-center gap-2 rounded-md bg-button px-3.5 py-2 text-sm font-medium text-button-foreground transition-colors hover:bg-button-hover disabled:cursor-wait disabled:opacity-70"
              disabled={isConnecting}
              onClick={onConnect}
              type="button"
            >
              {isConnecting
                ? connectionState.phase === "starting-managed"
                  ? "Starting managed server…"
                  : connectionState.phase === "verifying-managed"
                    ? "Checking managed server…"
                    : "Connecting…"
                : connectionState.status === "error"
                  ? "Retry connection"
                  : "Connect to OpenCode"}
            </button>
          )}
          {(isConnected || canStopManagedServer) && (
            <button
              className="inline-flex min-h-9 items-center rounded-md border border-divider px-3.5 py-2 text-sm font-medium transition-colors hover:bg-button-hover"
              onClick={onDisconnect}
              type="button"
            >
              {connectionState.status === "connected" ||
              connectionState.status === "version-mismatch"
                ? connectionState.owner === "managed"
                  ? "Stop managed server"
                  : "Disconnect"
                : "Stop managed server"}
            </button>
          )}
          {isDisconnecting && (
            <button
              aria-label="Stopping managed OpenCode server"
              className="inline-flex min-h-9 items-center rounded-md border border-divider px-3.5 py-2 text-sm font-medium opacity-70"
              disabled
              type="button"
            >
              Stopping managed server…
            </button>
          )}
          <button
            aria-label="Open OpenCode Visual in an expanded editor tab"
            className="inline-flex min-h-9 items-center gap-2 rounded-md border border-divider px-3.5 py-2 text-sm font-medium transition-colors hover:bg-button-hover"
            onClick={onOpenExpanded}
            type="button"
          >
            Open expanded view
            <svg
              aria-hidden="true"
              fill="none"
              height="14"
              viewBox="0 0 14 14"
              width="14"
            >
              <path
                d="M2.5 7h9m-4-4 4 4-4 4"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.4"
              />
            </svg>
          </button>
        </div>
      </section>

      <footer className="border-t border-divider pt-3 text-xs text-description">
        Health and version only · OpenCode 1.19.0 baseline · Managed servers use loopback
      </footer>
    </main>
  );
}

function getStatus(state: ConnectionState): {
  label: string;
  title: string;
  message: string;
  indicatorClass: string;
} {
  switch (state.status) {
    case "disconnected":
      return {
        label: "Not connected",
        title: "Connect to an OpenCode server",
        message:
          "This connection checks server health and version only. Chat, sessions, tools, and other operations are not available yet.",
        indicatorClass: "bg-description",
      };
    case "connecting":
      return {
        label: "Connecting",
        title:
          state.phase === "starting-managed"
            ? "Starting a managed OpenCode server"
            : state.phase === "verifying-managed"
              ? "Verifying the managed server"
              : "Checking OpenCode health",
        message:
          state.phase === "starting-managed"
            ? "No server was found at the local endpoint. Starting an extension-owned server on 127.0.0.1 for this workspace."
            : state.phase === "verifying-managed"
              ? `Checking health and version at ${state.serverUrl}. No chat request is sent.`
              : `Checking ${state.serverUrl}. No chat request is sent.`,
        indicatorClass: "animate-pulse bg-button",
      };
    case "disconnecting":
      return {
        label: "Stopping managed server",
        title: "Stopping the extension-owned server",
        message: `Waiting for the managed process at ${state.serverUrl} to exit.`,
        indicatorClass: "animate-pulse bg-description",
      };
    case "connected":
      return {
        label: "Connected",
        title: "Health check passed",
        message: `OpenCode ${state.version} is healthy at ${state.serverUrl}. ${state.owner === "managed" ? "This extension started and owns the server." : "This is an attached server; disconnect only detaches."} Health and version only; chat and sessions are not implemented.`,
        indicatorClass: "bg-button",
      };
    case "version-mismatch":
      return {
        label: "Version mismatch",
        title: "OpenCode version is not supported",
        message: `The server is healthy but reports ${state.actualVersion}. This extension targets ${state.expectedVersion}. ${state.owner === "managed" ? "The extension owns this managed process." : "The server is attached and will not be stopped on disconnect."}`,
        indicatorClass: "bg-description",
      };
    case "error":
      return {
        label: state.owner === "managed" ? "Managed server needs attention" : "Connection failed",
        title:
          state.reason === "server-stop"
            ? "Managed server shutdown needs attention"
            : "Could not connect to OpenCode",
        message: state.message,
        indicatorClass: "bg-description",
      };
  }
}
