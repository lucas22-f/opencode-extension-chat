import {
  isValidElement,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
  type ReactNode,
} from "react";
import ReactMarkdown, {
  defaultUrlTransform,
} from "react-markdown";
import type {
  ChatAssistantPart,
  ChatMessage,
  ChatSession,
  ChatPermissionRequest,
  ChatQuestionRequest,
  ChatRequestAction,
  ChatState,
  ChatToolPart,
} from "../shared/chat-state";
import type { ConnectionState } from "../shared/connection-state";
import type { CapabilityState } from "../shared/capability-state";
import {
  appendEditorContextToPromptDraft,
  type EditorContextResult,
} from "../shared/editor-context";
import {
  filterChoiceOptions,
  getChoiceAriaState,
  isChoiceActionAvailable,
  isFreshPromptAttemptResult,
  moveChoiceSelection,
  normalizeChoiceSelection,
  parseChoiceCommand,
  resolveChoiceOption,
  resolvePromptDraft,
  resolvePromptRetry,
  shouldSubmitPrompt,
  type PendingPromptAttempt,
  type PromptRetryAttempt,
} from "../shared/prompt-composer";
import { composeQuestionAnswers } from "./question-answers";

interface AppProps {
  chatState: ChatState;
  connectionState: ConnectionState;
  capabilityState: CapabilityState;
  onConnect: () => void;
  onDisconnect: () => void;
  onLoadSessions: () => void;
  onLoadMoreSessions: () => void;
  onSearchSessions: (query: string) => void;
  onLoadOlderHistory: () => void;
  onRefreshChoices: () => void;
  onLoadMcpStatus: () => void;
  onLoadToolMetadata: () => void;
  onLoadSkills: () => void;
  onLoadChildSessions: () => void;
  onReviewSessionHistory: () => void;
  onRefreshRequests: () => void;
  onRefreshSessionActivity: (sessionID: string) => void;
  onCreateSession: () => void;
  onCopyText: (text: string) => void;
  onSelectSession: (sessionID: string) => void;
  onInterruptSession: (sessionID: string) => void;
  onSelectModel: (providerID: string, modelID: string) => void;
  onSelectAgent: (agentID: string) => void;
  onDeleteSession: (sessionID: string) => void;
  onReplyToPermission: (
    sessionID: string,
    requestID: string,
    reply: "once" | "always" | "reject",
  ) => void;
  onReplyToQuestion: (
    sessionID: string,
    requestID: string,
    answers: string[][],
  ) => void;
  onRejectQuestion: (sessionID: string, requestID: string) => void;
  onSendPrompt: (
    requestID: string,
    attemptID: string,
    text: string,
    sessionID: string,
  ) => void;
  onAddEditorContext: () => void;
  onClearEditorContextResult: () => void;
  editorContextResult: EditorContextResult | null;
  onOpenExpanded: () => void;
}

export function App({
  chatState,
  connectionState,
  capabilityState,
  onConnect,
  onDisconnect,
  onLoadSessions,
  onLoadMoreSessions,
  onSearchSessions,
  onLoadOlderHistory,
  onRefreshChoices,
  onLoadMcpStatus,
  onLoadToolMetadata,
  onLoadSkills,
  onLoadChildSessions,
  onReviewSessionHistory,
  onRefreshRequests,
  onRefreshSessionActivity,
  onCreateSession,
  onCopyText,
  onSelectSession,
  onInterruptSession,
  onSelectModel,
  onSelectAgent,
  onDeleteSession,
  onReplyToPermission,
  onReplyToQuestion,
  onRejectQuestion,
  onSendPrompt,
  onAddEditorContext,
  onClearEditorContextResult,
  editorContextResult,
  onOpenExpanded,
}: AppProps) {
  const [draft, setDraft] = useState("");
  const [editorContextError, setEditorContextError] = useState<string | null>(null);
  const handledEditorContextResult = useRef<EditorContextResult | null>(null);
  const promptInput = useRef<HTMLTextAreaElement | null>(null);
  const insertedEditorContextDraft = useRef<string | null>(null);
  const [pendingPrompt, setPendingPrompt] =
    useState<PendingPromptAttempt | null>(null);
  const [retryablePrompt, setRetryablePrompt] =
    useState<PromptRetryAttempt | null>(null);
  const status = getStatus(connectionState);
  const isConnecting = connectionState.status === "connecting";
  const isDisconnecting = connectionState.status === "disconnecting";
  const canStopManagedServer =
    connectionState.status === "error" && connectionState.owner === "managed";
  const canChat = connectionState.status === "connected";

  useEffect(() => {
    if (
      !editorContextResult ||
      handledEditorContextResult.current === editorContextResult
    ) {
      return;
    }
    handledEditorContextResult.current = editorContextResult;
    if (editorContextResult.kind === "error") {
      setEditorContextError(editorContextResult.message);
      onClearEditorContextResult();
      return;
    }

    const insertion = appendEditorContextToPromptDraft(
      draft,
      editorContextResult.context,
    );
    if (insertion.kind === "too-large") {
      setEditorContextError(
        "The editor context would exceed the 20,000-character prompt limit. Remove some draft text and try again.",
      );
      onClearEditorContextResult();
      return;
    }

    setEditorContextError(null);
    insertedEditorContextDraft.current = insertion.draft;
    setDraft(insertion.draft);
    onClearEditorContextResult();
  }, [draft, editorContextResult, onClearEditorContextResult]);

  useEffect(() => {
    if (insertedEditorContextDraft.current !== draft) return;
    insertedEditorContextDraft.current = null;
    const input = promptInput.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(draft.length, draft.length);
    input.scrollTop = input.scrollHeight;
  }, [draft]);

  useEffect(() => {
    const result = chatState.promptResult;
    if (
      !pendingPrompt ||
      !result ||
      !isFreshPromptAttemptResult(result, pendingPrompt)
    ) {
      return;
    }

    setDraft((current) =>
      resolvePromptDraft(current, pendingPrompt.text, result.status),
    );
    setRetryablePrompt(
      result.status === "outcome-unknown" ? pendingPrompt : null,
    );
    setPendingPrompt(null);
  }, [chatState.promptResult, pendingPrompt]);

  const startPrompt = (attempt: PromptRetryAttempt): void => {
    const pending = {
      ...attempt,
      attemptID: globalThis.crypto.randomUUID(),
    };
    setPendingPrompt(pending);
    onSendPrompt(
      pending.requestID,
      pending.attemptID,
      pending.text,
      pending.sessionID,
    );
  };

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="product-eyebrow">OpenCode Visual</p>
          <h1>OpenCode</h1>
        </div>
        <span
          aria-label={`Connection status: ${status.label}`}
          className="connection-pill"
          role="status"
        >
          <span aria-hidden="true" className={`status-dot ${status.indicatorClass}`} />
          {status.label}
        </span>
      </header>

      {canChat ? (
        <ChatWorkspace
          chatState={chatState}
          connectionState={connectionState}
          capabilityState={capabilityState}
          draft={draft}
          onDraftChange={setDraft}
          pendingPrompt={pendingPrompt}
          retryablePrompt={retryablePrompt}
          setRetryablePrompt={setRetryablePrompt}
          onStartPrompt={startPrompt}
          onAddEditorContext={onAddEditorContext}
          promptInput={promptInput}
          editorContextError={editorContextError}
          onEditorContextErrorDismiss={() => setEditorContextError(null)}
          onCreateSession={onCreateSession}
          onCopyText={onCopyText}
          onDisconnect={onDisconnect}
          onLoadSessions={onLoadSessions}
          onLoadMoreSessions={onLoadMoreSessions}
          onSearchSessions={onSearchSessions}
          onLoadOlderHistory={onLoadOlderHistory}
          onRefreshChoices={onRefreshChoices}
          onLoadMcpStatus={onLoadMcpStatus}
          onLoadToolMetadata={onLoadToolMetadata}
          onLoadSkills={onLoadSkills}
          onLoadChildSessions={onLoadChildSessions}
          onReviewSessionHistory={onReviewSessionHistory}
          onRefreshRequests={onRefreshRequests}
          onRefreshSessionActivity={onRefreshSessionActivity}
          onOpenExpanded={onOpenExpanded}
          onSelectSession={onSelectSession}
          onInterruptSession={onInterruptSession}
          onSelectModel={onSelectModel}
          onSelectAgent={onSelectAgent}
          onDeleteSession={onDeleteSession}
          onReplyToPermission={onReplyToPermission}
          onReplyToQuestion={onReplyToQuestion}
          onRejectQuestion={onRejectQuestion}
        />
      ) : (
        <section
          aria-labelledby="connection-title"
          className="connection-panel"
        >
          <div aria-hidden="true" className="connection-icon">
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

          <div className="connection-copy">
            <h2 id="connection-title">{status.title}</h2>
            <p>{status.message}</p>
            {connectionState.status === "disconnected" && (
              <p className="connection-guidance">
                Connect attaches to the configured URL. Otherwise it checks
                {" "}http://127.0.0.1:4096 and may start a managed server in a
                trusted workspace.
              </p>
            )}
          </div>

          <div className="connection-actions">
            {!isConnecting && !isDisconnecting && !canStopManagedServer && (
              <button
                aria-label="Connect to OpenCode"
                className="primary-button"
                onClick={onConnect}
                type="button"
              >
                {connectionState.status === "error"
                  ? "Retry connection"
                  : "Connect to OpenCode"}
              </button>
            )}
            {isConnecting && (
              <button className="primary-button" disabled type="button">
                {connectionState.phase === "starting-managed"
                  ? "Starting managed server…"
                  : connectionState.phase === "verifying-managed"
                    ? "Checking managed server…"
                    : "Connecting…"}
              </button>
            )}
            {(connectionState.status === "version-mismatch" ||
              canStopManagedServer) && (
              <button
                className="secondary-button"
                onClick={onDisconnect}
                type="button"
              >
                {connectionState.status === "version-mismatch" &&
                connectionState.owner === "attached"
                  ? "Disconnect"
                  : "Stop managed server"}
              </button>
            )}
            {isDisconnecting && (
              <button className="secondary-button" disabled type="button">
                Stopping managed server…
              </button>
            )}
            <button
              aria-label="Open OpenCode Visual in an expanded editor tab"
              className="secondary-button"
              onClick={onOpenExpanded}
              type="button"
            >
              Open expanded view <span aria-hidden="true">↗</span>
            </button>
          </div>
        </section>
      )}

      <footer className="app-footer">
        OpenCode 1.19.0 baseline <span aria-hidden="true">·</span> Managed
        servers use loopback
      </footer>
    </main>
  );
}

interface ChatWorkspaceProps {
  chatState: ChatState;
  connectionState: Extract<ConnectionState, { status: "connected" }>;
  capabilityState: CapabilityState;
  draft: string;
  onDraftChange: (draft: string) => void;
  pendingPrompt: PendingPromptAttempt | null;
  retryablePrompt: PromptRetryAttempt | null;
  setRetryablePrompt: (pending: PromptRetryAttempt | null) => void;
  onCreateSession: () => void;
  onCopyText: (text: string) => void;
  onDisconnect: () => void;
  onLoadSessions: () => void;
  onLoadMoreSessions: () => void;
  onSearchSessions: (query: string) => void;
  onLoadOlderHistory: () => void;
  onRefreshChoices: () => void;
  onLoadMcpStatus: () => void;
  onLoadToolMetadata: () => void;
  onLoadSkills: () => void;
  onLoadChildSessions: () => void;
  onReviewSessionHistory: () => void;
  onRefreshRequests: () => void;
  onRefreshSessionActivity: (sessionID: string) => void;
  onOpenExpanded: () => void;
  onSelectSession: (sessionID: string) => void;
  onInterruptSession: (sessionID: string) => void;
  onSelectModel: (providerID: string, modelID: string) => void;
  onSelectAgent: (agentID: string) => void;
  onDeleteSession: (sessionID: string) => void;
  onReplyToPermission: (
    sessionID: string,
    requestID: string,
    reply: "once" | "always" | "reject",
  ) => void;
  onReplyToQuestion: (
    sessionID: string,
    requestID: string,
    answers: string[][],
  ) => void;
  onRejectQuestion: (sessionID: string, requestID: string) => void;
  onStartPrompt: (attempt: PromptRetryAttempt) => void;
  onAddEditorContext: () => void;
  promptInput: RefObject<HTMLTextAreaElement | null>;
  editorContextError: string | null;
  onEditorContextErrorDismiss: () => void;
}

function ChatWorkspace({
  chatState,
  connectionState,
  capabilityState,
  draft,
  onDraftChange,
  pendingPrompt,
  retryablePrompt,
  setRetryablePrompt,
  onCreateSession,
  onCopyText,
  onDisconnect,
  onLoadSessions,
  onLoadMoreSessions,
  onSearchSessions,
  onLoadOlderHistory,
  onRefreshChoices,
  onLoadMcpStatus,
  onLoadToolMetadata,
  onLoadSkills,
  onLoadChildSessions,
  onReviewSessionHistory,
  onRefreshRequests,
  onRefreshSessionActivity,
  onOpenExpanded,
  onSelectSession,
  onInterruptSession,
  onSelectModel,
  onSelectAgent,
  onDeleteSession,
  onReplyToPermission,
  onReplyToQuestion,
  onRejectQuestion,
  onStartPrompt,
  onAddEditorContext,
  promptInput,
  editorContextError,
  onEditorContextErrorDismiss,
}: ChatWorkspaceProps) {
  const [sessionSearchDraft, setSessionSearchDraft] = useState(
    chatState.sessionSearch,
  );
  const [providerFilter, setProviderFilter] = useState("");
  const [choiceCursor, setChoiceCursor] = useState(0);
  const choiceCommand = parseChoiceCommand(draft);

  useEffect(() => {
    setSessionSearchDraft(chatState.sessionSearch);
  }, [chatState.sessionSearch]);

  useEffect(() => {
    setProviderFilter("");
    setChoiceCursor(0);
  }, [chatState.selectedSessionID]);

  useEffect(() => {
    if (
      providerFilter &&
      !chatState.providers.some((provider) => provider.id === providerFilter)
    ) {
      setProviderFilter("");
    }
  }, [chatState.providers, providerFilter]);

  const filteredModels = chatState.models.filter(
    (model) => !providerFilter || model.providerID === providerFilter,
  );
  const providerNames = new Map(
    chatState.providers.map((provider) => [provider.id, provider.name]),
  );
  const providerOptions = filterChoiceOptions(
    chatState.providers.map((provider) => ({ id: provider.id, label: provider.name })),
    choiceCommand?.command === "provider" ? choiceCommand.query : "",
  );
  const modelOptions = filterChoiceOptions(
    filteredModels.filter((model) => model.enabled).map((model) => ({
      id: model.id,
      providerID: model.providerID,
      label: `${providerNames.get(model.providerID) ?? model.providerID} · ${model.name}`,
    })),
    choiceCommand?.command === "model" ? choiceCommand.query : "",
  );
  const activeChoiceOptions = choiceCommand?.command === "provider"
    ? providerOptions
    : choiceCommand?.command === "model"
      ? modelOptions
      : [];
  const activeChoiceStatus = choiceCommand?.command === "provider"
    ? chatState.providerChoicesStatus
    : chatState.modelChoicesStatus;
  useEffect(() => {
    setChoiceCursor((current) => normalizeChoiceSelection(current, activeChoiceOptions.length));
  }, [activeChoiceOptions.length, activeChoiceStatus, choiceCommand?.command]);
  const choiceActionable = isChoiceActionAvailable(
    activeChoiceStatus,
    chatState.switchingChoice,
    chatState.sending,
  );
  const activeChoiceIndex = normalizeChoiceSelection(choiceCursor, activeChoiceOptions.length);
  const choiceAriaState = getChoiceAriaState(
    choiceCommand?.command ?? null,
    activeChoiceStatus === "ready",
    activeChoiceOptions.length,
    activeChoiceIndex,
    choiceActionable,
  );
  const activeChoiceListboxId = choiceAriaState.controls;
  const canSend =
    chatState.selectedSessionID !== null &&
    chatState.streamStatus === "connected" &&
    !chatState.loadingMessages &&
    !chatState.loadingOlderMessages &&
    !chatState.sending &&
    chatState.switchingChoice === null &&
    pendingPrompt === null &&
    draft.trim().length > 0;
  const unknownPrompt =
    chatState.promptResult?.sessionID === chatState.selectedSessionID &&
    chatState.promptResult.status === "outcome-unknown"
      ? chatState.promptResult
      : null;
  const promptNotice = unknownPrompt
    ? `The prompt outcome is unknown; OpenCode may have accepted it. ${unknownPrompt.httpStatus === undefined ? "" : `The server returned HTTP ${unknownPrompt.httpStatus}. `}Review this session before retrying. OpenCode 1.19.0 deduplicates an exact retry only when the session, prompt, and delivery match.`
    : chatState.promptResult?.sessionID === chatState.selectedSessionID &&
        chatState.promptResult.status === "rejected"
      ? "OpenCode rejected the prompt. The draft is preserved; edit it or explicitly try again."
      : null;
  const retryableAttempt = resolvePromptRetry(
    retryablePrompt,
    draft,
    chatState.selectedSessionID,
  );
  const canRetryExactPrompt =
    unknownPrompt !== null &&
    unknownPrompt.requestID === retryableAttempt?.requestID &&
    unknownPrompt.sessionID === retryableAttempt?.sessionID;
  const selectedSessionOutsideList =
    chatState.activeSession?.id === chatState.selectedSessionID &&
    !chatState.sessions.some(
      (session) => session.id === chatState.activeSession?.id,
    )
      ? chatState.activeSession
      : null;

  const sendPrompt = (): void => {
    if (!canSend || choiceCommand) return;
    if (canRetryExactPrompt && retryableAttempt) {
      onStartPrompt(retryableAttempt);
      return;
    }
    const sessionID = chatState.selectedSessionID;
    if (!sessionID) return;
    const requestID = globalThis.crypto.randomUUID();
    const attempt = { requestID, sessionID, text: draft };
    setRetryablePrompt(null);
    onStartPrompt(attempt);
  };

  const retryExactPrompt = (): void => {
    if (!canSend || !canRetryExactPrompt || !retryableAttempt) return;
    onStartPrompt(retryableAttempt);
  };

  return (
    <section aria-label="OpenCode chat" className="chat-layout">
      <aside aria-label="Session history" className="session-sidebar">
        <div className="session-sidebar-heading">
          <h2>Sessions</h2>
          <button
            aria-label="Refresh sessions"
            className="icon-button"
            disabled={chatState.loadingSessions || chatState.sending}
            onClick={onLoadSessions}
            title="Refresh sessions"
            type="button"
          >
            <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 16 16" width="16">
              <path
                d="M13.5 7.2A5.6 5.6 0 0 0 3.4 4.8L2.5 6m0 0V3.5M2.5 6H5m-2.5 2.8a5.6 5.6 0 0 0 10.1 2.4l.9-1.2m0 0v2.5m0-2.5H11"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.3"
              />
            </svg>
          </button>
        </div>
        <form
          className="session-search-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSearchSessions(sessionSearchDraft);
          }}
        >
          <label className="visually-hidden" htmlFor="session-search">
            Search sessions
          </label>
          <input
            autoComplete="off"
            className="session-search-input"
            id="session-search"
            maxLength={200}
            onChange={(event) => setSessionSearchDraft(event.currentTarget.value)}
            placeholder="Search sessions"
            type="search"
            value={sessionSearchDraft}
          />
          <button
            className="text-button session-search-submit"
            disabled={chatState.loadingSessions || chatState.sending}
            type="submit"
          >
            Search
          </button>
        </form>
        <button
          className="new-session-button"
          disabled={
            chatState.loadingSessions ||
            chatState.sending ||
            chatState.switchingChoice !== null
          }
          onClick={onCreateSession}
          type="button"
        >
          <span aria-hidden="true">＋</span> New session
        </button>
        {chatState.sessionsError && (
          <p className="session-error" role="alert">
            {chatState.sessionsError}
          </p>
        )}
        <div className="session-list-region">
          {chatState.loadingSessions && (
            <p className="subtle-copy">Loading sessions…</p>
          )}
          {!chatState.loadingSessions &&
            chatState.sessions.length === 0 &&
            !selectedSessionOutsideList && (
            <p className="subtle-copy">
              {chatState.sessionSearch
                ? "No sessions match this search."
                : "No sessions returned by OpenCode."}
            </p>
          )}
          <ul className="session-list">
            {selectedSessionOutsideList && (
              <li className="selected-session-entry">
                <span className="session-list-label">
                  Selected session · outside {chatState.sessionSearch ? "search results" : "loaded pages"}
                </span>
                <SessionHistoryRow
                  deleting={chatState.deletingSessionID === selectedSessionOutsideList.id}
                  disabled={chatState.sending}
                  onDelete={onDeleteSession}
                  onSelect={onSelectSession}
                  selected
                  selectedOutsidePage
                  session={selectedSessionOutsideList}
                />
              </li>
            )}
            {chatState.sessions.map((session) => (
              <li key={session.id}>
                <SessionHistoryRow
                  deleting={chatState.deletingSessionID === session.id}
                  disabled={chatState.sending}
                  onDelete={onDeleteSession}
                  onSelect={onSelectSession}
                  selected={session.id === chatState.selectedSessionID}
                  session={session}
                />
              </li>
            ))}
          </ul>
          {chatState.sessionNextCursor !== null && (
            <button
              className="text-button load-more-sessions"
              disabled={
                chatState.loadingMoreSessions ||
                chatState.loadingSessions ||
                chatState.sending
              }
              onClick={onLoadMoreSessions}
              type="button"
            >
              {chatState.loadingMoreSessions ? "Loading more sessions…" : "Load more sessions"}
            </button>
          )}
        </div>
      </aside>

      <section aria-label="Conversation" className="conversation-panel">
        <div className="conversation-toolbar">
          <div className="conversation-location">
            <span className="live-indicator" aria-hidden="true" />
            <span>OpenCode {connectionState.version}</span>
            <span aria-hidden="true">·</span>
            <span
              className="selected-session-title"
              title={chatState.activeSession?.title ?? "No active session"}
            >
              {chatState.activeSession?.title ?? "No active session"}
            </span>
            <span aria-hidden="true">·</span>
            <span className="server-location" title={connectionState.serverUrl}>
              {connectionState.serverUrl}
            </span>
          </div>
          <div className="toolbar-actions">
            {chatState.selectedSessionID !== null &&
              chatState.sessionActivity === "active" && (
                <button
                  aria-label={
                    chatState.interruptStatus === "waiting"
                      ? "Stop requested; waiting for OpenCode to confirm the session is idle"
                      : chatState.interruptStatus === "error"
                        ? "Retry stop request for the selected session"
                        : "Request stop for the selected session"
                  }
                  className="text-button session-interrupt-button"
                  disabled={
                    chatState.interruptStatus === "requesting" ||
                    chatState.interruptStatus === "waiting"
                  }
                  onClick={() =>
                    onInterruptSession(chatState.selectedSessionID!)
                  }
                  title="Request interruption for the selected OpenCode session"
                  type="button"
                >
                  {chatState.interruptStatus === "requesting"
                    ? "Requesting stop…"
                    : chatState.interruptStatus === "waiting"
                      ? "Stop requested…"
                      : chatState.interruptStatus === "error"
                        ? "Retry stop request"
                        : "Stop session"}
                </button>
              )}
            <button
              className="icon-button expanded-button"
              onClick={onOpenExpanded}
              title="Open expanded view"
              type="button"
            >
              <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 16 16" width="16">
                <path
                  d="M6 2.5H2.5V6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10M2.8 2.8l3 3m7.4-3-3 3m3 7.4-3-3m-4.4 3-3-3"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.2"
                />
              </svg>
              <span>Expand</span>
            </button>
            <button className="text-button" onClick={onDisconnect} type="button">
              {connectionState.owner === "managed" ? "Stop server" : "Disconnect"}
            </button>
          </div>
        </div>

        <SessionChoiceControls
          agents={chatState.agents}
          agentChoicesError={chatState.agentChoicesError}
          agentChoicesStatus={chatState.agentChoicesStatus}
          choiceError={chatState.choiceError}
          disabled={chatState.sending || chatState.switchingChoice !== null}
          filteredModels={filteredModels}
          choiceCommand={choiceCommand}
          onCommandDraft={onDraftChange}
          modelChoicesError={chatState.modelChoicesError}
          modelChoicesStatus={chatState.modelChoicesStatus}
          onRefresh={onRefreshChoices}
          onSelectAgent={onSelectAgent}
          onSelectModel={onSelectModel}
          providerChoicesError={chatState.providerChoicesError}
          providerChoicesStatus={chatState.providerChoicesStatus}
          providerFilter={providerFilter}
          providerNames={providerNames}
          providers={chatState.providers}
          selectedAgent={chatState.selectedAgent}
          selectedModel={chatState.selectedModel}
          selectedSession={chatState.selectedSessionID !== null}
          setProviderFilter={setProviderFilter}
          switchingChoice={chatState.switchingChoice}
          onChoiceCursorChange={setChoiceCursor}
          choiceActionable={choiceActionable}
          providerOptions={providerOptions}
          modelOptions={modelOptions}
          activeChoiceIndex={activeChoiceIndex}
          activeChoiceListboxId={activeChoiceListboxId}
        />

        <CapabilityInventory
          capabilityState={capabilityState}
          onLoadChildSessions={onLoadChildSessions}
          onLoadMcpStatus={onLoadMcpStatus}
          onLoadSkills={onLoadSkills}
          onLoadToolMetadata={onLoadToolMetadata}
          selectedModel={chatState.selectedModel}
          selectedSessionID={chatState.selectedSessionID}
        />

        <RequestInbox
          chatState={chatState}
          onRefresh={onRefreshRequests}
          onReplyToPermission={onReplyToPermission}
          onReplyToQuestion={onReplyToQuestion}
          onRejectQuestion={onRejectQuestion}
        />

        <div aria-live="polite" className="messages-region" role="log">
          {chatState.historyNextCursor !== null && (
            <button
              className="text-button load-older-history"
              disabled={
                chatState.loadingMessages ||
                chatState.loadingOlderMessages ||
                chatState.sending
              }
              onClick={onLoadOlderHistory}
              type="button"
            >
              {chatState.loadingOlderMessages
                ? "Loading older messages…"
                : "Load older messages"}
            </button>
          )}
          {chatState.loadingMessages && (
            <p className="conversation-empty">Loading session messages…</p>
          )}
          {!chatState.loadingMessages && !chatState.selectedSessionID && (
            <div className="conversation-empty-state">
              <h2>Start with a session</h2>
              <p>Select a session from the history or create a new one.</p>
            </div>
          )}
          {!chatState.loadingMessages &&
            chatState.selectedSessionID &&
            chatState.messages.length === 0 &&
            !chatState.historyError && (
              <div className="conversation-empty-state">
                <h2>No messages yet</h2>
                <p>Send a prompt to begin this OpenCode session.</p>
              </div>
            )}
          {chatState.sessionDiffs.length > 0 && (
            <SessionDiffView diffs={chatState.sessionDiffs} />
          )}
          {chatState.messages.map((message) => (
            <MessageView
              key={message.id}
              message={message}
              onCopyText={onCopyText}
            />
          ))}
        </div>

        {(promptNotice ?? chatState.error) && (
          <p className="chat-error" role="alert">
            {promptNotice ?? chatState.error}
          </p>
        )}

        {chatState.historyError && (
          <p className="chat-error" role="alert">
            {chatState.historyError}
          </p>
        )}

        {unknownPrompt && (
          <div className="prompt-retry-control">
            <p>
              Review the current session before deciding whether to retry. An
              exact retry reuses the same message ID and prompt.
            </p>
            <div className="prompt-retry-actions">
              <button
                aria-label="Review session history"
                className="text-button prompt-retry-button"
                disabled={chatState.loadingMessages || chatState.sending}
                onClick={onReviewSessionHistory}
                type="button"
              >
                Review session history
              </button>
              {canRetryExactPrompt && (
                <button
                  aria-label="Retry exact prompt"
                  className="text-button prompt-retry-button"
                  disabled={!canSend}
                  onClick={retryExactPrompt}
                  type="button"
                >
                  Retry exact prompt
                </button>
              )}
            </div>
          </div>
        )}

        {chatState.selectedSessionID && (
          <p className={`stream-status stream-status-${chatState.streamStatus}`} role="status">
            {getStreamStatus(chatState.streamStatus)}
          </p>
        )}

        {chatState.selectedSessionID !== null && (
          <div className="session-activity-feedback">
            {chatState.sessionActivity === "unknown" &&
              chatState.sessionActivityRefreshing && (
                <p className="session-activity-status" role="status">
                  Checking session activity…
                </p>
              )}
            {chatState.interruptStatus === "requesting" && (
              <p className="session-activity-status" role="status">
                Requesting an interrupt for the selected session…
              </p>
            )}
            {chatState.interruptStatus === "waiting" && (
              <p className="session-activity-status" role="status">
                Stop requested — waiting for OpenCode to confirm this session is idle.
              </p>
            )}
            {chatState.interruptError && (
              <p className="session-activity-error" role="alert">
                {chatState.interruptError} Use “Retry stop request” to try again.
              </p>
            )}
            {chatState.sessionActivityError && (
              <div className="session-activity-error" role="alert">
                <span>{chatState.sessionActivityError}</span>
                <button
                  className="text-button session-activity-refresh"
                  disabled={chatState.sessionActivityRefreshing}
                  onClick={() =>
                    onRefreshSessionActivity(chatState.selectedSessionID!)
                  }
                  type="button"
                >
                  {chatState.sessionActivityRefreshing
                    ? "Checking…"
                    : "Check activity again"}
                </button>
              </div>
            )}
          </div>
        )}

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (choiceCommand) return;
            sendPrompt();
          }}
        >
          <label className="visually-hidden" htmlFor="prompt-composer">
            Message OpenCode
          </label>
          <textarea
            autoCapitalize="sentences"
            autoComplete="off"
            className="prompt-input"
            disabled={
              pendingPrompt !== null ||
              chatState.sending ||
              chatState.loadingMessages
            }
            id="prompt-composer"
            role={choiceCommand ? "combobox" : undefined}
            aria-autocomplete={choiceCommand ? "list" : undefined}
            aria-expanded={choiceCommand ? choiceAriaState.expanded : undefined}
            aria-controls={choiceCommand ? choiceAriaState.controls : undefined}
            aria-activedescendant={choiceAriaState.activeDescendant}
            maxLength={20_000}
            onChange={(event) => {
              onEditorContextErrorDismiss();
              onDraftChange(event.currentTarget.value);
              setChoiceCursor(0);
            }}
            onKeyDown={(event) => {
              if (choiceCommand && !event.nativeEvent.isComposing) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  if (choiceActionable) {
                    setChoiceCursor((current) => moveChoiceSelection(normalizeChoiceSelection(current, activeChoiceOptions.length), event.key === "ArrowDown" ? 1 : -1, activeChoiceOptions.length));
                  }
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  onDraftChange("");
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (!choiceActionable) return;
                  if (choiceCommand.command === "provider") {
                    const provider = resolveChoiceOption(providerOptions, activeChoiceIndex, choiceActionable);
                    if (provider) {
                      setProviderFilter(provider.id);
                      onDraftChange("/model ");
                      setChoiceCursor(0);
                    }
                  } else {
                    const model = resolveChoiceOption(modelOptions, activeChoiceIndex, choiceActionable);
                    if (model) {
                      onSelectModel(model.providerID, model.id);
                      onDraftChange("");
                      setChoiceCursor(0);
                    }
                  }
                  return;
                }
              }
              if (shouldSubmitPrompt({
                key: event.key,
                shiftKey: event.shiftKey,
                isComposing: event.nativeEvent.isComposing,
              })) {
                event.preventDefault();
                sendPrompt();
              }
            }}
            placeholder={
              !chatState.selectedSessionID
                ? "Select or create a session first"
                : chatState.streamStatus === "connected"
                  ? "Message OpenCode… Try /provider or /model"
                  : "Connecting to live updates…"
            }
            rows={3}
            ref={promptInput}
            value={draft}
          />
          {editorContextError && (
            <p className="editor-context-error" role="alert">
              {editorContextError}
            </p>
          )}
          <div className="composer-footer">
            <span>Enter to send <span aria-hidden="true">·</span> Shift+Enter for a new line</span>
            <div className="composer-actions">
              <button
                aria-label="Add editor context to prompt"
                className="text-button editor-context-button"
                disabled={pendingPrompt !== null || chatState.sending || chatState.loadingMessages}
                onClick={onAddEditorContext}
                title="Insert the active editor file reference and selected text into the draft"
                type="button"
              >
                Add editor context
              </button>
              <button className="send-button" disabled={!canSend || choiceCommand !== null} type="submit">
                {chatState.sending ? "Sending…" : "Send"}
                <span aria-hidden="true">↗</span>
              </button>
            </div>
          </div>
        </form>
      </section>
    </section>
  );
}

function SessionHistoryRow({
  deleting,
  disabled,
  onDelete,
  onSelect,
  selected,
  selectedOutsidePage = false,
  session,
}: {
  deleting: boolean;
  disabled: boolean;
  onDelete: (sessionID: string) => void;
  onSelect: (sessionID: string) => void;
  selected: boolean;
  selectedOutsidePage?: boolean;
  session: ChatSession;
}) {
  return (
    <div className="session-item-row">
      <button
        aria-current={selected ? "page" : undefined}
        aria-label={`${selectedOutsidePage ? "Open selected session" : "Open session"} ${session.title}`}
        className={`session-item ${selected ? "session-item-selected" : ""}`}
        disabled={disabled}
        onClick={() => onSelect(session.id)}
        type="button"
      >
        <span className="session-title">{session.title}</span>
        <time dateTime={new Date(session.updatedAt).toISOString()}>
          {formatUpdatedAt(session.updatedAt)}
        </time>
      </button>
      <button
        aria-label={`Delete session ${session.title}`}
        className="session-delete-button"
        disabled={disabled || deleting}
        onClick={() => onDelete(session.id)}
        title={deleting ? "Confirming session deletion" : "Delete session"}
        type="button"
      >
        {deleting ? "…" : "Delete"}
      </button>
    </div>
  );
}

function SessionChoiceControls({
  agents,
  agentChoicesError,
  agentChoicesStatus,
  choiceError,
  disabled,
  filteredModels,
  choiceCommand,
  onCommandDraft,
  onChoiceCursorChange,
  choiceActionable,
  providerOptions,
  modelOptions,
  activeChoiceIndex,
  activeChoiceListboxId,
  modelChoicesError,
  modelChoicesStatus,
  onRefresh,
  onSelectAgent,
  onSelectModel,
  providerChoicesError,
  providerChoicesStatus,
  providerFilter,
  providerNames,
  providers,
  selectedAgent,
  selectedModel,
  selectedSession,
  setProviderFilter,
  switchingChoice,
}: {
  agents: ChatState["agents"];
  agentChoicesError: string | null;
  agentChoicesStatus: ChatState["agentChoicesStatus"];
  choiceError: string | null;
  disabled: boolean;
  filteredModels: ChatState["models"];
  choiceCommand: ReturnType<typeof parseChoiceCommand>;
  onCommandDraft: (draft: string) => void;
  onChoiceCursorChange: (index: number) => void;
  choiceActionable: boolean;
  providerOptions: { id: string; label: string }[];
  modelOptions: { id: string; providerID: string; label: string }[];
  activeChoiceIndex: number;
  activeChoiceListboxId: string | undefined;
  modelChoicesError: string | null;
  modelChoicesStatus: ChatState["modelChoicesStatus"];
  onRefresh: () => void;
  onSelectAgent: (agentID: string) => void;
  onSelectModel: (providerID: string, modelID: string) => void;
  providerChoicesError: string | null;
  providerChoicesStatus: ChatState["providerChoicesStatus"];
  providerFilter: string;
  providerNames: Map<string, string>;
  providers: ChatState["providers"];
  selectedAgent: string | null;
  selectedModel: ChatState["selectedModel"];
  selectedSession: boolean;
  setProviderFilter: (providerID: string) => void;
  switchingChoice: ChatState["switchingChoice"];
}) {
  const selectableModels = filteredModels.filter((model) => model.enabled);
  const selectedAgentIsListed = agents.some((agent) => agent.id === selectedAgent);
  const choicesLoading =
    providerChoicesStatus === "loading" ||
    modelChoicesStatus === "loading" ||
    agentChoicesStatus === "loading";
  return (
    <section aria-label="Session model and agent choices" className="session-choice-controls">
      <div className="choice-fields">
        <div className="model-summary" aria-live="polite">
          <span>Model</span>
          <strong>{selectedModel ? `${providerNames.get(selectedModel.providerID) ?? selectedModel.providerID} · ${selectedModel.id}` : selectedSession ? "Session model not reported" : "Use OpenCode default"}</strong>
        </div>
        <label className="choice-field" htmlFor="session-agent">
          <span>Agent</span>
          <select
            disabled={disabled || agentChoicesStatus !== "ready"}
            id="session-agent"
            onChange={(event) => {
              if (agents.some((agent) => agent.id === event.currentTarget.value)) {
                onSelectAgent(event.currentTarget.value);
              }
            }}
            value={selectedAgent ?? ""}
          >
            <option value="">
              {agentChoicesStatus === "loading"
                ? "Loading agents…"
                : agentChoicesStatus === "unavailable"
                  ? "Agents unavailable"
                  : agentChoicesStatus === "idle"
                    ? "Agent choices not loaded"
                    : selectedSession
                      ? "Session agent not reported"
                      : "Use OpenCode default"}
            </option>
            {selectedAgent && !selectedAgentIsListed && (
              <option disabled value={selectedAgent}>
                Current: {selectedAgent} (not in available list)
              </option>
            )}
            {agentChoicesStatus === "ready" && agents.length === 0 && (
              <option disabled value="__none">No agents returned by OpenCode</option>
            )}
            {agents.map((agent) => (
              <option key={agent.id} title={agent.description} value={agent.id}>
                {agent.id}
              </option>
            ))}
          </select>
        </label>
        <button
          className="text-button refresh-choices-button"
          disabled={choicesLoading}
          onClick={onRefresh}
          type="button"
        >
          {choicesLoading ? "Loading choices…" : "Refresh choices"}
        </button>
      </div>
      <p className="choice-guidance">
        Type <code>/provider</code> or <code>/model</code> in the message box to choose from server-returned options.
        {" "}{switchingChoice === "model" ? "Switching the model for subsequent turns…" : selectedSession ? "Changes apply to subsequent turns." : "Choices will be used when you create a session."}
      </p>
      {choiceCommand && (
        <div className="choice-command-panel" role="group" aria-label={`${choiceCommand.command} choices`}>
          <div className="choice-command-heading">
            <strong>{choiceCommand.command === "provider" ? "Choose a provider" : "Choose a model"}</strong>
            <span>Use ↑/↓ and Enter, or click an option. Esc closes.</span>
          </div>
          {choiceCommand.command === "provider" && providerChoicesStatus === "loading" && <p role="status">Loading providers…</p>}
          {choiceCommand.command === "model" && modelChoicesStatus === "loading" && <p role="status">Loading models…</p>}
          {choiceCommand.command === "provider" && providerChoicesError && <p role="alert">{providerChoicesError}</p>}
          {choiceCommand.command === "model" && modelChoicesError && <p role="alert">{modelChoicesError}</p>}
          {choiceCommand.command === "provider" && providerChoicesStatus === "unavailable" && <p role="status">Providers unavailable. Refresh choices to try again.</p>}
          {choiceCommand.command === "model" && modelChoicesStatus === "unavailable" && <p role="status">Models unavailable. Refresh choices to try again.</p>}
          {choiceCommand.command === "provider" && providerChoicesStatus === "idle" && <p role="status">Provider choices are not loaded yet. Refresh choices to request them.</p>}
          {choiceCommand.command === "model" && modelChoicesStatus === "idle" && <p role="status">Model choices are not loaded yet. Refresh choices to request them.</p>}
          {choiceCommand.command === "provider" && providerChoicesStatus === "ready" && (providerOptions.length ? (
            <ul id={activeChoiceListboxId} role="listbox" aria-label="Providers">{providerOptions.map((provider, index) => <li key={provider.id}><button id={`provider-choice-option-${index}`} type="button" role="option" aria-selected={index === activeChoiceIndex} aria-disabled={!choiceActionable} disabled={!choiceActionable} className="choice-option" onMouseEnter={() => onChoiceCursorChange(index)} onClick={() => { if (!choiceActionable) return; setProviderFilter(provider.id); onCommandDraft("/model "); onChoiceCursorChange(0); }}>{provider.label}<span>{provider.id}</span></button></li>)}</ul>
          ) : <p role="status">No returned providers match “{choiceCommand.query}”.</p>)}
          {choiceCommand.command === "model" && modelChoicesStatus === "ready" && (modelOptions.length ? (
            <ul id={activeChoiceListboxId} role="listbox" aria-label="Models">{modelOptions.map((model, index) => <li key={modelChoiceKey(model.providerID, model.id)}><button id={`model-choice-option-${index}`} type="button" role="option" aria-selected={index === activeChoiceIndex} aria-disabled={!choiceActionable} disabled={!choiceActionable} className="choice-option" onMouseEnter={() => onChoiceCursorChange(index)} onClick={() => { if (!choiceActionable) return; onSelectModel(model.providerID, model.id); onCommandDraft(""); onChoiceCursorChange(0); }}>{model.label}<span>{model.id}</span></button></li>)}</ul>
          ) : <p role="status">No returned enabled models match “{choiceCommand.query}”.</p>)}
        </div>
      )}
      {choicesLoading && (
        <p className="choice-status" role="status">
          Loading provider, model, and agent choices for this workspace…
        </p>
      )}
      {choiceCommand?.command !== "provider" && providerChoicesStatus === "ready" && providers.length === 0 && (
        <p className="choice-status" role="status">
          OpenCode returned no providers for this workspace.
        </p>
      )}
      {choiceCommand?.command !== "model" && modelChoicesStatus === "ready" && selectableModels.length === 0 && (
        <p className="choice-status" role="status">
          {filteredModels.length === 0
            ? providerFilter
              ? "OpenCode returned no models for this provider filter."
              : "OpenCode returned no models for this workspace."
            : "OpenCode returned no enabled models for this workspace."}
        </p>
      )}
      {agentChoicesStatus === "ready" && agents.length === 0 && (
        <p className="choice-status" role="status">
          OpenCode returned no visible agents for this workspace.
        </p>
      )}
      {choiceCommand?.command !== "provider" && providerChoicesError && (
        <p className="choice-error" role="alert">{providerChoicesError}</p>
      )}
      {choiceCommand?.command !== "model" && modelChoicesError && (
        <p className="choice-error" role="alert">{modelChoicesError}</p>
      )}
      {agentChoicesError && (
        <p className="choice-error" role="alert">{agentChoicesError}</p>
      )}
      {choiceError && <p className="choice-error" role="alert">{choiceError}</p>}
    </section>
  );
}

function CapabilityInventory({
  capabilityState,
  onLoadChildSessions,
  onLoadMcpStatus,
  onLoadSkills,
  onLoadToolMetadata,
  selectedModel,
  selectedSessionID,
}: {
  capabilityState: CapabilityState;
  onLoadChildSessions: () => void;
  onLoadMcpStatus: () => void;
  onLoadSkills: () => void;
  onLoadToolMetadata: () => void;
  selectedModel: ChatState["selectedModel"];
  selectedSessionID: string | null;
}) {
  const toolScopeMatches = Boolean(
    selectedModel &&
    capabilityState.tools.providerID === selectedModel.providerID &&
    capabilityState.tools.modelID === selectedModel.id,
  );
  const tools = toolScopeMatches
    ? capabilityState.tools
    : {
        status: "idle" as const,
        providerID: null,
        modelID: null,
        tools: [],
        error: null,
      };
  const childScopeMatches =
    selectedSessionID !== null &&
    capabilityState.children.parentSessionID === selectedSessionID;
  const children = childScopeMatches
    ? capabilityState.children
    : {
        ...capabilityState.children,
        status: "idle" as const,
        parentSessionID: selectedSessionID,
        sessions: [],
        scannedSessionCount: 0,
        truncated: false,
        agentModesAvailable: null,
        error: null,
      };

  return (
    <details className="capability-inventory">
      <summary>
        <span>Read-only server inventory</span>
        <span className="capability-inventory-label">MCP · tools · skills · child sessions</span>
      </summary>
      <div className="capability-sections">
        <CapabilitySection
          emptyMessage="OpenCode returned no MCP server statuses."
          error={capabilityState.mcp.error}
          hasItems={capabilityState.mcp.servers.length > 0}
          onRefresh={onLoadMcpStatus}
          status={capabilityState.mcp.status}
          title="MCP server status"
        >
          <p className="capability-guidance">
            The server reports status only. This does not identify which MCP
            server owns a tool.
          </p>
          {capabilityState.mcp.status === "ready" &&
            capabilityState.mcp.servers.length > 0 && (
              <ul className="capability-list">
                {capabilityState.mcp.servers.map((server) => (
                  <li key={server.name}>
                    <span className="capability-item-name">{server.name}</span>
                    <span className="capability-item-state">
                      {formatCapabilityValue(server.status)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
        </CapabilitySection>

        <CapabilitySection
          disabled={!selectedModel}
          emptyMessage="OpenCode returned no tool metadata for this provider/model."
          error={tools.error}
          hasItems={tools.tools.length > 0}
          idleMessage={
            selectedModel
              ? `Load metadata for the server-reported model ${selectedModel.providerID}/${selectedModel.id}.`
              : "Select a server-reported model before loading tool metadata."
          }
          onRefresh={onLoadToolMetadata}
          status={tools.status}
          title="Tool metadata"
        >
          <p className="capability-guidance">
            Results are scoped to the provider/model shown above. The
            experimental endpoint reflects the server default agent, which may
            differ from the selected agent; it does not report per-MCP tool
            ownership or active execution.
          </p>
          {selectedModel && (
            <p className="capability-scope">
              Scope: <code>{selectedModel.providerID}/{selectedModel.id}</code>
              {" · experimental endpoint"}
            </p>
          )}
          {tools.status === "ready" && tools.tools.length > 0 && (
            <ul className="capability-list capability-tool-list">
              {tools.tools.map((tool) => (
                <li key={tool.id}>
                  <details className="capability-item-details">
                    <summary>
                      <span className="capability-item-name">{tool.id}</span>
                    </summary>
                    <div className="capability-item-content">
                      <p>{tool.description || "No description returned."}</p>
                      <details className="capability-parameters">
                        <summary>Parameter schema</summary>
                        <pre>{tool.parameters}</pre>
                      </details>
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </CapabilitySection>

        <CapabilitySection
          emptyMessage="OpenCode returned no registered skills."
          error={capabilityState.skills.error}
          hasItems={capabilityState.skills.skills.length > 0}
          onRefresh={onLoadSkills}
          status={capabilityState.skills.status}
          title="Registered skills"
        >
          <p className="capability-guidance">
            Skill metadata uses an experimental endpoint. The v1.19.0 response
            has no source-state field; skill contents and local locations are
            omitted.
          </p>
          {capabilityState.skills.status === "ready" &&
            capabilityState.skills.skills.length > 0 && (
              <ul className="capability-list capability-skill-list">
                {capabilityState.skills.skills.map((skill) => (
                  <li key={skill.name}>
                    <span className="capability-item-name">{skill.name}</span>
                    <span className="capability-item-state">Registered</span>
                    {skill.description && <p>{skill.description}</p>}
                  </li>
                ))}
              </ul>
            )}
        </CapabilitySection>

        <CapabilitySection
          disabled={!selectedSessionID}
          emptyMessage="No child sessions with a server-reported parentID match this session."
          error={children.error}
          hasItems={children.sessions.length > 0}
          idleMessage={
            selectedSessionID
              ? `Load child sessions whose server-reported parentID equals ${selectedSessionID}.`
              : "Select a session before loading its child sessions."
          }
          onRefresh={onLoadChildSessions}
          status={children.status}
          title="Child sessions"
        >
          <p className="capability-guidance">
            Relationships are filtered from server-returned parentID values;
            titles and naming patterns are not used.
          </p>
          {children.status === "ready" && children.sessions.length > 0 && (
            <ul className="capability-list capability-child-list">
              {children.sessions.map((session) => (
                <li key={session.id}>
                  <span className="capability-item-name">{session.title}</span>
                  <span className="capability-item-state">Child session</span>
                  {session.subagent && (
                    <span className="capability-item-state">Subagent</span>
                  )}
                  <code>{session.id}</code>
                  {session.agent && <span>Agent: {session.agent}</span>}
                  <time dateTime={new Date(session.updatedAt).toISOString()}>
                    Updated {formatUpdatedAt(session.updatedAt)}
                  </time>
                </li>
              ))}
            </ul>
          )}
          {children.status === "ready" && children.agentModesAvailable === false && (
            <p className="capability-guidance">
              Agent classification was unavailable; these entries remain
              labeled only as child sessions.
            </p>
          )}
          {children.status === "ready" && children.truncated && (
            <p className="capability-guidance">
              The server returned another page cursor after {children.scannedSessionCount} session
              records; only those scanned records were checked for this parentID.
            </p>
          )}
        </CapabilitySection>
      </div>
    </details>
  );
}

function CapabilitySection({
  children,
  disabled = false,
  emptyMessage,
  error,
  hasItems,
  idleMessage,
  onRefresh,
  status,
  title,
}: {
  children: ReactNode;
  disabled?: boolean;
  emptyMessage: string;
  error: string | null;
  hasItems: boolean;
  idleMessage?: string;
  onRefresh: () => void;
  status: CapabilityState["mcp"]["status"];
  title: string;
}) {
  return (
    <details className="capability-section">
      <summary>
        <span>{title}</span>
        <span className={`capability-status capability-status-${status}`}>
          {formatCapabilityValue(status)}
        </span>
      </summary>
      <div className="capability-section-content">
        {status === "idle" && idleMessage && (
          <p className="capability-guidance">{idleMessage}</p>
        )}
        {status === "loading" && (
          <p className="capability-guidance" role="status">
            Loading server-returned metadata…
          </p>
        )}
        {status === "ready" && !hasItems && (
          <p className="capability-guidance" role="status">{emptyMessage}</p>
        )}
        {error && <p className="capability-error" role="alert">{error}</p>}
        {children}
        <button
          className="text-button capability-refresh-button"
          disabled={disabled || status === "loading"}
          onClick={onRefresh}
          type="button"
        >
          {status === "idle" ? "Load" : status === "loading" ? "Loading…" : "Refresh"}
        </button>
      </div>
    </details>
  );
}

function formatCapabilityValue(value: string): string {
  const words = value.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function modelChoiceKey(providerID: string, modelID: string): string {
  return JSON.stringify([providerID, modelID]);
}

function MessageView({
  message,
  onCopyText,
}: {
  message: ChatMessage;
  onCopyText: (text: string) => void;
}) {
  return (
    <article
      aria-label={`${message.role === "assistant" ? "OpenCode" : message.role === "system" ? "OpenCode context" : "You"} message`}
      className={`message-row message-${message.role}`}
    >
      <p className="message-author">
        {message.role === "assistant" ? "OpenCode" : message.role === "system" ? "OpenCode context" : "You"}
      </p>
      {message.role === "assistant" && message.parts ? (
        <div className="assistant-parts">
          {message.parts.map((part) => (
            <AssistantPartView
              key={`${part.type}:${part.id}`}
              onCopyText={onCopyText}
              part={part}
            />
          ))}
        </div>
      ) : message.role === "system" ? (
        <p style={{ whiteSpace: "pre-wrap" }}>{message.text}</p>
      ) : (
        <MarkdownContent onCopyText={onCopyText} text={message.text} />
      )}
    </article>
  );
}

function RequestInbox({
  chatState,
  onRefresh,
  onReplyToPermission,
  onReplyToQuestion,
  onRejectQuestion,
}: {
  chatState: ChatState;
  onRefresh: () => void;
  onReplyToPermission: (
    sessionID: string,
    requestID: string,
    reply: "once" | "always" | "reject",
  ) => void;
  onReplyToQuestion: (
    sessionID: string,
    requestID: string,
    answers: string[][],
  ) => void;
  onRejectQuestion: (sessionID: string, requestID: string) => void;
}) {
  if (
    !chatState.selectedSessionID ||
    (!chatState.loadingRequests &&
      !chatState.requestError &&
      chatState.permissionRequests.length === 0 &&
      chatState.questionRequests.length === 0)
  ) {
    return null;
  }

  return (
    <section
      aria-label="Pending permission and question requests"
      aria-live="polite"
      aria-relevant="additions"
      aria-atomic="false"
      className="request-inbox"
    >
      <header className="request-inbox-header">
        <h2>Pending requests</h2>
        <button
          aria-label="Refresh pending requests"
          className="text-button"
          disabled={chatState.loadingRequests}
          onClick={onRefresh}
          type="button"
        >
          {chatState.loadingRequests ? "Refreshing…" : "Refresh"}
        </button>
      </header>
      {chatState.loadingRequests && (
        <p className="request-inbox-status" role="status">
          Checking the selected session for pending requests…
        </p>
      )}
      {chatState.requestError && (
        <p className="request-error" role="alert">{chatState.requestError}</p>
      )}
      {chatState.activeRequestAction?.status === "accepted" && (
        <p className="request-inbox-status" role="status">
          OpenCode accepted the response. Pending requests are being refreshed.
        </p>
      )}
      {chatState.permissionRequests.map((request) => (
        <PermissionRequestCard
          key={`${request.sessionID}\u0000${request.id}`}
          request={request}
          action={chatState.activeRequestAction}
          actionsDisabled={chatState.activeRequestAction !== null}
          onReply={onReplyToPermission}
        />
      ))}
      {chatState.questionRequests.map((request) => (
        <QuestionRequestCard
          key={`${request.sessionID}\u0000${request.id}`}
          request={request}
          action={chatState.activeRequestAction}
          actionsDisabled={chatState.activeRequestAction !== null}
          onReply={onReplyToQuestion}
          onReject={onRejectQuestion}
        />
      ))}
    </section>
  );
}

function PermissionRequestCard({
  request,
  action,
  actionsDisabled,
  onReply,
}: {
  request: ChatPermissionRequest;
  action: ChatRequestAction | null;
  actionsDisabled: boolean;
  onReply: (
    sessionID: string,
    requestID: string,
    reply: "once" | "always" | "reject",
  ) => void;
}) {
  const actionStatus = getRequestActionStatus(action, "permission", request);
  return (
    <article className="request-card permission-request-card">
      <div className="request-card-heading">
        <h3>Permission required: {request.action}</h3>
        <code>{request.id}</code>
      </div>
      {request.resources.length > 0 && (
        <div className="request-context">
          <h4>Resources</h4>
          <ul>
            {request.resources.map((resource, index) => (
              <li key={`${index}:${resource}`}><code>{resource}</code></li>
            ))}
          </ul>
        </div>
      )}
      {request.save && request.save.length > 0 && (
        <div className="request-context">
          <h4>Save scopes</h4>
          <ul>
            {request.save.map((scope, index) => (
              <li key={`${index}:${scope}`}><code>{scope}</code></li>
            ))}
          </ul>
        </div>
      )}
      {request.source && (
        <p className="request-source">
          Tool call <code>{request.source.callID}</code>
        </p>
      )}
      {request.metadata && (
        <details className="request-metadata">
          <summary>Request context</summary>
          <pre>{request.metadata}</pre>
        </details>
      )}
      {actionStatus && <p className="request-inbox-status" role="status">{actionStatus}</p>}
      <div className="request-actions">
        <button
          className="primary-button"
          disabled={actionsDisabled}
          onClick={() => onReply(request.sessionID, request.id, "once")}
          type="button"
        >
          Allow once
        </button>
        <button
          className="secondary-button"
          disabled={actionsDisabled}
          onClick={() => onReply(request.sessionID, request.id, "always")}
          type="button"
        >
          Always allow
        </button>
        <button
          className="secondary-button"
          disabled={actionsDisabled}
          onClick={() => onReply(request.sessionID, request.id, "reject")}
          type="button"
        >
          Reject
        </button>
      </div>
    </article>
  );
}

function QuestionRequestCard({
  request,
  action,
  actionsDisabled,
  onReply,
  onReject,
}: {
  request: ChatQuestionRequest;
  action: ChatRequestAction | null;
  actionsDisabled: boolean;
  onReply: (
    sessionID: string,
    requestID: string,
    answers: string[][],
  ) => void;
  onReject: (sessionID: string, requestID: string) => void;
}) {
  const [selectedAnswers, setSelectedAnswers] = useState<string[][]>(() =>
    request.questions.map(() => []),
  );
  const [customAnswers, setCustomAnswers] = useState<string[]>(() =>
    request.questions.map(() => ""),
  );
  const [customSelected, setCustomSelected] = useState<boolean[]>(() =>
    request.questions.map(() => false),
  );
  const actionStatus = getRequestActionStatus(action, "question", request);
  const answers = composeQuestionAnswers(
    request.questions,
    selectedAnswers,
    customAnswers,
    customSelected,
  );
  const canAnswer = answers !== undefined;

  const submitAnswers = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!answers || actionsDisabled) return;
    onReply(request.sessionID, request.id, answers);
  };

  return (
    <article className="request-card question-request-card">
      <div className="request-card-heading">
        <h3>Question from OpenCode</h3>
        <code>{request.id}</code>
      </div>
      {request.tool && (
        <p className="request-source">
          Tool call <code>{request.tool.callID}</code>
        </p>
      )}
      {request.questions.length === 0 && (
        <p className="request-inbox-status">
          OpenCode supplied no questions to answer. Reject or refresh this request.
        </p>
      )}
      <form onSubmit={submitAnswers}>
        {request.questions.map((question, questionIndex) => {
          const groupName = `question-${request.id}-${questionIndex}`;
          const selected = selectedAnswers[questionIndex] ?? [];
          const customAnswer = customAnswers[questionIndex] ?? "";
          const useCustom = customSelected[questionIndex] ?? false;
          const setSelected = (values: string[]): void => {
            setSelectedAnswers((current) =>
              current.map((answers, index) => index === questionIndex ? values : answers),
            );
          };
          const setCustomAnswer = (value: string): void => {
            setCustomAnswers((current) =>
              current.map((answer, index) => index === questionIndex ? value : answer),
            );
          };
          const setUseCustom = (value: boolean): void => {
            setCustomSelected((current) =>
              current.map((selectedCustom, index) => index === questionIndex ? value : selectedCustom),
            );
          };

          return (
            <fieldset className="question-fieldset" key={`${question.header}:${questionIndex}`}>
              <legend>
                {question.header ? <strong>{question.header}: </strong> : null}
                {question.question}
                {question.multiple ? " (select all that apply)" : ""}
              </legend>
              {question.options.map((option, optionIndex) => (
                <label
                  className="question-option"
                  key={`${option.label}:${optionIndex}`}
                >
                  <input
                    checked={selected.includes(option.label)}
                    disabled={actionsDisabled}
                    name={groupName}
                    onChange={(event) => {
                      if (question.multiple) {
                        setSelected(
                          event.currentTarget.checked
                            ? [...selected, option.label]
                            : selected.filter((answer) => answer !== option.label),
                        );
                        return;
                      }
                      setSelected([option.label]);
                      setUseCustom(false);
                    }}
                    type={question.multiple ? "checkbox" : "radio"}
                  />
                  <span>
                    <span>{option.label}</span>
                    {option.description && (
                      <small className="question-option-description">
                        {option.description}
                      </small>
                    )}
                  </span>
                </label>
              ))}
              {question.custom && (
                <div className="question-custom-answer">
                  {!question.multiple && (
                    <label className="question-option">
                      <input
                        checked={useCustom}
                        disabled={actionsDisabled}
                        name={groupName}
                        onChange={() => setUseCustom(true)}
                        type="radio"
                      />
                      <span>Custom answer</span>
                    </label>
                  )}
                  <label className="visually-hidden" htmlFor={`${groupName}-custom`}>
                    Custom answer for {question.header || question.question}
                  </label>
                  <input
                    autoComplete="off"
                    className="request-text-input"
                    disabled={actionsDisabled}
                    id={`${groupName}-custom`}
                    maxLength={8_000}
                    onChange={(event) => {
                      setCustomAnswer(event.currentTarget.value);
                      if (!question.multiple) setUseCustom(true);
                    }}
                    placeholder="Enter a custom answer"
                    type="text"
                    value={customAnswer}
                  />
                </div>
              )}
            </fieldset>
          );
        })}
        {actionStatus && <p className="request-inbox-status" role="status">{actionStatus}</p>}
        <div className="request-actions">
          <button
            className="primary-button"
            disabled={!canAnswer || actionsDisabled}
            type="submit"
          >
            Submit answers
          </button>
          <button
            className="secondary-button"
            disabled={actionsDisabled}
            onClick={() => onReject(request.sessionID, request.id)}
            type="button"
          >
            Reject question
          </button>
        </div>
      </form>
    </article>
  );
}

function getRequestActionStatus(
  action: ChatRequestAction | null,
  kind: ChatRequestAction["kind"],
  request: ChatPermissionRequest | ChatQuestionRequest,
): string | null {
  if (
    !action ||
    action.kind !== kind ||
    action.sessionID !== request.sessionID ||
    action.requestID !== request.id
  ) {
    return null;
  }
  return action.status === "submitting"
    ? "Sending response to OpenCode…"
    : "OpenCode accepted the response; checking pending state…";
}

function AssistantPartView({
  onCopyText,
  part,
}: {
  onCopyText: (text: string) => void;
  part: ChatAssistantPart;
}) {
  if (part.type === "text") {
    return <MarkdownContent onCopyText={onCopyText} text={part.text} />;
  }
  return <ToolActivityView part={part} />;
}

function ToolActivityView({ part }: { part: ChatToolPart }) {
  const title = part.name ?? "Tool call";
  const status = part.status ?? "Status not provided";
  const hasDetails = Boolean(
    part.input !== undefined ||
      part.output !== undefined ||
      part.result !== undefined ||
      part.structured !== undefined ||
      part.content !== undefined ||
      part.error !== undefined ||
      part.generic !== undefined,
  );

  return (
    <details aria-label={`Tool call: ${title}`} className="tool-activity">
      <summary className="tool-activity-summary">
        <span className="tool-activity-name">{title}</span>
        <span className={`tool-activity-status ${part.status ? `tool-status-${part.status}` : ""}`}>
          {status}
        </span>
        {part.durationMs !== undefined && (
          <span className="tool-activity-duration">
            {formatDuration(part.durationMs)}
          </span>
        )}
      </summary>
      {hasDetails && (
        <dl className="tool-activity-fields">
          {part.input !== undefined && (
            <ToolField label="Input" value={part.input} />
          )}
          {part.output !== undefined && (
            <ToolField label="Output" value={part.output} />
          )}
          {part.result !== undefined && (
            <ToolField label="Result" value={part.result} />
          )}
          {part.structured !== undefined && (
            <ToolField label="Structured data" value={part.structured} />
          )}
          {part.content !== undefined && (
            <ToolField label="Content" value={part.content} />
          )}
          {part.error !== undefined && (
            <ToolField label="Error" value={part.error} />
          )}
          {part.generic !== undefined && (
            <ToolField label="Tool details" value={part.generic} />
          )}
        </dl>
      )}
    </details>
  );
}

function ToolField({ label, value }: { label: string; value: string }) {
  return (
    <div className="tool-activity-field">
      <dt>{label}</dt>
      <dd><pre>{value}</pre></dd>
    </div>
  );
}

function SessionDiffView({ diffs }: { diffs: ChatState["sessionDiffs"] }) {
  return (
    <details aria-label="Session file changes" className="session-diff-view">
      <summary>Session file changes ({diffs.length})</summary>
      <ul>
        {diffs.map((diff, index) => (
          <li key={`${diff.file ?? "file"}:${index}`}>
            <div className="session-diff-heading">
              <code>{diff.file ?? "File path not provided"}</code>
              {diff.status && <span>{diff.status}</span>}
              <span>+{diff.additions} −{diff.deletions}</span>
            </div>
            {diff.patch !== undefined && <pre>{diff.patch}</pre>}
          </li>
        ))}
      </ul>
    </details>
  );
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)} s`;
  return `${Math.floor(durationMs / 60_000)} min ${Math.round((durationMs % 60_000) / 1_000)} s`;
}

function MarkdownContent({
  onCopyText,
  text,
}: {
  onCopyText: (text: string) => void;
  text: string;
}) {
  return (
    <div className="markdown-content">
      <ReactMarkdown
        components={{
          pre: ({ children }) => (
            <CopyableCodeBlock onCopyText={onCopyText}>
              {children}
            </CopyableCodeBlock>
          ),
        }}
        skipHtml
        urlTransform={defaultUrlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function CopyableCodeBlock({
  children,
  onCopyText,
}: {
  children: ReactNode;
  onCopyText: (text: string) => void;
}) {
  const codeText = textFromRenderedNode(children).replace(/\n$/, "");

  return (
    <div className="code-block">
      <pre>{children}</pre>
      <button
        aria-label="Copy code block"
        className="copy-code-button"
        disabled={!codeText || codeText.length > 1_000_000}
        onClick={() => onCopyText(codeText)}
        type="button"
      >
        Copy code
      </button>
    </div>
  );
}

function textFromRenderedNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromRenderedNode).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return textFromRenderedNode(node.props.children);
  }
  return "";
}

function formatUpdatedAt(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(timestamp);
}

function getStreamStatus(status: ChatState["streamStatus"]): string {
  switch (status) {
    case "inactive":
      return "Live updates paused while this view is closed.";
    case "connecting":
      return "Connecting to OpenCode live updates…";
    case "connected":
      return "Live updates connected.";
    case "error":
      return "Live updates need attention.";
  }
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
          "Connect to browse server sessions, open conversation history, and send prompts.",
        indicatorClass: "status-dot-muted",
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
            : `Checking ${state.serverUrl}.`,
        indicatorClass: "status-dot-active",
      };
    case "disconnecting":
      return {
        label: "Stopping managed server",
        title: "Stopping the extension-owned server",
        message: `Waiting for the managed process at ${state.serverUrl} to exit.`,
        indicatorClass: "status-dot-active",
      };
    case "connected":
      return {
        label: "Connected",
        title: "OpenCode is ready",
        message: `OpenCode ${state.version} is healthy at ${state.serverUrl}. ${state.owner === "managed" ? "This extension started and owns the server." : "This is an attached server; disconnect only detaches."}`,
        indicatorClass: "status-dot-connected",
      };
    case "version-mismatch":
      return {
        label: "Version mismatch",
        title: "OpenCode version is not supported",
        message: `The server is healthy but reports ${state.actualVersion}. This extension targets ${state.expectedVersion}. ${state.owner === "managed" ? "The extension owns this managed process." : "The server is attached and will not be stopped on disconnect."}`,
        indicatorClass: "status-dot-muted",
      };
    case "error":
      return {
        label: state.owner === "managed" ? "Managed server needs attention" : "Connection failed",
        title:
          state.reason === "server-stop"
            ? "Managed server shutdown needs attention"
            : "Could not connect to OpenCode",
        message: state.message,
        indicatorClass: "status-dot-muted",
      };
  }
}
