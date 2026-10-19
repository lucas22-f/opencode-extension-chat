import type { CapabilityMcpServer, CapabilityState } from "../shared/capability-state";

export function McpControls({
  actionError,
  connectionGeneration,
  onChange,
  pendingServer,
  servers,
  status,
}: {
  actionError: string | null;
  connectionGeneration: number;
  onChange: (name: string, connect: boolean, generation: number) => void;
  pendingServer: string | null;
  servers: CapabilityMcpServer[];
  status: CapabilityState["mcp"]["status"];
}) {
  const disabled = status !== "ready" || pendingServer !== null;
  return (
    <>
      {actionError && <p className="capability-error" role="alert">{actionError}</p>}
      <ul className="capability-list">
        {servers.map((server) => {
          const pending = pendingServer === server.name;
          const connected = server.status === "connected";
          return (
            <li key={server.name} className="mcp-server-row">
              <span className="capability-item-name">{server.name}</span>
              <span className="capability-item-state">{pending ? "Updating…" : formatMcpStatus(server.status)}</span>
              <button
                aria-label={`Connect MCP server ${server.name}`}
                className="text-button mcp-action-button"
                disabled={disabled || pending || (connected && !pending)}
                onClick={createMcpActionCallback(onChange, server.name, true, connectionGeneration)}
                type="button"
              >
                {pending ? "Updating…" : "Connect"}
              </button>
              <button
                aria-label={`Disconnect MCP server ${server.name}`}
                className="text-button mcp-action-button"
                disabled={disabled || pending || !connected}
                onClick={createMcpActionCallback(onChange, server.name, false, connectionGeneration)}
                type="button"
              >
                {pending ? "Updating…" : "Disconnect"}
              </button>
              {(server.status === "needs_auth" || server.status === "needs_client_registration") && (
                <p className="capability-guidance mcp-auth-guidance">
                  {server.status === "needs_auth"
                    ? "Authentication is required. OpenCode Visual does not start OAuth automatically."
                    : "Client registration is required. OpenCode Visual does not start OAuth automatically."}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function createMcpActionCallback(
  onChange: (name: string, connect: boolean, generation: number) => void,
  name: string,
  connect: boolean,
  generation: number,
): () => void {
  return () => onChange(name, connect, generation);
}

function formatMcpStatus(status: CapabilityMcpServer["status"]): string {
  switch (status) {
    case "connected": return "Connected";
    case "disabled": return "Disabled";
    case "failed": return "Failed";
    case "needs_auth": return "Needs authentication";
    case "needs_client_registration": return "Needs client registration";
  }
}
