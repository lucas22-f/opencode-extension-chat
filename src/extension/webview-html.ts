import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

interface WebviewManifestEntry {
  file: string;
  css?: string[];
}

type WebviewManifest = Record<string, WebviewManifestEntry>;

export async function createWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): Promise<string> {
  const webviewRoot = vscode.Uri.joinPath(extensionUri, "dist", "webview");
  const manifestUri = vscode.Uri.joinPath(
    webviewRoot,
    ".vite",
    "manifest.json",
  );
  const manifestText = new TextDecoder().decode(
    await vscode.workspace.fs.readFile(manifestUri),
  );
  const manifest = JSON.parse(manifestText) as WebviewManifest;
  const entry = manifest["index.html"];

  if (!entry?.file) {
    throw new Error("The webview entry is missing from the Vite manifest.");
  }

  const nonce = randomBytes(18).toString("base64");
  const scriptUri = asWebviewAssetUri(webview, webviewRoot, entry.file);
  const stylesheetLinks = (entry.css ?? [])
    .map((assetPath) => {
      const stylesheetUri = asWebviewAssetUri(webview, webviewRoot, assetPath);
      return `<link rel="stylesheet" href="${escapeAttribute(stylesheetUri)}">`;
    })
    .join("\n    ");
  const contentSecurityPolicy = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    `style-src ${webview.cspSource}`,
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(contentSecurityPolicy)}">
    <title>OpenCode Visual</title>
    ${stylesheetLinks}
  </head>
  <body>
    <div id="root"></div>
    <script type="module" nonce="${nonce}" src="${escapeAttribute(scriptUri)}"></script>
  </body>
</html>`;
}

function asWebviewAssetUri(
  webview: vscode.Webview,
  webviewRoot: vscode.Uri,
  assetPath: string,
): string {
  const segments = assetPath.split("/");
  if (
    assetPath.startsWith("/") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("The webview manifest contains an invalid asset path.");
  }

  return webview
    .asWebviewUri(vscode.Uri.joinPath(webviewRoot, ...segments))
    .toString();
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
