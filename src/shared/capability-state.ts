import { z } from "zod";
import { sessionIdSchema } from "./chat-state";

export const CAPABILITY_TOOL_LIMIT = 500;
export const CAPABILITY_SKILL_LIMIT = 256;
export const CAPABILITY_CHILD_SESSION_LIMIT = 2_000;
export const CAPABILITY_PARAMETER_SCHEMA_LENGTH = 32_768;

export const capabilitySectionStatusSchema = z.enum([
  "idle",
  "loading",
  "ready",
  "unavailable",
  "error",
]);

export const capabilityMcpServerSchema = z
  .object({
    name: z.string().min(1).max(256),
    status: z.enum([
      "connected",
      "disabled",
      "failed",
      "needs_auth",
      "needs_client_registration",
    ]),
  })
  .strict();

export const capabilityToolSchema = z
  .object({
    id: z.string().min(1).max(256),
    description: z.string().max(4_000),
    parameters: z.string().max(CAPABILITY_PARAMETER_SCHEMA_LENGTH),
  })
  .strict();

export const capabilitySkillSchema = z
  .object({
    name: z.string().min(1).max(256),
    description: z.string().max(4_000).optional(),
  })
  .strict();

export const capabilityChildSessionSchema = z
  .object({
    id: sessionIdSchema,
    title: z.string().max(500),
    updatedAt: z.number().finite().min(0).max(8_640_000_000_000_000),
    agent: z.string().min(1).max(256).optional(),
    subagent: z.boolean().optional(),
  })
  .strict();

const capabilityMcpSectionSchema = z
  .object({
    status: capabilitySectionStatusSchema,
    servers: z.array(capabilityMcpServerSchema).max(500),
    error: z.string().max(500).nullable(),
  })
  .strict();

const capabilityToolSectionSchema = z
  .object({
    status: capabilitySectionStatusSchema,
    providerID: z.string().min(1).max(256).nullable(),
    modelID: z.string().min(1).max(256).nullable(),
    tools: z.array(capabilityToolSchema).max(CAPABILITY_TOOL_LIMIT),
    error: z.string().max(500).nullable(),
  })
  .strict();

const capabilitySkillSectionSchema = z
  .object({
    status: capabilitySectionStatusSchema,
    skills: z.array(capabilitySkillSchema).max(CAPABILITY_SKILL_LIMIT),
    error: z.string().max(500).nullable(),
  })
  .strict();

const capabilityChildSessionSectionSchema = z
  .object({
    status: capabilitySectionStatusSchema,
    parentSessionID: sessionIdSchema.nullable(),
    sessions: z
      .array(capabilityChildSessionSchema)
      .max(CAPABILITY_CHILD_SESSION_LIMIT),
    scannedSessionCount: z
      .number()
      .int()
      .min(0)
      .max(CAPABILITY_CHILD_SESSION_LIMIT),
    truncated: z.boolean(),
    agentModesAvailable: z.boolean().nullable(),
    error: z.string().max(500).nullable(),
  })
  .strict();

export const capabilityStateSchema = z
  .object({
    mcp: capabilityMcpSectionSchema,
    tools: capabilityToolSectionSchema,
    skills: capabilitySkillSectionSchema,
    children: capabilityChildSessionSectionSchema,
  })
  .strict();

export type CapabilityMcpServer = z.infer<typeof capabilityMcpServerSchema>;
export type CapabilityTool = z.infer<typeof capabilityToolSchema>;
export type CapabilitySkill = z.infer<typeof capabilitySkillSchema>;
export type CapabilityChildSession = z.infer<
  typeof capabilityChildSessionSchema
>;
export type CapabilityState = z.infer<typeof capabilityStateSchema>;

export const initialCapabilityState: CapabilityState = {
  mcp: { status: "idle", servers: [], error: null },
  tools: {
    status: "idle",
    providerID: null,
    modelID: null,
    tools: [],
    error: null,
  },
  skills: { status: "idle", skills: [], error: null },
  children: {
    status: "idle",
    parentSessionID: null,
    sessions: [],
    scannedSessionCount: 0,
    truncated: false,
    agentModesAvailable: null,
    error: null,
  },
};
