import { z } from "zod";
import {
  harnessIdSchema,
  type AgentNode,
  type HarnessId,
  type ModelOption,
} from "./domain";

export type HarnessSessionRef = {
  harnessId: HarnessId;
  sessionId: string;
  directory: string;
};

export const harnessSessionRefSchema = z.strictObject({
  harnessId: harnessIdSchema,
  sessionId: z.string().min(1),
  directory: z.string().min(1),
}) satisfies z.ZodType<HarnessSessionRef>;

/**
 * Normalized events every harness adapter translates its native stream into.
 * Covers the full lifecycle: session creation, model output (text/reasoning),
 * tool activity, approvals, usage, process output, and terminal conditions
 * (warning/error/timeout/cancellation). `status` carries harness lifecycle
 * notes that are none of the above (e.g. OpenCode's "session idle").
 */
export const harnessEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("session"), session: harnessSessionRefSchema }),
  z.strictObject({ type: z.literal("assistant_text"), text: z.string() }),
  z.strictObject({ type: z.literal("reasoning"), text: z.string() }),
  z.strictObject({
    type: z.literal("tool_start"),
    tool: z.string(),
    input: z.unknown().optional(),
  }),
  z.strictObject({
    type: z.literal("tool_progress"),
    tool: z.string(),
    message: z.string(),
  }),
  z.strictObject({
    type: z.literal("tool_result"),
    tool: z.string(),
    output: z.unknown().optional(),
    error: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("approval"),
    id: z.string(),
    permission: z.string(),
    title: z.string(),
    pattern: z.union([z.string(), z.array(z.string())]).optional(),
  }),
  z.strictObject({
    type: z.literal("usage"),
    tokens: z.strictObject({
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cacheRead: z.number(),
      cacheWrite: z.number(),
    }),
    cost: z.number().optional(),
  }),
  z.strictObject({ type: z.literal("stdout"), text: z.string() }),
  z.strictObject({ type: z.literal("stderr"), text: z.string() }),
  z.strictObject({ type: z.literal("warning"), message: z.string() }),
  z.strictObject({ type: z.literal("error"), message: z.string() }),
  z.strictObject({ type: z.literal("timeout"), message: z.string() }),
  z.strictObject({ type: z.literal("cancelled"), message: z.string() }),
  z.strictObject({ type: z.literal("status"), message: z.string() }),
]);
export type HarnessEvent = z.infer<typeof harnessEventSchema>;

/** Generalizes OpenCodeStatus across harnesses. */
export type HarnessStatus = {
  harnessId: HarnessId;
  installed: boolean;
  binaryPath?: string;
  version?: string;
  compatible: boolean;
  connected: boolean;
  error?: string;
};

export type HarnessRunInput = {
  runId: string;
  nodeId: string;
  directory: string;
  session?: HarnessSessionRef;
  modelId: string;
  job: string;
  context: string;
  access: AgentNode["access"];
  outputSchema: Record<string, unknown>;
  onSession(ref: HarnessSessionRef): void;
  onEvent(event: HarnessEvent): void;
};

export type HarnessRunResult = {
  session: HarnessSessionRef;
  output: unknown;
};

export interface HarnessAdapter {
  readonly id: HarnessId;
  probe(): Promise<HarnessStatus>;
  listModels(): Promise<ModelOption[]>;
  run(input: HarnessRunInput): Promise<HarnessRunResult>;
  abort(session: HarnessSessionRef): Promise<void>;
  close(): Promise<void>;
}

export interface HarnessRegistry {
  get(id: HarnessId): HarnessAdapter;
  probeAll(): Promise<HarnessStatus[]>;
  closeAll(): Promise<void>;
}
