import { z } from "zod";

export const MAX_PROMPT_LENGTH = 20_000;
export const MAX_QUESTION_OPTIONS = 64;
export const MAX_QUESTION_ANSWERS = MAX_QUESTION_OPTIONS + 1;
export const MAX_SESSION_HISTORY_ENTRIES = 2_000;
export const MAX_CHAT_HISTORY_MESSAGES = 5_000;
export const MAX_CURSOR_LENGTH = 16_384;
export const MAX_SESSION_SEARCH_LENGTH = 200;

export const sessionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const promptTextSchema = z
  .string()
  .min(1)
  .max(MAX_PROMPT_LENGTH)
  .refine((text) => text.trim().length > 0);

export const promptRequestIDSchema = z.string().uuid();

export const pendingRequestIDSchema = z.string().min(1).max(256);
export const permissionReplySchema = z.enum(["once", "always", "reject"]);
export const questionAnswersSchema = z
  .array(z.array(z.string().max(8_000)).max(MAX_QUESTION_ANSWERS))
  .max(32);

export const chatPermissionRequestSchema = z
  .object({
    id: pendingRequestIDSchema,
    sessionID: sessionIdSchema,
    action: z.string().min(1).max(256),
    resources: z.array(z.string().max(4_096)).max(128),
    save: z.array(z.string().max(4_096)).max(128).optional(),
    metadata: z.string().max(16_384).optional(),
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

export const chatQuestionRequestSchema = z
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

export const chatRequestActionSchema = z
  .object({
    sessionID: sessionIdSchema,
    requestID: pendingRequestIDSchema,
    kind: z.enum(["permission", "question"]),
    action: z.enum(["once", "always", "reject", "answer"]),
    status: z.enum(["submitting", "accepted"]),
  })
  .strict();

export const promptResultSchema = z
  .object({
    requestID: promptRequestIDSchema,
    attemptID: promptRequestIDSchema,
    sessionID: sessionIdSchema.nullable(),
    status: z.enum(["submitting", "accepted", "rejected", "outcome-unknown"]),
    httpStatus: z.number().int().min(100).max(599).optional(),
  })
  .strict()
  .refine((result) => result.sessionID !== null || result.status === "rejected", {
    path: ["sessionID"],
    message: "Only rejected prompt results may omit a target session.",
  });

export const chatSessionSchema = z
  .object({
    id: sessionIdSchema,
    title: z.string().max(500),
    updatedAt: z.number().finite().nonnegative(),
    agent: z.string().min(1).max(256).optional(),
    model: z
      .object({
        id: z.string().min(1).max(256),
        providerID: z.string().min(1).max(256),
        variant: z.string().min(1).max(256).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const chatChoiceStatusSchema = z.enum([
  "idle",
  "loading",
  "ready",
  "unavailable",
]);

export const sessionActivitySchema = z.enum(["unknown", "active", "inactive"]);
export const sessionActivityErrorCategorySchema = z.enum([
  "http-error", "request-failed", "invalid-shape", "sdk-unavailable",
]);
export const interruptStatusSchema = z.enum([
  "idle",
  "requesting",
  "waiting",
  "error",
]);

export const chatProviderChoiceSchema = z
  .object({
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(500),
  })
  .strict();

export const chatModelChoiceSchema = z
  .object({
    id: z.string().min(1).max(256),
    providerID: z.string().min(1).max(256),
    name: z.string().min(1).max(500),
    enabled: z.boolean(),
    variants: z.array(z.string().min(1).max(256)).max(256),
  })
  .strict();

export const chatAgentChoiceSchema = z
  .object({
    id: z.string().min(1).max(256),
    description: z.string().max(2_000).optional(),
  })
  .strict();

export const chatModelReferenceSchema = z
  .object({
    id: z.string().min(1).max(256),
    providerID: z.string().min(1).max(256),
    variant: z.string().min(1).max(256).optional(),
  })
  .strict();

export const chatTextPartSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal("text"),
    text: z.string(),
  })
  .strict();

export const chatToolPartSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal("tool"),
    callID: z.string().min(1).max(256).optional(),
    name: z.string().optional(),
    status: z.enum(["pending", "running", "completed", "error"]).optional(),
    input: z.string().optional(),
    output: z.string().optional(),
    result: z.string().optional(),
    structured: z.string().optional(),
    content: z.string().optional(),
    error: z.string().optional(),
    durationMs: z.number().finite().nonnegative().optional(),
    generic: z.string().optional(),
  })
  .strict();

export const chatAssistantPartSchema = z.discriminatedUnion("type", [
  chatTextPartSchema,
  chatToolPartSchema,
]);

export const chatSessionDiffSchema = z
  .object({
    file: z.string().optional(),
    patch: z.string().optional(),
    additions: z.number().finite().nonnegative(),
    deletions: z.number().finite().nonnegative(),
    status: z.enum(["added", "deleted", "modified"]).optional(),
  })
  .strict();

export const chatMessageSchema = z
  .object({
    id: z.string().min(1).max(256),
    role: z.enum(["user", "assistant", "system"]),
    text: z.string(),
    parts: z.array(chatAssistantPartSchema).optional(),
  })
  .strict();

export const chatStateSchema = z
  .object({
    sessions: z.array(chatSessionSchema).max(MAX_SESSION_HISTORY_ENTRIES),
    selectedSessionID: sessionIdSchema.nullable(),
    activeSession: chatSessionSchema.nullable(),
    messages: z.array(chatMessageSchema).max(MAX_CHAT_HISTORY_MESSAGES),
    sessionSearch: z.string().max(MAX_SESSION_SEARCH_LENGTH),
    sessionNextCursor: z.string().min(1).max(MAX_CURSOR_LENGTH).nullable(),
    historyNextCursor: z.string().min(1).max(MAX_CURSOR_LENGTH).nullable(),
    loadingMoreSessions: z.boolean(),
    loadingOlderMessages: z.boolean(),
    sessionsError: z.string().max(500).nullable(),
    deletingSessionID: sessionIdSchema.nullable(),
    providers: z.array(chatProviderChoiceSchema).max(256),
    providerChoicesStatus: chatChoiceStatusSchema,
    providerChoicesError: z.string().max(500).nullable(),
    models: z.array(chatModelChoiceSchema).max(2_000),
    modelChoicesStatus: chatChoiceStatusSchema,
    modelChoicesError: z.string().max(500).nullable(),
    agents: z.array(chatAgentChoiceSchema).max(256),
    agentChoicesStatus: chatChoiceStatusSchema,
    agentChoicesError: z.string().max(500).nullable(),
    selectedModel: chatModelReferenceSchema.nullable(),
    selectedAgent: z.string().min(1).max(256).nullable(),
    switchingChoice: z.enum(["model", "agent"]).nullable(),
    choiceError: z.string().max(500).nullable(),
    sessionDiffs: z.array(chatSessionDiffSchema),
    permissionRequests: z.array(chatPermissionRequestSchema).max(64),
    questionRequests: z.array(chatQuestionRequestSchema).max(64),
    loadingRequests: z.boolean(),
    requestError: z.string().max(500).nullable(),
    activeRequestAction: chatRequestActionSchema.nullable(),
    loadingSessions: z.boolean(),
    loadingMessages: z.boolean(),
    historyError: z.string().max(500).nullable(),
    sending: z.boolean(),
    sessionActivity: sessionActivitySchema,
    sessionActivityRefreshing: z.boolean(),
    sessionActivityError: z.string().max(500).nullable(),
    sessionActivityErrorCategory: sessionActivityErrorCategorySchema.nullable(),
    sessionActivityHttpStatus: z.number().int().min(100).max(599).nullable(),
    interruptStatus: interruptStatusSchema,
    interruptError: z.string().max(500).nullable(),
    promptResult: promptResultSchema.nullable(),
    streamStatus: z.enum(["inactive", "connecting", "connected", "error"]),
    error: z.string().max(500).nullable(),
  })
  .strict();

export type ChatSession = z.infer<typeof chatSessionSchema>;
export type ChatProviderChoice = z.infer<typeof chatProviderChoiceSchema>;
export type ChatModelChoice = z.infer<typeof chatModelChoiceSchema>;
export type ChatAgentChoice = z.infer<typeof chatAgentChoiceSchema>;
export type ChatModelReference = z.infer<typeof chatModelReferenceSchema>;
export type ChatAssistantPart = z.infer<typeof chatAssistantPartSchema>;
export type ChatTextPart = z.infer<typeof chatTextPartSchema>;
export type ChatToolPart = z.infer<typeof chatToolPartSchema>;
export type ChatSessionDiff = z.infer<typeof chatSessionDiffSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatPermissionRequest = z.infer<typeof chatPermissionRequestSchema>;
export type ChatQuestionRequest = z.infer<typeof chatQuestionRequestSchema>;
export type ChatRequestAction = z.infer<typeof chatRequestActionSchema>;
export type PromptResult = z.infer<typeof promptResultSchema>;
export type ChatState = z.infer<typeof chatStateSchema>;

export const initialChatState: ChatState = {
  sessions: [],
  selectedSessionID: null,
  activeSession: null,
  messages: [],
  sessionSearch: "",
  sessionNextCursor: null,
  historyNextCursor: null,
  loadingMoreSessions: false,
  loadingOlderMessages: false,
  sessionsError: null,
  deletingSessionID: null,
  providers: [],
  providerChoicesStatus: "idle",
  providerChoicesError: null,
  models: [],
  modelChoicesStatus: "idle",
  modelChoicesError: null,
  agents: [],
  agentChoicesStatus: "idle",
  agentChoicesError: null,
  selectedModel: null,
  selectedAgent: null,
  switchingChoice: null,
  choiceError: null,
  sessionDiffs: [],
  permissionRequests: [],
  questionRequests: [],
  loadingRequests: false,
  requestError: null,
  activeRequestAction: null,
  loadingSessions: false,
  loadingMessages: false,
  historyError: null,
  sending: false,
  sessionActivity: "unknown",
  sessionActivityRefreshing: false,
  sessionActivityError: null,
  sessionActivityErrorCategory: null,
  sessionActivityHttpStatus: null,
  interruptStatus: "idle",
  interruptError: null,
  promptResult: null,
  streamStatus: "inactive",
  error: null,
};
