import { z } from "zod";

export const DEFAULT_SERVER_URL = "http://127.0.0.1:4096";
export const SUPPORTED_OPENCODE_VERSION = "1.19.0";

export const connectionStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("disconnected") }).strict(),
  z
    .object({
      status: z.literal("connecting"),
      serverUrl: z.string(),
      phase: z.enum(["checking", "starting-managed", "verifying-managed"]),
    })
    .strict(),
  z
    .object({
      status: z.literal("connected"),
      serverUrl: z.string(),
      version: z.string(),
      owner: z.enum(["attached", "managed"]),
    })
    .strict(),
  z
    .object({
      status: z.literal("version-mismatch"),
      serverUrl: z.string(),
      actualVersion: z.string(),
      expectedVersion: z.string(),
      owner: z.enum(["attached", "managed"]),
    })
    .strict(),
  z
    .object({
      status: z.literal("disconnecting"),
      serverUrl: z.string(),
      owner: z.literal("managed"),
    })
    .strict(),
  z
    .object({
      status: z.literal("error"),
      serverUrl: z.string().optional(),
      reason: z.enum([
        "configuration",
        "authentication-required",
        "unreachable",
        "timeout",
        "invalid-response",
        "unexpected-response",
        "workspace-required",
        "workspace-untrusted",
        "server-start",
        "server-stop",
      ]),
      message: z.string(),
      owner: z.literal("managed").optional(),
    })
    .strict(),
]);

export type ConnectionState = z.infer<typeof connectionStateSchema>;

export const initialConnectionState: ConnectionState = {
  status: "disconnected",
};
