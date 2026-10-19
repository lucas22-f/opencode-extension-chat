import { useState, type ReactNode } from "react";
import type { CapabilityState } from "../shared/capability-state";
import type { ChatState } from "../shared/chat-state";

export type CatalogEntry = { name: string; description?: string };

export type CatalogSearchable = { name?: string; id?: string; description?: string };

/**
 * Case-insensitive catalog search over server-returned names/ids and
 * descriptions. Pure so the UI cannot widen the match beyond metadata.
 */
export function filterCatalogEntries<T extends CatalogSearchable>(
  query: string,
  entries: T[],
): T[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return entries;
  return entries.filter((entry) =>
    `${entry.name ?? entry.id ?? ""} ${entry.description ?? ""}`
      .toLocaleLowerCase()
      .includes(normalized),
  );
}

/**
 * Compact composer-anchored tools + skills navigation over the existing
 * validated capability state. Metadata only: there is no run/execute
 * control here. Tool metadata reflects the experimental server endpoint
 * scoped to the selected model's server default agent; skills prepare an
 * editable quoted reference in the existing draft through the parent.
 */
export function ComposerCatalog({
  capabilityState,
  selectedModel,
  open,
  onOpenChange,
  onLoadToolMetadata,
  onLoadSkills,
  onPrepareSkillReference,
}: {
  capabilityState: CapabilityState;
  selectedModel: ChatState["selectedModel"];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLoadToolMetadata: () => void;
  onLoadSkills: () => void;
  onPrepareSkillReference: (skill: CatalogEntry) => void;
}): ReactNode {
  const [query, setQuery] = useState("");

  // Mirrors the validated CapabilityInventory scope rule: metadata captured
  // for a different provider/model is never presented as current scope.
  const toolScopeMatches = Boolean(
    selectedModel &&
    capabilityState.tools.providerID === selectedModel.providerID &&
    capabilityState.tools.modelID === selectedModel.id,
  );
  const staleTools =
    !toolScopeMatches && capabilityState.tools.providerID !== null
      ? capabilityState.tools
      : null;
  const tools = toolScopeMatches
    ? capabilityState.tools
    : {
        status: "idle" as const,
        providerID: null,
        modelID: null,
        tools: [],
        error: null,
      };
  const filteredTools = filterCatalogEntries(query, tools.tools);
  const filteredSkills = filterCatalogEntries(query, capabilityState.skills.skills);

  return (
    <div
      aria-label="Tools and skills catalog"
      className="composer-catalog-popover"
      hidden={!open}
      id="composer-catalog-panel"
      role="group"
    >
      <label className="visually-hidden" htmlFor="composer-catalog-search">
        Search tools and skills
      </label>
      <input
        autoComplete="off"
        className="composer-catalog-search"
        id="composer-catalog-search"
        maxLength={200}
        onChange={(event) => setQuery(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onOpenChange(false);
          }
        }}
        placeholder="Search tools and skills"
        type="search"
        value={query}
      />
      <CatalogToolsSection
        disabled={!selectedModel}
        filteredTools={filteredTools}
        idleMessage={
          selectedModel
            ? `Load tool metadata for ${selectedModel.providerID}/${selectedModel.id}.`
            : "Select a server-reported model before loading tool metadata."
        }
        onLoad={onLoadToolMetadata}
        error={tools.error}
        scopeLabel={
          toolScopeMatches && selectedModel
            ? `${selectedModel.providerID}/${selectedModel.id}`
            : null
        }
        staleTools={staleTools}
        status={tools.status}
        tools={tools.tools}
      />
      <CatalogSkillsSection
        error={capabilityState.skills.error}
        filteredSkills={filteredSkills}
        onLoad={onLoadSkills}
        onPrepareSkillReference={onPrepareSkillReference}
        onOpenChange={onOpenChange}
        skills={capabilityState.skills.skills}
        status={capabilityState.skills.status}
      />
      <p className="composer-catalog-note">
        Metadata only. Nothing here runs a tool or skill; tools and skills act
        only through OpenCode's own agent and permission flow.
      </p>
    </div>
  );
}

function CatalogToolsSection({
  disabled,
  error,
  filteredTools,
  idleMessage,
  onLoad,
  scopeLabel,
  staleTools,
  status,
  tools,
}: {
  disabled: boolean;
  error: string | null;
  filteredTools: CapabilityState["tools"]["tools"];
  idleMessage: string;
  onLoad: () => void;
  scopeLabel: string | null;
  staleTools: CapabilityState["tools"] | null;
  status: CapabilityState["tools"]["status"];
  tools: CapabilityState["tools"]["tools"];
}) {
  return (
    <section aria-label="Tool metadata" className="composer-catalog-section">
      <header className="composer-catalog-heading">
        <strong>Tools</strong>
        <button
          className="text-button"
          disabled={disabled || status === "loading"}
          onClick={onLoad}
          type="button"
        >
          {status === "idle" ? "Load tools" : status === "loading" ? "Loading tools…" : "Refresh tools"}
        </button>
      </header>
      {staleTools && staleTools.providerID && staleTools.modelID && (
        <p className="composer-catalog-scope-note">
          Stored tool metadata is for {staleTools.providerID}/{staleTools.modelID},
          not the selected model. Refresh tools to load the selected model's scope.
        </p>
      )}
      {scopeLabel && (
        <p className="composer-catalog-scope-note">
          Scope: <code>{scopeLabel}</code>
          {" · experimental endpoint, scoped to the server default agent; it may differ from the selected agent."}
        </p>
      )}
      {status === "idle" && <p className="composer-catalog-note">{idleMessage}</p>}
      {status === "loading" && (
        <p className="composer-catalog-note" role="status">Loading tool metadata…</p>
      )}
      {status === "unavailable" && (
        <p className="composer-catalog-note" role="status">
          Tool metadata is unavailable for this workspace.
        </p>
      )}
      {error && <p className="composer-catalog-note" role="alert">{error}</p>}
      {status === "ready" && tools.length === 0 && (
        <p className="composer-catalog-note" role="status">
          OpenCode returned no tool metadata for this provider/model.
        </p>
      )}
      {status === "ready" && tools.length > 0 && filteredTools.length === 0 && (
        <p className="composer-catalog-note" role="status">No tools match this search.</p>
      )}
      {status === "ready" && filteredTools.length > 0 && (
        <ul className="composer-catalog-list">
          {filteredTools.map((tool) => (
            <li className="composer-catalog-item" key={tool.id}>
              <code className="composer-catalog-name">{tool.id}</code>
              <span className="composer-catalog-description">{tool.description || "No description returned."}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CatalogSkillsSection({
  error,
  filteredSkills,
  onLoad,
  onPrepareSkillReference,
  onOpenChange,
  skills,
  status,
}: {
  error: string | null;
  filteredSkills: CapabilityState["skills"]["skills"];
  onLoad: () => void;
  onPrepareSkillReference: (skill: CatalogEntry) => void;
  onOpenChange: (open: boolean) => void;
  skills: CapabilityState["skills"]["skills"];
  status: CapabilityState["skills"]["status"];
}) {
  return (
    <section aria-label="Registered skills" className="composer-catalog-section">
      <header className="composer-catalog-heading">
        <strong>Skills</strong>
        <button
          className="text-button"
          disabled={status === "loading"}
          onClick={onLoad}
          type="button"
        >
          {status === "idle" ? "Load skills" : status === "loading" ? "Loading skills…" : "Refresh skills"}
        </button>
      </header>
      {status === "idle" && (
        <p className="composer-catalog-note">Load the registered skill catalog to begin.</p>
      )}
      {status === "loading" && (
        <p className="composer-catalog-note" role="status">Loading skill metadata…</p>
      )}
      {status === "unavailable" && (
        <p className="composer-catalog-note" role="status">
          Skill metadata is unavailable for this workspace.
        </p>
      )}
      {error && (
        <p className="composer-catalog-note" role="alert">{error}</p>
      )}
      {status === "ready" && skills.length === 0 && (
        <p className="composer-catalog-note" role="status">
          OpenCode returned no registered skills.
        </p>
      )}
      {status === "ready" && skills.length > 0 && filteredSkills.length === 0 && (
        <p className="composer-catalog-note" role="status">No skills match this search.</p>
      )}
      {status === "ready" && filteredSkills.length > 0 && (
        <ul className="composer-catalog-list">
          {filteredSkills.map((skill) => (
            <li className="composer-catalog-item" key={skill.name}>
              <button
                className="text-button composer-catalog-skill-button"
                onClick={() => {
                  onPrepareSkillReference(skill);
                  onOpenChange(false);
                }}
                title="Prepares an editable skill-reference note in your draft; it does not run the skill."
                type="button"
              >
                Prepare skill reference: <code>{skill.name}</code>
                {skill.description && (
                  <span className="composer-catalog-description">{skill.description}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}