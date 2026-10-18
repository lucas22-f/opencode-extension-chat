import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { z } from "zod";
import {
  chatModelReferenceSchema,
  MAX_SESSION_HISTORY_ENTRIES,
  sessionIdSchema,
  type ChatModelReference,
} from "../shared/chat-state";
import {
  CAPABILITY_PARAMETER_SCHEMA_LENGTH,
  CAPABILITY_SKILL_LIMIT,
  CAPABILITY_TOOL_LIMIT,
  initialCapabilityState,
  type CapabilityChildSession,
  type CapabilityMcpServer,
  type CapabilitySkill,
  type CapabilityState,
  type CapabilityTool,
} from "../shared/capability-state";
import type { OpenCodeConnection } from "./opencode-connection";

const SESSION_LIST_LIMIT = 50;

const serverMcpStatusMapSchema = z.record(
  z.string().min(1).max(256),
  z
    .object({
      status: z.enum([
        "connected",
        "disabled",
        "failed",
        "needs_auth",
        "needs_client_registration",
      ]),
    }),
);

const serverToolListSchema = z
  .array(
    z
      .object({
        id: z.string().min(1).max(256),
        description: z.string().max(4_000),
        parameters: z.unknown(),
      }),
  )
  .max(CAPABILITY_TOOL_LIMIT)
  .superRefine((tools, context) => {
    const ids = new Set<string>();
    tools.forEach((tool, index) => {
      if (ids.has(tool.id)) {
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: "Tool IDs must be unique.",
        });
      }
      ids.add(tool.id);
    });
  });

const serverSkillListSchema = z
  .object({
    data: z
      .array(
        z.object({
          name: z.string().min(1).max(256),
          description: z.string().max(4_000).optional(),
        }),
      )
      .max(CAPABILITY_SKILL_LIMIT),
  });

const serverSessionSchema = z
  .object({
    id: sessionIdSchema,
    parentID: sessionIdSchema.optional(),
    title: z.string().max(500),
    time: z.object({
      updated: z.number().finite().min(0).max(8_640_000_000_000_000),
    }),
    agent: z.string().min(1).max(256).optional(),
  });

const serverSessionPageSchema = z
  .object({
    data: z.array(serverSessionSchema).max(SESSION_LIST_LIMIT),
    cursor: z
      .object({
        previous: z.string().min(1).max(16_384).optional(),
        next: z.string().min(1).max(16_384).optional(),
      }),
  });

const serverAgentListSchema = z
  .object({
    data: z
      .array(
        z.object({
          id: z.string().min(1).max(256),
          mode: z.enum(["subagent", "primary", "all"]),
        }),
      )
      .max(256),
  });

type OpenCodeSdkClient = ReturnType<typeof createOpencodeClient>;
type OpenCodeSdkClientFactory = (
  serverUrl: string,
  directory: string,
) => OpenCodeSdkClient;
type InventorySection = "mcp" | "tools" | "skills" | "children";

interface RequestSnapshot {
  client: OpenCodeSdkClient;
  connectionGeneration: number;
  sectionGeneration: number;
  controller: AbortController;
  signal: AbortSignal;
}

export class OpenCodeCapabilities {
  private currentState: CapabilityState = initialCapabilityState;
  private readonly listeners = new Set<(state: CapabilityState) => void>();
  private readonly unsubscribeConnection: () => void;
  private readonly controllers: Partial<Record<InventorySection, AbortController>> = {};
  private readonly sectionGenerations: Record<InventorySection, number> = {
    mcp: 0,
    tools: 0,
    skills: 0,
    children: 0,
  };
  private client: OpenCodeSdkClient | undefined;
  private serverUrl: string | undefined;
  private directory: string | undefined;
  private connectionController: AbortController | undefined;
  private connectionGeneration = 0;
  private selectedSessionID: string | null = null;
  private disposed = false;

  constructor(
    connection: OpenCodeConnection,
    private readonly getConnectedWorkspaceDirectory: () => string | undefined,
    private readonly isWorkspaceTrusted: () => boolean = () => true,
    private readonly clientFactory: OpenCodeSdkClientFactory = (serverUrl, directory) =>
      createOpencodeClient({ baseUrl: serverUrl, directory, redirect: "error" }),
  ) {
    this.unsubscribeConnection = connection.subscribe((state) => {
      if (state.status === "connected") {
        this.connect(state.serverUrl);
        return;
      }
      this.resetConnection();
    });
  }

  get state(): CapabilityState {
    return this.currentState;
  }

  subscribe(listener: (state: CapabilityState) => void): () => void {
    this.listeners.add(listener);
    listener(this.currentState);
    return () => this.listeners.delete(listener);
  }

  setSelectedSessionID(sessionID: string | null): void {
    const parsed = sessionID === null ? null : sessionIdSchema.safeParse(sessionID);
    const nextSessionID =
      parsed === null ? null : parsed.success ? parsed.data : null;
    if (nextSessionID === this.selectedSessionID) return;

    this.selectedSessionID = nextSessionID;
    this.invalidateSection("children");
    this.setState({
      children: {
        ...initialCapabilityState.children,
        parentSessionID: nextSessionID,
      },
    });
  }

  async refreshMcpStatus(): Promise<void> {
    const snapshot = this.beginRequest("mcp");
    if (!snapshot) {
      this.setState({
        mcp: {
          status: "unavailable",
          servers: [],
          error: "Connect to a trusted OpenCode workspace before loading MCP status.",
        },
      });
      return;
    }
    this.setState({ mcp: { status: "loading", servers: [], error: null } });

    try {
      const response = await snapshot.client.mcp.status(
        { directory: this.directory },
        { signal: snapshot.signal },
      );
      if (response.error !== undefined) {
        if (!this.isCurrentRequest("mcp", snapshot)) return;
        const failure = requestFailure(response.response?.status, "mcp");
        this.setState({
          mcp: { status: failure.status, servers: [], error: failure.message },
        });
        return;
      }
      const result = serverMcpStatusMapSchema.safeParse(response.data);
      if (!result.success || Object.keys(result.data ?? {}).length > 500) {
        throw new Error("Invalid MCP status response.");
      }
      if (!this.isCurrentRequest("mcp", snapshot)) return;
      const servers: CapabilityMcpServer[] = Object.entries(result.data).map(
        ([name, value]) => ({ name, status: value.status }),
      );
      this.setState({ mcp: { status: "ready", servers, error: null } });
    } catch (error) {
      if (!this.isCurrentRequest("mcp", snapshot)) return;
      const failure = requestFailure(undefined, "mcp");
      this.setState({
        mcp: {
          status: failure.status,
          servers: [],
          error: failure.message,
        },
      });
    } finally {
      this.finishRequest("mcp", snapshot);
    }
  }

  async refreshToolMetadata(
    model: ChatModelReference | null,
  ): Promise<void> {
    const parsedModel = chatModelReferenceSchema.safeParse(model);
    if (!parsedModel.success) {
      this.invalidateSection("tools");
      this.setState({
        tools: {
          status: "idle",
          providerID: null,
          modelID: null,
          tools: [],
          error: null,
        },
      });
      return;
    }

    const { providerID, id: modelID } = parsedModel.data;
    const snapshot = this.beginRequest("tools");
    if (!snapshot) {
      this.setState({
        tools: {
          status: "unavailable",
          providerID,
          modelID,
          tools: [],
          error: "Connect to a trusted OpenCode workspace before loading tool metadata.",
        },
      });
      return;
    }
    this.setState({
      tools: { status: "loading", providerID, modelID, tools: [], error: null },
    });

    try {
      const response = await snapshot.client.tool.list(
        { directory: this.directory, provider: providerID, model: modelID },
        { signal: snapshot.signal },
      );
      if (response.error !== undefined) {
        if (!this.isCurrentRequest("tools", snapshot)) return;
        const failure = requestFailure(response.response?.status, "tools");
        this.setState({
          tools: {
            status: failure.status,
            providerID,
            modelID,
            tools: [],
            error: failure.message,
          },
        });
        return;
      }
      const result = serverToolListSchema.safeParse(response.data);
      if (!result.success) throw new Error("Invalid tool metadata response.");
      const tools: CapabilityTool[] = result.data.map((tool) => ({
        id: tool.id,
        description: tool.description,
        parameters: serializeToolParameters(tool.parameters),
      }));
      if (!this.isCurrentRequest("tools", snapshot)) return;
      this.setState({
        tools: { status: "ready", providerID, modelID, tools, error: null },
      });
    } catch (error) {
      if (!this.isCurrentRequest("tools", snapshot)) return;
      const failure = requestFailure(undefined, "tools");
      this.setState({
        tools: {
          status: failure.status,
          providerID,
          modelID,
          tools: [],
          error: failure.message,
        },
      });
    } finally {
      this.finishRequest("tools", snapshot);
    }
  }

  async refreshSkills(): Promise<void> {
    const snapshot = this.beginRequest("skills");
    if (!snapshot) {
      this.setState({
        skills: {
          status: "unavailable",
          skills: [],
          error: "Connect to a trusted OpenCode workspace before loading skill metadata.",
        },
      });
      return;
    }
    this.setState({ skills: { status: "loading", skills: [], error: null } });

    try {
      const response = await snapshot.client.v2.skill.list(
        { location: { directory: this.directory } },
        { signal: snapshot.signal },
      );
      if (response.error !== undefined) {
        if (!this.isCurrentRequest("skills", snapshot)) return;
        const failure = requestFailure(response.response?.status, "skills");
        this.setState({
          skills: { status: failure.status, skills: [], error: failure.message },
        });
        return;
      }
      const result = serverSkillListSchema.safeParse(response.data);
      if (!result.success) throw new Error("Invalid skill metadata response.");
      const skills: CapabilitySkill[] = result.data.data.map((skill) => ({
        name: skill.name,
        ...(skill.description === undefined
          ? {}
          : { description: skill.description }),
      }));
      if (!this.isCurrentRequest("skills", snapshot)) return;
      this.setState({ skills: { status: "ready", skills, error: null } });
    } catch (error) {
      if (!this.isCurrentRequest("skills", snapshot)) return;
      const failure = requestFailure(undefined, "skills");
      this.setState({
        skills: {
          status: failure.status,
          skills: [],
          error: failure.message,
        },
      });
    } finally {
      this.finishRequest("skills", snapshot);
    }
  }

  async refreshChildSessions(sessionID: string | null): Promise<void> {
    const parsedSessionID = sessionID === null
      ? null
      : sessionIdSchema.safeParse(sessionID);
    if (
      !parsedSessionID ||
      !parsedSessionID.success ||
      parsedSessionID.data !== this.selectedSessionID
    ) {
      return;
    }

    const parentSessionID = parsedSessionID.data;
    const snapshot = this.beginRequest("children");
    if (!snapshot) {
      this.setState({
        children: {
          ...initialCapabilityState.children,
          status: "unavailable",
          parentSessionID,
          error: "Connect to a trusted OpenCode workspace before loading child sessions.",
        },
      });
      return;
    }
    this.setState({
      children: {
        ...initialCapabilityState.children,
        status: "loading",
        parentSessionID,
      },
    });

    try {
      const { sessions, scannedSessionCount, truncated } =
        await this.loadChildSessionPages(snapshot, parentSessionID);
      if (!this.isCurrentChildRequest(snapshot, parentSessionID)) return;

      const needsAgentModes = sessions.some((session) => session.agent !== undefined);
      const agentModes = needsAgentModes
        ? await this.loadAgentModes(snapshot)
        : { available: true, modes: new Map<string, "subagent" | "primary" | "all">() };
      if (!this.isCurrentChildRequest(snapshot, parentSessionID)) return;

      const children = sessions.map((session): CapabilityChildSession => {
        const mode = session.agent ? agentModes.modes.get(session.agent) : undefined;
        return {
          id: session.id,
          title: session.title,
          updatedAt: session.time.updated,
          ...(session.agent === undefined ? {} : { agent: session.agent }),
          ...(mode === "subagent" ? { subagent: true } : {}),
        };
      });
      this.setState({
        children: {
          status: "ready",
          parentSessionID,
          sessions: children,
          scannedSessionCount,
          truncated,
          agentModesAvailable: agentModes.available,
          error: null,
        },
      });
    } catch {
      if (!this.isCurrentChildRequest(snapshot, parentSessionID)) return;
      this.setState({
        children: {
          ...initialCapabilityState.children,
          status: "error",
          parentSessionID,
          error: "Could not verify child sessions for the selected session. Refresh to try again.",
        },
      });
    } finally {
      this.finishRequest("children", snapshot);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeConnection();
    this.resetConnection();
    this.listeners.clear();
  }

  private connect(serverUrl: string): void {
    if (this.disposed) return;
    const directory = this.getConnectedWorkspaceDirectory();
    if (!this.isWorkspaceTrusted() || !directory) {
      this.resetConnection();
      const unavailable = "Trust and connect an OpenCode workspace before loading capability metadata.";
      this.setState({
        mcp: { status: "unavailable", servers: [], error: unavailable },
        tools: {
          status: "unavailable",
          providerID: null,
          modelID: null,
          tools: [],
          error: unavailable,
        },
        skills: { status: "unavailable", skills: [], error: unavailable },
        children: {
          ...initialCapabilityState.children,
          status: "unavailable",
          parentSessionID: this.selectedSessionID,
          error: unavailable,
        },
      });
      return;
    }
    if (this.client && this.serverUrl === serverUrl && this.directory === directory) {
      return;
    }

    this.resetConnection();
    try {
      this.client = this.clientFactory(serverUrl, directory);
      this.serverUrl = serverUrl;
      this.directory = directory;
      this.connectionController = new AbortController();
    } catch {
      this.resetConnection();
      this.setState({
        mcp: {
          status: "error",
          servers: [],
          error: "Could not prepare the OpenCode capability client.",
        },
        tools: {
          status: "error",
          providerID: null,
          modelID: null,
          tools: [],
          error: "Could not prepare the OpenCode capability client.",
        },
        skills: {
          status: "error",
          skills: [],
          error: "Could not prepare the OpenCode capability client.",
        },
        children: {
          ...initialCapabilityState.children,
          status: "error",
          parentSessionID: this.selectedSessionID,
          error: "Could not prepare the OpenCode capability client.",
        },
      });
    }
  }

  private resetConnection(): void {
    this.connectionGeneration += 1;
    for (const section of ["mcp", "tools", "skills", "children"] as const) {
      this.invalidateSection(section);
    }
    this.connectionController?.abort();
    this.connectionController = undefined;
    this.client = undefined;
    this.serverUrl = undefined;
    this.directory = undefined;
    this.setState({
      ...initialCapabilityState,
      children: {
        ...initialCapabilityState.children,
        parentSessionID: this.selectedSessionID,
      },
    });
  }

  private beginRequest(section: InventorySection): RequestSnapshot | undefined {
    if (!this.client || !this.directory || !this.connectionController) {
      return undefined;
    }
    this.invalidateSection(section);
    const controller = new AbortController();
    this.controllers[section] = controller;
    return {
      client: this.client,
      connectionGeneration: this.connectionGeneration,
      sectionGeneration: this.sectionGenerations[section],
      controller,
      signal: AbortSignal.any([
        controller.signal,
        this.connectionController.signal,
      ]),
    };
  }

  private isCurrentRequest(
    section: InventorySection,
    snapshot: RequestSnapshot,
  ): boolean {
    return (
      !this.disposed &&
      !snapshot.controller.signal.aborted &&
      this.client === snapshot.client &&
      this.connectionGeneration === snapshot.connectionGeneration &&
      this.sectionGenerations[section] === snapshot.sectionGeneration
    );
  }

  private isCurrentChildRequest(
    snapshot: RequestSnapshot,
    parentSessionID: string,
  ): boolean {
    return (
      this.isCurrentRequest("children", snapshot) &&
      this.selectedSessionID === parentSessionID
    );
  }

  private finishRequest(
    section: InventorySection,
    snapshot: RequestSnapshot,
  ): void {
    if (this.controllers[section] === snapshot.controller) {
      delete this.controllers[section];
    }
  }

  private invalidateSection(section: InventorySection): void {
    this.sectionGenerations[section] += 1;
    this.controllers[section]?.abort();
    delete this.controllers[section];
  }

  private async loadChildSessionPages(
    snapshot: RequestSnapshot,
    parentSessionID: string,
  ): Promise<{
    sessions: z.infer<typeof serverSessionSchema>[];
    scannedSessionCount: number;
    truncated: boolean;
  }> {
    const matches = new Map<string, z.infer<typeof serverSessionSchema>>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let scannedSessionCount = 0;
    let exhausted = false;

    while (scannedSessionCount < MAX_SESSION_HISTORY_ENTRIES) {
      const limit = Math.min(
        SESSION_LIST_LIMIT,
        MAX_SESSION_HISTORY_ENTRIES - scannedSessionCount,
      );
      const response = await snapshot.client.v2.session.list(
        {
          directory: this.directory,
          limit,
          order: "desc",
          ...(cursor === undefined ? {} : { cursor }),
        },
        { signal: snapshot.signal, throwOnError: true },
      );
      const page = serverSessionPageSchema.safeParse(response.data);
      if (!page.success || page.data.data.length > limit) {
        throw new Error("Invalid session page.");
      }
      scannedSessionCount += page.data.data.length;
      for (const session of page.data.data) {
        if (session.parentID === parentSessionID) matches.set(session.id, session);
      }

      const nextCursor = page.data.cursor.next;
      if (nextCursor === undefined) {
        exhausted = true;
        break;
      }
      if (seenCursors.has(nextCursor) || nextCursor === cursor) {
        throw new Error("Session list cursor did not advance.");
      }
      seenCursors.add(nextCursor);
      if (scannedSessionCount >= MAX_SESSION_HISTORY_ENTRIES) break;
      cursor = nextCursor;
    }

    return {
      sessions: Array.from(matches.values()),
      scannedSessionCount,
      truncated: !exhausted && scannedSessionCount >= MAX_SESSION_HISTORY_ENTRIES,
    };
  }

  private async loadAgentModes(
    snapshot: RequestSnapshot,
  ): Promise<{
    available: boolean;
    modes: Map<string, "subagent" | "primary" | "all">;
  }> {
    try {
      const response = await snapshot.client.v2.agent.list(
        { location: { directory: this.directory } },
        { signal: snapshot.signal, throwOnError: true },
      );
      const result = serverAgentListSchema.safeParse(response.data);
      if (!result.success) {
        return { available: false, modes: new Map() };
      }
      return {
        available: true,
        modes: new Map(result.data.data.map((agent) => [agent.id, agent.mode])),
      };
    } catch {
      return { available: false, modes: new Map() };
    }
  }

  private setState(patch: Partial<CapabilityState>): void {
    this.currentState = { ...this.currentState, ...patch };
    for (const listener of this.listeners) listener(this.currentState);
  }
}

function serializeToolParameters(value: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch {
    throw new Error("Invalid tool parameter schema.");
  }
  if (
    serialized === undefined ||
    serialized.length > CAPABILITY_PARAMETER_SCHEMA_LENGTH
  ) {
    throw new Error("Invalid tool parameter schema.");
  }
  return serialized;
}

function requestFailure(
  status: number | undefined,
  section: "mcp" | "tools" | "skills",
): { status: "unavailable" | "error"; message: string } {
  if (status === 404 || status === 405 || status === 501) {
    return {
      status: "unavailable",
      message:
        section === "mcp"
          ? "MCP status is unavailable from this server."
          : section === "tools"
          ? "Tool metadata uses an experimental endpoint that is unavailable on this server."
          : "Skill metadata uses an experimental endpoint that is unavailable on this server.",
    };
  }
  return {
    status: "error",
    message:
      section === "mcp"
        ? "Could not load MCP server status. Check the connection and retry."
        : section === "tools"
        ? "Could not load tool metadata. Check the connection and retry."
        : "Could not load skill metadata. Check the connection and retry.",
  };
}
