import { z } from "zod";
import {
  connectionStateSchema,
  type ConnectionState,
} from "./connection-state";

const webviewActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("open-expanded") }).strict(),
  z.object({ type: z.literal("webview-ready") }).strict(),
  z.object({ type: z.literal("connect") }).strict(),
  z.object({ type: z.literal("disconnect") }).strict(),
]);

const extensionMessageSchema = z
  .object({
    type: z.literal("connection-state"),
    state: connectionStateSchema,
  })
  .strict();

export interface WebviewActions {
  openExpanded: () => void;
  webviewReady: () => void;
  connect: () => void;
  disconnect: () => void;
}

export function dispatchWebviewMessage(
  message: unknown,
  actions: WebviewActions,
): boolean {
  const result = webviewActionSchema.safeParse(message);
  if (!result.success) return false;

  switch (result.data.type) {
    case "open-expanded":
      actions.openExpanded();
      break;
    case "webview-ready":
      actions.webviewReady();
      break;
    case "connect":
      actions.connect();
      break;
    case "disconnect":
      actions.disconnect();
      break;
  }

  return true;
}

export function dispatchExtensionMessage(
  message: unknown,
  updateConnectionState: (state: ConnectionState) => void,
): boolean {
  const result = extensionMessageSchema.safeParse(message);
  if (!result.success) return false;

  updateConnectionState(result.data.state);
  return true;
}
