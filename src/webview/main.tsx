import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { App } from "./App";
import "./styles.css";
import {
  initialConnectionState,
  type ConnectionState,
} from "../shared/connection-state";
import { initialChatState, type ChatState } from "../shared/chat-state";
import {
  initialCapabilityState,
  type CapabilityState,
} from "../shared/capability-state";
import type { EditorContextResult } from "../shared/editor-context";
import { dispatchExtensionMessage } from "../shared/webview-message";

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscodeApi = acquireVsCodeApi();
const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("The OpenCode Visual webview root element is missing.");
}

function WebviewApp() {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>(initialConnectionState);
  const [chatState, setChatState] = useState<ChatState>(initialChatState);
  const [capabilityState, setCapabilityState] =
    useState<CapabilityState>(initialCapabilityState);
  const [editorContextResult, setEditorContextResult] =
    useState<EditorContextResult | null>(null);

  useEffect(() => {
    const receiveMessage = (event: MessageEvent<unknown>): void => {
      dispatchExtensionMessage(event.data, {
        updateConnectionState: setConnectionState,
        updateChatState: setChatState,
        updateCapabilityState: setCapabilityState,
        updateEditorContextResult: setEditorContextResult,
      });
    };

    window.addEventListener("message", receiveMessage);
    vscodeApi.postMessage({ type: "webview-ready" });
    return () => window.removeEventListener("message", receiveMessage);
  }, []);

  return (
    <App
      chatState={chatState}
      connectionState={connectionState}
      capabilityState={capabilityState}
      onConnect={() => vscodeApi.postMessage({ type: "connect" })}
      onDisconnect={() => vscodeApi.postMessage({ type: "disconnect" })}
      onLoadSessions={() => vscodeApi.postMessage({ type: "load-sessions" })}
      onLoadMoreSessions={() =>
        vscodeApi.postMessage({ type: "load-more-sessions" })
      }
      onSearchSessions={(query) =>
        vscodeApi.postMessage({ type: "search-sessions", query })
      }
      onLoadOlderHistory={() =>
        vscodeApi.postMessage({ type: "load-older-history" })
      }
      onRefreshChoices={() =>
        vscodeApi.postMessage({ type: "refresh-choices" })
      }
      onLoadMcpStatus={() =>
        vscodeApi.postMessage({ type: "load-mcp-status" })
      }
      onLoadToolMetadata={() =>
        vscodeApi.postMessage({ type: "load-tool-metadata" })
      }
      onLoadSkills={() => vscodeApi.postMessage({ type: "load-skills" })}
      onLoadCommands={() => vscodeApi.postMessage({ type: "load-commands" })}
      onRunCommand={(name, argumentsText) => vscodeApi.postMessage({ type: "run-command", name, arguments: argumentsText })}
      onLoadChildSessions={() =>
        vscodeApi.postMessage({ type: "load-child-sessions" })
      }
      onReviewSessionHistory={() =>
        vscodeApi.postMessage({ type: "review-session-history" })
      }
      onRefreshRequests={() =>
        vscodeApi.postMessage({ type: "refresh-requests" })
      }
      onRefreshSessionActivity={(sessionID) =>
        vscodeApi.postMessage({ type: "refresh-session-activity", sessionID })
      }
      onCreateSession={() => vscodeApi.postMessage({ type: "create-session" })}
      onCopyText={(text) =>
        vscodeApi.postMessage({ type: "copy-text", text })
      }
      onSelectSession={(sessionID) =>
        vscodeApi.postMessage({ type: "select-session", sessionID })
      }
      onInterruptSession={(sessionID) =>
        vscodeApi.postMessage({ type: "interrupt-session", sessionID })
      }
      onSelectModel={(providerID, modelID) =>
        vscodeApi.postMessage({ type: "select-model", providerID, modelID })
      }
      onSelectAgent={(agentID) =>
        vscodeApi.postMessage({ type: "select-agent", agentID })
      }
      onDeleteSession={(sessionID) =>
        vscodeApi.postMessage({ type: "delete-session", sessionID })
      }
      onReplyToPermission={(sessionID, requestID, reply) =>
        vscodeApi.postMessage({
          type: "reply-permission",
          sessionID,
          requestID,
          reply,
        })
      }
      onReplyToQuestion={(sessionID, requestID, answers) =>
        vscodeApi.postMessage({
          type: "reply-question",
          sessionID,
          requestID,
          answers,
        })
      }
      onRejectQuestion={(sessionID, requestID) =>
        vscodeApi.postMessage({ type: "reject-question", sessionID, requestID })
      }
      onSendPrompt={(requestID, attemptID, text, sessionID) =>
        vscodeApi.postMessage({
          type: "send-prompt",
          requestID,
          attemptID,
          text,
          sessionID,
        })
      }
      onAddEditorContext={() =>
        vscodeApi.postMessage({ type: "add-editor-context" })
      }
      onClearEditorContextResult={() => setEditorContextResult(null)}
      editorContextResult={editorContextResult}
      onOpenExpanded={() =>
        vscodeApi.postMessage({ type: "open-expanded" })
      }
    />
  );
}

createRoot(rootElement).render(<WebviewApp />);
