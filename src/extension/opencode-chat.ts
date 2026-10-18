import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { z } from "zod";
import {
  initialChatState,
  MAX_CHAT_HISTORY_MESSAGES,
  MAX_CURSOR_LENGTH,
  MAX_SESSION_HISTORY_ENTRIES,
  MAX_SESSION_SEARCH_LENGTH,
  chatPermissionRequestSchema,
  chatQuestionRequestSchema,
  chatModelReferenceSchema,
  pendingRequestIDSchema,
  permissionReplySchema,
  MAX_QUESTION_OPTIONS,
  promptRequestIDSchema,
  promptTextSchema,
  questionAnswersSchema,
  sessionIdSchema,
  type ChatAssistantPart,
  type ChatMessage,
  type ChatModelReference,
  type ChatPermissionRequest,
  type ChatQuestionRequest,
  type ChatRequestAction,
  type ChatSession,
  type ChatState,
  type ChatTextPart,
  type ChatToolPart,
  type PromptResult,
} from "../shared/chat-state";
import type { OpenCodeConnection } from "./opencode-connection";
import {
  noDiagnostics,
  type DiagnosticFlow,
  type DiagnosticsSink,
  type HistoryDropReason,
  type ActivityDiagnosticReason,
  type PromptDiagnosticReason,
} from "./diagnostics";

const SESSION_LIST_LIMIT = 50;
const MESSAGE_HISTORY_LIMIT = 100;
const SESSION_LIST_MAX = MAX_SESSION_HISTORY_ENTRIES;
const EVENT_RETRY_LIMIT = 3;
const EVENT_ID_CACHE_LIMIT = 4_096;
const promptOutcomeUnknownMessage = (httpStatus?: number): string =>
  `The prompt outcome is unknown; OpenCode may have accepted it. Review this session before retrying. An exact retry uses the same request ID.${httpStatus === undefined ? "" : ` (HTTP ${httpStatus})`}`;

const serverSessionSchema = z.object({
  id: sessionIdSchema,
  title: z.string(),
  time: z.object({ updated: z.number().finite().nonnegative() }).passthrough(),
  agent: z.string().min(1).max(256).optional(),
  model: chatModelReferenceSchema.optional(),
});

const cursorSchema = z.object({
  previous: z.string().min(1).max(MAX_CURSOR_LENGTH).optional(),
  next: z.string().min(1).max(MAX_CURSOR_LENGTH).optional(),
}).strict();

const serverSessionPageSchema = z.object({
  data: z.array(serverSessionSchema).max(SESSION_LIST_LIMIT),
  cursor: cursorSchema,
}).passthrough();

const serverHistoryPageSchema = z.object({
  data: z.array(z.unknown()).max(MESSAGE_HISTORY_LIMIT),
  cursor: cursorSchema,
}).passthrough();

const serverProviderSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(500),
  disabled: z.boolean().optional(),
}).passthrough();

const serverModelSchema = z.object({
  id: z.string().min(1).max(256),
  providerID: z.string().min(1).max(256),
  name: z.string().min(1).max(500),
  enabled: z.boolean(),
  variants: z.array(z.object({ id: z.string().min(1).max(256) }).passthrough()).max(256),
}).passthrough();

const serverAgentSchema = z.object({
  id: z.string().min(1).max(256),
  description: z.string().max(2_000).optional(),
  hidden: z.boolean(),
}).passthrough();

const serverUserMessageSchema = z.object({
  id: z.string().min(1).max(256),
  type: z.literal("user"),
  text: z.string(),
});

const serverTextHistoryRecordSchema = z.object({
  id: z.string().min(1).max(256),
  type: z.enum(["synthetic", "system"]),
  text: z.string(),
});

const serverShellHistoryRecordSchema = z.object({
  id: z.string().min(1).max(256),
  type: z.literal("shell"),
  command: z.string(),
  output: z.string(),
});

const serverCompactionHistoryRecordSchema = z.object({
  id: z.string().min(1).max(256),
  type: z.literal("compaction"),
  summary: z.string(),
  recent: z.string(),
});

const serverAgentSwitchHistoryRecordSchema = z.object({
  id: z.string().min(1).max(256),
  type: z.literal("agent-switched"),
  agent: z.string().min(1).max(256),
});

const serverModelSwitchHistoryRecordSchema = z.object({
  id: z.string().min(1).max(256),
  type: z.literal("model-switched"),
  model: z.object({
    providerID: z.string().min(1).max(256),
    id: z.string().min(1).max(256),
  }).passthrough(),
});

const serverAssistantMessageSchema = z.object({
  id: z.string().min(1).max(256),
  type: z.literal("assistant"),
  content: z.array(
    z.object({
      id: z.string().min(1).max(256),
      type: z.string(),
    }).passthrough(),
  ),
  time: z
    .object({
      created: z.number().finite().optional(),
      completed: z.number().finite().optional(),
    })
    .passthrough()
    .optional(),
});

const serverPromptAdmissionSchema = z.object({
  id: z.string().min(1).max(256),
  sessionID: sessionIdSchema,
  prompt: z.object({ text: z.string() }),
  delivery: z.enum(["steer", "queue"]),
});

const permissionRequestPayloadSchema = z
  .object({
    id: pendingRequestIDSchema,
    sessionID: sessionIdSchema,
    action: z.string().min(1).max(256),
    resources: z.array(z.string().max(4_096)).max(128),
    save: z.array(z.string().max(4_096)).max(128).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    source: z
      .object({
        type: z.literal("tool"),
        messageID: pendingRequestIDSchema,
        callID: pendingRequestIDSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

const questionRequestPayloadSchema = z
  .object({
    id: pendingRequestIDSchema,
    sessionID: sessionIdSchema,
    questions: z
      .array(
        z
          .object({
            header: z.string().max(64),
            question: z.string().max(8_000),
            options: z
              .array(
                z
                  .object({
                    label: z.string().max(256),
                    description: z.string().max(2_000),
                  })
                  .strict(),
              )
              .max(MAX_QUESTION_OPTIONS),
            multiple: z.boolean().optional(),
            custom: z.boolean().optional(),
          })
          .strict(),
      )
      .max(32),
    tool: z
      .object({
        messageID: pendingRequestIDSchema,
        callID: pendingRequestIDSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

const permissionAskedEventSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal("permission.v2.asked"),
    data: permissionRequestPayloadSchema,
  })
  .passthrough();

const permissionRepliedEventSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal("permission.v2.replied"),
    data: z
      .object({
        sessionID: sessionIdSchema,
        requestID: pendingRequestIDSchema,
        reply: permissionReplySchema,
      })
      .strict(),
  })
  .passthrough();

const questionAskedEventSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal("question.v2.asked"),
    data: questionRequestPayloadSchema,
  })
  .passthrough();

const questionRepliedEventSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal("question.v2.replied"),
    data: z
      .object({
        sessionID: sessionIdSchema,
        requestID: pendingRequestIDSchema,
        answers: questionAnswersSchema,
      })
      .strict(),
  })
  .passthrough();

const questionRejectedEventSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal("question.v2.rejected"),
    data: z
      .object({
        sessionID: sessionIdSchema,
        requestID: pendingRequestIDSchema,
      })
      .strict(),
  })
  .passthrough();

const serverPermissionRequestSchema = permissionRequestPayloadSchema;
const serverQuestionRequestSchema = questionRequestPayloadSchema;

const v2EventEnvelopeSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.string().min(1),
  })
  .passthrough();

const activeSessionMapSchema = z.record(
  sessionIdSchema,
  z.object({ type: z.literal("running") }).strict(),
);

const sessionStatusEventSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal("session.status"),
    data: z
      .object({
        sessionID: sessionIdSchema,
        status: z.enum(["idle", "busy", "retry"]),
      })
      .strict(),
  })
  .passthrough();

const sessionIdleEventSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal("session.idle"),
    data: z.object({ sessionID: sessionIdSchema }).strict(),
  })
  .passthrough();

const textDeltaEventSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal("session.next.text.delta"),
    data: z
      .object({
        timestamp: z.number().finite(),
        sessionID: sessionIdSchema,
        assistantMessageID: z.string().min(1).max(256),
        textID: z.string().min(1).max(256),
        delta: z.string(),
      })
      .strict(),
  })
  .passthrough();

const textEndedEventSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal("session.next.text.ended"),
    data: z
      .object({
        timestamp: z.number().finite(),
        sessionID: sessionIdSchema,
        assistantMessageID: z.string().min(1).max(256),
        textID: z.string().min(1).max(256),
        text: z.string(),
      })
      .strict(),
  })
  .passthrough();

const toolEventIdentitySchema = z.object({
  timestamp: z.number().finite(),
  sessionID: sessionIdSchema,
  assistantMessageID: z.string().min(1).max(256),
  callID: z.string().min(1).max(256),
});

const toolInputStartedEventSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal("session.next.tool.input.started"),
    data: toolEventIdentitySchema.extend({ name: z.string().min(1).max(256) }).strict(),
  })
  .passthrough();

const toolInputDeltaEventSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal("session.next.tool.input.delta"),
    data: toolEventIdentitySchema.extend({ delta: z.string() }).strict(),
  })
  .passthrough();

const toolInputEndedEventSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal("session.next.tool.input.ended"),
    data: toolEventIdentitySchema.extend({ text: z.string() }).strict(),
  })
  .passthrough();

const toolCalledEventSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal("session.next.tool.called"),
    data: toolEventIdentitySchema.extend({
      tool: z.string().min(1).max(256),
      input: z.record(z.string(), z.unknown()),
      provider: z.object({ executed: z.boolean() }).passthrough().optional(),
    }).strict(),
  })
  .passthrough();

const toolProgressEventSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal("session.next.tool.progress"),
    data: toolEventIdentitySchema.extend({
      structured: z.record(z.string(), z.unknown()),
      content: z.array(z.unknown()),
    }).strict(),
  })
  .passthrough();

const toolSuccessEventSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal("session.next.tool.success"),
    data: toolEventIdentitySchema.extend({
      structured: z.record(z.string(), z.unknown()),
      content: z.array(z.unknown()),
      outputPaths: z.array(z.string()).optional(),
      result: z.unknown().optional(),
      provider: z.object({ executed: z.boolean() }).passthrough().optional(),
    }).strict(),
  })
  .passthrough();

const toolFailedEventSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal("session.next.tool.failed"),
    data: toolEventIdentitySchema.extend({
      error: z.unknown(),
      result: z.unknown().optional(),
      provider: z.object({ executed: z.boolean() }).passthrough().optional(),
    }).strict(),
  })
  .passthrough();

const messagePartUpdatedEventSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal("message.part.updated"),
    data: z.object({
      sessionID: sessionIdSchema,
      part: z.unknown(),
      time: z.number().finite(),
    }).strict(),
  })
  .passthrough();

const sessionDiffEventSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal("session.diff"),
    data: z.object({
      sessionID: sessionIdSchema,
      diff: z.array(
        z.object({
          file: z.string().optional(),
          patch: z.string().optional(),
          additions: z.number().finite().nonnegative(),
          deletions: z.number().finite().nonnegative(),
          status: z.enum(["added", "deleted", "modified"]).optional(),
        }).passthrough(),
      ),
    }).strict(),
  })
  .passthrough();

type OpenCodeSdkClient = ReturnType<typeof createOpencodeClient>;
type OpenCodeSdkClientFactory = (
  serverUrl: string,
  directory: string,
) => OpenCodeSdkClient;
type AssistantTextPart = ChatTextPart & {
  historyOrder?: number;
  timestamp?: number;
  orderTimestamp?: number;
  arrivalOrdinal?: number;
  durableSequence?: number;
};

type BufferedTextEvent = {
  id: string;
  sessionID: string;
  messageID: string;
  partID: string;
  timestamp: number;
  arrivalOrdinal: number;
  durableSequence?: number;
  delta?: string;
  endedText?: string;
};

type ToolEventPayload = {
  id: string;
  sessionID: string;
  messageID: string;
  callID: string;
  timestamp: number;
  durableSequence?: number;
} & (
  | { kind: "input-started"; name: string }
  | { kind: "input-delta"; delta: string }
  | { kind: "input-ended"; text: string }
  | { kind: "called"; name: string; input: Record<string, unknown> }
  | {
      kind: "progress";
      structured: Record<string, unknown>;
      content: unknown[];
    }
  | {
      kind: "success";
      structured: Record<string, unknown>;
      content: unknown[];
      result?: unknown;
    }
  | { kind: "failed"; error: unknown; result?: unknown }
  | {
      kind: "canonical";
      partID: string;
      name: string;
      state: Record<string, unknown>;
  }
);

type BufferedToolEvent = ToolEventPayload & { arrivalOrdinal: number };
type IncomingTextEvent = Omit<BufferedTextEvent, "arrivalOrdinal">;
type BufferedAssistantEvent = BufferedTextEvent | BufferedToolEvent;

type PendingRequestEvent =
  | { kind: "permission-asked"; request: ChatPermissionRequest }
  | { kind: "permission-resolved"; sessionID: string; requestID: string }
  | { kind: "question-asked"; request: ChatQuestionRequest }
  | { kind: "question-resolved"; sessionID: string; requestID: string };

interface PendingRequestSnapshot {
  client: OpenCodeSdkClient;
  sessionID: string;
  connectionGeneration: number;
  selectionGeneration: number;
  controller: AbortController;
  bufferedEvents: PendingRequestEvent[];
}

type RequestOperation = (
  client: OpenCodeSdkClient,
  signal: AbortSignal | undefined,
) => Promise<unknown>;

type AssistantToolPart = ChatToolPart & {
  historyOrder?: number;
  orderTimestamp: number;
  orderArrivalOrdinal: number;
  orderDurableSequence?: number;
  events: BufferedToolEvent[];
  canonical?: {
    partID: string;
    updatedAt: number;
    state: Record<string, unknown>;
  };
  historyState?: {
    state: Record<string, unknown>;
    created?: number;
    ran?: number;
    completed?: number;
  };
};

interface HistorySnapshot {
  sessionID: string;
  selectionGeneration: number;
  controller: AbortController;
  mode: "latest" | "older";
  cursor?: string;
  priorCursor: string | null;
  priorMessages: ChatMessage[];
  priorParts: Map<string, Map<string, AssistantTextPart>>;
  priorToolParts: Map<string, Map<string, AssistantToolPart>>;
  bufferedEvents: BufferedAssistantEvent[];
}

interface HistoryMappingResult {
  messages: ChatMessage[];
  droppedReason?: HistoryDropReason;
}

export class OpenCodeChat {
  private currentState: ChatState = initialChatState;
  private readonly listeners = new Set<(state: ChatState) => void>();
  private readonly messageViews = new Set<object>();
  private client: OpenCodeSdkClient | undefined;
  private serverUrl: string | undefined;
  private directory: string | undefined;
  private connectionController: AbortController | undefined;
  private sessionListController: AbortController | undefined;
  private choicesController: AbortController | undefined;
  private historyController: AbortController | undefined;
  private eventController: AbortController | undefined;
  private requestController: AbortController | undefined;
  private eventGeneration = 0;
  private connectionGeneration = 0;
  private selectionGeneration = 0;
  private activityGeneration = 0;
  private activityEventRevision = 0;
  private sessionListGeneration = 0;
  private choicesGeneration = 0;
  private choiceActionGeneration = 0;
  private eventArrivalOrdinal = 0;
  private disposed = false;
  private readonly unsubscribeConnection: () => void;
  private readonly seenEventIDs = new Set<string>();
  private readonly eventIDOrder: string[] = [];
  private readonly inFlightPromptAttemptIDs = new Set<string>();
  private readonly assistantParts = new Map<string, Map<string, AssistantTextPart>>();
  private readonly assistantToolParts = new Map<
    string,
    Map<string, AssistantToolPart>
  >();
  private readonly historyToolMessageIDs = new Set<string>();
  private activeHistorySnapshot: HistorySnapshot | undefined;
  private activeRequestSnapshot: PendingRequestSnapshot | undefined;
  private readonly inFlightRequestActions = new Set<string>();
  private streamReadiness:
    | { generation: number; resolve: () => void }
    | undefined;

  constructor(
    connection: OpenCodeConnection,
    private readonly getWorkspaceDirectory: () => string | undefined,
    private readonly clientFactory: OpenCodeSdkClientFactory = (serverUrl, directory) =>
      createOpencodeClient({ baseUrl: serverUrl, directory, redirect: "error" }),
    private readonly isWorkspaceTrusted: () => boolean = () => true,
    private readonly diagnostics: DiagnosticsSink = noDiagnostics,
  ) {
    this.unsubscribeConnection = connection.subscribe((state) => {
      if (state.status === "connected") {
        void this.connect(state.serverUrl, this.getWorkspaceDirectory());
        return;
      }
      if (this.client) void this.disconnect();
    });
  }

  get state(): ChatState {
    return this.currentState;
  }

  get connectedWorkspaceDirectory(): string | undefined {
    return this.client ? this.directory : undefined;
  }

  subscribe(listener: (state: ChatState) => void): () => void {
    const view = {};
    const wasEmpty = this.messageViews.size === 0;
    this.messageViews.add(view);
    this.listeners.add(listener);
    listener(this.currentState);
    if (wasEmpty && this.client && this.currentState.selectedSessionID) {
      void this.selectSession(this.currentState.selectedSessionID);
    }

    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
      this.messageViews.delete(view);
      if (this.messageViews.size === 0) this.pauseEventStream();
    };
  }

  async refreshSessions(): Promise<void> {
    await this.loadSessionPage({
      search: this.currentState.sessionSearch,
      mode: "replace",
    });
  }

  async searchSessions(query: string): Promise<void> {
    const parsedQuery = z.string().max(MAX_SESSION_SEARCH_LENGTH).safeParse(query);
    if (!parsedQuery.success) {
      this.setState({ sessionsError: "Session search text is too long." });
      return;
    }
    await this.loadSessionPage({
      search: parsedQuery.data.trim(),
      mode: "replace",
    });
  }

  async loadMoreSessions(): Promise<void> {
    const cursor = this.currentState.sessionNextCursor;
    if (
      !cursor ||
      this.currentState.loadingSessions ||
      this.currentState.loadingMoreSessions
    ) {
      return;
    }
    await this.loadSessionPage({
      search: this.currentState.sessionSearch,
      cursor,
      mode: "append",
    });
  }

  async refreshChoices(): Promise<void> {
    const client = this.client;
    const directory = this.directory;
    const connectionGeneration = this.connectionGeneration;
    if (!client || !directory) return;

    this.choicesController?.abort();
    const controller = new AbortController();
    const generation = ++this.choicesGeneration;
    this.choicesController = controller;
    const signal = this.connectionController
      ? AbortSignal.any([controller.signal, this.connectionController.signal])
      : controller.signal;
    this.setState({
      providerChoicesStatus: "loading",
      providerChoicesError: null,
      modelChoicesStatus: "loading",
      modelChoicesError: null,
      agentChoicesStatus: "loading",
      agentChoicesError: null,
      choiceError: null,
    });

    const location = { directory };
    const [providerResult, modelResult, agentResult] = await Promise.all([
      loadServerChoiceList(
        async () =>
          (await client.v2.provider.list({ location }, { signal, throwOnError: true }))
            .data.data,
        z.array(serverProviderSchema).max(256),
        "Provider discovery uses an experimental endpoint. Check the OpenCode 1.19.0 server and retry choices.",
      ),
      loadServerChoiceList(
        async () =>
          (await client.v2.model.list({ location }, { signal, throwOnError: true }))
            .data.data,
        z.array(serverModelSchema).max(2_000),
        "Model discovery uses an experimental endpoint. Check the OpenCode 1.19.0 server and retry choices.",
      ),
      loadServerChoiceList(
        async () =>
          (await client.v2.agent.list({ location }, { signal, throwOnError: true }))
            .data.data,
        z.array(serverAgentSchema).max(256),
        "Agent choices could not be loaded. Check the workspace and retry choices.",
      ),
    ]);

    if (
      generation !== this.choicesGeneration ||
      connectionGeneration !== this.connectionGeneration ||
      this.client !== client ||
      controller.signal.aborted
    ) {
      return;
    }

    this.setState({
      providers:
        providerResult.status === "ready"
          ? providerResult.items.map((provider) => ({
              id: provider.id,
              name: provider.name,
            }))
          : [],
      providerChoicesStatus: providerResult.status,
      providerChoicesError:
        providerResult.status === "unavailable" ? providerResult.error : null,
      models:
        modelResult.status === "ready"
          ? modelResult.items.map((model) => ({
              id: model.id,
              providerID: model.providerID,
              name: model.name,
              enabled: model.enabled,
              variants: model.variants.map((variant) => variant.id),
            }))
          : [],
      modelChoicesStatus: modelResult.status,
      modelChoicesError:
        modelResult.status === "unavailable" ? modelResult.error : null,
      agents:
        agentResult.status === "ready"
          ? agentResult.items
              .filter((agent) => !agent.hidden)
              .map((agent) => ({
                id: agent.id,
                ...(agent.description === undefined
                  ? {}
                  : { description: agent.description }),
              }))
          : [],
      agentChoicesStatus: agentResult.status,
      agentChoicesError:
        agentResult.status === "unavailable" ? agentResult.error : null,
    });

    if (this.choicesController === controller) this.choicesController = undefined;
  }

  async createSession(): Promise<void> {
    const client = this.client;
    const directory = this.directory;
    const generation = this.connectionGeneration;
    if (!client || !directory || this.currentState.sending) return;

    this.setState({ loadingSessions: true, error: null });
    try {
      const response = await client.v2.session.create(
        {
          location: { directory },
          ...(this.isAvailableModel(this.currentState.selectedModel)
            ? { model: this.currentState.selectedModel }
            : {}),
          ...(this.isAvailableAgent(this.currentState.selectedAgent)
            ? { agent: this.currentState.selectedAgent }
            : {}),
        },
        { signal: this.connectionController?.signal, throwOnError: true },
      );
      if (generation !== this.connectionGeneration || this.client !== client) return;

      const session = toChatSession(serverSessionSchema.parse(response.data.data));
      const sessions = [
        session,
        ...this.currentState.sessions.filter((item) => item.id !== session.id),
      ].slice(0, SESSION_LIST_MAX);
      this.sessionListGeneration += 1;
      this.sessionListController?.abort();
      this.setState({
        sessions,
        sessionSearch: "",
        sessionNextCursor: null,
        loadingSessions: false,
        loadingMoreSessions: false,
        sessionsError: null,
        selectedModel: session.model ?? null,
        selectedAgent: session.agent ?? null,
      });
      await this.selectSession(session.id);
      await this.refreshSessions();
    } catch {
      if (generation !== this.connectionGeneration || this.client !== client) return;
      this.setState({
        loadingSessions: false,
        error: "Could not create an OpenCode session. Try again.",
      });
    }
  }

  async selectModel(providerID: string, modelID: string): Promise<void> {
    const model = this.currentState.models.find(
      (item) =>
        item.providerID === providerID && item.id === modelID && item.enabled,
    );
    if (!model) {
      this.setState({ choiceError: "Choose a model returned by OpenCode." });
      return;
    }
    const reference: ChatModelReference = { id: model.id, providerID: model.providerID };
    const sessionID = this.currentState.selectedSessionID;
    if (!sessionID) {
      this.setState({ selectedModel: reference, choiceError: null });
      return;
    }
    if (
      this.currentState.selectedModel?.id === reference.id &&
      this.currentState.selectedModel.providerID === reference.providerID
    ) {
      return;
    }

    const client = this.client;
    if (!client) return;
    await this.switchSessionChoice(
      "model",
      sessionID,
      () =>
        client.v2.session.switchModel(
          { sessionID, model: reference },
          { signal: this.connectionController?.signal, throwOnError: true },
        ),
      () => {
        this.setSessionChoice(sessionID, { model: reference });
        this.setState({ selectedModel: reference });
      },
    );
  }

  async selectAgent(agentID: string): Promise<void> {
    if (!this.isAvailableAgent(agentID)) {
      this.setState({ choiceError: "Choose an agent returned by OpenCode." });
      return;
    }
    const sessionID = this.currentState.selectedSessionID;
    if (!sessionID) {
      this.setState({ selectedAgent: agentID, choiceError: null });
      return;
    }
    if (this.currentState.selectedAgent === agentID) return;

    const client = this.client;
    if (!client) return;
    await this.switchSessionChoice(
      "agent",
      sessionID,
      () =>
        client.v2.session.switchAgent(
          { sessionID, agent: agentID },
          { signal: this.connectionController?.signal, throwOnError: true },
        ),
      () => {
        this.setSessionChoice(sessionID, { agent: agentID });
        this.setState({ selectedAgent: agentID });
      },
    );
  }

  beginSessionDeletionConfirmation(sessionID: string): ChatSession | undefined {
    if (
      !sessionIdSchema.safeParse(sessionID).success ||
      this.currentState.deletingSessionID !== null
    ) {
      return undefined;
    }
    const session = this.findSession(sessionID);
    if (!session) return undefined;
    this.setState({ deletingSessionID: sessionID, sessionsError: null });
    return session;
  }

  cancelSessionDeletionConfirmation(sessionID: string): void {
    if (this.currentState.deletingSessionID === sessionID) {
      this.setState({ deletingSessionID: null });
    }
  }

  async deleteSession(sessionID: string): Promise<void> {
    const client = this.client;
    const directory = this.directory;
    const generation = this.connectionGeneration;
    if (
      !client ||
      !directory ||
      this.currentState.deletingSessionID !== sessionID ||
      !this.findSession(sessionID)
    ) {
      return;
    }

    try {
      const response = await client.session.delete(
        { sessionID, directory },
        { signal: this.connectionController?.signal, throwOnError: true },
      );
      if (generation !== this.connectionGeneration || this.client !== client) return;
      if (response.data !== true) throw new Error("Session deletion was not confirmed.");

      const wasSelected = this.currentState.selectedSessionID === sessionID;
      this.setState({
        sessions: this.currentState.sessions.filter((session) => session.id !== sessionID),
        ...(wasSelected
          ? {
              selectedSessionID: null,
              activeSession: null,
              sessionActivity: "unknown" as const,
              sessionActivityRefreshing: false,
              sessionActivityError: null,
              sessionActivityErrorCategory: null,
              sessionActivityHttpStatus: null,
              interruptStatus: "idle" as const,
              interruptError: null,
              messages: [],
              historyNextCursor: null,
              sessionDiffs: [],
              permissionRequests: [],
              questionRequests: [],
              loadingRequests: false,
              requestError: null,
              activeRequestAction: null,
              loadingMessages: false,
              loadingOlderMessages: false,
              historyError: null,
              selectedModel: null,
              selectedAgent: null,
              streamStatus: "inactive" as const,
            }
          : {}),
        sessionNextCursor: null,
        sessionsError: null,
      });
      if (wasSelected) {
        this.selectionGeneration += 1;
        this.activeHistorySnapshot?.controller.abort();
        this.activeHistorySnapshot = undefined;
        this.historyController?.abort();
        this.historyController = undefined;
        this.requestController?.abort();
        this.requestController = undefined;
        this.activeRequestSnapshot = undefined;
        this.stopEventStream();
        this.assistantParts.clear();
        this.assistantToolParts.clear();
        this.historyToolMessageIDs.clear();
      }
      await this.refreshSessions();
    } catch {
      if (generation !== this.connectionGeneration || this.client !== client) return;
      this.setState({
        sessionsError:
          "OpenCode could not delete this session. Check the connection and try again.",
      });
    }
  }

  async selectSession(sessionID: string): Promise<void> {
    const client = this.client;
    const selectedSession =
      this.currentState.sessions.find((session) => session.id === sessionID) ??
      (this.currentState.activeSession?.id === sessionID
        ? this.currentState.activeSession
        : undefined);
    if (
      !client ||
      this.currentState.sending ||
      !sessionIdSchema.safeParse(sessionID).success ||
      !selectedSession
    ) {
      return;
    }

    const selectionGeneration = ++this.selectionGeneration;
    this.activityGeneration += 1;
    this.activityEventRevision += 1;
    this.choiceActionGeneration += 1;
    this.activeHistorySnapshot?.controller.abort();
    this.activeHistorySnapshot = undefined;
    this.historyController?.abort();
    this.historyController = undefined;
    this.requestController?.abort();
    this.requestController = undefined;
    this.activeRequestSnapshot = undefined;
    this.stopEventStream();
    this.assistantParts.clear();
    this.assistantToolParts.clear();
    this.historyToolMessageIDs.clear();
    this.seenEventIDs.clear();
    this.eventIDOrder.length = 0;
    this.setState({
      selectedSessionID: sessionID,
      activeSession: selectedSession,
      messages: [],
      historyNextCursor: null,
      loadingOlderMessages: false,
      selectedModel: selectedSession.model ?? null,
      selectedAgent: selectedSession.agent ?? null,
      switchingChoice: null,
      choiceError: null,
      sessionDiffs: [],
      permissionRequests: [],
      questionRequests: [],
      loadingRequests: true,
      requestError: null,
      activeRequestAction: null,
      loadingMessages: true,
      historyError: null,
      sending: false,
      sessionActivity: "unknown",
      sessionActivityRefreshing: true,
      sessionActivityError: null,
      sessionActivityErrorCategory: null,
      sessionActivityHttpStatus: null,
      interruptStatus: "idle",
      interruptError: null,
      streamStatus: "inactive",
      error:
        this.currentState.promptResult?.status === "outcome-unknown" &&
        this.currentState.promptResult.sessionID === sessionID
          ? this.currentState.error
          : null,
    });
    void this.refreshSessionActivityFor(sessionID, selectionGeneration);
    const snapshot = this.beginHistorySnapshot(sessionID, selectionGeneration);
    const requestSnapshot = this.beginRequestSnapshot(
      client,
      sessionID,
      selectionGeneration,
    );
    if (this.messageViews.size > 0) {
      await this.startEventStream(sessionID, selectionGeneration);
    }
    if (!this.isCurrentSnapshot(snapshot, client)) return;
    await Promise.all([
      this.loadAndReconcileHistory(client, snapshot),
      this.loadSessionRequests(requestSnapshot),
    ]);
  }

  async reviewSelectedSessionHistory(): Promise<void> {
    const client = this.client;
    const sessionID = this.currentState.selectedSessionID;
    const selectionGeneration = this.selectionGeneration;
    if (
      !client ||
      !sessionID ||
      this.currentState.sending ||
      !sessionIdSchema.safeParse(sessionID).success
    ) {
      return;
    }

    const snapshot = this.beginHistorySnapshot(sessionID, selectionGeneration);
    await this.loadAndReconcileHistory(client, snapshot);
  }

  async loadOlderHistory(): Promise<void> {
    const client = this.client;
    const sessionID = this.currentState.selectedSessionID;
    const cursor = this.currentState.historyNextCursor;
    const selectionGeneration = this.selectionGeneration;
    if (
      !client ||
      !sessionID ||
      !cursor ||
      this.currentState.loadingMessages ||
      this.currentState.loadingOlderMessages ||
      this.currentState.sending
    ) {
      return;
    }

    const snapshot = this.beginHistorySnapshot(
      sessionID,
      selectionGeneration,
      "older",
      cursor,
    );
    await this.loadAndReconcileHistory(client, snapshot);
  }

  private async loadSessionPage(options: {
    search: string;
    cursor?: string;
    mode: "replace" | "append";
  }): Promise<void> {
    const client = this.client;
    const directory = this.directory;
    const connectionGeneration = this.connectionGeneration;
    if (!client || !directory) return;
    if (options.mode === "append" && !options.cursor) return;

    if (options.mode === "replace") {
      this.sessionListController?.abort();
    }
    const controller = new AbortController();
    const generation = options.mode === "replace"
      ? ++this.sessionListGeneration
      : this.sessionListGeneration;
    this.sessionListController = controller;
    const signal = this.connectionController
      ? AbortSignal.any([controller.signal, this.connectionController.signal])
      : controller.signal;
    const searchChanged = options.search !== this.currentState.sessionSearch;
    this.setState({
      sessionSearch: options.search,
      loadingSessions: options.mode === "replace",
      loadingMoreSessions: options.mode === "append",
      sessionsError: null,
      ...(searchChanged
        ? { sessions: [], sessionNextCursor: null }
        : {}),
    });

    try {
      const response = await client.v2.session.list(
        {
          directory,
          limit: SESSION_LIST_LIMIT,
          order: "desc",
          ...(options.search ? { search: options.search } : {}),
          ...(options.cursor ? { cursor: options.cursor } : {}),
        },
        { signal, throwOnError: true },
      );
      if (
        generation !== this.sessionListGeneration ||
        connectionGeneration !== this.connectionGeneration ||
        this.client !== client ||
        controller.signal.aborted
      ) {
        return;
      }

      const page = serverSessionPageSchema.safeParse(response.data);
      if (!page.success) throw new Error("Invalid session page response.");
      const pageSessions = page.data.data.map(toChatSession);
      const sessions = mergeSessionPage(
        options.mode === "append" ? this.currentState.sessions : [],
        pageSessions,
      ).slice(0, SESSION_LIST_MAX);
      const selectedID = this.currentState.selectedSessionID;
      const activeSession = selectedID
        ? sessions.find((session) => session.id === selectedID) ??
          this.currentState.activeSession
        : null;
      const nextCursor =
        sessions.length >= SESSION_LIST_MAX ||
        page.data.cursor.next === options.cursor
          ? null
          : page.data.cursor.next ?? null;
      this.setState({
        sessions,
        activeSession,
        sessionNextCursor: nextCursor,
        loadingSessions: false,
        loadingMoreSessions: false,
        sessionsError: null,
      });
      if (!selectedID && sessions[0]) await this.selectSession(sessions[0].id);
    } catch {
      if (
        generation !== this.sessionListGeneration ||
        connectionGeneration !== this.connectionGeneration ||
        this.client !== client
      ) {
        return;
      }
      this.setState({
        loadingSessions: false,
        loadingMoreSessions: false,
        sessionsError:
          "Could not load OpenCode sessions. Check the connection or search text, then try again.",
      });
    } finally {
      if (this.sessionListController === controller) {
        this.sessionListController = undefined;
      }
    }
  }

  private findSession(sessionID: string): ChatSession | undefined {
    return this.currentState.sessions.find((session) => session.id === sessionID) ??
      (this.currentState.activeSession?.id === sessionID
        ? this.currentState.activeSession
        : undefined);
  }

  private isAvailableModel(
    reference: ChatModelReference | null,
  ): reference is ChatModelReference {
    if (!reference) return false;
    const model = this.currentState.models.find(
      (item) => item.id === reference.id && item.providerID === reference.providerID,
    );
    return Boolean(
      model?.enabled &&
      (reference.variant === undefined || model.variants.includes(reference.variant)),
    );
  }

  private isAvailableAgent(agentID: string | null): agentID is string {
    return Boolean(agentID && this.currentState.agents.some((agent) => agent.id === agentID));
  }

  private setSessionChoice(
    sessionID: string,
    choice: { model?: ChatModelReference; agent?: string },
  ): void {
    const update = (session: ChatSession): ChatSession => ({
      ...session,
      ...(choice.model === undefined ? {} : { model: choice.model }),
      ...(choice.agent === undefined ? {} : { agent: choice.agent }),
    });
    this.setState({
      sessions: this.currentState.sessions.map((session) =>
        session.id === sessionID ? update(session) : session,
      ),
      activeSession:
        this.currentState.activeSession?.id === sessionID
          ? update(this.currentState.activeSession)
          : this.currentState.activeSession,
    });
  }

  private async switchSessionChoice(
    kind: "model" | "agent",
    sessionID: string,
    operation: () => Promise<unknown>,
    onAccepted: () => void,
  ): Promise<void> {
    if (this.currentState.switchingChoice !== null) return;
    const client = this.client;
    if (!client || this.currentState.selectedSessionID !== sessionID) return;
    const connectionGeneration = this.connectionGeneration;
    const selectionGeneration = this.selectionGeneration;
    const actionGeneration = ++this.choiceActionGeneration;
    this.setState({ switchingChoice: kind, choiceError: null });

    try {
      await operation();
      if (
        actionGeneration !== this.choiceActionGeneration ||
        connectionGeneration !== this.connectionGeneration ||
        selectionGeneration !== this.selectionGeneration ||
        this.client !== client ||
        this.currentState.selectedSessionID !== sessionID
      ) {
        return;
      }
      onAccepted();
      this.setState({ switchingChoice: null, choiceError: null });
    } catch {
      if (
        actionGeneration !== this.choiceActionGeneration ||
        connectionGeneration !== this.connectionGeneration ||
        selectionGeneration !== this.selectionGeneration ||
        this.client !== client ||
        this.currentState.selectedSessionID !== sessionID
      ) {
        return;
      }
      this.setState({
        switchingChoice: null,
        choiceError:
          kind === "model"
            ? "OpenCode did not confirm the model switch. Refresh choices and try again."
            : "OpenCode did not confirm the agent switch. Refresh choices and try again.",
      });
    }
  }

  async refreshSelectedRequests(): Promise<void> {
    const client = this.client;
    const sessionID = this.currentState.selectedSessionID;
    if (!client || !sessionID) return;

    const snapshot = this.beginRequestSnapshot(
      client,
      sessionID,
      this.selectionGeneration,
    );
    await this.loadSessionRequests(snapshot);
  }

  async refreshSessionActivity(sessionID: string): Promise<void> {
    if (
      !sessionIdSchema.safeParse(sessionID).success ||
      this.currentState.selectedSessionID !== sessionID
    ) {
      return;
    }
    await this.refreshSessionActivityFor(sessionID, this.selectionGeneration);
  }

  async interruptSession(sessionID: string): Promise<void> {
    const parsedSessionID = sessionIdSchema.safeParse(sessionID);
    const client = this.client;
    const connectionGeneration = this.connectionGeneration;
    const selectionGeneration = this.selectionGeneration;
    if (
      !parsedSessionID.success ||
      !client ||
      this.currentState.selectedSessionID !== sessionID ||
      this.currentState.sessionActivity !== "active" ||
      this.currentState.interruptStatus === "requesting" ||
      this.currentState.interruptStatus === "waiting"
    ) {
      return;
    }

    this.setState({ interruptStatus: "requesting", interruptError: null });
    try {
      const response = await client.v2.session.interrupt(
        { sessionID: parsedSessionID.data },
        { signal: this.connectionController?.signal, throwOnError: true },
      );
      if (
        connectionGeneration !== this.connectionGeneration ||
        selectionGeneration !== this.selectionGeneration ||
        this.client !== client ||
        this.currentState.selectedSessionID !== sessionID
      ) {
        return;
      }
      if (getResponseHttpStatus(response) !== 204) {
        throw new Error("OpenCode returned an unexpected interrupt response.");
      }

      if (!isSessionActivityInactive(this.currentState)) {
        this.setState({ interruptStatus: "waiting", interruptError: null });
        await this.refreshSessionActivityFor(sessionID, selectionGeneration);
      }
    } catch {
      if (
        connectionGeneration !== this.connectionGeneration ||
        selectionGeneration !== this.selectionGeneration ||
        this.client !== client ||
        this.currentState.selectedSessionID !== sessionID ||
        this.currentState.sessionActivity !== "active"
      ) {
        return;
      }
      this.setState({
        interruptStatus: "error",
        interruptError:
          "OpenCode could not confirm the stop request. Check the connection and retry.",
      });
    }
  }

  private async refreshSessionActivityFor(
    sessionID: string,
    selectionGeneration: number,
  ): Promise<void> {
    const client = this.client;
    const connectionGeneration = this.connectionGeneration;
    if (
      !client ||
      this.currentState.selectedSessionID !== sessionID ||
      this.selectionGeneration !== selectionGeneration
    ) {
      return;
    }

    const requestGeneration = ++this.activityGeneration;
    const eventRevision = this.activityEventRevision;
    const diagnosticFlow = this.diagnostics.createFlow();
    this.setState({
      sessionActivityRefreshing: true,
    });
    try {
      const activeMethod = client.v2.session.active;
      if (typeof activeMethod !== "function") {
        throw Object.assign(new Error(), { activityReason: "sdk-unavailable" as const });
      }
      const response = await activeMethod.call(client.v2.session);
      const responseStatus = getResponseHttpStatus(response);
      if (
        (("error" in response && response.error !== undefined) ||
          (responseStatus !== undefined && (responseStatus < 200 || responseStatus >= 300)))
      ) {
        throw Object.assign(new Error(), {
          activityReason: responseStatus === undefined ? "request-failed" as const : "http-error" as const,
          ...(responseStatus === undefined ? {} : { activityHttpStatus: responseStatus }),
        });
      }
      const responseBody = response.data;
      const activeSessionPayload =
        isRecord(responseBody) &&
          Object.prototype.hasOwnProperty.call(responseBody, "data")
          ? responseBody.data
          : undefined;
      const parsedActiveSessions = activeSessionMapSchema.safeParse(
        activeSessionPayload,
      );
      if (!parsedActiveSessions.success) {
        throw Object.assign(new Error(), { activityReason: "invalid-shape" as const });
      }
      const activeSessions = parsedActiveSessions.data;
      if (
        !this.isCurrentActivityRequest(
          client,
          sessionID,
          connectionGeneration,
          selectionGeneration,
          requestGeneration,
          eventRevision,
        )
      ) {
        return;
      }

      const isActive = Object.prototype.hasOwnProperty.call(
        activeSessions,
        sessionID,
      );
      this.setState({
        sessionActivity: isActive ? "active" : "inactive",
        sessionActivityRefreshing: false,
        sessionActivityError: null,
        sessionActivityErrorCategory: null,
        sessionActivityHttpStatus: null,
        ...(!isActive
          ? { interruptStatus: "idle" as const, interruptError: null }
          : {}),
      });
    } catch (error) {
      if (
        !this.isCurrentActivityRequest(
          client,
          sessionID,
          connectionGeneration,
          selectionGeneration,
          requestGeneration,
          eventRevision,
        )
      ) {
        return;
      }
      const status = isRecord(error)
        ? sanitizeHttpStatus(error.activityHttpStatus) ?? getHttpStatus(error)
        : getHttpStatus(error);
      const reason: ActivityDiagnosticReason =
        isRecord(error) && error.activityReason === "sdk-unavailable"
          ? "sdk-unavailable"
          : isRecord(error) && error.activityReason === "invalid-shape"
            ? "invalid-shape"
            : status === undefined
              ? "request-failed"
              : "http-error";
      this.diagnostics.record({
        type: "session.activity.failed",
        flow: diagnosticFlow,
        reason,
        ...(status === undefined ? {} : { httpStatus: status }),
      });
      this.setState({
        sessionActivityRefreshing: false,
        sessionActivityErrorCategory: reason,
        sessionActivityHttpStatus: status ?? null,
        sessionActivityError: activityFailureMessage(reason, status),
      });
    }
  }

  private isCurrentActivityRequest(
    client: OpenCodeSdkClient,
    sessionID: string,
    connectionGeneration: number,
    selectionGeneration: number,
    requestGeneration: number,
    eventRevision: number,
  ): boolean {
    return (
      !this.disposed &&
      this.client === client &&
      this.connectionGeneration === connectionGeneration &&
      this.currentState.selectedSessionID === sessionID &&
      this.selectionGeneration === selectionGeneration &&
      this.activityGeneration === requestGeneration &&
      this.activityEventRevision === eventRevision
    );
  }

  async replyToPermission(
    sessionID: string,
    requestID: string,
    reply: "once" | "always" | "reject",
  ): Promise<void> {
    const parsedSessionID = sessionIdSchema.safeParse(sessionID);
    const parsedRequestID = pendingRequestIDSchema.safeParse(requestID);
    const parsedReply = permissionReplySchema.safeParse(reply);
    if (!parsedSessionID.success || !parsedRequestID.success || !parsedReply.success) {
      this.setState({ requestError: "The permission response is invalid." });
      return;
    }

    await this.performRequestAction(
      {
        sessionID: parsedSessionID.data,
        requestID: parsedRequestID.data,
        kind: "permission",
        action: parsedReply.data,
        status: "submitting",
      },
      (client, signal) =>
        client.v2.session.permission.reply(
          {
            sessionID: parsedSessionID.data,
            requestID: parsedRequestID.data,
            reply: parsedReply.data,
          },
          { signal, throwOnError: true },
        ),
    );
  }

  async replyToQuestion(
    sessionID: string,
    requestID: string,
    answers: string[][],
  ): Promise<void> {
    const parsedSessionID = sessionIdSchema.safeParse(sessionID);
    const parsedRequestID = pendingRequestIDSchema.safeParse(requestID);
    const parsedAnswers = questionAnswersSchema.safeParse(answers);
    const request = this.currentState.questionRequests.find(
      (item) =>
        item.sessionID === sessionID &&
        requestCorrelationKey(item.sessionID, item.id) ===
          requestCorrelationKey(sessionID, requestID),
    );
    if (
      !parsedSessionID.success ||
      !parsedRequestID.success ||
      !parsedAnswers.success ||
      !request ||
      parsedAnswers.data.length !== request.questions.length
    ) {
      this.setState({
        requestError: "The answers do not match a pending question request. Refresh requests and try again.",
      });
      return;
    }

    await this.performRequestAction(
      {
        sessionID: parsedSessionID.data,
        requestID: parsedRequestID.data,
        kind: "question",
        action: "answer",
        status: "submitting",
      },
      (client, signal) =>
        client.v2.session.question.reply(
          {
            sessionID: parsedSessionID.data,
            requestID: parsedRequestID.data,
            questionV2Reply: { answers: parsedAnswers.data },
          },
          { signal, throwOnError: true },
        ),
    );
  }

  async rejectQuestion(sessionID: string, requestID: string): Promise<void> {
    const parsedSessionID = sessionIdSchema.safeParse(sessionID);
    const parsedRequestID = pendingRequestIDSchema.safeParse(requestID);
    if (!parsedSessionID.success || !parsedRequestID.success) {
      this.setState({ requestError: "The question rejection is invalid." });
      return;
    }

    await this.performRequestAction(
      {
        sessionID: parsedSessionID.data,
        requestID: parsedRequestID.data,
        kind: "question",
        action: "reject",
        status: "submitting",
      },
      (client, signal) =>
        client.v2.session.question.reject(
          {
            sessionID: parsedSessionID.data,
            requestID: parsedRequestID.data,
          },
          { signal, throwOnError: true },
        ),
    );
  }

  async sendPrompt(
    requestID: string,
    attemptID: string,
    text: string,
    targetSessionID: string,
  ): Promise<void> {
    const diagnosticFlow = this.diagnostics.createFlow();
    const diagnosticStartedAt = Date.now();
    let diagnosticFinished = false;
    const finishDiagnostic = (
      outcome: "accepted" | "rejected" | "unknown",
      httpStatus?: number,
      reason?: PromptDiagnosticReason,
    ): void => {
      if (diagnosticFinished) return;
      diagnosticFinished = true;
      this.diagnostics.record({
        type: "prompt.submission.finished",
        flow: diagnosticFlow,
        outcome,
        durationMs: Date.now() - diagnosticStartedAt,
        ...(httpStatus === undefined ? {} : { httpStatus }),
        ...(reason ? { reason } : {}),
      });
    };
    this.diagnostics.record({
      type: "prompt.submission.started",
      flow: diagnosticFlow,
      characterCount: typeof text === "string" ? Math.min(text.length, 1_000_000) : 0,
      delivery: "steer",
    });

    const parsedRequestID = promptRequestIDSchema.safeParse(requestID);
    const parsedAttemptID = promptRequestIDSchema.safeParse(attemptID);
    const parsedText = promptTextSchema.safeParse(text);
    const parsedTargetSessionID = sessionIdSchema.safeParse(targetSessionID);
    const client = this.client;
    const selectionGeneration = this.selectionGeneration;
    const connectionGeneration = this.connectionGeneration;
    if (
      !parsedRequestID.success ||
      !parsedAttemptID.success ||
      !parsedText.success ||
      this.inFlightPromptAttemptIDs.has(attemptID)
    ) {
      finishDiagnostic(
        "rejected",
        undefined,
        parsedRequestID.success &&
          parsedAttemptID.success &&
          parsedText.success &&
          this.inFlightPromptAttemptIDs.has(attemptID)
          ? "duplicate-attempt"
          : "invalid-input",
      );
      return;
    }
    if (!parsedTargetSessionID.success) {
      finishDiagnostic("rejected", undefined, "invalid-session");
      this.setPromptResult(requestID, attemptID, null, "rejected");
      this.setState({
        error: "The target session is invalid. The prompt was not sent.",
      });
      return;
    }
    const sessionID = parsedTargetSessionID.data;
    if (this.currentState.selectedSessionID !== sessionID) {
      finishDiagnostic("rejected", undefined, "session-changed");
      this.setPromptResult(requestID, attemptID, sessionID, "rejected");
      this.setState({
        error: "The selected session changed before submission. The prompt was not sent.",
      });
      return;
    }
    if (!client || this.currentState.streamStatus !== "connected") {
      finishDiagnostic("rejected", undefined, "connection-not-ready");
      this.setState({
        promptResult: { requestID, attemptID, sessionID, status: "rejected" },
        error: "OpenCode is not ready to accept a prompt. The draft is preserved.",
      });
      return;
    }
    if (this.currentState.sending) {
      finishDiagnostic("rejected", undefined, "submission-in-progress");
      this.setState({
        promptResult: { requestID, attemptID, sessionID, status: "rejected" },
        error: "Another prompt is being submitted. This request was not sent.",
      });
      return;
    }

    this.inFlightPromptAttemptIDs.add(attemptID);
    this.setState({
      sending: true,
      promptResult: { requestID, attemptID, sessionID, status: "submitting" },
      error: null,
    });
    try {
      const serverMessageID = `msg_${requestID}`;
      const response = await client.v2.session.prompt(
        {
          sessionID,
          id: serverMessageID,
          prompt: { text: parsedText.data },
          delivery: "steer",
        },
        { signal: this.connectionController?.signal, throwOnError: true },
      );
      if (
        connectionGeneration !== this.connectionGeneration ||
        this.client !== client ||
        selectionGeneration !== this.selectionGeneration ||
        this.currentState.selectedSessionID !== sessionID
      ) {
        finishDiagnostic(
          "unknown",
          getResponseHttpStatus(response),
          "context-changed",
        );
        return;
      }

      const responseStatus = getResponseHttpStatus(response);
      const result = serverPromptAdmissionSchema.safeParse(response.data.data);
      if (
        !result.success ||
        result.data.sessionID !== sessionID ||
        result.data.id !== serverMessageID ||
        result.data.prompt.text !== parsedText.data ||
        result.data.delivery !== "steer"
      ) {
        finishDiagnostic("unknown", responseStatus, "response-invalid");
        this.setPromptResult(
          requestID,
          attemptID,
          sessionID,
          "outcome-unknown",
          responseStatus,
        );
        this.setState({
          sending: false,
          error: promptOutcomeUnknownMessage(),
        });
        return;
      }
      const admitted = result.data;
      this.upsertMessage({
        id: admitted.id,
        role: "user",
        text: admitted.prompt.text,
      });
      finishDiagnostic("accepted", responseStatus);
      this.setState({
        sending: false,
        promptResult: { requestID, attemptID, sessionID, status: "accepted" },
        error: null,
      });
      void this.refreshSessions();
    } catch (error) {
      if (
        connectionGeneration !== this.connectionGeneration ||
        this.client !== client ||
        selectionGeneration !== this.selectionGeneration ||
        this.currentState.selectedSessionID !== sessionID
      ) {
        finishDiagnostic("unknown", getHttpStatus(error), "context-changed");
        return;
      }
      if (isDefinitivePromptRejection(error)) {
        finishDiagnostic("rejected", getHttpStatus(error), "server-rejected");
        this.setState({
          sending: false,
          promptResult: { requestID, attemptID, sessionID, status: "rejected" },
          error: "OpenCode rejected the prompt. The draft is preserved; edit it or explicitly try again.",
        });
        return;
      }
      const httpStatus = getHttpStatus(error);
      finishDiagnostic("unknown", httpStatus, "transport-uncertain");
      this.setPromptResult(
        requestID,
        attemptID,
        sessionID,
        "outcome-unknown",
        httpStatus,
      );
      this.setState({
        sending: false,
        error: promptOutcomeUnknownMessage(httpStatus),
      });
    } finally {
      if (!diagnosticFinished) {
        finishDiagnostic("unknown", undefined, "interrupted");
      }
      this.inFlightPromptAttemptIDs.delete(attemptID);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeConnection();
    await this.disconnect();
    this.listeners.clear();
    this.messageViews.clear();
  }

  private async connect(serverUrl: string, directory: string | undefined): Promise<void> {
    if (this.disposed) return;
    if (!this.isWorkspaceTrusted()) {
      await this.disconnect();
      this.setState({
        error: "Trust this workspace to access OpenCode sessions and send prompts.",
      });
      return;
    }
    if (!directory) {
      await this.disconnect();
      this.setState({
        error: "Open a workspace folder to use OpenCode sessions and chat.",
      });
      return;
    }
    if (this.client && this.serverUrl === serverUrl && this.directory === directory) return;

    await this.disconnect();
    if (this.disposed) return;
    const client = this.clientFactory(serverUrl, directory);
    this.client = client;
    this.serverUrl = serverUrl;
    this.directory = directory;
    this.connectionController = new AbortController();
    this.setState({ loadingSessions: true, error: null });
    await Promise.all([this.refreshSessions(), this.refreshChoices()]);
  }

  private async disconnect(): Promise<void> {
    const promptResult =
      this.currentState.promptResult?.status === "submitting"
        ? {
            ...this.currentState.promptResult,
            status: "outcome-unknown" as const,
          }
        : this.currentState.promptResult;
    const promptError =
      promptResult?.status === "outcome-unknown" || promptResult?.status === "rejected"
        ? this.currentState.error
        : null;
    this.connectionGeneration += 1;
    this.selectionGeneration += 1;
    this.activityGeneration += 1;
    this.activityEventRevision += 1;
    this.sessionListGeneration += 1;
    this.choicesGeneration += 1;
    this.choiceActionGeneration += 1;
    this.connectionController?.abort();
    this.connectionController = undefined;
    this.sessionListController?.abort();
    this.sessionListController = undefined;
    this.choicesController?.abort();
    this.choicesController = undefined;
    this.historyController?.abort();
    this.historyController = undefined;
    this.requestController?.abort();
    this.requestController = undefined;
    this.stopEventStream();
    this.client = undefined;
    this.serverUrl = undefined;
    this.directory = undefined;
    this.assistantParts.clear();
    this.assistantToolParts.clear();
    this.historyToolMessageIDs.clear();
    this.seenEventIDs.clear();
    this.eventIDOrder.length = 0;
    this.activeHistorySnapshot?.controller.abort();
    this.activeHistorySnapshot = undefined;
    this.activeRequestSnapshot = undefined;
    this.setState({
      ...initialChatState,
      promptResult,
      ...(promptError ? { error: promptError } : {}),
    });
  }

  private startEventStream(
    sessionID: string,
    selectionGeneration: number,
  ): Promise<void> {
    const client = this.client;
    if (!client || this.messageViews.size === 0) return Promise.resolve();

    const controller = new AbortController();
    const generation = ++this.eventGeneration;
    this.eventController = controller;
    this.setState({ streamStatus: "connecting" });
    const diagnosticFlow = this.diagnostics.createFlow();
    this.diagnostics.record({
      type: "stream.connection.started",
      flow: diagnosticFlow,
    });
    const readiness = new Promise<void>((resolve) => {
      this.streamReadiness = { generation, resolve };
    });
    void this.consumeEventStream(
      client,
      sessionID,
      selectionGeneration,
      generation,
      controller.signal,
      diagnosticFlow,
    );
    return readiness;
  }

  private async consumeEventStream(
    client: OpenCodeSdkClient,
    sessionID: string,
    selectionGeneration: number,
    generation: number,
    signal: AbortSignal,
    diagnosticFlow: DiagnosticFlow,
  ): Promise<void> {
    let hasConnected = false;
    try {
      const { stream } = await client.v2.event.subscribe({
        signal,
        sseMaxRetryAttempts: EVENT_RETRY_LIMIT,
        sseDefaultRetryDelay: 250,
        sseMaxRetryDelay: 1_000,
        onSseError: () => {
          if (this.isCurrentStream(generation, selectionGeneration, signal)) {
            this.diagnostics.record({
              type: "stream.connection.failed",
              flow: diagnosticFlow,
              reason: "retry",
            });
            this.setState({
              streamStatus: "error",
              error: "Live OpenCode updates were interrupted. Select the session to reconnect.",
            });
          }
        },
      });

      for await (const rawEvent of stream) {
        if (!this.isCurrentStream(generation, selectionGeneration, signal)) return;
        const eventEnvelope = v2EventEnvelopeSchema.safeParse(rawEvent);
        if (!eventEnvelope.success || this.isDuplicateEvent(eventEnvelope.data.id)) continue;

        if (eventEnvelope.data.type === "server.connected") {
          this.diagnostics.record({
            type: "stream.connection.ready",
            flow: diagnosticFlow,
            phase: hasConnected ? "reconnected" : "connected",
          });
          this.setState({ streamStatus: "connected", error: null });
          if (!hasConnected) {
            hasConnected = true;
            this.resolveStreamReadiness(generation);
          } else if (this.currentState.selectedSessionID === sessionID) {
            void this.refreshSessionActivityFor(sessionID, selectionGeneration);
            this.beginReconnectSnapshot(client, sessionID, selectionGeneration);
          }
          continue;
        }

        if (eventEnvelope.data.type === "session.status") {
          const event = sessionStatusEventSchema.safeParse(rawEvent);
          if (!event.success || event.data.data.sessionID !== sessionID) continue;
          if (event.data.data.status === "idle") {
            this.reconcileSelectedSessionIdle(sessionID, selectionGeneration);
          } else {
            this.receiveSelectedSessionBusy(sessionID, selectionGeneration);
          }
          this.setState({ streamStatus: "connected", error: null });
          continue;
        }

        if (eventEnvelope.data.type === "session.idle") {
          const event = sessionIdleEventSchema.safeParse(rawEvent);
          if (!event.success || event.data.data.sessionID !== sessionID) continue;
          this.reconcileSelectedSessionIdle(sessionID, selectionGeneration);
          this.setState({ streamStatus: "connected", error: null });
          continue;
        }

        const requestEvent = parsePendingRequestEvent(rawEvent);
        if (requestEvent) {
          if (pendingRequestEventSessionID(requestEvent) !== sessionID) continue;
          this.receivePendingRequestEvent(requestEvent, selectionGeneration);
          this.setState({ streamStatus: "connected", error: null });
          continue;
        }

        if (eventEnvelope.data.type === "session.next.text.delta") {
          const event = textDeltaEventSchema.safeParse(rawEvent);
          if (!event.success || event.data.data.sessionID !== sessionID) continue;
          this.receiveTextEvent({
            id: event.data.id,
            sessionID,
            messageID: event.data.data.assistantMessageID,
            partID: event.data.data.textID,
            timestamp: event.data.data.timestamp,
            durableSequence: durableEventSequence(rawEvent),
            delta: event.data.data.delta,
          }, selectionGeneration);
          this.setState({ streamStatus: "connected", error: null });
          continue;
        }

        if (eventEnvelope.data.type === "session.next.text.ended") {
          const event = textEndedEventSchema.safeParse(rawEvent);
          if (!event.success || event.data.data.sessionID !== sessionID) continue;
          this.receiveTextEvent({
            id: event.data.id,
            sessionID,
            messageID: event.data.data.assistantMessageID,
            partID: event.data.data.textID,
            timestamp: event.data.data.timestamp,
            durableSequence: durableEventSequence(rawEvent),
            endedText: event.data.data.text,
          }, selectionGeneration);
          this.setState({ streamStatus: "connected", error: null });
          continue;
        }

        if (eventEnvelope.data.type === "session.diff") {
          const event = sessionDiffEventSchema.safeParse(rawEvent);
          if (!event.success || event.data.data.sessionID !== sessionID) continue;
          this.setState({
            sessionDiffs: event.data.data.diff.map((diff) => ({
              ...(diff.file === undefined ? {} : { file: diff.file }),
              ...(diff.patch === undefined ? {} : { patch: diff.patch }),
              additions: diff.additions,
              deletions: diff.deletions,
              ...(diff.status === undefined ? {} : { status: diff.status }),
            })),
            streamStatus: "connected",
            error: null,
          });
          continue;
        }

        const toolEvent = parseToolEvent(rawEvent);
        if (toolEvent) {
          if (toolEvent.sessionID !== sessionID) continue;
          this.receiveToolEvent(toolEvent, selectionGeneration);
          this.setState({ streamStatus: "connected", error: null });
        }
      }

      if (this.isCurrentStream(generation, selectionGeneration, signal)) {
        this.diagnostics.record({
          type: "stream.connection.failed",
          flow: diagnosticFlow,
          reason: "ended",
        });
        this.setState({
          streamStatus: "error",
          error: "The OpenCode event stream ended. Select the session to reconnect.",
        });
      }
    } catch {
      if (this.isCurrentStream(generation, selectionGeneration, signal)) {
        this.diagnostics.record({
          type: "stream.connection.failed",
          flow: diagnosticFlow,
          reason: "transport",
        });
        this.setState({
          streamStatus: "error",
          error: "Could not receive live OpenCode updates. Select the session to reconnect.",
        });
      }
    } finally {
      this.resolveStreamReadiness(generation);
    }
  }

  private receiveSelectedSessionBusy(
    sessionID: string,
    selectionGeneration: number,
  ): void {
    if (
      this.selectionGeneration !== selectionGeneration ||
      this.currentState.selectedSessionID !== sessionID
    ) {
      return;
    }
    this.activityGeneration += 1;
    this.activityEventRevision += 1;
    this.setState({
      sessionActivity: "active",
      sessionActivityRefreshing: false,
      sessionActivityError: null,
      sessionActivityErrorCategory: null,
      sessionActivityHttpStatus: null,
    });
  }

  private reconcileSelectedSessionIdle(
    sessionID: string,
    selectionGeneration: number,
  ): void {
    if (
      this.selectionGeneration !== selectionGeneration ||
      this.currentState.selectedSessionID !== sessionID
    ) {
      return;
    }
    this.activityGeneration += 1;
    this.activityEventRevision += 1;
    void this.refreshSessionActivityFor(sessionID, selectionGeneration);
  }

  private beginHistorySnapshot(
    sessionID: string,
    selectionGeneration: number,
    mode: "latest" | "older" = "latest",
    cursor?: string,
  ): HistorySnapshot {
    this.activeHistorySnapshot?.controller.abort();
    this.historyController?.abort();
    const controller = new AbortController();
    const snapshot: HistorySnapshot = {
      sessionID,
      selectionGeneration,
      controller,
      mode,
      ...(cursor === undefined ? {} : { cursor }),
      priorCursor: this.currentState.historyNextCursor,
      priorMessages: uniqueMessages([
        ...(this.activeHistorySnapshot?.priorMessages ?? []),
        ...this.currentState.messages,
      ]),
      priorParts: cloneAssistantParts(this.assistantParts),
      priorToolParts: cloneAssistantToolParts(this.assistantToolParts),
      bufferedEvents: this.activeHistorySnapshot?.bufferedEvents ?? [],
    };
    this.activeHistorySnapshot = snapshot;
    this.historyController = controller;
    this.setState({
      loadingMessages: mode === "latest",
      loadingOlderMessages: mode === "older",
      historyError: null,
    });
    return snapshot;
  }

  private beginRequestSnapshot(
    client: OpenCodeSdkClient,
    sessionID: string,
    selectionGeneration: number,
  ): PendingRequestSnapshot {
    this.requestController?.abort();
    const controller = new AbortController();
    const snapshot: PendingRequestSnapshot = {
      client,
      sessionID,
      connectionGeneration: this.connectionGeneration,
      selectionGeneration,
      controller,
      bufferedEvents: [],
    };
    this.activeRequestSnapshot = snapshot;
    this.requestController = controller;
    this.setState({ loadingRequests: true, requestError: null });
    return snapshot;
  }

  private async loadSessionRequests(
    snapshot: PendingRequestSnapshot,
    options: { preserveRequestError?: boolean } = {},
  ): Promise<boolean> {
    try {
      const signal = this.connectionController
        ? AbortSignal.any([snapshot.controller.signal, this.connectionController.signal])
        : snapshot.controller.signal;
      const [permissionResponse, questionResponse] = await Promise.all([
        snapshot.client.v2.session.permission.list(
          { sessionID: snapshot.sessionID },
          { signal, throwOnError: true },
        ),
        snapshot.client.v2.session.question.list(
          { sessionID: snapshot.sessionID },
          { signal, throwOnError: true },
        ),
      ]);
      if (!this.isCurrentRequestSnapshot(snapshot)) return false;

      const permissions = z
        .array(serverPermissionRequestSchema)
        .max(64)
        .safeParse(permissionResponse.data.data);
      const questions = z
        .array(serverQuestionRequestSchema)
        .max(64)
        .safeParse(questionResponse.data.data);
      if (!permissions.success || !questions.success) {
        throw new Error("OpenCode returned an invalid pending-request list.");
      }

      this.setState({
        permissionRequests: permissions.data
          .filter((request) => request.sessionID === snapshot.sessionID)
          .map(mapPermissionRequest),
        questionRequests: questions.data
          .filter((request) => request.sessionID === snapshot.sessionID)
          .map(mapQuestionRequest),
        loadingRequests: false,
        requestError: options.preserveRequestError
          ? this.currentState.requestError
          : null,
        activeRequestAction:
          this.currentState.activeRequestAction?.sessionID === snapshot.sessionID &&
          this.currentState.activeRequestAction.status === "accepted"
            ? null
            : this.currentState.activeRequestAction,
      });
      for (const event of snapshot.bufferedEvents) {
        this.applyPendingRequestEvent(event);
      }
      return true;
    } catch {
      if (!this.isCurrentRequestSnapshot(snapshot)) return false;
      this.setState({
        loadingRequests: false,
        requestError: options.preserveRequestError && this.currentState.requestError
          ? this.currentState.requestError
          : "Could not refresh pending permission and question requests. Try again.",
      });
      for (const event of snapshot.bufferedEvents) {
        this.applyPendingRequestEvent(event);
      }
      return false;
    } finally {
      if (this.activeRequestSnapshot === snapshot) {
        this.activeRequestSnapshot = undefined;
        if (this.requestController === snapshot.controller) {
          this.requestController = undefined;
        }
      }
    }
  }

  private isCurrentRequestSnapshot(snapshot: PendingRequestSnapshot): boolean {
    return (
      this.activeRequestSnapshot === snapshot &&
      !snapshot.controller.signal.aborted &&
      this.client === snapshot.client &&
      this.connectionGeneration === snapshot.connectionGeneration &&
      this.selectionGeneration === snapshot.selectionGeneration &&
      this.currentState.selectedSessionID === snapshot.sessionID
    );
  }

  private receivePendingRequestEvent(
    event: PendingRequestEvent,
    selectionGeneration: number,
  ): void {
    if (
      selectionGeneration !== this.selectionGeneration ||
      pendingRequestEventSessionID(event) !== this.currentState.selectedSessionID
    ) {
      return;
    }
    const snapshot = this.activeRequestSnapshot;
    if (
      snapshot &&
      snapshot.sessionID === pendingRequestEventSessionID(event) &&
      snapshot.selectionGeneration === selectionGeneration
    ) {
      snapshot.bufferedEvents.push(event);
      return;
    }
    this.applyPendingRequestEvent(event);
  }

  private applyPendingRequestEvent(event: PendingRequestEvent): void {
    const sessionID = pendingRequestEventSessionID(event);
    if (sessionID !== this.currentState.selectedSessionID) return;

    if (event.kind === "permission-asked") {
      const key = requestCorrelationKey(event.request.sessionID, event.request.id);
      const permissionRequests = this.currentState.permissionRequests.filter(
        (request) => requestCorrelationKey(request.sessionID, request.id) !== key,
      );
      if (permissionRequests.length >= 64) {
        this.setState({
          requestError: "Too many pending permission requests to display. Refresh requests after resolving some.",
        });
        return;
      }
      this.setState({ permissionRequests: [...permissionRequests, event.request] });
      return;
    }

    if (event.kind === "question-asked") {
      const key = requestCorrelationKey(event.request.sessionID, event.request.id);
      const questionRequests = this.currentState.questionRequests.filter(
        (request) => requestCorrelationKey(request.sessionID, request.id) !== key,
      );
      if (questionRequests.length >= 64) {
        this.setState({
          requestError: "Too many pending question requests to display. Refresh requests after resolving some.",
        });
        return;
      }
      this.setState({ questionRequests: [...questionRequests, event.request] });
      return;
    }

    const key = requestCorrelationKey(sessionID, event.requestID);
    const activeAction = this.currentState.activeRequestAction;
    const resolvedKind = event.kind === "permission-resolved" ? "permission" : "question";
    this.setState({
      ...(event.kind === "permission-resolved"
        ? {
            permissionRequests: this.currentState.permissionRequests.filter(
              (request) => requestCorrelationKey(request.sessionID, request.id) !== key,
            ),
          }
        : {
            questionRequests: this.currentState.questionRequests.filter(
              (request) => requestCorrelationKey(request.sessionID, request.id) !== key,
            ),
          }),
      ...(activeAction?.kind === resolvedKind &&
      requestCorrelationKey(activeAction.sessionID, activeAction.requestID) === key
        ? { activeRequestAction: null }
        : {}),
    });
  }

  private async performRequestAction(
    action: ChatRequestAction,
    operation: RequestOperation,
  ): Promise<void> {
    const client = this.client;
    const selectionGeneration = this.selectionGeneration;
    const connectionGeneration = this.connectionGeneration;
    const isPending = action.kind === "permission"
      ? this.currentState.permissionRequests.some(
          (request) =>
            requestCorrelationKey(request.sessionID, request.id) ===
            requestCorrelationKey(action.sessionID, action.requestID),
        )
      : this.currentState.questionRequests.some(
          (request) =>
            requestCorrelationKey(request.sessionID, request.id) ===
            requestCorrelationKey(action.sessionID, action.requestID),
        );
    const actionKey = `${action.kind}\u0000${requestCorrelationKey(action.sessionID, action.requestID)}`;
    if (
      !client ||
      this.currentState.selectedSessionID !== action.sessionID ||
      !isPending ||
      this.currentState.activeRequestAction !== null ||
      this.inFlightRequestActions.has(actionKey)
    ) {
      this.setState({
        requestError: "This request is no longer pending or the selected session changed. Refresh requests and try again.",
      });
      return;
    }

    const currentAction = (): boolean =>
      this.connectionGeneration === connectionGeneration &&
      this.client === client &&
      this.selectionGeneration === selectionGeneration &&
      this.currentState.selectedSessionID === action.sessionID;
    const isActiveAction = (): boolean => {
      const active = this.currentState.activeRequestAction;
      return Boolean(
        active &&
        active.kind === action.kind &&
        active.sessionID === action.sessionID &&
        active.requestID === action.requestID,
      );
    };

    this.inFlightRequestActions.add(actionKey);
    this.setState({
      activeRequestAction: { ...action, status: "submitting" },
      requestError: null,
    });
    try {
      await operation(client, this.connectionController?.signal);
      if (!currentAction()) return;
      if (isActiveAction()) {
        this.setState({
          activeRequestAction: { ...action, status: "accepted" },
        });
      }
      const snapshot = this.beginRequestSnapshot(
        client,
        action.sessionID,
        selectionGeneration,
      );
      await this.loadSessionRequests(snapshot);
    } catch {
      if (!currentAction()) return;
      const actionError =
        "OpenCode did not confirm this response. Refresh pending requests to verify its state.";
      if (isActiveAction()) {
        this.setState({
          activeRequestAction: null,
        });
      }
      const snapshot = this.beginRequestSnapshot(
        client,
        action.sessionID,
        selectionGeneration,
      );
      this.setState({ requestError: actionError });
      await this.loadSessionRequests(snapshot, { preserveRequestError: true });
    } finally {
      this.inFlightRequestActions.delete(actionKey);
    }
  }

  private async loadAndReconcileHistory(
    client: OpenCodeSdkClient,
    snapshot: HistorySnapshot,
  ): Promise<void> {
    const diagnosticFlow = this.diagnostics.createFlow();
    const diagnosticStartedAt = Date.now();
    let diagnosticFinished = false;
    let rawCount: number | undefined;
    let mappedCount = 0;
    const droppedReasons: Record<HistoryDropReason, number> = {
      "invalid-id": 0,
      "unsupported-shape": 0,
      "no-renderable-text": 0,
    };
    let mappingCountsReady = false;
    const finishDiagnostic = (
      outcome: "empty" | "success" | "failure" | "cancelled",
      failureReason?: "request" | "invalid-response",
    ): void => {
      if (diagnosticFinished) return;
      diagnosticFinished = true;
      const droppedCount = Object.values(droppedReasons).reduce(
        (total, count) => total + count,
        0,
      );
      this.diagnostics.record({
        type: "history.reload.finished",
        flow: diagnosticFlow,
        outcome,
        durationMs: Date.now() - diagnosticStartedAt,
        ...(rawCount === undefined ? {} : { rawCount }),
        ...(mappingCountsReady
          ? { mappedCount, droppedCount, droppedReasons }
          : {}),
        ...(failureReason ? { failureReason } : {}),
      });
    };
    this.diagnostics.record({
      type: "history.reload.started",
      flow: diagnosticFlow,
    });
    let failureReason: "request" | "invalid-response" = "request";

    try {
      const response = await client.v2.session.messages(
        snapshot.mode === "older"
          ? { sessionID: snapshot.sessionID, cursor: snapshot.cursor! }
          : {
              sessionID: snapshot.sessionID,
              limit: MESSAGE_HISTORY_LIMIT,
              order: "desc",
            },
        { signal: snapshot.controller.signal, throwOnError: true },
      );
      if (!this.isCurrentSnapshot(snapshot, client)) {
        finishDiagnostic("cancelled");
        return;
      }

      failureReason = "invalid-response";
      const parsedHistory = serverHistoryPageSchema.safeParse(response.data);
      if (!parsedHistory.success) throw new Error("Invalid history response.");
      const history = parsedHistory.data.data.reverse();
      rawCount = history.length;
      this.assistantParts.clear();
      this.assistantToolParts.clear();
      this.historyToolMessageIDs.clear();
      const messages: ChatMessage[] = [];
      for (const item of history) {
        const mapped = this.mapHistoryMessage(item);
        if (mapped.droppedReason) {
          droppedReasons[mapped.droppedReason] += 1;
          continue;
        }
        mappedCount += 1;
        messages.push(...mapped.messages);
      }
      mappingCountsReady = true;
      failureReason = "request";
      this.mergePriorAssistantParts(snapshot.priorParts, snapshot.priorToolParts);
      const priorMessages = uniqueMessages([
        ...snapshot.priorMessages,
        ...this.currentState.messages,
      ]);
      const mergedMessages = snapshot.mode === "older"
        ? this.mergePriorMessages(messages, priorMessages)
        : this.mergePriorMessages(priorMessages, messages);
      const pageNextCursor = parsedHistory.data.cursor.next ?? null;
      const historyNextCursor = snapshot.mode === "older"
        ? pageNextCursor === snapshot.cursor
          ? null
          : pageNextCursor
        : snapshot.priorCursor ?? pageNextCursor;
      this.currentState = {
        ...this.currentState,
        messages: mergedMessages,
        historyNextCursor,
      };
      this.activeHistorySnapshot = undefined;
      if (this.historyController === snapshot.controller) this.historyController = undefined;
      this.setState({
        messages: mergedMessages,
        historyNextCursor,
      });
      this.replayBufferedEvents(snapshot.bufferedEvents, snapshot.sessionID);
      this.setState({
        ...(snapshot.mode === "latest"
          ? { loadingMessages: false }
          : { loadingOlderMessages: false }),
      });
      finishDiagnostic(rawCount === 0 ? "empty" : "success");
    } catch {
      if (!this.isCurrentSnapshot(snapshot, client)) {
        finishDiagnostic("cancelled");
        return;
      }
      finishDiagnostic("failure", failureReason);
      this.activeHistorySnapshot = undefined;
      if (this.historyController === snapshot.controller) this.historyController = undefined;
      this.replayBufferedEvents(snapshot.bufferedEvents, snapshot.sessionID);
      this.setState({
        ...(snapshot.mode === "latest"
          ? { loadingMessages: false }
          : { loadingOlderMessages: false }),
        historyError:
          snapshot.mode === "older"
            ? "Could not load older session messages. Try loading them again."
            : "Could not load the selected OpenCode session history. Try reviewing it again.",
      });
    }
  }

  private isCurrentSnapshot(
    snapshot: HistorySnapshot,
    client: OpenCodeSdkClient,
  ): boolean {
    return (
      this.activeHistorySnapshot === snapshot &&
      !snapshot.controller.signal.aborted &&
      this.client === client &&
      this.selectionGeneration === snapshot.selectionGeneration &&
      this.currentState.selectedSessionID === snapshot.sessionID
    );
  }

  private beginReconnectSnapshot(
    client: OpenCodeSdkClient,
    sessionID: string,
    selectionGeneration: number,
  ): void {
    if (
      this.client !== client ||
      this.selectionGeneration !== selectionGeneration ||
      this.currentState.selectedSessionID !== sessionID
    ) {
      return;
    }
    const snapshot = this.beginHistorySnapshot(sessionID, selectionGeneration);
    void this.loadAndReconcileHistory(client, snapshot);
    const requestSnapshot = this.beginRequestSnapshot(
      client,
      sessionID,
      selectionGeneration,
      );
    void this.loadSessionRequests(requestSnapshot);
  }

  private resolveStreamReadiness(generation: number): void {
    if (this.streamReadiness?.generation !== generation) return;
    const resolve = this.streamReadiness.resolve;
    this.streamReadiness = undefined;
    resolve();
  }

  private receiveTextEvent(
    event: IncomingTextEvent,
    selectionGeneration: number,
  ): void {
    if (
      selectionGeneration !== this.selectionGeneration ||
      event.sessionID !== this.currentState.selectedSessionID
    ) {
      return;
    }
    const capturedEvent: BufferedTextEvent = {
      ...event,
      arrivalOrdinal: ++this.eventArrivalOrdinal,
    };
    const snapshot = this.activeHistorySnapshot;
    if (
      snapshot &&
      snapshot.sessionID === event.sessionID &&
      snapshot.selectionGeneration === selectionGeneration
    ) {
      snapshot.bufferedEvents.push(capturedEvent);
      return;
    }
    this.applyTextEvent(capturedEvent);
  }

  private applyTextEvent(event: BufferedTextEvent): void {
    if (event.endedText !== undefined) {
      this.finishAssistantText(
        event.messageID,
        event.partID,
        event.endedText,
        event.timestamp,
        event.arrivalOrdinal,
        event.timestamp,
        event.durableSequence,
      );
      return;
    }
    this.appendAssistantText(
      event.messageID,
      event.partID,
      event.delta ?? "",
      event.timestamp,
      event.arrivalOrdinal,
      event.durableSequence,
    );
  }

  private receiveToolEvent(
    event: ToolEventPayload,
    selectionGeneration: number,
  ): void {
    if (
      selectionGeneration !== this.selectionGeneration ||
      event.sessionID !== this.currentState.selectedSessionID
    ) {
      return;
    }
    const capturedEvent: BufferedToolEvent = {
      ...event,
      arrivalOrdinal: ++this.eventArrivalOrdinal,
    };
    const snapshot = this.activeHistorySnapshot;
    if (
      snapshot &&
      snapshot.sessionID === event.sessionID &&
      snapshot.selectionGeneration === selectionGeneration
    ) {
      snapshot.bufferedEvents.push(capturedEvent);
      return;
    }
    this.applyToolEvent(capturedEvent);
  }

  private applyToolEvent(event: BufferedToolEvent): void {
    const key = toolCorrelationKey(event.sessionID, event.messageID, event.callID);
    const parts =
      this.assistantToolParts.get(event.messageID) ??
      new Map<string, AssistantToolPart>();
    let current = parts.get(key);
    if (event.kind === "canonical") {
      const historyMatches = Array.from(parts.entries()).filter(
        ([, candidate]) =>
          candidate.historyOrder !== undefined &&
          candidate.id === event.partID &&
          (candidate.callID === undefined || candidate.callID === event.callID),
      );
      if (historyMatches.length === 1) {
        const [historyKey, historyPart] = historyMatches[0]!;
        if (current && current !== historyPart) {
          current = mergeAssistantToolParts(historyPart, current);
        } else {
          current = historyPart;
        }
        current.callID = event.callID;
        parts.delete(historyKey);
        parts.set(key, current);
      }
    }
    if (!current) {
      current = {
        id: event.kind === "canonical" ? event.partID : event.callID,
        type: "tool",
        callID: event.callID,
        events: [],
        orderTimestamp: event.timestamp,
        orderArrivalOrdinal: event.arrivalOrdinal,
        ...(event.durableSequence === undefined ? {} : { orderDurableSequence: event.durableSequence }),
      };
    }
    const order = earliestPartOrder(
      current.orderTimestamp,
      current.orderArrivalOrdinal,
      event.timestamp,
      event.arrivalOrdinal,
    );
    current.orderTimestamp = order.orderTimestamp;
    current.orderArrivalOrdinal = order.arrivalOrdinal;
    if (event.durableSequence !== undefined) {
      current.orderDurableSequence = current.orderDurableSequence === undefined
        ? event.durableSequence
        : Math.min(current.orderDurableSequence, event.durableSequence);
    }
    if (event.kind === "canonical") {
      const historyTimestamp =
        current.historyState?.completed ??
        current.historyState?.ran ??
        current.historyState?.created;
      const isNewerThanHistory =
        historyTimestamp === undefined || event.timestamp > historyTimestamp;
      const isNewerThanCanonical =
        !current.canonical || event.timestamp >= current.canonical.updatedAt;
      if (isNewerThanHistory && isNewerThanCanonical) {
        current.canonical = {
          partID: event.partID,
          updatedAt: event.timestamp,
          state: event.state,
        };
        current.id = event.partID;
        current.name = event.name;
      }
    } else if (!current.events.some((item) => item.id === event.id)) {
      current.events.push(event);
      current.events.sort(compareBufferedEvents);
    }
    parts.set(key, current);
    this.assistantToolParts.set(event.messageID, parts);
    this.syncAssistantMessage(event.messageID);
  }

  private replayBufferedEvents(
    events: BufferedAssistantEvent[],
    sessionID: string,
  ): void {
    const grouped = new Map<string, BufferedTextEvent[]>();
    const groupedTools = new Map<string, BufferedToolEvent[]>();
    for (const event of events) {
      if (event.sessionID !== sessionID) continue;
      if ("kind" in event) {
        const key = toolCorrelationKey(event.sessionID, event.messageID, event.callID);
        const items = groupedTools.get(key) ?? [];
        items.push(event);
        groupedTools.set(key, items);
        continue;
      }
      const key = `${event.messageID}\u0000${event.partID}`;
      const items = grouped.get(key) ?? [];
      items.push(event);
      grouped.set(key, items);
    }

    for (const items of grouped.values()) {
      const first = items[0];
      if (!first) continue;
      const current = this.assistantParts.get(first.messageID)?.get(first.partID);
      let timestamp = current?.timestamp;
      let delta = "";
      let endedText: string | undefined;
      const orderedItems = items.sort(compareBufferedEvents);
      const firstEvent = orderedItems[0];
      for (const event of orderedItems) {
        if (timestamp !== undefined && event.timestamp < timestamp) continue;
        timestamp = event.timestamp;
        if (event.endedText !== undefined) {
          endedText = event.endedText;
          delta = "";
          continue;
        }
        if (endedText === undefined) delta += event.delta ?? "";
      }

      if (endedText !== undefined) {
        this.finishAssistantText(
          first.messageID,
          first.partID,
          endedText,
          timestamp ?? 0,
          firstEvent?.arrivalOrdinal ?? 0,
          firstEvent?.timestamp,
          firstEvent?.durableSequence,
        );
        continue;
      }
      const reconciledText = mergeSnapshotText(current?.text ?? "", delta);
      if (!reconciledText) continue;
      const parts = this.assistantParts.get(first.messageID) ?? new Map<string, AssistantTextPart>();
      parts.set(first.partID, {
        id: first.partID,
        type: "text",
        text: reconciledText,
        timestamp,
        durableSequence: firstEvent?.durableSequence ?? current?.durableSequence,
        ...earliestPartOrder(
          current?.orderTimestamp,
          current?.arrivalOrdinal,
          firstEvent?.timestamp ?? timestamp ?? 0,
          firstEvent?.arrivalOrdinal ?? 0,
        ),
        ...(current?.historyOrder === undefined ? {} : { historyOrder: current.historyOrder }),
      });
      this.assistantParts.set(first.messageID, parts);
      this.syncAssistantMessage(first.messageID);
    }

    for (const items of groupedTools.values()) {
      for (const event of items.sort(compareBufferedEvents)) {
        this.applyToolEvent(event);
      }
    }
  }

  private mergePriorAssistantParts(
    priorParts: Map<string, Map<string, AssistantTextPart>>,
    priorToolParts: Map<string, Map<string, AssistantToolPart>>,
  ): void {
    for (const [messageID, previousParts] of priorParts) {
      const currentParts = this.assistantParts.get(messageID) ?? new Map<string, AssistantTextPart>();
      for (const [partID, previous] of previousParts) {
        const current = currentParts.get(partID);
        currentParts.set(partID, {
          id: partID,
          type: "text",
          text: mergeSnapshotText(current?.text ?? "", previous.text),
          timestamp: latestTimestamp(current?.timestamp, previous.timestamp),
          orderTimestamp: current?.orderTimestamp ?? previous.orderTimestamp,
          arrivalOrdinal: current?.arrivalOrdinal ?? previous.arrivalOrdinal,
          durableSequence: current?.durableSequence ?? previous.durableSequence,
          historyOrder: current?.historyOrder ?? previous.historyOrder,
        });
      }
      this.assistantParts.set(messageID, currentParts);
    }

    for (const [messageID, previousParts] of priorToolParts) {
      const currentParts = this.assistantToolParts.get(messageID) ?? new Map<string, AssistantToolPart>();
      for (const [previousKey, previous] of previousParts) {
        const matchingHistoryEntry = previous.canonical
          ? Array.from(currentParts.entries()).find(
            ([, part]) =>
                part.historyOrder !== undefined &&
                part.id === previous.canonical?.partID &&
                (part.callID === undefined || part.callID === previous.callID),
            )
          : undefined;
        const currentKey = currentParts.has(previousKey)
          ? previousKey
          : matchingHistoryEntry?.[0];
        const current = currentKey ? currentParts.get(currentKey) : undefined;
        if (currentKey && current) currentParts.delete(currentKey);
        const merged = current
          ? mergeAssistantToolParts(current, previous)
          : cloneAssistantToolPart(previous);
        currentParts.set(previousKey, merged);
      }
      this.assistantToolParts.set(messageID, currentParts);
    }
  }

  private mergePriorMessages(
    earlierMessages: ChatMessage[],
    laterMessages: ChatMessage[],
  ): ChatMessage[] {
    const messages = mergeOrderedMessages(earlierMessages, laterMessages);
    const assistantMessageIDs = new Set([
      ...this.assistantParts.keys(),
      ...this.assistantToolParts.keys(),
    ]);
    for (const messageID of assistantMessageIDs) {
      const message = this.createAssistantMessage(messageID);
      if (!message) continue;
      const index = messages.findIndex((item) => item.id === messageID);
      if (index === -1) messages.push(message);
      else messages[index] = message;
    }
    return messages.slice(-MAX_CHAT_HISTORY_MESSAGES);
  }

  private isCurrentStream(
    eventGeneration: number,
    selectionGeneration: number,
    signal: AbortSignal,
  ): boolean {
    return (
      !signal.aborted &&
      eventGeneration === this.eventGeneration &&
      selectionGeneration === this.selectionGeneration
    );
  }

  private stopEventStream(): void {
    this.eventGeneration += 1;
    this.eventController?.abort();
    this.eventController = undefined;
    if (this.streamReadiness) {
      const resolve = this.streamReadiness.resolve;
      this.streamReadiness = undefined;
      resolve();
    }
  }

  private pauseEventStream(): void {
    this.stopEventStream();
    this.selectionGeneration += 1;
    this.historyController?.abort();
    this.historyController = undefined;
    this.activeHistorySnapshot?.controller.abort();
    this.activeHistorySnapshot = undefined;
    this.requestController?.abort();
    this.requestController = undefined;
    this.activeRequestSnapshot = undefined;
    if (this.currentState.selectedSessionID) {
      this.setState({
        streamStatus: "inactive",
        loadingMessages: false,
        loadingOlderMessages: false,
      });
    }
  }

  private isDuplicateEvent(eventID: string): boolean {
    if (this.seenEventIDs.has(eventID)) return true;
    this.seenEventIDs.add(eventID);
    this.eventIDOrder.push(eventID);
    if (this.eventIDOrder.length > EVENT_ID_CACHE_LIMIT) {
      const oldest = this.eventIDOrder.shift();
      if (oldest) this.seenEventIDs.delete(oldest);
    }
    return false;
  }

  private setPromptResult(
    requestID: string,
    attemptID: string,
    sessionID: string | null,
    status: PromptResult["status"],
    httpStatus?: number,
  ): void {
    this.setState({
      promptResult: {
        requestID,
        attemptID,
        sessionID,
        status,
        ...(httpStatus === undefined ? {} : { httpStatus }),
      },
    });
  }

  private createAssistantMessage(messageID: string): ChatMessage | undefined {
    const ordered = this.getAssistantParts(messageID);
    const text = ordered
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    const hasToolParts = ordered.some((part) => part.type === "tool");
    if (!text && !hasToolParts) return undefined;
    return {
      id: messageID,
      role: "assistant",
      text,
      ...(hasToolParts ? { parts: ordered } : {}),
    };
  }

  private getAssistantParts(messageID: string): ChatAssistantPart[] {
    const ordered: Array<{
      part: ChatAssistantPart;
      historyOrder?: number;
      timestamp: number;
      arrivalOrdinal: number;
      durableSequence?: number;
      id: string;
    }> = [];
    for (const part of this.assistantParts.get(messageID)?.values() ?? []) {
      ordered.push({
        part: { id: part.id, type: "text", text: part.text },
        ...(part.historyOrder === undefined ? {} : { historyOrder: part.historyOrder }),
        timestamp: part.orderTimestamp ?? part.timestamp ?? Number.MAX_SAFE_INTEGER,
        arrivalOrdinal: part.arrivalOrdinal ?? Number.MAX_SAFE_INTEGER,
        ...(part.durableSequence === undefined ? {} : { durableSequence: part.durableSequence }),
        id: part.id,
      });
    }
    for (const part of this.assistantToolParts.get(messageID)?.values() ?? []) {
      if (
        part.historyOrder === undefined &&
        !part.canonical &&
        this.historyToolMessageIDs.has(messageID)
      ) {
        continue;
      }
      ordered.push({
        part: materializeAssistantToolPart(part),
        ...(part.historyOrder === undefined ? {} : { historyOrder: part.historyOrder }),
        timestamp: part.orderTimestamp,
        arrivalOrdinal: part.orderArrivalOrdinal,
        ...(part.orderDurableSequence === undefined ? {} : { durableSequence: part.orderDurableSequence }),
        id: part.id,
      });
    }
    const useHistoryOrder = ordered.every((item) => item.historyOrder !== undefined);
    const useDurableSequence = ordered.every((item) => item.durableSequence !== undefined);
    const historical = ordered
      .filter((item) => item.historyOrder !== undefined)
      .sort((left, right) => left.historyOrder! - right.historyOrder!);
    if (historical.length > 0) {
      const streamed = ordered.filter((item) => item.historyOrder === undefined);
      const useSequenceForPlacement = ordered.every(
        (item) => item.durableSequence !== undefined,
      );
      const comparePlacement = useSequenceForPlacement
        ? compareDurableSequence
        : compareFallbackPartOrder;
      streamed.sort(comparePlacement);
      const merged = [...historical];
      for (const item of streamed) {
        const insertionIndex = merged.findIndex(
          (candidate) => comparePlacement(item, candidate) < 0,
        );
        if (insertionIndex < 0) merged.push(item);
        else merged.splice(insertionIndex, 0, item);
      }
      return merged.map((item) => item.part);
    }
    ordered.sort((left, right) => {
      if (useHistoryOrder) {
        return left.historyOrder! - right.historyOrder!;
      }
      if (useDurableSequence) {
        return left.durableSequence! - right.durableSequence!;
      }
      return compareFallbackPartOrder(left, right);
    });
    return ordered.map((item) => item.part);
  }

  private mapHistoryMessage(value: unknown): HistoryMappingResult {
    if (!isRecord(value)) {
      return { messages: [], droppedReason: "unsupported-shape" };
    }
    if (hasInvalidHistoryID(value)) {
      return { messages: [], droppedReason: "invalid-id" };
    }

    const user = serverUserMessageSchema.safeParse(value);
    if (user.success) {
      return {
        messages: [{ id: user.data.id, role: "user", text: user.data.text }],
      };
    }

    const mappedSystem = <T extends { id: string }>(
      schema: z.ZodType<T>,
      text: (data: T) => string,
    ): HistoryMappingResult | undefined => {
      const parsed = schema.safeParse(value);
      if (!parsed.success) return undefined;
      return {
        messages: [{ id: parsed.data.id, role: "system", text: text(parsed.data) }],
      };
    };
    const knownRecord =
      mappedSystem(serverTextHistoryRecordSchema, (record) => record.text) ??
      mappedSystem(serverShellHistoryRecordSchema, (record) =>
        `Shell command: ${record.command}\nOutput:\n${record.output}`,
      ) ??
      mappedSystem(serverCompactionHistoryRecordSchema, (record) =>
        `${record.summary}\n\n${record.recent}`,
      ) ??
      mappedSystem(serverAgentSwitchHistoryRecordSchema, (record) =>
        `Agent switched to ${record.agent}`,
      ) ??
      mappedSystem(serverModelSwitchHistoryRecordSchema, (record) => {
        return `Model switched to ${record.model.providerID}/${record.model.id}`;
      });
    if (knownRecord) return knownRecord;
    if (value.type !== "user" && value.type !== "assistant") {
      return { messages: [], droppedReason: "unsupported-shape" };
    }

    const assistant = serverAssistantMessageSchema.safeParse(value);
    if (!assistant.success) {
      return { messages: [], droppedReason: "unsupported-shape" };
    }
    const textParts = new Map<string, AssistantTextPart>();
    const toolParts = new Map<string, AssistantToolPart>();
    assistant.data.content.forEach((part, historyOrder) => {
      if (part.type === "text" && typeof part.text === "string") {
        textParts.set(part.id, {
          id: part.id,
          type: "text",
          text: part.text,
          historyOrder,
        });
      }
      if (part.type !== "tool") return;
      const toolPart = mapHistoryToolPart(
        part,
        historyOrder,
      );
      const key = toolPart.callID
        ? toolCorrelationKey(
            this.currentState.selectedSessionID ?? "",
            assistant.data.id,
            toolPart.callID,
          )
        : `history:${toolPart.id}`;
      toolParts.set(key, toolPart);
    });
    this.assistantParts.set(assistant.data.id, textParts);
    if (toolParts.size > 0) {
      this.assistantToolParts.set(assistant.data.id, toolParts);
      this.historyToolMessageIDs.add(assistant.data.id);
    }
    const message = this.createAssistantMessage(assistant.data.id);
    return message
      ? { messages: [message] }
      : { messages: [], droppedReason: "no-renderable-text" };
  }

  private appendAssistantText(
    messageID: string,
    partID: string,
    delta: string,
    timestamp: number,
    arrivalOrdinal: number,
    durableSequence?: number,
  ): void {
    const parts = this.assistantParts.get(messageID) ?? new Map<string, AssistantTextPart>();
    const current = parts.get(partID);
    if (current && current.timestamp === undefined) {
      if (current.text.includes(delta)) return;
      const reconciledText = mergeSnapshotText(current.text, delta);
      if (reconciledText === current.text) return;
      const order = earliestPartOrder(
        current.orderTimestamp,
        current.arrivalOrdinal,
        timestamp,
        arrivalOrdinal,
      );
      parts.set(partID, {
        id: partID,
        type: "text",
        text: reconciledText,
        timestamp,
        durableSequence: current?.durableSequence ?? durableSequence,
        ...order,
        ...(current.historyOrder === undefined ? {} : { historyOrder: current.historyOrder }),
      });
      this.assistantParts.set(messageID, parts);
      this.syncAssistantMessage(messageID);
      return;
    }
    if (current && current.timestamp !== undefined && timestamp < current.timestamp) return;
    const order = earliestPartOrder(
      current?.orderTimestamp,
      current?.arrivalOrdinal,
      timestamp,
      arrivalOrdinal,
    );
    parts.set(partID, {
      id: partID,
      type: "text",
      text: `${current?.text ?? ""}${delta}`,
      timestamp,
      durableSequence: current?.durableSequence ?? durableSequence,
      ...order,
      ...(current?.historyOrder === undefined ? {} : { historyOrder: current.historyOrder }),
    });
    this.assistantParts.set(messageID, parts);
    this.syncAssistantMessage(messageID);
  }

  private finishAssistantText(
    messageID: string,
    partID: string,
    text: string,
    timestamp: number,
    arrivalOrdinal: number,
    orderTimestamp = timestamp,
    durableSequence?: number,
  ): void {
    const parts = this.assistantParts.get(messageID) ?? new Map<string, AssistantTextPart>();
    const current = parts.get(partID);
    if (current && current.timestamp !== undefined && timestamp < current.timestamp) return;
    const order = earliestPartOrder(
      current?.orderTimestamp,
      current?.arrivalOrdinal,
      orderTimestamp,
      arrivalOrdinal,
    );
    parts.set(partID, {
      id: partID,
      type: "text",
      text,
      timestamp,
      durableSequence: current?.durableSequence ?? durableSequence,
      ...order,
      ...(current?.historyOrder === undefined ? {} : { historyOrder: current.historyOrder }),
    });
    this.assistantParts.set(messageID, parts);
    this.syncAssistantMessage(messageID);
  }

  private syncAssistantMessage(messageID: string): void {
    const message = this.createAssistantMessage(messageID);
    if (message) this.upsertMessage(message);
  }

  private upsertMessage(message: ChatMessage): void {
    const existingIndex = this.currentState.messages.findIndex(
      (current) => current.id === message.id,
    );
    const messages = [...this.currentState.messages];
    if (existingIndex === -1) messages.push(message);
    else messages[existingIndex] = message;
    this.setState({ messages: messages.slice(-MAX_CHAT_HISTORY_MESSAGES) });
  }

  private setState(patch: Partial<ChatState>): void {
    this.currentState = { ...this.currentState, ...patch };
    for (const listener of this.listeners) listener(this.currentState);
  }
}

type ServerChoiceList<T> =
  | { status: "ready"; items: T[] }
  | { status: "unavailable"; error: string };

async function loadServerChoiceList<T>(
  request: () => Promise<unknown>,
  schema: z.ZodType<T[]>,
  unavailableMessage: string,
): Promise<ServerChoiceList<T>> {
  try {
    const result = schema.safeParse(await request());
    return result.success
      ? { status: "ready", items: result.data }
      : { status: "unavailable", error: unavailableMessage };
  } catch {
    return { status: "unavailable", error: unavailableMessage };
  }
}

function mergeSessionPage(
  existing: ChatSession[],
  incoming: ChatSession[],
): ChatSession[] {
  const merged: ChatSession[] = [];
  const indexes = new Map<string, number>();
  for (const session of [...existing, ...incoming]) {
    const index = indexes.get(session.id);
    if (index === undefined) {
      indexes.set(session.id, merged.length);
      merged.push(session);
    } else {
      merged[index] = session;
    }
  }
  return merged;
}

function parseToolEvent(value: unknown): ToolEventPayload | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  const durableSequence = durableEventSequence(value);
  const orderMetadata =
    durableSequence === undefined ? {} : { durableSequence };

  if (value.type === "session.next.tool.input.started") {
    const event = toolInputStartedEventSchema.safeParse(value);
    if (!event.success) return undefined;
    return {
      id: event.data.id,
      sessionID: event.data.data.sessionID,
      messageID: event.data.data.assistantMessageID,
      callID: event.data.data.callID,
      timestamp: event.data.data.timestamp,
      ...orderMetadata,
      kind: "input-started",
      name: event.data.data.name,
    };
  }

  if (value.type === "session.next.tool.input.delta") {
    const event = toolInputDeltaEventSchema.safeParse(value);
    if (!event.success) return undefined;
    return {
      id: event.data.id,
      sessionID: event.data.data.sessionID,
      messageID: event.data.data.assistantMessageID,
      callID: event.data.data.callID,
      timestamp: event.data.data.timestamp,
      ...orderMetadata,
      kind: "input-delta",
      delta: event.data.data.delta,
    };
  }

  if (value.type === "session.next.tool.input.ended") {
    const event = toolInputEndedEventSchema.safeParse(value);
    if (!event.success) return undefined;
    return {
      id: event.data.id,
      sessionID: event.data.data.sessionID,
      messageID: event.data.data.assistantMessageID,
      callID: event.data.data.callID,
      timestamp: event.data.data.timestamp,
      ...orderMetadata,
      kind: "input-ended",
      text: event.data.data.text,
    };
  }

  if (value.type === "session.next.tool.called") {
    const event = toolCalledEventSchema.safeParse(value);
    if (!event.success) return undefined;
    return {
      id: event.data.id,
      sessionID: event.data.data.sessionID,
      messageID: event.data.data.assistantMessageID,
      callID: event.data.data.callID,
      timestamp: event.data.data.timestamp,
      ...orderMetadata,
      kind: "called",
      name: event.data.data.tool,
      input: event.data.data.input,
    };
  }

  if (value.type === "session.next.tool.progress") {
    const event = toolProgressEventSchema.safeParse(value);
    if (!event.success) return undefined;
    return {
      id: event.data.id,
      sessionID: event.data.data.sessionID,
      messageID: event.data.data.assistantMessageID,
      callID: event.data.data.callID,
      timestamp: event.data.data.timestamp,
      ...orderMetadata,
      kind: "progress",
      structured: event.data.data.structured,
      content: event.data.data.content,
    };
  }

  if (value.type === "session.next.tool.success") {
    const event = toolSuccessEventSchema.safeParse(value);
    if (!event.success) return undefined;
    return {
      id: event.data.id,
      sessionID: event.data.data.sessionID,
      messageID: event.data.data.assistantMessageID,
      callID: event.data.data.callID,
      timestamp: event.data.data.timestamp,
      ...orderMetadata,
      kind: "success",
      structured: event.data.data.structured,
      content: event.data.data.content,
      ...(event.data.data.result === undefined
        ? {}
        : { result: event.data.data.result }),
    };
  }

  if (value.type === "session.next.tool.failed") {
    const event = toolFailedEventSchema.safeParse(value);
    if (!event.success) return undefined;
    return {
      id: event.data.id,
      sessionID: event.data.data.sessionID,
      messageID: event.data.data.assistantMessageID,
      callID: event.data.data.callID,
      timestamp: event.data.data.timestamp,
      ...orderMetadata,
      kind: "failed",
      error: event.data.data.error,
      ...(event.data.data.result === undefined
        ? {}
        : { result: event.data.data.result }),
    };
  }

  if (value.type !== "message.part.updated") return undefined;
  const event = messagePartUpdatedEventSchema.safeParse(value);
  if (!event.success || !isRecord(event.data.data.part)) return undefined;
  const part = event.data.data.part;
  if (part.type !== "tool") return undefined;
  const toolPart = z
    .object({
      id: z.string().min(1).max(256),
      sessionID: sessionIdSchema,
      messageID: z.string().min(1).max(256),
      type: z.literal("tool"),
      callID: z.string().min(1).max(256),
      tool: z.string().min(1),
      state: z.record(z.string(), z.unknown()),
    })
    .passthrough()
    .safeParse(part);
  if (!toolPart.success || toolPart.data.sessionID !== event.data.data.sessionID) {
    return undefined;
  }
  return {
    id: event.data.id,
    sessionID: toolPart.data.sessionID,
    messageID: toolPart.data.messageID,
    callID: toolPart.data.callID,
    timestamp: event.data.data.time,
    ...orderMetadata,
    kind: "canonical",
    partID: toolPart.data.id,
    name: toolPart.data.tool,
    state: toolPart.data.state,
  };
}

function parsePendingRequestEvent(value: unknown): PendingRequestEvent | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;

  if (value.type === "permission.v2.asked") {
    const event = permissionAskedEventSchema.safeParse(value);
    return event.success
      ? { kind: "permission-asked", request: mapPermissionRequest(event.data.data) }
      : undefined;
  }

  if (value.type === "permission.v2.replied") {
    const event = permissionRepliedEventSchema.safeParse(value);
    return event.success
      ? {
          kind: "permission-resolved",
          sessionID: event.data.data.sessionID,
          requestID: event.data.data.requestID,
        }
      : undefined;
  }

  if (value.type === "question.v2.asked") {
    const event = questionAskedEventSchema.safeParse(value);
    return event.success
      ? { kind: "question-asked", request: mapQuestionRequest(event.data.data) }
      : undefined;
  }

  if (value.type === "question.v2.replied") {
    const event = questionRepliedEventSchema.safeParse(value);
    return event.success
      ? {
          kind: "question-resolved",
          sessionID: event.data.data.sessionID,
          requestID: event.data.data.requestID,
        }
      : undefined;
  }

  if (value.type !== "question.v2.rejected") return undefined;
  const event = questionRejectedEventSchema.safeParse(value);
  return event.success
    ? {
        kind: "question-resolved",
        sessionID: event.data.data.sessionID,
        requestID: event.data.data.requestID,
      }
    : undefined;
}

function mapPermissionRequest(
  request: z.infer<typeof serverPermissionRequestSchema>,
): ChatPermissionRequest {
  const metadata = request.metadata === undefined
    ? undefined
    : serializeRequestMetadata(request.metadata);
  return chatPermissionRequestSchema.parse({
    id: request.id,
    sessionID: request.sessionID,
    action: request.action,
    resources: request.resources,
    ...(request.save === undefined ? {} : { save: request.save }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(request.source === undefined ? {} : { source: request.source }),
  });
}

function mapQuestionRequest(
  request: z.infer<typeof serverQuestionRequestSchema>,
): ChatQuestionRequest {
  return chatQuestionRequestSchema.parse({
    id: request.id,
    sessionID: request.sessionID,
    questions: request.questions,
    ...(request.tool === undefined ? {} : { tool: request.tool }),
  });
}

function serializeRequestMetadata(
  metadata: Record<string, unknown>,
): string | undefined {
  try {
    const serialized = JSON.stringify(metadata, null, 2);
    if (serialized === undefined) return undefined;
    if (serialized.length <= 16_384) return serialized;
    return `${serialized.slice(0, 16_350)}\n… [truncated]`;
  } catch {
    return undefined;
  }
}

function pendingRequestEventSessionID(event: PendingRequestEvent): string {
  return event.kind === "permission-asked" || event.kind === "question-asked"
    ? event.request.sessionID
    : event.sessionID;
}

function requestCorrelationKey(sessionID: string, requestID: string): string {
  return `${sessionID}\u0000${requestID}`;
}

function compareFallbackPartOrder(
  left: { timestamp: number; arrivalOrdinal: number; id: string },
  right: { timestamp: number; arrivalOrdinal: number; id: string },
): number {
  return (
    left.timestamp - right.timestamp ||
    left.arrivalOrdinal - right.arrivalOrdinal ||
    left.id.localeCompare(right.id)
  );
}

function compareDurableSequence(
  left: { durableSequence?: number },
  right: { durableSequence?: number },
): number {
  return left.durableSequence! - right.durableSequence!;
}

function mapHistoryToolPart(
  value: unknown,
  historyOrder: number,
): AssistantToolPart {
  const part = isRecord(value) ? value : {};
  const id = isValidHistoryID(part.id) ? part.id : `unknown-tool-${historyOrder}`;
  const state = isRecord(part.state) ? part.state : undefined;
  const time = isRecord(part.time) ? part.time : undefined;
  const created = finiteNumber(time?.created);
  const ran = finiteNumber(time?.ran);
  const completed = finiteNumber(time?.completed);
  const callID = isValidHistoryID(part.callID) ? part.callID : undefined;
  const status = state ? toolStatus(state.status) : undefined;
  return {
    id,
    type: "tool",
    ...(callID === undefined ? {} : { callID }),
    ...(typeof part.name === "string" ? { name: part.name } : {}),
    ...(status === undefined ? {} : { status }),
    historyOrder,
    orderTimestamp: finiteNumber(time?.created) ?? historyOrder,
    orderArrivalOrdinal: historyOrder,
    events: [],
    ...(state ? { historyState: { state, created, ran, completed } } : {}),
    ...(status === undefined ? { generic: formatToolValue(part) } : {}),
  };
}

function materializeAssistantToolPart(record: AssistantToolPart): ChatToolPart {
  let eventName: string | undefined;
  let calledInput: string | undefined;
  let endedInput: string | undefined;
  let inputDelta = "";
  let hasInputDelta = false;
  let output: string | undefined;
  let result: string | undefined;
  let structured: string | undefined;
  let content: string | undefined;
  let error: string | undefined;
  let eventStatus: ChatToolPart["status"];

  for (const event of record.events) {
    if (event.kind === "input-started") eventName = event.name;
    if (event.kind === "input-delta") {
      inputDelta += event.delta;
      hasInputDelta = true;
    }
    if (event.kind === "input-ended") endedInput = event.text;
    if (event.kind === "called") {
      eventName = event.name;
      calledInput = formatToolValue(event.input);
    }
    if (event.kind === "progress") {
      structured = formatToolValue(event.structured);
      content = formatToolValue(event.content);
    }
    if (event.kind === "success") {
      eventStatus = "completed";
      structured = formatToolValue(event.structured);
      content = formatToolValue(event.content);
      if (event.result !== undefined) result = formatToolValue(event.result);
    }
    if (event.kind === "failed") {
      eventStatus = "error";
      error = formatToolValue(event.error);
      if (event.result !== undefined) result = formatToolValue(event.result);
    }
  }

  let status = eventStatus;
  let name = record.name ?? eventName;
  let input = endedInput ?? (hasInputDelta ? inputDelta : calledInput);
  let durationMs = elapsedDuration(
    record.historyState?.ran,
    record.historyState?.completed,
  );
  let generic = record.generic;
  if (record.historyState) {
    const state = record.historyState.state;
    status = toolStatus(state.status);
    if (hasOwn(state, "input")) input = formatToolValue(state.input);
    if (hasOwn(state, "output")) output = formatToolValue(state.output);
    if (hasOwn(state, "result")) result = formatToolValue(state.result);
    if (hasOwn(state, "structured")) structured = formatToolValue(state.structured);
    if (hasOwn(state, "content")) content = formatToolValue(state.content);
    if (hasOwn(state, "error")) error = formatToolValue(state.error);
  }

  if (record.canonical) {
    const state = record.canonical.state;
    status = toolStatus(state.status);
    if (hasOwn(state, "input")) input = formatToolValue(state.raw ?? state.input);
    if (hasOwn(state, "output")) output = formatToolValue(state.output);
    if (hasOwn(state, "result")) result = formatToolValue(state.result);
    if (hasOwn(state, "structured")) structured = formatToolValue(state.structured);
    if (hasOwn(state, "content")) content = formatToolValue(state.content);
    if (hasOwn(state, "error")) error = formatToolValue(state.error);
    const time = isRecord(state.time) ? state.time : undefined;
    durationMs = elapsedDuration(finiteNumber(time?.start), finiteNumber(time?.end)) ?? durationMs;
    if (status === undefined) generic = formatToolValue(state);
  }

  return {
    id: record.id,
    type: "tool",
    ...(record.callID === undefined ? {} : { callID: record.callID }),
    ...(name === undefined ? {} : { name }),
    ...(status === undefined ? {} : { status }),
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(result === undefined ? {} : { result }),
    ...(structured === undefined ? {} : { structured }),
    ...(content === undefined ? {} : { content }),
    ...(error === undefined ? {} : { error }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(generic === undefined ? {} : { generic }),
  };
}

function mergeAssistantToolParts(
  current: AssistantToolPart,
  previous: AssistantToolPart,
): AssistantToolPart {
  const order = earliestPartOrder(
    current.orderTimestamp,
    current.orderArrivalOrdinal,
    previous.orderTimestamp,
    previous.orderArrivalOrdinal,
  );
  const events = new Map<string, BufferedToolEvent>();
  for (const event of [...current.events, ...previous.events]) events.set(event.id, event);
  const historyState = current.historyState ?? previous.historyState;
  let canonical = current.canonical;
  if (!canonical || (previous.canonical && previous.canonical.updatedAt > canonical.updatedAt)) {
    canonical = previous.canonical;
  }
  const historyTimestamp =
    historyState?.completed ?? historyState?.ran ?? historyState?.created;
  if (
    canonical &&
    historyTimestamp !== undefined &&
    canonical.updatedAt < historyTimestamp
  ) {
    canonical = undefined;
  }
  return {
    ...previous,
    ...current,
    id: current.historyOrder === undefined ? previous.id : current.id,
    ...(current.callID ?? previous.callID
      ? { callID: current.callID ?? previous.callID }
      : {}),
    ...(current.name ?? previous.name ? { name: current.name ?? previous.name } : {}),
    historyOrder: current.historyOrder ?? previous.historyOrder,
    ...order,
    events: Array.from(events.values()).sort(compareBufferedEvents),
    canonical,
    historyState,
    ...(current.generic ?? previous.generic
      ? { generic: current.generic ?? previous.generic }
      : {}),
  };
}

function cloneAssistantToolPart(part: AssistantToolPart): AssistantToolPart {
  return {
    ...part,
    events: part.events.map((event) => ({ ...event })),
    ...(part.canonical
      ? { canonical: { ...part.canonical, state: { ...part.canonical.state } } }
      : {}),
    ...(part.historyState
      ? { historyState: { ...part.historyState, state: { ...part.historyState.state } } }
      : {}),
  };
}

function cloneAssistantToolParts(
  parts: Map<string, Map<string, AssistantToolPart>>,
): Map<string, Map<string, AssistantToolPart>> {
  return new Map(
    Array.from(parts, ([messageID, messageParts]) => [
      messageID,
      new Map(
        Array.from(messageParts, ([key, part]) => [key, cloneAssistantToolPart(part)]),
      ),
    ]),
  );
}

function toolCorrelationKey(sessionID: string, messageID: string, callID: string): string {
  return `${sessionID}\u0000${messageID}\u0000${callID}`;
}

function compareBufferedEvents(
  left: {
    timestamp: number;
    arrivalOrdinal: number;
    durableSequence?: number;
  },
  right: {
    timestamp: number;
    arrivalOrdinal: number;
    durableSequence?: number;
  },
): number {
  if (
    left.durableSequence !== undefined &&
    right.durableSequence !== undefined &&
    left.durableSequence !== right.durableSequence
  ) {
    return left.durableSequence - right.durableSequence;
  }
  return left.timestamp - right.timestamp || left.arrivalOrdinal - right.arrivalOrdinal;
}

function earliestPartOrder(
  currentTimestamp: number | undefined,
  currentArrivalOrdinal: number | undefined,
  nextTimestamp: number,
  nextArrivalOrdinal: number,
): { orderTimestamp: number; arrivalOrdinal: number } {
  if (
    currentTimestamp === undefined ||
    nextTimestamp < currentTimestamp ||
    (nextTimestamp === currentTimestamp &&
      (currentArrivalOrdinal === undefined ||
        nextArrivalOrdinal < currentArrivalOrdinal))
  ) {
    return { orderTimestamp: nextTimestamp, arrivalOrdinal: nextArrivalOrdinal };
  }
  return {
    orderTimestamp: currentTimestamp,
    arrivalOrdinal: currentArrivalOrdinal ?? nextArrivalOrdinal,
  };
}

function durableEventSequence(value: unknown): number | undefined {
  if (!isRecord(value) || !isRecord(value.durable)) return undefined;
  const sequence = finiteNumber(value.durable.seq);
  return sequence !== undefined && Number.isInteger(sequence) && sequence >= 0
    ? sequence
    : undefined;
}

function toolStatus(value: unknown): ChatToolPart["status"] {
  return value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "error"
    ? value
    : undefined;
}

function formatToolValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function elapsedDuration(start: number | undefined, end: number | undefined): number | undefined {
  if (start === undefined || end === undefined || end < start) return undefined;
  return end - start;
}

function cloneAssistantParts(
  parts: Map<string, Map<string, AssistantTextPart>>,
): Map<string, Map<string, AssistantTextPart>> {
  return new Map(
    Array.from(parts, ([messageID, messageParts]) => [
      messageID,
      new Map(Array.from(messageParts, ([partID, part]) => [partID, { ...part }])),
    ]),
  );
}

function uniqueMessages(messages: ChatMessage[]): ChatMessage[] {
  const byID = new Map<string, ChatMessage>();
  for (const message of messages) byID.set(message.id, message);
  return Array.from(byID.values());
}

function mergeOrderedMessages(
  earlierMessages: ChatMessage[],
  laterMessages: ChatMessage[],
): ChatMessage[] {
  const merged: ChatMessage[] = [];
  const indexes = new Map<string, number>();
  for (const message of [...earlierMessages, ...laterMessages]) {
    const index = indexes.get(message.id);
    if (index === undefined) {
      indexes.set(message.id, merged.length);
      merged.push(message);
    } else {
      merged[index] = message;
    }
  }
  return merged;
}

function mergeSnapshotText(snapshotText: string, newerText: string): string {
  if (!snapshotText) return newerText;
  if (!newerText || snapshotText.endsWith(newerText)) return snapshotText;
  if (newerText.startsWith(snapshotText)) return newerText;
  if (snapshotText.startsWith(newerText)) return snapshotText;

  const maxOverlap = Math.min(snapshotText.length, newerText.length);
  for (let length = maxOverlap; length > 0; length -= 1) {
    if (snapshotText.endsWith(newerText.slice(0, length))) {
      return `${snapshotText}${newerText.slice(length)}`;
    }
  }
  return `${snapshotText}${newerText}`;
}

function latestTimestamp(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

function isDefinitivePromptRejection(error: unknown): boolean {
  const status = getHttpStatus(error);
  return status === 400 || status === 401 || status === 404 || status === 409;
}

function getHttpStatus(error: unknown): number | undefined {
  if (!(error instanceof Error) || typeof error.cause !== "object" || !error.cause) {
    return undefined;
  }
  try {
    const status = Reflect.get(error.cause, "status");
    return sanitizeHttpStatus(status);
  } catch {
    return undefined;
  }
}

function activityFailureMessage(
  reason: ActivityDiagnosticReason,
  status: number | undefined,
): string {
  if (reason === "http-error") {
    return status === 401 || status === 403
      ? `OpenCode denied the activity check (HTTP ${status}). Check server authentication and retry.`
      : `OpenCode rejected the activity check (HTTP ${status}). Check server compatibility and retry.`;
  }
  if (reason === "invalid-shape") {
    return "OpenCode returned an unrecognized activity response. Check that the server uses the supported 1.19.0 API.";
  }
  if (reason === "sdk-unavailable") {
    return "The installed OpenCode SDK does not provide the activity check. Verify the extension's SDK version.";
  }
  return "The activity request could not reach OpenCode. Check the connection and retry.";
}

function getResponseHttpStatus(response: unknown): number | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  try {
    const fetchResponse = Reflect.get(response, "response");
    if (typeof fetchResponse !== "object" || fetchResponse === null) return undefined;
    return sanitizeHttpStatus(Reflect.get(fetchResponse, "status"));
  } catch {
    return undefined;
  }
}

function sanitizeHttpStatus(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : undefined;
}

function hasInvalidHistoryID(value: Record<string, unknown>): boolean {
  if (!isValidHistoryID(value.id)) return true;
  if (value.type === "assistant" && Array.isArray(value.content)) {
    for (const part of value.content) {
      if (isRecord(part) && !isValidHistoryID(part.id)) return true;
    }
  }
  return false;
}

function isValidHistoryID(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionActivityInactive(state: ChatState): boolean {
  return state.sessionActivity === "inactive";
}

function toChatSession(
  session: z.infer<typeof serverSessionSchema>,
): ChatSession {
  return {
    id: session.id,
    title: session.title.slice(0, 500),
    updatedAt: session.time.updated,
    ...(session.agent === undefined ? {} : { agent: session.agent }),
    ...(session.model === undefined ? {} : { model: session.model }),
  };
}
