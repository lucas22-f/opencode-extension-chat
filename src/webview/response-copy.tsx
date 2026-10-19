import type { ChatAssistantPart, ChatMessage } from "../shared/chat-state";

export function getAssistantVisibleText(
  message: Pick<ChatMessage, "role" | "text" | "parts">,
): string {
  if (message.role !== "assistant") return "";
  if (message.parts === undefined) return message.text;
  return message.parts
    .filter((part): part is Extract<ChatAssistantPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function ResponseCopyButton({
  message,
  onCopyText,
  suppressed = false,
}: {
  message: Pick<ChatMessage, "role" | "text" | "parts">;
  onCopyText: (text: string) => void;
  suppressed?: boolean;
}) {
  const text = getAssistantVisibleText(message);
  if (!text || suppressed) return null;

  return (
    <button
      aria-label="Copy response"
      className="text-button copy-response-button"
      disabled={text.length > 1_000_000}
      onClick={() => onCopyText(text)}
      type="button"
    >
      Copy response
    </button>
  );
}
