import { z } from "zod";
import {
  connectionStateSchema,
  type ConnectionState,
} from "./connection-state";
import {
  chatStateSchema,
  pendingRequestIDSchema,
  permissionReplySchema,
  promptRequestIDSchema,
  promptTextSchema,
  questionAnswersSchema,
  sessionIdSchema,
  MAX_SESSION_SEARCH_LENGTH,
  type ChatState,
} from "./chat-state";
import {
  editorContextResultSchema,
  type EditorContextResult,
} from "./editor-context";
import {
  capabilityStateSchema,
  type CapabilityState,
} from "./capability-state";

const webviewActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("open-expanded") }).strict(),
  z.object({ type: z.literal("webview-ready") }).strict(),
  z.object({ type: z.literal("connect") }).strict(),
  z.object({ type: z.literal("disconnect") }).strict(),
  z.object({ type: z.literal("load-sessions") }).strict(),
  z.object({ type: z.literal("load-more-sessions") }).strict(),
  z
    .object({
      type: z.literal("search-sessions"),
      query: z.string().max(MAX_SESSION_SEARCH_LENGTH),
    })
    .strict(),
  z.object({ type: z.literal("load-older-history") }).strict(),
  z.object({ type: z.literal("refresh-choices") }).strict(),
  z.object({ type: z.literal("load-mcp-status") }).strict(),
  z.object({ type: z.literal("load-tool-metadata") }).strict(),
  z.object({ type: z.literal("load-skills") }).strict(),
  z.object({ type: z.literal("load-child-sessions") }).strict(),
  z.object({ type: z.literal("review-session-history") }).strict(),
  z.object({ type: z.literal("refresh-requests") }).strict(),
  z
    .object({ type: z.literal("refresh-session-activity"), sessionID: sessionIdSchema })
    .strict(),
  z.object({ type: z.literal("create-session") }).strict(),
  z.object({ type: z.literal("add-editor-context") }).strict(),
  z
    .object({ type: z.literal("copy-text"), text: z.string().max(1_000_000) })
    .strict(),
  z
    .object({ type: z.literal("select-session"), sessionID: sessionIdSchema })
    .strict(),
  z
    .object({ type: z.literal("interrupt-session"), sessionID: sessionIdSchema })
    .strict(),
  z
    .object({
      type: z.literal("select-model"),
      providerID: z.string().min(1).max(256),
      modelID: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({ type: z.literal("select-agent"), agentID: z.string().min(1).max(256) })
    .strict(),
  z
    .object({ type: z.literal("delete-session"), sessionID: sessionIdSchema })
    .strict(),
  z
    .object({
      type: z.literal("reply-permission"),
      sessionID: sessionIdSchema,
      requestID: pendingRequestIDSchema,
      reply: permissionReplySchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("reply-question"),
      sessionID: sessionIdSchema,
      requestID: pendingRequestIDSchema,
      answers: questionAnswersSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("reject-question"),
      sessionID: sessionIdSchema,
      requestID: pendingRequestIDSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("send-prompt"),
      requestID: promptRequestIDSchema,
      attemptID: promptRequestIDSchema,
      text: promptTextSchema,
      sessionID: z.string().max(128),
    })
    .strict(),
]);

const extensionMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("connection-state"),
      state: connectionStateSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("chat-state"),
      state: chatStateSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("capability-state"),
      state: capabilityStateSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("editor-context-result"),
      result: editorContextResultSchema,
    })
    .strict(),
]);

export interface WebviewActions {
  openExpanded: () => void;
  webviewReady: () => void;
  connect: () => void;
  disconnect: () => void;
  loadSessions: () => void;
  loadMoreSessions: () => void;
  searchSessions: (query: string) => void;
  loadOlderHistory: () => void;
  refreshChoices: () => void;
  loadMcpStatus: () => void;
  loadToolMetadata: () => void;
  loadSkills: () => void;
  loadChildSessions: () => void;
  reviewSessionHistory: () => void;
  refreshRequests: () => void;
  refreshSessionActivity: (sessionID: string) => void;
  createSession: () => void;
  addEditorContext: () => void;
  copyText: (text: string) => void;
  selectSession: (sessionID: string) => void;
  interruptSession: (sessionID: string) => void;
  selectModel: (providerID: string, modelID: string) => void;
  selectAgent: (agentID: string) => void;
  deleteSession: (sessionID: string) => void;
  replyToPermission: (
    sessionID: string,
    requestID: string,
    reply: "once" | "always" | "reject",
  ) => void;
  replyToQuestion: (
    sessionID: string,
    requestID: string,
    answers: string[][],
  ) => void;
  rejectQuestion: (sessionID: string, requestID: string) => void;
  sendPrompt: (
    requestID: string,
    attemptID: string,
    text: string,
    sessionID: string,
  ) => void;
}

export interface ExtensionMessageActions {
  updateConnectionState: (state: ConnectionState) => void;
  updateChatState: (state: ChatState) => void;
  updateCapabilityState: (state: CapabilityState) => void;
  updateEditorContextResult: (result: EditorContextResult) => void;
}

export function dispatchWebviewMessage(
  message: unknown,
  actions: WebviewActions,
): boolean {
  const result = webviewActionSchema.safeParse(message);
  if (!result.success) return false;

  switch (result.data.type) {
    case "open-expanded":
      actions.openExpanded();
      break;
    case "webview-ready":
      actions.webviewReady();
      break;
    case "connect":
      actions.connect();
      break;
    case "disconnect":
      actions.disconnect();
      break;
    case "load-sessions":
      actions.loadSessions();
      break;
    case "load-more-sessions":
      actions.loadMoreSessions();
      break;
    case "search-sessions":
      actions.searchSessions(result.data.query);
      break;
    case "load-older-history":
      actions.loadOlderHistory();
      break;
    case "refresh-choices":
      actions.refreshChoices();
      break;
    case "load-mcp-status":
      actions.loadMcpStatus();
      break;
    case "load-tool-metadata":
      actions.loadToolMetadata();
      break;
    case "load-skills":
      actions.loadSkills();
      break;
    case "load-child-sessions":
      actions.loadChildSessions();
      break;
    case "review-session-history":
      actions.reviewSessionHistory();
      break;
    case "refresh-requests":
      actions.refreshRequests();
      break;
    case "refresh-session-activity":
      actions.refreshSessionActivity(result.data.sessionID);
      break;
    case "create-session":
      actions.createSession();
      break;
    case "add-editor-context":
      actions.addEditorContext();
      break;
    case "copy-text":
      actions.copyText(result.data.text);
      break;
    case "select-session":
      actions.selectSession(result.data.sessionID);
      break;
    case "interrupt-session":
      actions.interruptSession(result.data.sessionID);
      break;
    case "select-model":
      actions.selectModel(result.data.providerID, result.data.modelID);
      break;
    case "select-agent":
      actions.selectAgent(result.data.agentID);
      break;
    case "delete-session":
      actions.deleteSession(result.data.sessionID);
      break;
    case "reply-permission":
      actions.replyToPermission(
        result.data.sessionID,
        result.data.requestID,
        result.data.reply,
      );
      break;
    case "reply-question":
      actions.replyToQuestion(
        result.data.sessionID,
        result.data.requestID,
        result.data.answers,
      );
      break;
    case "reject-question":
      actions.rejectQuestion(result.data.sessionID, result.data.requestID);
      break;
    case "send-prompt":
      actions.sendPrompt(
        result.data.requestID,
        result.data.attemptID,
        result.data.text,
        result.data.sessionID,
      );
      break;
  }

  return true;
}

export function dispatchExtensionMessage(
  message: unknown,
  actions: ExtensionMessageActions,
): boolean {
  const result = extensionMessageSchema.safeParse(message);
  if (!result.success) return false;

  switch (result.data.type) {
    case "connection-state":
      actions.updateConnectionState(result.data.state);
      break;
    case "chat-state":
      actions.updateChatState(result.data.state);
      break;
    case "capability-state":
      actions.updateCapabilityState(result.data.state);
      break;
    case "editor-context-result":
      actions.updateEditorContextResult(result.data.result);
      break;
  }
  return true;
}
