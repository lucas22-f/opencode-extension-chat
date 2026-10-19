import type { CapabilitySkill } from "../shared/capability-state";
import { appendEditorContextToPromptDraft } from "../shared/editor-context";

export const MAX_SKILL_REFERENCE_DESCRIPTION_CHARACTERS = 1_200;

/**
 * Builds a bounded, fully quoted skill-reference note from server-returned
 * skill metadata only. Skill contents, files, and instructions are never
 * loaded or injected; the note explicitly labels itself as preparation,
 * not execution. OpenCode's own agent flow decides any actual skill use.
 */
export function createSkillReferenceBlock(skill: CapabilitySkill): string {
  const lines = [
    "[OpenCode Visual skill reference]",
    `Skill (registered name): ${formatInlineCode(serializeMetadata(skill.name))}`,
  ];
  if (skill.description) {
    lines.push(
      `Registered description: ${formatInlineCode(
        serializeMetadata(truncateDescription(skill.description)),
      )}`,
    );
  }
  lines.push(
    "Source: server-returned skill metadata only; skill contents and files are not loaded.",
    "Preparation only: this editable note was added to your draft. OpenCode does not execute the skill from this selection.",
    "[End OpenCode Visual skill reference]",
  );
  return lines.join("\n");
}

/**
 * Reuses the existing validated draft-append contract unchanged: preserves
 * the current draft, separates with the established separator rules, and
 * rejects preparation that would overflow the prompt limit.
 */
export function prepareSkillReferenceDraft(
  draft: string,
  skill: CapabilitySkill,
): { kind: "inserted"; draft: string } | { kind: "too-large" } {
  return appendEditorContextToPromptDraft(draft, createSkillReferenceBlock(skill));
}

function truncateDescription(description: string): string {
  if (description.length <= MAX_SKILL_REFERENCE_DESCRIPTION_CHARACTERS) {
    return description;
  }
  return `${description.slice(0, MAX_SKILL_REFERENCE_DESCRIPTION_CHARACTERS - 1)}…`;
}

/**
 * Serializes server-returned metadata as a JSON string literal so newlines,
 * carriage returns, control characters, quotes, and the block's own end
 * marker can never leave the quoted field line or forge block structure.
 * The dynamic backtick delimiter is then computed over the serialized form.
 */
function serializeMetadata(value: string): string {
  return JSON.stringify(value);
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
