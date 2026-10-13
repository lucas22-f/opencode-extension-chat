import * as vscode from "vscode";
import { ManagedOpenCodeServer } from "./managed-opencode-server";
import { OpenCodeConnection } from "./opencode-connection";
import { dispatchWebviewMessage } from "../shared/webview-message";
import { createWebviewHtml } from "./webview-html";

const CHAT_VIEW_ID = "opencodeVisual.chatView";
const OPEN_EXPANDED_COMMAND = "opencodeVisual.openExpandedView";
const EXPANDED_VIEW_TYPE = "opencodeVisual.expanded";

let expandedPanel: vscode.WebviewPanel | undefined;
let activeConnection: OpenCodeConnection | undefined;

class ChatViewProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly openExpanded: () => void,
    private readonly connection: OpenCodeConnection,
  ) {}

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    const { webview } = webviewView;
    const webviewRoot = vscode.Uri.joinPath(
      this.context.extensionUri,
      "dist",
      "webview",
    );

    webview.options = {
      enableScripts: true,
      localResourceRoots: [webviewRoot],
    };
    const html = await createWebviewHtml(webview, this.context.extensionUri);
    const messageSubscription = bindWebviewMessages(
      webview,
      this.connection,
      this.openExpanded,
    );
    this.context.subscriptions.push(messageSubscription);
    webviewView.onDidDispose(() => messageSubscription.dispose());
    webview.html = html;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const managedServerStorage = vscode.Uri.joinPath(
    context.globalStorageUri,
    "managed-server-leases",
  ).fsPath;
  const connection = new OpenCodeConnection(
    undefined,
    (directory) =>
      new ManagedOpenCodeServer(directory, {
        leaseStorageDirectory: managedServerStorage,
      }),
  );
  activeConnection = connection;
  const openExpanded = (): void => {
    void openExpandedPanel(context, connection);
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      CHAT_VIEW_ID,
      new ChatViewProvider(context, openExpanded, connection),
    ),
    vscode.commands.registerCommand(OPEN_EXPANDED_COMMAND, openExpanded),
  );
}

export async function deactivate(): Promise<void> {
  const connection = activeConnection;
  activeConnection = undefined;
  expandedPanel = undefined;
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
): Promise<void> {
  if (expandedPanel) {
    expandedPanel.reveal(vscode.ViewColumn.Active);
    return;
  }

  const webviewRoot = vscode.Uri.joinPath(
    context.extensionUri,
    "dist",
    "webview",
  );
  const panel = vscode.window.createWebviewPanel(
    EXPANDED_VIEW_TYPE,
    "OpenCode Visual",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      localResourceRoots: [webviewRoot],
    },
  );
  expandedPanel = panel;

  const messageSubscription = bindWebviewMessages(
    panel.webview,
    connection,
    () => {
      void openExpandedPanel(context, connection);
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
  openExpanded: () => void,
): vscode.Disposable {
  const messageSubscription = webview.onDidReceiveMessage(
    (message: unknown) => {
      dispatchWebviewMessage(message, {
        openExpanded,
        webviewReady: () => {
          void webview.postMessage({
            type: "connection-state",
            state: connection.state,
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
      });
    },
  );
  const unsubscribe = connection.subscribe((state) => {
    void webview.postMessage({ type: "connection-state", state });
  });

  return new vscode.Disposable(() => {
    messageSubscription.dispose();
    unsubscribe();
  });
}
