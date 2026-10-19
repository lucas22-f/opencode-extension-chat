import { useMemo, useState } from "react";
import type { CapabilityState } from "../shared/capability-state";

export function CommandMenu({
  commands,
  status,
  error,
  draft,
  onDraftChange,
  onLoad,
  onRun,
  disabled,
}: {
  commands: CapabilityState["commands"]["commands"];
  status: CapabilityState["commands"]["status"];
  error: string | null;
  draft: string;
  onDraftChange: (value: string) => void;
  onLoad: () => void;
  onRun: (name: string, args: string) => void;
  disabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return commands.filter((command) =>
      !normalized || `${command.name} ${command.description ?? ""}`.toLocaleLowerCase().includes(normalized),
    );
  }, [commands, query]);
  const candidate = commands.find((command) => {
    const match = new RegExp(`^/${escapeRegExp(command.name)}(?:\\s+([\\s\\S]*))?$`).exec(draft.trim());
    return match !== null;
  });
  const args = candidate
    ? new RegExp(`^/${escapeRegExp(candidate.name)}(?:\\s+([\\s\\S]*))?$`).exec(draft.trim())?.[1] ?? ""
    : "";

  return (
    <section className="command-menu" aria-label="OpenCode commands">
      <div className="command-menu-heading">
        <strong>Commands</strong>
        <button className="text-button" type="button" disabled={status === "loading"} onClick={onLoad}>
          {status === "loading" ? "Loading…" : "Refresh commands"}
        </button>
      </div>
      <label className="visually-hidden" htmlFor="command-search">Search commands</label>
      <input id="command-search" type="search" value={query} placeholder="Search commands" onChange={(event) => setQuery(event.currentTarget.value)} />
      {error && <p role="alert">{error}</p>}
      {status === "idle" && <p role="status">Load the server command catalog to begin.</p>}
      {status === "ready" && filtered.length === 0 && <p role="status">No commands match this search.</p>}
      {status === "ready" && filtered.length > 0 && (
        <ul className="command-list">
          {filtered.map((command) => (
            <li key={command.name}>
              <button type="button" onClick={() => onDraftChange(`/${command.name} `)}>
                <code>/{command.name}</code>{command.description && <span>{command.description}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {candidate && (
        <button className="command-run-button" type="button" disabled={disabled || status !== "ready"} onClick={() => onRun(candidate.name, args)}>
          {status === "loading" ? "Running…" : `Run /${candidate.name}`}
        </button>
      )}
    </section>
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
