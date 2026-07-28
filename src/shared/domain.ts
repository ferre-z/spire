import { z } from "zod";

export const nodeRoleSchema = z.enum(["planner", "implementer"]);
export type NodeRole = z.infer<typeof nodeRoleSchema>;

export const agentNodeSchema = z.object({
  id: z.string().min(1),
  type: z.literal("opencode"),
  role: nodeRoleSchema,
  name: z.string().min(1).max(80),
  instructions: z.string().min(1).max(12_000),
  model: z.string().min(1),
  position: z.object({ x: z.number(), y: z.number() }),
});
export type AgentNode = z.infer<typeof agentNodeSchema>;

export const graphEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  condition: z.enum(["always", "accepted", "needs_changes"]),
  label: z.string().min(1),
});
export type GraphEdge = z.infer<typeof graphEdgeSchema>;

export const graphDefinitionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(120),
    version: z.number().int().positive(),
    nodes: z.array(agentNodeSchema).length(2),
    edges: z.array(graphEdgeSchema).min(2),
    maxIterations: z.number().int().min(1).max(5),
    createdAt: z.string().datetime(),
  })
  .superRefine((graph, context) => {
    const roles = new Set(graph.nodes.map((node) => node.role));
    if (!roles.has("planner") || !roles.has("implementer")) {
      context.addIssue({
        code: "custom",
        message: "A graph requires one planner and one implementer.",
      });
    }
    const ids = new Set(graph.nodes.map((node) => node.id));
    for (const edge of graph.edges) {
      if (!ids.has(edge.source) || !ids.has(edge.target)) {
        context.addIssue({
          code: "custom",
          message: `Edge ${edge.id} references an unknown node.`,
        });
      }
    }
  });
export type GraphDefinition = z.infer<typeof graphDefinitionSchema>;

export const taskBriefSchema = z.object({
  goal: z.string().min(1),
  constraints: z.array(z.string()),
  acceptanceChecks: z.array(z.string()).min(1),
  implementationNotes: z.array(z.string()),
});
export type TaskBrief = z.infer<typeof taskBriefSchema>;

export const implementationReportSchema = z.object({
  summary: z.string().min(1),
  changedFiles: z.array(z.string()),
  validations: z.array(
    z.object({
      command: z.string(),
      status: z.enum(["passed", "failed", "unknown"]),
    }),
  ),
  blockers: z.array(z.string()),
});
export type ImplementationReport = z.infer<typeof implementationReportSchema>;

export const reviewVerdictSchema = z.object({
  decision: z.enum(["accepted", "needs_changes"]),
  evidence: z.array(z.string()),
  feedback: z.array(z.string()),
});
export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

export const runStatusSchema = z.enum([
  "preparing",
  "planning",
  "implementing",
  "reviewing",
  "succeeded",
  "needs_attention",
  "failed",
  "stopped",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const runEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string().datetime(),
  nodeId: z.string().optional(),
  kind: z.string(),
  phase: z.string(),
  message: z.string(),
  payload: z.unknown().optional(),
});
export type RunEvent = z.infer<typeof runEventSchema>;

export const artifactSchema = z.object({
  diff: z.string(),
  changedFiles: z.array(z.string()),
  worktreePath: z.string(),
  branch: z.string(),
  brief: taskBriefSchema.optional(),
  implementation: implementationReportSchema.optional(),
  verdict: reviewVerdictSchema.optional(),
});
export type RunArtifacts = z.infer<typeof artifactSchema>;

export const runRecordSchema = z.object({
  id: z.string(),
  graphId: z.string(),
  graphVersion: z.number().int(),
  repositoryPath: z.string(),
  goal: z.string(),
  status: runStatusSchema,
  iteration: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  activeNodeId: z.string().optional(),
  error: z.string().optional(),
  events: z.array(runEventSchema),
  artifacts: artifactSchema.optional(),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

export type OpenCodeStatus = {
  installed: boolean;
  binaryPath?: string;
  version?: string;
  compatible: boolean;
  connected: boolean;
  error?: string;
};

export type ModelOption = {
  id: string;
  name: string;
};

export type AppSnapshot = {
  onboardingComplete: boolean;
  openCode: OpenCodeStatus;
  models: ModelOption[];
  graphs: GraphDefinition[];
  runs: RunRecord[];
  activeRunId?: string;
};

export type StartRunInput = {
  graph: GraphDefinition;
  repositoryPath: string;
  goal: string;
};

export type UpdateGraphInput = {
  graph: GraphDefinition;
};

export type ProviderInput = {
  apiKey: string;
};
