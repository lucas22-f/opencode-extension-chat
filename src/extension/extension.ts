import * as vscode from "vscode";
import { ManagedOpenCodeServer } from "./managed-opencode-server";
import { OpenCodeConnection } from "./opencode-connection";
import { OpenCodeChat } from "./opencode-chat";
import { OpenCodeCapabilities } from "./opencode-capabilities";
import { captureActiveEditorContext } from "./editor-context";
import { dispatchWebviewMessage } from "../shared/webview-message";
import { SUPPORTED_OPENCODE_VERSION } from "../shared/connection-state";
import type { EditorContextResult } from "../shared/editor-context";
import { createWebviewHtml, createWebviewOptions } from "./webview-html";
import {
  DIAGNOSTICS_CHANNEL_NAME,
  DiagnosticsRecorder,
} from "./diagnostics";

const CHAT_VIEW_ID = "opencodeVisual.chatView";
const OPEN_EXPANDED_COMMAND = "opencodeVisual.openExpandedView";
const RUN_HEALTH_CHECK_COMMAND = "opencodeVisual.runHealthCheck";
const COPY_DIAGNOSTICS_COMMAND = "opencodeVisual.copyDiagnostics";
const ADD_EDITOR_CONTEXT_COMMAND = "opencodeVisual.addEditorContext";
const EXPANDED_VIEW_TYPE = "opencodeVisual.expanded";

let expandedPanel: vscode.WebviewPanel | undefined;
let activeConnection: OpenCodeConnection | undefined;
let activeChat: OpenCodeChat | undefined;
let activeCapabilities: OpenCodeCapabilities | undefined;
const chatWebviews = new Set<vscode.Webview>();
let lastUsedChatWebview: vscode.Webview | undefined;

class ChatViewProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly openExpanded: () => void,
    private readonly connection: OpenCodeConnection,
    private readonly chat: OpenCodeChat,
    private readonly capabilities: OpenCodeCapabilities,
  ) {}

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    const { webview } = webviewView;
    webview.options = createWebviewOptions(this.context.extensionUri);
    const html = await createWebviewHtml(webview, this.context.extensionUri);
    const messageSubscription = bindWebviewMessages(
      webview,
      this.connection,
      this.chat,
      this.capabilities,
      this.openExpanded,
    );
    this.context.subscriptions.push(messageSubscription);
    webviewView.onDidDispose(() => messageSubscription.dispose());
    webview.html = html;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel(
    DIAGNOSTICS_CHANNEL_NAME,
  );
  const diagnostics = new DiagnosticsRecorder(
    (line) => outputChannel.appendLine(line),
    (lines) => {
      outputChannel.clear();
      for (const line of lines) outputChannel.appendLine(line);
    },
  );
  const managedServerStorage = vscode.Uri.joinPath(
    context.globalStorageUri,
    "managed-server-leases",
  ).fsPath;
  const managedServerDatabasePath = vscode.Uri.joinPath(
    context.globalStorageUri,
    "managed-opencode",
    "opencode.db",
  ).fsPath;
  const connection = new OpenCodeConnection(
    undefined,
    (directory) =>
      new ManagedOpenCodeServer(directory, {
        leaseStorageDirectory: managedServerStorage,
        databasePath: managedServerDatabasePath,
      }),
    diagnostics,
  );
  activeConnection = connection;
  const chat = new OpenCodeChat(
    connection,
    () => connection.connectedWorkspaceDirectory,
    undefined,
    () => vscode.workspace.isTrusted,
    diagnostics,
  );
  activeChat = chat;
  const capabilities = new OpenCodeCapabilities(
    connection,
    () => connection.connectedWorkspaceDirectory,
    () => vscode.workspace.isTrusted,
  );
  activeCapabilities = capabilities;
  const openExpanded = (): void => {
    void openExpandedPanel(context, connection, chat, capabilities);
  };

  context.subscriptions.push(
    outputChannel,
    vscode.window.registerWebviewViewProvider(
      CHAT_VIEW_ID,
      new ChatViewProvider(context, openExpanded, connection, chat, capabilities),
    ),
    vscode.commands.registerCommand(OPEN_EXPANDED_COMMAND, openExpanded),
    vscode.commands.registerCommand(ADD_EDITOR_CONTEXT_COMMAND, async () => {
      const webview = expandedPanel?.active
        ? expandedPanel.webview
        : lastUsedChatWebview;
      if (!webview || !chatWebviews.has(webview)) {
        void vscode.window.showInformationMessage(
          "Open the OpenCode Visual chat before adding editor context.",
        );
        return;
      }
      await addEditorContextToWebview(webview, chat);
    }),
    vscode.commands.registerCommand(RUN_HEALTH_CHECK_COMMAND, async () => {
      outputChannel.show(true);
      const serverUrl = vscode.workspace
        .getConfiguration("opencodeVisual")
        .get<unknown>("serverUrl");
      try {
        const result = await connection.checkHealth(serverUrl);
        if (result.kind === "healthy") {
          if (result.version === SUPPORTED_OPENCODE_VERSION) {
            void vscode.window.showInformationMessage(
              "OpenCode Visual health check succeeded. See Output → OpenCode Visual Diagnostics.",
            );
          } else {
            void vscode.window.showWarningMessage(
              "OpenCode responded with an unsupported version. See Output → OpenCode Visual Diagnostics.",
            );
          }
          return;
        }
        void vscode.window.showWarningMessage(
          `OpenCode Visual health check: ${healthCheckSummary(result.kind)}. See Output → OpenCode Visual Diagnostics.`,
        );
      } catch {
        void vscode.window.showWarningMessage(
          "OpenCode Visual health check could not be completed. See Output → OpenCode Visual Diagnostics.",
        );
      }
    }),
    vscode.commands.registerCommand(COPY_DIAGNOSTICS_COMMAND, async () => {
      const transcript = diagnostics.getTranscript();
      if (!transcript) {
        void vscode.window.showInformationMessage(
          "No OpenCode Visual diagnostics have been recorded yet.",
        );
        return;
      }
      try {
        await vscode.env.clipboard.writeText(transcript);
        void vscode.window.showInformationMessage(
          "Sanitized OpenCode Visual diagnostics copied to the clipboard.",
        );
      } catch {
        void vscode.window.showErrorMessage(
          "Could not copy OpenCode Visual diagnostics to the clipboard.",
        );
      }
    }),
    new vscode.Disposable(() => {
      void chat.dispose();
    }),
  );
}

function healthCheckSummary(kind: string): string {
  switch (kind) {
    case "invalid-configuration":
      return "the configured server URL is invalid";
    case "authentication-required":
      return "the server requires authentication";
    case "unreachable":
      return "the server could not be reached";
    case "timeout":
      return "the health request timed out";
    case "invalid-response":
      return "the server returned an invalid health response";
    case "unexpected-response":
      return "the server returned an unexpected response";
    default:
      return "the check failed";
  }
}

export async function deactivate(): Promise<void> {
  const chat = activeChat;
  activeChat = undefined;
  const connection = activeConnection;
  activeConnection = undefined;
  const capabilities = activeCapabilities;
  activeCapabilities = undefined;
  expandedPanel = undefined;
  chatWebviews.clear();
  lastUsedChatWebview = undefined;
  capabilities?.dispose();
  await chat?.dispose();
  try {
    await connection?.dispose();
  } catch {
    await vscode.window.showErrorMessage(
      "OpenCode Visual could not confirm that its managed OpenCode server stopped.",
    );
  }
}

async function openExpandedPanel(
  context: vscode.ExtensionContext,
  connection: OpenCodeConnection,
  chat: OpenCodeChat,
  capabilities: OpenCodeCapabilities,
): Promise<void> {
  if (expandedPanel) {
    expandedPanel.reveal(vscode.ViewColumn.Active);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    EXPANDED_VIEW_TYPE,
    "OpenCode Visual",
    vscode.ViewColumn.Active,
    createWebviewOptions(context.extensionUri),
  );
  expandedPanel = panel;

  const messageSubscription = bindWebviewMessages(
    panel.webview,
    connection,
    chat,
    capabilities,
    () => {
      void openExpandedPanel(context, connection, chat, capabilities);
    },
  );
  context.subscriptions.push(panel, messageSubscription);
  context.subscriptions.push(
    panel.onDidDispose(() => {
      messageSubscription.dispose();
      if (expandedPanel === panel) expandedPanel = undefined;
    }),
  );

  panel.webview.html = await createWebviewHtml(
    panel.webview,
    context.extensionUri,
  );
}

function bindWebviewMessages(
  webview: vscode.Webview,
  connection: OpenCodeConnection,
  chat: OpenCodeChat,
  capabilities: OpenCodeCapabilities,
  openExpanded: () => void,
): vscode.Disposable {
  chatWebviews.add(webview);
  const messageSubscription = webview.onDidReceiveMessage(
    (message: unknown) => {
      lastUsedChatWebview = webview;
      dispatchWebviewMessage(message, {
        openExpanded,
        webviewReady: () => {
          void webview.postMessage({
            type: "connection-state",
            state: connection.state,
          });
          void webview.postMessage({ type: "chat-state", state: chat.state });
          void webview.postMessage({
            type: "capability-state",
            state: capabilities.state,
          });
        },
        connect: () => {
          const serverUrl = vscode.workspace
            .getConfiguration("opencodeVisual")
            .get<unknown>("serverUrl");
          const directory = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          void connection.connect(serverUrl, {
            ...(directory ? { directory } : {}),
            trusted: vscode.workspace.isTrusted,
          });
        },
        disconnect: () => {
          void connection.disconnect();
        },
        loadSessions: () => {
          void chat.refreshSessions();
        },
        loadMoreSessions: () => {
          void chat.loadMoreSessions();
        },
        searchSessions: (query) => {
          void chat.searchSessions(query);
        },
        loadOlderHistory: () => {
          void chat.loadOlderHistory();
        },
        refreshChoices: () => {
          void chat.refreshChoices();
        },
        loadMcpStatus: () => {
          void capabilities.refreshMcpStatus();
        },
        setMcpServerConnection: (name, connect, generation) => {
          void capabilities.setMcpServerConnection(name, connect, generation);
        },
        loadToolMetadata: () => {
          void capabilities.refreshToolMetadata(chat.state.selectedModel);
        },
        loadSkills: () => {
          void capabilities.refreshSkills();
        },
        loadCommands: () => {
          void capabilities.refreshCommands();
        },
        runCommand: (name, argumentsText) => {
          const sessionID = chat.state.selectedSessionID;
          const model = chat.state.selectedModel;
          if (!sessionID || !model || chat.state.sending) {
            void vscode.window.showErrorMessage("Select a session and model before running a command.");
            return;
          }
          void capabilities.runCommand({
            name,
            arguments: argumentsText,
            sessionID,
            model: `${model.providerID}/${model.id}`,
            agent: chat.state.selectedAgent,
          }).then((accepted) => {
            void (accepted
              ? vscode.window.showInformationMessage("OpenCode command submitted.")
              : vscode.window.showErrorMessage("OpenCode could not confirm the command. Review the session before retrying."));
          });
        },
        loadChildSessions: () => {
          void capabilities.refreshChildSessions(chat.state.selectedSessionID);
        },
        reviewSessionHistory: () => {
          void chat.reviewSelectedSessionHistory();
        },
        refreshRequests: () => {
          void chat.refreshSelectedRequests();
        },
        refreshSessionActivity: (sessionID) => {
          void chat.refreshSessionActivity(sessionID);
        },
        createSession: () => {
          void chat.createSession();
        },
        addEditorContext: () => {
          void addEditorContextToWebview(webview, chat);
        },
        copyText: (text) => {
          void vscode.env.clipboard.writeText(text).then(undefined, () => {
            void vscode.window.showErrorMessage(
              "Could not copy the rendered code block.",
            );
          });
        },
        selectSession: (sessionID) => {
          void chat.selectSession(sessionID);
        },
        interruptSession: (sessionID) => {
          void chat.interruptSession(sessionID);
        },
        selectModel: (providerID, modelID) => {
          void chat.selectModel(providerID, modelID);
        },
        selectAgent: (agentID) => {
          void chat.selectAgent(agentID);
        },
        deleteSession: (sessionID) => {
          void confirmAndDeleteSession(chat, sessionID);
        },
        replyToPermission: (sessionID, requestID, reply) => {
          void chat.replyToPermission(sessionID, requestID, reply);
        },
        replyToQuestion: (sessionID, requestID, answers) => {
          void chat.replyToQuestion(sessionID, requestID, answers);
        },
        rejectQuestion: (sessionID, requestID) => {
          void chat.rejectQuestion(sessionID, requestID);
        },
        sendPrompt: (requestID, attemptID, text, sessionID) => {
          void chat.sendPrompt(requestID, attemptID, text, sessionID);
        },
      });
    },
  );
  const unsubscribe = connection.subscribe((state) => {
    void webview.postMessage({ type: "connection-state", state });
  });
  capabilities.setSelectedSessionID(chat.state.selectedSessionID);
  const unsubscribeCapabilities = capabilities.subscribe((state) => {
    void webview.postMessage({ type: "capability-state", state });
  });
  const unsubscribeChat = chat.subscribe((state) => {
    capabilities.setSelectedSessionID(state.selectedSessionID);
    void webview.postMessage({ type: "chat-state", state });
  });

  return new vscode.Disposable(() => {
    messageSubscription.dispose();
    unsubscribe();
    unsubscribeCapabilities();
    unsubscribeChat();
    chatWebviews.delete(webview);
    if (lastUsedChatWebview === webview) {
      lastUsedChatWebview = Array.from(chatWebviews).at(-1);
    }
  });
}

async function addEditorContextToWebview(
  webview: vscode.Webview,
  chat: OpenCodeChat,
): Promise<void> {
  let result: EditorContextResult;
  try {
    result = await captureActiveEditorContext(
      vscode.window.activeTextEditor,
      chat.connectedWorkspaceDirectory,
      vscode.workspace.workspaceFolders,
      () => vscode.workspace.isTrusted,
      {
        getConnectedWorkspaceDirectory: () => chat.connectedWorkspaceDirectory,
        getWorkspaceFolders: () => vscode.workspace.workspaceFolders,
        getActiveTextEditor: () => vscode.window.activeTextEditor,
      },
    );
  } catch {
    result = {
      kind: "error" as const,
      message: "The active editor context could not be validated.",
    };
  }

  await webview.postMessage({ type: "editor-context-result", result });
}

async function confirmAndDeleteSession(
  chat: OpenCodeChat,
  sessionID: string,
): Promise<void> {
  const session = chat.beginSessionDeletionConfirmation(sessionID);
  if (!session) return;

  try {
    const confirmation = await vscode.window.showWarningMessage(
      `Delete “${session.title}” from OpenCode?`,
      {
        modal: true,
        detail:
          "This permanently removes the session's messages and history. This cannot be undone.",
      },
      { title: "Cancel", isCloseAffordance: true },
      { title: "Delete session" },
    );
    if (confirmation?.title !== "Delete session") return;
    await chat.deleteSession(sessionID);
  } catch {
    void vscode.window.showErrorMessage(
      "OpenCode could not confirm or complete the session deletion.",
    );
  } finally {
    chat.cancelSessionDeletionConfirmation(sessionID);
  }
}
