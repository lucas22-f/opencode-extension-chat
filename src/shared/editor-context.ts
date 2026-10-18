import { z } from "zod";
import { MAX_PROMPT_LENGTH } from "./chat-state";

export const MAX_EDITOR_SELECTION_CHARACTERS = 8_000;
export const MAX_EDITOR_CONTEXT_BLOCK_CHARACTERS = 10_000;

export const editorContextResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ready"),
      context: z.string().min(1).max(MAX_EDITOR_CONTEXT_BLOCK_CHARACTERS),
    })
    .strict(),
  z
    .object({
      kind: z.literal("error"),
      message: z.string().min(1).max(500),
    })
    .strict(),
]);

export type EditorContextResult = z.infer<typeof editorContextResultSchema>;

export interface EditorContextSelection {
  text: string;
  startLine: number;
  endLine: number;
}

export function createEditorContextBlock(
  relativePath: string,
  selection?: EditorContextSelection,
): string {
  const lines = [
    "[OpenCode Visual editor context]",
    `File reference (workspace-relative): ${formatInlineCode(relativePath)}`,
    selection
      ? "Source: selected text from the active VS Code editor buffer; includes unsaved changes."
      : "Source: file reference only; no file or buffer contents are included.",
  ];

  if (selection) {
    const fence = "`".repeat(Math.max(3, longestBacktickRun(selection.text) + 1));
    lines.push(
      `Selected lines (1-based, inclusive): ${selection.startLine}–${selection.endLine}`,
      "Selected text:",
      `${fence}text`,
      selection.text,
      fence,
    );
  }

  lines.push(
    "Reference hint only: the connected OpenCode server may not be able to access this workspace path.",
    "[End OpenCode Visual editor context]",
  );
  return lines.join("\n");
}

export function appendEditorContextToPromptDraft(
  draft: string,
  context: string,
): { kind: "inserted"; draft: string } | { kind: "too-large" } {
  const separator = draft.length === 0 ? "" : draft.endsWith("\n") ? "\n" : "\n\n";
  const nextDraft = `${draft}${separator}${context}`;
  if (nextDraft.length > MAX_PROMPT_LENGTH) return { kind: "too-large" };
  return { kind: "inserted", draft: nextDraft };
}

function formatInlineCode(value: string): string {
  const delimiter = "`".repeat(Math.max(1, longestBacktickRun(value) + 1));
  const paddedValue = value.startsWith(" ") || value.endsWith(" ")
    ? ` ${value} `
    : value;
  return `${delimiter}${paddedValue}${delimiter}`;
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  let current = 0;
  for (const character of value) {
    current = character === "`" ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}
