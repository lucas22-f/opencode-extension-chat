import type { PromptResult } from "./chat-state";

export interface PromptKeyInput {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
}

export interface ChoiceCommand {
  command: "provider" | "model";
  query: string;
}

export interface ChoiceAriaState {
  expanded: boolean;
  controls: string | undefined;
  activeDescendant: string | undefined;
}

export function getChoiceAriaState(
  command: ChoiceCommand["command"] | null,
  choicesReady: boolean,
  optionCount: number,
  activeIndex: number,
  actionable: boolean,
): ChoiceAriaState {
  const expanded = command !== null && choicesReady && optionCount > 0;
  const hasActiveOption = expanded && actionable && activeIndex >= 0 && activeIndex < optionCount;
  return {
    expanded,
    controls: expanded ? `${command}-choice-listbox` : undefined,
    activeDescendant: hasActiveOption
      ? `${command}-choice-option-${activeIndex}`
      : undefined,
  };
}

export function parseChoiceCommand(text: string): ChoiceCommand | null {
  if (text.includes("\n") || text.includes("\r")) return null;
  const match = /^\/(provider|model)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  return { command: match[1]!.toLowerCase() as ChoiceCommand["command"], query: match[2] ?? "" };
}

export function filterChoiceOptions<T extends { id: string; label: string }>(
  options: T[],
  query: string,
): T[] {
  const normalized = query.trim().toLocaleLowerCase();
  return normalized
    ? options.filter((option) =>
        `${option.id} ${option.label}`.toLocaleLowerCase().includes(normalized),
      )
    : options;
}

export function moveChoiceSelection(
  current: number,
  direction: -1 | 1,
  length: number,
): number {
  if (length === 0) return -1;
  if (!Number.isInteger(current) || current < 0 || current >= length) {
    return direction === 1 ? 0 : length - 1;
  }
  return (current + direction + length) % length;
}

export function normalizeChoiceSelection(current: number, length: number): number {
  if (length <= 0) return -1;
  if (!Number.isInteger(current) || current < 0) return 0;
  return Math.min(current, length - 1);
}

export function isChoiceActionAvailable(
  choicesStatus: string,
  switchingChoice: string | null,
  disabled = false,
): boolean {
  return choicesStatus === "ready" && switchingChoice === null && !disabled;
}

export function resolveChoiceOption<T>(
  options: T[],
  index: number,
  actionable: boolean,
): T | null {
  return actionable && Number.isInteger(index) && index >= 0
    ? options[index] ?? null
    : null;
}

export interface PromptRetryAttempt {
  requestID: string;
  sessionID: string;
  text: string;
}

export interface PendingPromptAttempt extends PromptRetryAttempt {
  attemptID: string;
}

export function shouldSubmitPrompt(input: PromptKeyInput): boolean {
  return input.key === "Enter" && !input.shiftKey && input.isComposing !== true;
}

export function resolvePromptDraft(
  currentDraft: string,
  submittedText: string,
  outcome: "submitting" | "accepted" | "rejected" | "outcome-unknown",
): string {
  return outcome === "accepted" && currentDraft === submittedText ? "" : currentDraft;
}

export function resolvePromptRetry(
  attempt: PromptRetryAttempt | null,
  currentDraft: string,
  selectedSessionID: string | null,
): PromptRetryAttempt | null {
  if (
    !attempt ||
    !selectedSessionID ||
    attempt.sessionID !== selectedSessionID ||
    attempt.text !== currentDraft
  ) {
    return null;
  }
  return attempt;
}

export function isFreshPromptAttemptResult(
  result: PromptResult,
  pending: PendingPromptAttempt,
): boolean {
  return (
    result.requestID === pending.requestID &&
    result.attemptID === pending.attemptID &&
    (result.sessionID === pending.sessionID ||
      (result.sessionID === null && result.status === "rejected")) &&
    result.status !== "submitting"
  );
}
