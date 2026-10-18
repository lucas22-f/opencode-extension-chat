import type { TextEditor, WorkspaceFolder } from "vscode";
import { describe, expect, it, vi } from "vitest";
import {
  captureActiveEditorContext,
  type EditorContextCaptureOptions,
} from "../src/extension/editor-context";
import {
  createEditorContextBlock,
  MAX_EDITOR_CONTEXT_BLOCK_CHARACTERS,
  MAX_EDITOR_SELECTION_CHARACTERS,
} from "../src/shared/editor-context";

const WORKSPACE = String.raw`C:\Workspace C 2026\Project`;
const OTHER_WORKSPACE = String.raw`C:\Workspace C 2026\Other Project`;

interface TestSelection {
  isEmpty: boolean;
  start: { line: number; character: number };
  end: { line: number; character: number };
}

function createEditor(options: {
  path?: string;
  scheme?: string;
  selection?: TestSelection;
  text?: string;
} = {}) {
  let documentVersion = 1;
  const selection = options.selection ?? {
    isEmpty: true,
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
  };
  const getText = vi.fn((_range?: unknown) => options.text ?? "");
  const editor = {
    document: {
      get version() {
        return documentVersion;
      },
      uri: {
        scheme: options.scheme ?? "file",
        fsPath: options.path ?? String.raw`C:\Workspace C 2026\Project\src\main.ts`,
      },
      getText,
    },
    selection,
  } as unknown as TextEditor;
  return {
    editor,
    getText,
    selection,
    setDocumentVersion: (version: number) => {
      documentVersion = version;
    },
  };
}

function createWorkspaceFolder(path = WORKSPACE, scheme = "file") {
  return {
    uri: { scheme, fsPath: path },
  } as unknown as WorkspaceFolder;
}

function options(
  canonicalizePath: (filePath: string) => Promise<string> = async (path) => path,
  pathFlavor: "posix" | "win32" = "win32",
): EditorContextCaptureOptions {
  return { canonicalizePath, pathFlavor };
}

describe("active editor prompt context", () => {
  it("fails closed for an untrusted workspace or missing editor", async () => {
    const { editor, getText } = createEditor({
      selection: {
        isEmpty: false,
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
      text: "private",
    });
    const canonicalizePath = vi.fn(async (path: string) => path);

    await expect(
      captureActiveEditorContext(
        editor,
        WORKSPACE,
        [createWorkspaceFolder()],
        () => false,
        options(canonicalizePath),
      ),
    ).resolves.toMatchObject({ kind: "error" });
    await expect(
      captureActiveEditorContext(
        undefined,
        WORKSPACE,
        [createWorkspaceFolder()],
        () => true,
        options(canonicalizePath),
      ),
    ).resolves.toMatchObject({ kind: "error" });
    expect(canonicalizePath).not.toHaveBeenCalled();
    expect(getText).not.toHaveBeenCalled();
  });

  it("rejects when there is no active connected workspace root", async () => {
    const { editor, getText } = createEditor();
    const result = await captureActiveEditorContext(
      editor,
      undefined,
      [createWorkspaceFolder()],
      () => true,
      options(),
    );

    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("No active OpenCode workspace root"),
    });
    expect(getText).not.toHaveBeenCalled();
  });

  it.each(["untitled", "git", "vscode-notebook-cell"])(
    "rejects a %s document URI",
    async (scheme) => {
      const { editor } = createEditor({ scheme });
      const canonicalizePath = vi.fn(async (path: string) => path);

      await expect(
        captureActiveEditorContext(
          editor,
          WORKSPACE,
          [createWorkspaceFolder()],
          () => true,
          options(canonicalizePath),
        ),
      ).resolves.toMatchObject({ kind: "error" });
      expect(canonicalizePath).not.toHaveBeenCalled();
    },
  );

  it("rejects lexical out-of-root paths and traversal after root validation", async () => {
    const canonicalizePath = vi.fn(async (path: string) => path);
    const { editor, getText } = createEditor({
      path: String.raw`C:\Workspace C 2026\Project\..\Project-escape\secret.ts`,
      selection: {
        isEmpty: false,
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
      text: "private",
    });

    await expect(
      captureActiveEditorContext(
        editor,
        WORKSPACE,
        [createWorkspaceFolder()],
        () => true,
        options(canonicalizePath),
      ),
    ).resolves.toMatchObject({
      kind: "error",
      message: expect.stringContaining("outside the workspace connected to OpenCode"),
    });
    expect(canonicalizePath).toHaveBeenCalledTimes(2);
    expect(getText).not.toHaveBeenCalled();
  });

  it("rejects when the captured connected root is no longer a workspace folder", async () => {
    const { editor, getText } = createEditor({
      path: `${OTHER_WORKSPACE}\\private.ts`,
      selection: {
        isEmpty: false,
        start: { line: 0, character: 0 },
        end: { line: 0, character: 7 },
      },
      text: "private",
    });

    const result = await captureActiveEditorContext(
      editor,
      WORKSPACE,
      [createWorkspaceFolder(OTHER_WORKSPACE)],
      () => true,
      options(),
    );

    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("no longer the active first folder"),
    });
    expect(getText).not.toHaveBeenCalled();
  });

  it("rejects an editor from a different current workspace folder", async () => {
    const { editor, getText } = createEditor({
      path: `${OTHER_WORKSPACE}\\private.ts`,
      selection: {
        isEmpty: false,
        start: { line: 0, character: 0 },
        end: { line: 0, character: 7 },
      },
      text: "private",
    });

    const result = await captureActiveEditorContext(
      editor,
      WORKSPACE,
      [createWorkspaceFolder(), createWorkspaceFolder(OTHER_WORKSPACE)],
      () => true,
      options(),
    );

    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("different workspace folder"),
    });
    expect(getText).not.toHaveBeenCalled();
  });

  it("rejects an editor owned by a nested workspace folder under the connected root", async () => {
    const nestedWorkspace = `${WORKSPACE}\\nested`;
    const { editor, getText } = createEditor({
      path: `${nestedWorkspace}\\private.ts`,
      selection: {
        isEmpty: false,
        start: { line: 0, character: 0 },
        end: { line: 0, character: 7 },
      },
      text: "private",
    });

    const result = await captureActiveEditorContext(
      editor,
      WORKSPACE,
      [createWorkspaceFolder(), createWorkspaceFolder(nestedWorkspace)],
      () => true,
      options(),
    );

    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("different workspace folder"),
    });
    expect(getText).not.toHaveBeenCalled();
  });

  it("rejects context when the captured root is no longer the active first folder", async () => {
    const { editor, getText } = createEditor({
      path: `${WORKSPACE}\\src\\connected.ts`,
      selection: {
        isEmpty: false,
        start: { line: 0, character: 0 },
        end: { line: 0, character: 4 },
      },
      text: "private",
    });
    const result = await captureActiveEditorContext(
      editor,
      WORKSPACE,
      [createWorkspaceFolder(OTHER_WORKSPACE), createWorkspaceFolder()],
      () => true,
      options(),
    );

    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("no longer the active first folder"),
    });
    expect(getText).not.toHaveBeenCalled();
  });

  it("rejects if workspace folders change during canonical realpath validation", async () => {
    let currentWorkspaceFolders: readonly WorkspaceFolder[] = [createWorkspaceFolder()];
    const selection: TestSelection = {
      isEmpty: false,
      start: { line: 0, character: 0 },
      end: { line: 0, character: 6 },
    };
    const { editor, getText } = createEditor({
      path: String.raw`C:\Workspace C 2026\Project\src\source.ts`,
      selection,
      text: "secret",
    });
    const canonicalizePath = vi.fn(async (path: string) => {
      if (path.endsWith("source.ts")) {
        currentWorkspaceFolders = [createWorkspaceFolder(OTHER_WORKSPACE)];
      }
      return path;
    });

    const result = await captureActiveEditorContext(
      editor,
      WORKSPACE,
      currentWorkspaceFolders,
      () => true,
      {
        ...options(canonicalizePath),
        getWorkspaceFolders: () => currentWorkspaceFolders,
        getActiveTextEditor: () => editor,
      },
    );

    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("Workspace folders changed while editor context was being validated"),
    });
    expect(getText).not.toHaveBeenCalled();
  });

  it("rejects a different active editor selected during awaited realpath validation", async () => {
    const selection: TestSelection = {
      isEmpty: false,
      start: { line: 0, character: 0 },
      end: { line: 0, character: 6 },
    };
    const { editor, getText } = createEditor({
      path: String.raw`C:\Workspace C 2026\Project\src\source.ts`,
      selection,
      text: "CONNECTED_TEXT",
    });
    const foreignEditorData = createEditor({
      path: String.raw`C:\Workspace C 2026\Other Project\private.ts`,
      selection,
      text: "FOREIGN_SELECTED_TEXT",
    });
    let activeEditor: TextEditor | undefined = editor;
    let releaseDocumentRealpath!: () => void;
    let signalDocumentRealpathStarted!: () => void;
    const documentRealpathStarted = new Promise<void>((resolve) => {
      signalDocumentRealpathStarted = resolve;
    });
    const canonicalizePath = vi.fn(async (path: string) => {
      if (path.endsWith("source.ts")) {
        signalDocumentRealpathStarted();
        await new Promise<void>((resolve) => {
          releaseDocumentRealpath = resolve;
        });
      }
      return path;
    });

    const capture = captureActiveEditorContext(
      editor,
      WORKSPACE,
      [createWorkspaceFolder()],
      () => true,
      {
        ...options(canonicalizePath),
        getActiveTextEditor: () => activeEditor,
      },
    );
    await documentRealpathStarted;
    activeEditor = foreignEditorData.editor;
    releaseDocumentRealpath();
    const result = await capture;

    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("active editor changed"),
    });
    expect(getText).not.toHaveBeenCalled();
    expect(foreignEditorData.getText).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private.ts");
    expect(JSON.stringify(result)).not.toContain("FOREIGN_SELECTED_TEXT");
  });

  it("rejects a document symlink whose canonical target escapes the workspace", async () => {
    const { editor, getText } = createEditor({
      selection: {
        isEmpty: false,
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
      text: "private",
    });
    const canonicalizePath = vi.fn(async (path: string) =>
      path.endsWith("main.ts")
        ? String.raw`C:\Outside\secret.ts`
        : String.raw`C:\Workspace C 2026\Project`,
    );

    await expect(
      captureActiveEditorContext(
        editor,
        WORKSPACE,
        [createWorkspaceFolder()],
        () => true,
        options(canonicalizePath),
      ),
    ).resolves.toMatchObject({ kind: "error" });
    expect(canonicalizePath).toHaveBeenCalledTimes(3);
    expect(getText).not.toHaveBeenCalled();
  });

  it("adds only a safe workspace-relative file reference when there is no selection", async () => {
    const { editor, getText } = createEditor({
      path: String.raw`C:\Workspace C 2026\Project\src\folder name\Ñ file.ts`,
    });
    const result = await captureActiveEditorContext(
      editor,
      WORKSPACE,
      [createWorkspaceFolder()],
      () => true,
      options(),
    );

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.context).toContain(String.raw`src\folder name\Ñ file.ts`);
    expect(result.context).toContain("file reference only; no file or buffer contents are included");
    expect(result.context).toContain("may not be able to access this workspace path");
    expect(result.context).not.toContain(WORKSPACE);
    expect(getText).not.toHaveBeenCalled();
  });

  it("preserves selected unsaved buffer text and reports inclusive 1-based lines", async () => {
    const selection: TestSelection = {
      isEmpty: false,
      start: { line: 2, character: 0 },
      end: { line: 4, character: 0 },
    };
    const selectedText = "first line\r\nsecond `line`\r\n";
    const { editor, getText } = createEditor({
      path: String.raw`C:\Workspace C 2026\Project\src\editor.ts`,
      selection,
      text: selectedText,
    });

    const result = await captureActiveEditorContext(
      editor,
      WORKSPACE,
      [createWorkspaceFolder()],
      () => true,
      options(),
    );

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.context).toContain(
      "Source: selected text from the active VS Code editor buffer; includes unsaved changes.",
    );
    expect(result.context).toContain("Selected lines (1-based, inclusive): 3–4");
    expect(result.context).toContain(selectedText);
    expect(result.context).toContain("```text");
    expect(getText).toHaveBeenCalledOnce();
    expect(getText).toHaveBeenCalledWith(selection);
    expect(result.context).not.toContain(WORKSPACE);
    expect(result.context.length).toBeLessThanOrEqual(MAX_EDITOR_CONTEXT_BLOCK_CHARACTERS);
  });

  it("rejects a selection if the editor buffer changes during path validation", async () => {
    const { editor, getText, setDocumentVersion } = createEditor({
      selection: {
        isEmpty: false,
        start: { line: 0, character: 0 },
        end: { line: 0, character: 4 },
      },
      text: "before",
    });
    const canonicalizePath = vi.fn(async (path: string) => {
      setDocumentVersion(2);
      return path;
    });

    await expect(
      captureActiveEditorContext(
        editor,
        WORKSPACE,
        [createWorkspaceFolder()],
        () => true,
        options(canonicalizePath),
      ),
    ).resolves.toMatchObject({ kind: "error" });
    expect(getText).not.toHaveBeenCalled();
  });

  it("compares Windows canonical paths without case sensitivity and preserves separators", async () => {
    const { editor } = createEditor({
      path: String.raw`c:\workspace c 2026\project\src\資料 folder\file name.ts`,
    });
    const canonicalizePath = vi.fn(async (path: string) =>
      path.includes("Workspace")
        ? String.raw`C:\Workspace C 2026\Project`
        : String.raw`c:\workspace c 2026\project\src\資料 folder\file name.ts`,
    );

    const result = await captureActiveEditorContext(
      editor,
      WORKSPACE,
      [createWorkspaceFolder()],
      () => true,
      options(canonicalizePath, "win32"),
    );

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.context).toContain(String.raw`src\資料 folder\file name.ts`);
    expect(result.context).not.toContain(String.raw`C:\Workspace C 2026`);
  });

  it("rejects oversized selections without truncating or returning context", async () => {
    const selection: TestSelection = {
      isEmpty: false,
      start: { line: 0, character: 0 },
      end: { line: 1, character: 0 },
    };
    const { editor, getText } = createEditor({
      selection,
      text: "x".repeat(MAX_EDITOR_SELECTION_CHARACTERS + 1),
    });
    const canonicalizePath = vi.fn(async (path: string) => path);

    const result = await captureActiveEditorContext(
      editor,
      WORKSPACE,
      [createWorkspaceFolder()],
      () => true,
      options(canonicalizePath),
    );

    expect(result).toMatchObject({ kind: "error" });
    expect(getText).toHaveBeenCalledWith(selection);
    expect(canonicalizePath).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result)).not.toContain("x".repeat(100));
  });

  it("uses unambiguous delimiters when selected text contains backtick fences", () => {
    const text = "```ts\nconst value = 1;\n```";
    const context = createEditorContextBlock("src/main.ts", {
      text,
      startLine: 1,
      endLine: 3,
    });

    expect(context).toContain("````text");
    expect(context).toContain(text);
  });
});
