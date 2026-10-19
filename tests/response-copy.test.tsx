import type { ButtonHTMLAttributes, ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getAssistantVisibleText, ResponseCopyButton } from "../src/webview/response-copy";

const textPart = (id: string, text: string) => ({ id, type: "text" as const, text });

function buttonProps(element: ReactElement): ButtonHTMLAttributes<HTMLButtonElement> {
  return element.props as ButtonHTMLAttributes<HTMLButtonElement>;
}

describe("assistant response copy", () => {
  it("extracts ordered visible text parts without tool data or whitespace changes", () => {
    const message = {
      role: "assistant" as const,
      text: "stale fallback",
      parts: [
        textPart("text-1", "  **First**\n"),
        {
          id: "tool-1",
          type: "tool" as const,
          input: "private input",
          output: "private output",
        },
        textPart("text-2", "second  "),
      ],
    };

    expect(getAssistantVisibleText(message)).toBe("  **First**\nsecond  ");
  });

  it("uses message text only when parts are absent and honors empty parts as authoritative", () => {
    expect(getAssistantVisibleText({ role: "assistant", text: "fallback" })).toBe("fallback");
    expect(getAssistantVisibleText({ role: "assistant", text: "fallback", parts: [] })).toBe("");
    expect(getAssistantVisibleText({ role: "user", text: "user text" })).toBe("");
    expect(getAssistantVisibleText({ role: "system", text: "private context" })).toBe("");
  });

  it("calls only the supplied copy callback with the visible response and has an accessible label", () => {
    const onCopyText = vi.fn();
    const element = ResponseCopyButton({
      message: { role: "assistant", text: "  **Answer**  " },
      onCopyText,
    });
    expect(element).not.toBeNull();
    if (!element) return;

    const props = buttonProps(element as ReactElement);
    expect(renderToStaticMarkup(element)).toContain('aria-label="Copy response"');
    expect(renderToStaticMarkup(element)).toContain(">Copy response</button>");
    expect(props.disabled).toBe(false);
    props.onClick?.({} as never);
    expect(onCopyText).toHaveBeenCalledExactlyOnceWith("  **Answer**  ");
    expect(renderToStaticMarkup(element)).not.toContain("Copied");
  });

  it("renders no action for empty text and disables payloads beyond the existing one-million-character limit", () => {
    expect(
      ResponseCopyButton({ message: { role: "assistant", text: "" }, onCopyText: vi.fn() }),
    ).toBeNull();

    const oversized = ResponseCopyButton({
      message: { role: "assistant", text: "x".repeat(1_000_001) },
      onCopyText: vi.fn(),
    });
    expect(oversized).not.toBeNull();
    if (oversized) expect(buttonProps(oversized as ReactElement).disabled).toBe(true);
  });
});
