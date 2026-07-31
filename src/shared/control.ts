import { z } from "zod";
import {
  artifactSchema,
  graphDefinitionSchema,
  harnessIdSchema,
  runRecordSchema,
  runStatusSchema,
  type AppSnapshot,
  type GraphDefinition,
  type HarnessId,
  type ModelOption,
  type OpenCodeStatus,
  type RunArtifacts,
  type RunRecord,
  type StartRunInput,
  type UpdateGraphInput,
} from "./domain";
import { harnessProbeStatusSchema } from "./harness";
import {
  workspaceLayoutRecordSchema,
  type WorkspaceLayoutRecord,
} from "./workspace";
import {
  traceCursorSchema,
  traceFilterSchema,
  tracePageSchema,
  type TraceCursor,
  type TraceFilter,
  type TracePage,
} from "./trace";

/**
 * Control plane contract.
 *
 * `SpireControl.execute()` (a later task) dispatches the operations declared
 * in `ControlOperationMap`; the Electron IPC adapter and the MCP stdio
 * sidecar both share these exact types. Every operation has capability
 * metadata in `CONTROL_CAPABILITIES` plus Zod schemas so inputs and outputs
 * can be validated at runtime on either side of the boundary.
 */

export const CONTROL_PAGE_MAX_LIMIT = 200;

// Zod schemas for domain types that `domain.ts` declares as plain types.
export const openCodeStatusSchema = z.strictObject({
  installed: z.boolean(),
  binaryPath: z.string().optional(),
  version: z.string().optional(),
  compatible: z.boolean(),
  connected: z.boolean(),
  error: z.string().optional(),
}) satisfies z.ZodType<OpenCodeStatus>;

export const modelOptionSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
}) satisfies z.ZodType<ModelOption>;

export const appSnapshotSchema = z.strictObject({
  onboardingComplete: z.boolean(),
  openCode: openCodeStatusSchema,
  models: z.array(modelOptionSchema),
  graphs: z.array(graphDefinitionSchema),
  runs: z.array(runRecordSchema),
  activeRunId: z.string().optional(),
}) satisfies z.ZodType<AppSnapshot>;

export const startRunInputSchema = z.strictObject({
  graph: graphDefinitionSchema,
  repositoryPath: z.string().min(1),
  goal: z.string().min(1),
}) satisfies z.ZodType<StartRunInput>;

export const updateGraphInputSchema = z.strictObject({
  graph: graphDefinitionSchema,
}) satisfies z.ZodType<UpdateGraphInput>;

/** Shared pagination envelope for list operations. */
export const pageInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(CONTROL_PAGE_MAX_LIMIT).optional(),
  cursor: z.string().min(1).optional(),
});
export type PageInput = z.infer<typeof pageInputSchema>;

export const graphRefSchema = z.strictObject({
  graphId: z.string().min(1),
  version: z.number().int().positive().optional(),
});
export type GraphRef = z.infer<typeof graphRefSchema>;

export const graphPageSchema = z.strictObject({
  graphs: z.array(graphDefinitionSchema),
  nextCursor: z.string().min(1).nullable(),
});
export type GraphPage = z.infer<typeof graphPageSchema>;

export const diagnosticsSchema = z.strictObject({
  appVersion: z.string().min(1),
  platform: z.string().min(1),
  isWayland: z.boolean(),
  openCode: openCodeStatusSchema,
  graphCount: z.number().int().nonnegative(),
  runCount: z.number().int().nonnegative(),
});
export type Diagnostics = z.infer<typeof diagnosticsSchema>;

export const repositoryPathInputSchema = z.strictObject({
  path: z.string().min(1),
});

export const repositoryValidationSchema = z.strictObject({
  path: z.string().min(1),
  ok: z.boolean(),
  reason: z.string().optional(),
});
export type RepositoryValidation = z.infer<typeof repositoryValidationSchema>;

export const runQuerySchema = z.strictObject({
  graphId: z.string().min(1).optional(),
  repositoryPath: z.string().min(1).optional(),
  status: runStatusSchema.optional(),
  limit: z.number().int().min(1).max(CONTROL_PAGE_MAX_LIMIT).optional(),
  cursor: z.string().min(1).optional(),
});
export type RunQuery = z.infer<typeof runQuerySchema>;

export const runPageSchema = z.strictObject({
  runs: z.array(runRecordSchema),
  nextCursor: z.string().min(1).nullable(),
});
export type RunPage = z.infer<typeof runPageSchema>;

export const runIdInputSchema = z.strictObject({
  runId: z.string().min(1),
});

export const graphIdInputSchema = z.strictObject({
  graphId: z.string().min(1),
});

export const harnessIdInputSchema = z.strictObject({
  harnessId: harnessIdSchema,
});

/**
 * Status of one harness in the multi-harness registry. The canonical status
 * shape is `HarnessProbeStatus` from shared/harness.ts — do not re-declare it.
 */
export const harnessStatusSchema = z.strictObject({
  id: harnessIdSchema,
  name: z.string().min(1),
  status: harnessProbeStatusSchema,
});
export type HarnessStatus = z.infer<typeof harnessStatusSchema>;

export const savedResultSchema = z.strictObject({ saved: z.literal(true) });
export const resetResultSchema = z.strictObject({ reset: z.literal(true) });

/** Input for operations that take no arguments. */
export const emptyInputSchema = z.record(z.string(), z.never());

/** Caller-supplied context attached to every control execution and trace. */
export const controlContextSchema = z.strictObject({
  correlationId: z.string().min(1),
  origin: z.enum(["ipc", "mcp"]),
  requestedAt: z.string().datetime(),
});
export type ControlContext = z.infer<typeof controlContextSchema>;

export type ControlOperationMap = {
  "state.get": { input: Record<string, never>; output: AppSnapshot };
  "diagnostics.get": { input: Record<string, never>; output: Diagnostics };
  "graphs.list": { input: PageInput; output: GraphPage };
  "graphs.get": { input: GraphRef; output: GraphDefinition };
  "graphs.save": { input: UpdateGraphInput; output: GraphDefinition };
  "repositories.validate": {
    input: { path: string };
    output: RepositoryValidation;
  };
  "runs.list": { input: RunQuery; output: RunPage };
  "runs.get": { input: { runId: string }; output: RunRecord };
  "runs.start": { input: StartRunInput; output: RunRecord };
  "runs.stop": { input: { runId: string }; output: RunRecord };
  "runs.retry": { input: { runId: string }; output: RunRecord };
  "runs.artifacts.get": { input: { runId: string }; output: RunArtifacts };
  "worktrees.cleanup": { input: { runId: string }; output: RunRecord };
  "layouts.list": { input: { graphId: string }; output: WorkspaceLayoutRecord[] };
  "layouts.save": { input: WorkspaceLayoutRecord; output: { saved: true } };
  "layouts.reset": { input: { graphId: string }; output: { reset: true } };
  "harnesses.list": { input: Record<string, never>; output: HarnessStatus[] };
  "harnesses.models": { input: { harnessId: HarnessId }; output: ModelOption[] };
  "traces.query": { input: TraceFilter; output: TracePage };
  "traces.tail": { input: TraceCursor; output: TracePage };
};

export type ControlOperationName = keyof ControlOperationMap;

export type ControlCapability<Input = unknown, Output = unknown> = {
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  inputSchema: z.ZodType<Input>;
  outputSchema: z.ZodType<Output>;
};

type ControlCapabilities = {
  [Name in ControlOperationName]: ControlCapability<
    ControlOperationMap[Name]["input"],
    ControlOperationMap[Name]["output"]
  >;
};

const READ = { readOnly: true, destructive: false, idempotent: true } as const;

export const CONTROL_CAPABILITIES: ControlCapabilities = {
  "state.get": {
    ...READ,
    inputSchema: emptyInputSchema,
    outputSchema: appSnapshotSchema,
  },
  "diagnostics.get": {
    ...READ,
    inputSchema: emptyInputSchema,
    outputSchema: diagnosticsSchema,
  },
  "graphs.list": {
    ...READ,
    inputSchema: pageInputSchema,
    outputSchema: graphPageSchema,
  },
  "graphs.get": {
    ...READ,
    inputSchema: graphRefSchema,
    outputSchema: graphDefinitionSchema,
  },
  "graphs.save": {
    readOnly: false,
    destructive: false,
    idempotent: true,
    inputSchema: updateGraphInputSchema,
    outputSchema: graphDefinitionSchema,
  },
  "repositories.validate": {
    ...READ,
    inputSchema: repositoryPathInputSchema,
    outputSchema: repositoryValidationSchema,
  },
  "runs.list": {
    ...READ,
    inputSchema: runQuerySchema,
    outputSchema: runPageSchema,
  },
  "runs.get": {
    ...READ,
    inputSchema: runIdInputSchema,
    outputSchema: runRecordSchema,
  },
  "runs.start": {
    readOnly: false,
    destructive: false,
    idempotent: false,
    inputSchema: startRunInputSchema,
    outputSchema: runRecordSchema,
  },
  "runs.stop": {
    readOnly: false,
    destructive: false,
    idempotent: true,
    inputSchema: runIdInputSchema,
    outputSchema: runRecordSchema,
  },
  "runs.retry": {
    readOnly: false,
    destructive: false,
    idempotent: false,
    inputSchema: runIdInputSchema,
    outputSchema: runRecordSchema,
  },
  "runs.artifacts.get": {
    ...READ,
    inputSchema: runIdInputSchema,
    outputSchema: artifactSchema,
  },
  "worktrees.cleanup": {
    readOnly: false,
    destructive: true,
    idempotent: true,
    inputSchema: runIdInputSchema,
    outputSchema: runRecordSchema,
  },
  "layouts.list": {
    ...READ,
    inputSchema: graphIdInputSchema,
    outputSchema: z.array(workspaceLayoutRecordSchema),
  },
  "layouts.save": {
    readOnly: false,
    destructive: false,
    idempotent: true,
    inputSchema: workspaceLayoutRecordSchema,
    outputSchema: savedResultSchema,
  },
  "layouts.reset": {
    readOnly: false,
    destructive: true,
    idempotent: true,
    inputSchema: graphIdInputSchema,
    outputSchema: resetResultSchema,
  },
  "harnesses.list": {
    ...READ,
    inputSchema: emptyInputSchema,
    outputSchema: z.array(harnessStatusSchema),
  },
  "harnesses.models": {
    ...READ,
    inputSchema: harnessIdInputSchema,
    outputSchema: z.array(modelOptionSchema),
  },
  "traces.query": {
    ...READ,
    inputSchema: traceFilterSchema,
    outputSchema: tracePageSchema,
  },
  "traces.tail": {
    ...READ,
    inputSchema: traceCursorSchema,
    outputSchema: tracePageSchema,
  },
};

export const CONTROL_OPERATION_NAMES = Object.keys(
  CONTROL_CAPABILITIES,
) as [ControlOperationName, ...ControlOperationName[]];

export const controlOperationNameSchema = z.enum(CONTROL_OPERATION_NAMES);
