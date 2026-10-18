import { describe, expect, it } from "vitest";
import { MAX_PROMPT_LENGTH } from "../src/shared/chat-state";
import { appendEditorContextToPromptDraft } from "../src/shared/editor-context";
import {
  isFreshPromptAttemptResult,
  isChoiceActionAvailable,
  getChoiceAriaState,
  parseChoiceCommand,
  filterChoiceOptions,
  moveChoiceSelection,
  resolveChoiceOption,
  resolvePromptDraft,
  resolvePromptRetry,
  shouldSubmitPrompt,
} from "../src/shared/prompt-composer";

describe("prompt composer keyboard behavior", () => {
  it("recognizes only complete single-line provider and model commands", () => {
    expect(parseChoiceCommand("/provider anth")).toEqual({
      command: "provider",
      query: "anth",
    });
    expect(parseChoiceCommand("/model\nplease explain")).toBeNull();
    expect(parseChoiceCommand("A normal multiline thought\nwith /provider in it")).toBeNull();
    expect(parseChoiceCommand("ordinary /model prose")).toBeNull();
    expect(parseChoiceCommand("/settings")).toBeNull();
  });

  it("filters returned choice labels and clamps keyboard selection", () => {
    const options = [
      { id: "anthropic", label: "Anthropic" },
      { id: "openai", label: "OpenAI" },
    ];
    expect(filterChoiceOptions(options, "anth")).toEqual([options[0]]);
    expect(moveChoiceSelection(0, 1, 2)).toBe(1);
    expect(moveChoiceSelection(1, 1, 2)).toBe(0);
    expect(moveChoiceSelection(0, -1, 2)).toBe(1);
    expect(moveChoiceSelection(0, 1, 0)).toBe(-1);
    expect(moveChoiceSelection(8, 1, 2)).toBe(0);
    expect(moveChoiceSelection(8, -1, 2)).toBe(1);
    expect(moveChoiceSelection(-9, 1, 2)).toBe(0);
    expect(moveChoiceSelection(-9, -1, 2)).toBe(1);
    expect(isChoiceActionAvailable("ready", null)).toBe(true);
    expect(isChoiceActionAvailable("loading", null)).toBe(false);
    expect(isChoiceActionAvailable("error", null)).toBe(false);
    expect(isChoiceActionAvailable("unavailable", null)).toBe(false);
    expect(isChoiceActionAvailable("ready", "model")).toBe(false);
    expect(resolveChoiceOption(options, 8, true)).toBeNull();
    expect(resolveChoiceOption(options, -1, true)).toBeNull();
    expect(resolveChoiceOption(options, 0, false)).toBeNull();
    expect(resolveChoiceOption(options, 1, true)).toEqual(options[1]);
    expect(getChoiceAriaState("model", true, 2, 1, true)).toEqual({
      expanded: true,
      controls: "model-choice-listbox",
      activeDescendant: "model-choice-option-1",
    });
    expect(getChoiceAriaState("model", false, 2, 1, true)).toEqual({
      expanded: false,
      controls: undefined,
      activeDescendant: undefined,
    });
    expect(getChoiceAriaState("model", true, 0, -1, true).activeDescendant).toBeUndefined();
    expect(getChoiceAriaState("model", true, 2, 9, false).activeDescendant).toBeUndefined();
    expect(getChoiceAriaState("provider", true, 1, 0, true).controls).toBe("provider-choice-listbox");
  });

  it("submits on Enter", () => {
    expect(shouldSubmitPrompt({ key: "Enter", shiftKey: false })).toBe(true);
  });

  it("preserves a newline on Shift+Enter", () => {
    expect(shouldSubmitPrompt({ key: "Enter", shiftKey: true })).toBe(false);
  });

  it("does not submit while an IME composition is active", () => {
    expect(
      shouldSubmitPrompt({ key: "Enter", shiftKey: false, isComposing: true }),
    ).toBe(false);
  });

  it("clears the submitted draft only after admission and only if it is unchanged", () => {
    expect(resolvePromptDraft("accepted text", "accepted text", "accepted")).toBe("");
    expect(resolvePromptDraft("newer text", "accepted text", "accepted")).toBe(
      "newer text",
    );
  });

  it("keeps the draft while admission is still pending", () => {
    expect(resolvePromptDraft("pending text", "pending text", "submitting")).toBe(
      "pending text",
    );
  });

  it.each(["rejected", "outcome-unknown"] as const)(
    "preserves the draft when prompt outcome is %s",
    (outcome) => {
      expect(resolvePromptDraft("keep this draft", "keep this draft", outcome)).toBe(
        "keep this draft",
      );
    },
  );

  it("reuses a retry ID only for the exact same prompt in the same session", () => {
    const attempt = {
      requestID: "550e8400-e29b-41d4-a716-446655440000",
      sessionID: "ses_selected123",
      text: "Retry this exact prompt.",
    };

    expect(
      resolvePromptRetry(attempt, "Retry this exact prompt.", "ses_selected123"),
    ).toEqual(attempt);
    expect(resolvePromptRetry(attempt, "Edited prompt.", "ses_selected123")).toBe(
      null,
    );
    expect(
      resolvePromptRetry(attempt, "Retry this exact prompt.", "ses_other123"),
    ).toBe(null);
  });

  it("keeps inserted editor context in the exact prompt text used by retries", () => {
    const context = [
      "[OpenCode Visual editor context]",
      "File reference (workspace-relative): `src/feature.ts`",
      "Selected lines (1-based, inclusive): 4–5",
      "```text",
      "selected buffer text",
      "```",
      "[End OpenCode Visual editor context]",
    ].join("\n");
    const insertion = appendEditorContextToPromptDraft("Explain this code.", context);
    expect(insertion).toEqual({
      kind: "inserted",
      draft: `Explain this code.\n\n${context}`,
    });

    if (insertion.kind !== "inserted") throw new Error("Expected context insertion.");
    const attempt = {
      requestID: "550e8400-e29b-41d4-a716-446655440000",
      sessionID: "ses_selected123",
      text: insertion.draft,
    };
    expect(resolvePromptRetry(attempt, insertion.draft, attempt.sessionID)).toEqual(
      attempt,
    );
    expect(
      resolvePromptRetry(
        attempt,
        `${insertion.draft} edited`,
        attempt.sessionID,
      ),
    ).toBeNull();
  });

  it("rejects editor context insertion rather than overflowing the prompt limit", () => {
    expect(
      appendEditorContextToPromptDraft("x".repeat(MAX_PROMPT_LENGTH - 5), "context"),
    ).toEqual({ kind: "too-large" });
  });

  it("ignores the previous unknown result until a retry produces a fresh result", () => {
    const attempt = {
      requestID: "550e8400-e29b-41d4-a716-446655440000",
      sessionID: "ses_selected123",
      text: "Retry this exact prompt.",
      attemptID: "550e8400-e29b-41d4-a716-446655440001",
    };
    const previousResult = {
      requestID: attempt.requestID,
      attemptID: "550e8400-e29b-41d4-a716-446655440002",
      sessionID: attempt.sessionID,
      status: "outcome-unknown" as const,
    };
    expect(isFreshPromptAttemptResult(previousResult, attempt)).toBe(false);
    expect(
      isFreshPromptAttemptResult(
        { ...previousResult, attemptID: attempt.attemptID, status: "submitting" },
        attempt,
      ),
    ).toBe(false);
    expect(
      isFreshPromptAttemptResult(
        { ...previousResult, attemptID: attempt.attemptID, status: "accepted" },
        attempt,
      ),
    ).toBe(true);
  });

  it("completes an invalid-target rejection for the matching attempt", () => {
    const attempt = {
      requestID: "550e8400-e29b-41d4-a716-446655440000",
      sessionID: "../invalid",
      text: "Retry this exact prompt.",
      attemptID: "550e8400-e29b-41d4-a716-446655440001",
    };
    const result = {
      requestID: attempt.requestID,
      attemptID: attempt.attemptID,
      sessionID: null,
      status: "rejected" as const,
    };

    expect(isFreshPromptAttemptResult(result, attempt)).toBe(true);
    expect(
      isFreshPromptAttemptResult(
        { ...result, attemptID: "550e8400-e29b-41d4-a716-446655440002" },
        attempt,
      ),
    ).toBe(false);
  });
});
