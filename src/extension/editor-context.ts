import { realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";
import type { TextEditor, WorkspaceFolder } from "vscode";
import {
  createEditorContextBlock,
  editorContextResultSchema,
  MAX_EDITOR_CONTEXT_BLOCK_CHARACTERS,
  MAX_EDITOR_SELECTION_CHARACTERS,
  type EditorContextResult,
} from "../shared/editor-context";

export interface EditorContextCaptureOptions {
  canonicalizePath?: (filePath: string) => Promise<string>;
  pathFlavor?: "posix" | "win32";
  getConnectedWorkspaceDirectory?: () => string | undefined;
  getWorkspaceFolders?: () => readonly WorkspaceFolder[] | undefined;
  getActiveTextEditor?: () => TextEditor | undefined;
}

export async function captureActiveEditorContext(
  editor: TextEditor | undefined,
  connectedWorkspaceDirectory: string | undefined,
  workspaceFolders: readonly WorkspaceFolder[] | undefined,
  isWorkspaceTrusted: () => boolean,
  options: EditorContextCaptureOptions = {},
): Promise<EditorContextResult> {
  if (!isWorkspaceTrusted()) {
    return editorContextError("Trust the workspace before adding editor context.");
  }
  if (!editor) {
    return editorContextError("Open a file in the connected workspace to add editor context.");
  }

  const documentUri = editor.document.uri;
  if (documentUri.scheme !== "file") {
    return editorContextError("Editor context is available only for files in a local workspace.");
  }

  const activeSelection = editor.selection;
  const documentVersion = editor.document.version;
  const initialWorkspaceFolders = workspaceFolders ? [...workspaceFolders] : undefined;
  const pathApi = options.pathFlavor === "win32" ||
    (options.pathFlavor === undefined && process.platform === "win32")
    ? win32
    : posix;
  if (
    !connectedWorkspaceDirectory ||
    !pathApi.isAbsolute(connectedWorkspaceDirectory) ||
    !initialWorkspaceFolders?.length
  ) {
    return editorContextError(
      "No active OpenCode workspace root is connected. Reconnect before adding editor context.",
    );
  }

  const workspacePath = pathApi.resolve(connectedWorkspaceDirectory);
  const documentPath = pathApi.resolve(documentUri.fsPath);
  if (!pathApi.isAbsolute(documentUri.fsPath)) {
    return editorContextError("The active editor file is outside the connected workspace.");
  }

  const currentWorkspacePaths = initialWorkspaceFolders.map((folder) =>
    folder.uri.scheme === "file" && pathApi.isAbsolute(folder.uri.fsPath)
      ? pathApi.resolve(folder.uri.fsPath)
      : undefined,
  );
  let canonicalWorkspacePath: string;
  let canonicalCurrentWorkspacePaths: Array<string | undefined>;
  const canonicalizePath = options.canonicalizePath ?? realpath;
  try {
    canonicalWorkspacePath = await canonicalizePath(workspacePath);
    canonicalCurrentWorkspacePaths = await Promise.all(
      currentWorkspacePaths.map(async (path) => {
        if (!path) return undefined;
        try {
          return await canonicalizePath(path);
        } catch {
          return undefined;
        }
      }),
    );
  } catch {
    return editorContextError(
      "The connected OpenCode workspace root could not be validated. Reconnect before adding editor context.",
    );
  }

  if (!isWorkspaceTrusted()) {
    return editorContextError("Trust the workspace before adding editor context.");
  }

  if (
    !canonicalCurrentWorkspacePaths[0] ||
    !sameCanonicalPath(
      canonicalWorkspacePath,
      canonicalCurrentWorkspacePaths[0],
      pathApi,
    )
  ) {
    return editorContextError(
      "The connected OpenCode workspace is no longer the active first folder. Reconnect before adding editor context.",
    );
  }

  const isLexicallyWithinConnectedRoot =
    isContainedPath(workspacePath, documentPath, pathApi) ||
    currentWorkspacePaths.some(
      (path, index) =>
        path !== undefined &&
        canonicalCurrentWorkspacePaths[index] !== undefined &&
        sameCanonicalPath(
          canonicalWorkspacePath,
          canonicalCurrentWorkspacePaths[index]!,
          pathApi,
        ) &&
        isContainedPath(path, documentPath, pathApi),
    );
  if (!isLexicallyWithinConnectedRoot) {
    const belongsToAnotherWorkspace = currentWorkspacePaths.some(
      (path, index) =>
        path !== undefined &&
        canonicalCurrentWorkspacePaths[index] !== undefined &&
        !sameCanonicalPath(
          canonicalWorkspacePath,
          canonicalCurrentWorkspacePaths[index]!,
          pathApi,
        ) &&
        isContainedPath(path, documentPath, pathApi),
    );
    return editorContextError(
      belongsToAnotherWorkspace
        ? "The active editor is in a different workspace folder than the one connected to OpenCode."
        : "The active editor file is outside the workspace connected to OpenCode.",
    );
  }

  let canonicalDocumentPath: string;
  try {
    canonicalDocumentPath = await canonicalizePath(documentPath);
  } catch {
    return editorContextError("The active editor file could not be validated inside the connected workspace.");
  }

  if (!isWorkspaceTrusted()) {
    return editorContextError("Trust the workspace before adding editor context.");
  }

  const latestConnectedWorkspaceDirectory = options.getConnectedWorkspaceDirectory
    ? options.getConnectedWorkspaceDirectory()
    : connectedWorkspaceDirectory;
  if (
    !latestConnectedWorkspaceDirectory ||
    !pathApi.isAbsolute(latestConnectedWorkspaceDirectory) ||
    !sameCanonicalPath(
      workspacePath,
      pathApi.resolve(latestConnectedWorkspaceDirectory),
      pathApi,
    )
  ) {
    return editorContextError(
      "The connected OpenCode workspace changed while context was being validated. Reconnect and try again.",
    );
  }

  const latestWorkspaceFolders = options.getWorkspaceFolders
    ? options.getWorkspaceFolders()
    : workspaceFolders;
  const latestEditor = options.getActiveTextEditor
    ? options.getActiveTextEditor()
    : editor;
  if (!sameWorkspaceFolderSnapshot(initialWorkspaceFolders, latestWorkspaceFolders, pathApi)) {
    return editorContextError(
      "Workspace folders changed while editor context was being validated. Reconnect and try again.",
    );
  }
  if (
    !latestEditor ||
    latestEditor.document.uri.scheme !== "file" ||
    !pathApi.isAbsolute(latestEditor.document.uri.fsPath) ||
    !sameCanonicalPath(
      documentPath,
      pathApi.resolve(latestEditor.document.uri.fsPath),
      pathApi,
    ) ||
    !sameSelection(activeSelection, latestEditor.selection) ||
    (!activeSelection.isEmpty && latestEditor.document.version !== documentVersion)
  ) {
    return editorContextError(
      "The active editor changed while context was being validated. Try again.",
    );
  }

  const currentEditorWorkspacePath = canonicalCurrentWorkspacePaths
    .filter(
      (path): path is string =>
        path !== undefined && isContainedPath(path, canonicalDocumentPath, pathApi),
    )
    .sort(
      (left, right) =>
        pathDepth(pathApi.relative(left, canonicalDocumentPath), pathApi) -
        pathDepth(pathApi.relative(right, canonicalDocumentPath), pathApi),
    )[0];
  if (
    currentEditorWorkspacePath &&
    !sameCanonicalPath(canonicalWorkspacePath, currentEditorWorkspacePath, pathApi)
  ) {
    return editorContextError(
      "The active editor is in a different workspace folder than the one connected to OpenCode.",
    );
  }
  if (!isContainedPath(canonicalWorkspacePath, canonicalDocumentPath, pathApi)) {
    return editorContextError("The active editor file is outside the workspace connected to OpenCode.");
  }

  const relativePath = pathApi.relative(canonicalWorkspacePath, canonicalDocumentPath);
  if (relativePath.length === 0 || /[\u0000-\u001f\u007f]/.test(relativePath)) {
    return editorContextError(
      "The active editor file path could not be validated.",
    );
  }

  let selection: { text: string; startLine: number; endLine: number } | undefined;
  if (!activeSelection.isEmpty) {
    if (editor.document.version !== documentVersion) {
      return editorContextError(
        "The active editor changed while context was being validated. Try again.",
      );
    }

    const { start, end } = activeSelection;
    if (
      !Number.isInteger(start.line) ||
      !Number.isInteger(start.character) ||
      !Number.isInteger(end.line) ||
      !Number.isInteger(end.character) ||
      start.line < 0 ||
      start.character < 0 ||
      end.line < start.line ||
      end.character < 0 ||
      (end.line === start.line && end.character < start.character)
    ) {
      return editorContextError("The active editor selection could not be validated.");
    }

    let text: string;
    try {
      text = editor.document.getText(activeSelection);
    } catch {
      return editorContextError("The active editor selection could not be read.");
    }
    if (text.length > MAX_EDITOR_SELECTION_CHARACTERS) {
      return editorContextError(
        `The selection is too large to add to the prompt (limit ${MAX_EDITOR_SELECTION_CHARACTERS.toLocaleString()} characters).`,
      );
    }

    selection = {
      text,
      startLine: start.line + 1,
      endLine:
        end.line + 1 - (end.line > start.line && end.character === 0 ? 1 : 0),
    };
  }

  const context = createEditorContextBlock(relativePath, selection);
  if (context.length > MAX_EDITOR_CONTEXT_BLOCK_CHARACTERS) {
    return editorContextError("The editor context is too large to add to the prompt.");
  }
  return editorContextResultSchema.parse({ kind: "ready", context });
}

function isContainedPath(
  rootPath: string,
  targetPath: string,
  pathApi: typeof posix,
): boolean {
  const relativePath = pathApi.relative(rootPath, targetPath);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${pathApi.sep}`) &&
      !pathApi.isAbsolute(relativePath))
  );
}

function sameCanonicalPath(
  leftPath: string,
  rightPath: string,
  pathApi: typeof posix,
): boolean {
  return (
    isContainedPath(leftPath, rightPath, pathApi) &&
    isContainedPath(rightPath, leftPath, pathApi)
  );
}

function sameWorkspaceFolderSnapshot(
  initial: readonly WorkspaceFolder[],
  current: readonly WorkspaceFolder[] | undefined,
  pathApi: typeof posix,
): boolean {
  if (!current || initial.length !== current.length) return false;
  return initial.every((folder, index) => {
    const currentFolder = current[index];
    if (!currentFolder || folder.uri.scheme !== currentFolder.uri.scheme) return false;
    if (folder.uri.scheme !== "file") {
      return folder.uri.toString() === currentFolder.uri.toString();
    }
    return (
      pathApi.isAbsolute(folder.uri.fsPath) &&
      pathApi.isAbsolute(currentFolder.uri.fsPath) &&
      sameCanonicalPath(
        pathApi.resolve(folder.uri.fsPath),
        pathApi.resolve(currentFolder.uri.fsPath),
        pathApi,
      )
    );
  });
}

function sameSelection(
  left: TextEditor["selection"],
  right: TextEditor["selection"],
): boolean {
  return (
    left.isEmpty === right.isEmpty &&
    left.start.line === right.start.line &&
    left.start.character === right.start.character &&
    left.end.line === right.end.line &&
    left.end.character === right.end.character
  );
}

function pathDepth(relativePath: string, pathApi: typeof posix): number {
  return relativePath.length === 0 ? 0 : relativePath.split(pathApi.sep).length;
}

function editorContextError(message: string): EditorContextResult {
  return editorContextResultSchema.parse({ kind: "error", message });
}
