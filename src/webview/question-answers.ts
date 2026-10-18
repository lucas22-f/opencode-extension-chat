import type { ChatQuestionRequest } from "../shared/chat-state";

export function composeQuestionAnswers(
  questions: ChatQuestionRequest["questions"],
  selectedAnswers: string[][],
  customAnswers: string[],
  customSelected: boolean[],
): string[][] | undefined {
  if (questions.length === 0) return undefined;

  const answers: string[][] = [];
  for (const [index, question] of questions.entries()) {
    const selected = selectedAnswers[index] ?? [];
    const custom = customAnswers[index] ?? "";
    const hasCustomAnswer = custom.trim().length > 0;

    if (question.multiple) {
      if (selected.length === 0 && !hasCustomAnswer) return undefined;
      answers.push([...selected, ...(hasCustomAnswer ? [custom] : [])]);
      continue;
    }

    if (customSelected[index]) {
      if (!hasCustomAnswer) return undefined;
      answers.push([custom]);
      continue;
    }

    if (selected.length === 0) return undefined;
    answers.push(selected.slice(0, 1));
  }

  return answers;
}
