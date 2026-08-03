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
export type LegacyAgentNode = z.infer<typeof agentNodeSchema>;

export const graphEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  condition: z.enum(["always", "accepted", "needs_changes"]),
  label: z.string().min(1),
});
export type LegacyGraphEdge = z.infer<typeof graphEdgeSchema>;

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

export const harnessIdSchema = z.enum(["opencode", "codex", "claude-code"]);
export type HarnessId = z.infer<typeof harnessIdSchema>;

export const nodeKindSchema = z.enum([
  "agent",
  "decision",
  "checkpoint",
  "subgraph",
]);
export type NodeKind = z.infer<typeof nodeKindSchema>;

export const planMutationSchema = z.enum([
  "retry",
  "skip",
  "reorder",
  "reroute",
  "pause",
  "replace",
  "insert",
  "remove",
  "edit",
]);
export type PlanMutation = z.infer<typeof planMutationSchema>;

export const nodeAuthoritySchema = z.strictObject({
  scope: z.enum(["self", "connected", "group", "graph"]).default("self"),
  actions: z.array(planMutationSchema).default([]),
});
export type NodeAuthority = z.infer<typeof nodeAuthoritySchema>;

const nodeAccessSchema = z.strictObject({
  mode: z.enum(["read-only", "workspace-write"]).default("read-only"),
  writeScopes: z.array(z.string()).default([]),
});

const nodePositionSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
});

const agentLikeShape = {
  id: z.string().min(1),
  name: z.string().min(1),
  roleLabel: z.string().min(1).optional(),
  job: z.string().min(1),
  harnessId: harnessIdSchema,
  modelId: z.string().min(1),
  access: nodeAccessSchema.default({ mode: "read-only", writeScopes: [] }),
  authority: nodeAuthoritySchema.default({ scope: "self", actions: [] }),
  activation: z.enum(["all", "any"]).default("all"),
  maxVisits: z.number().int().positive().default(3),
  groupId: z.string().min(1).optional(),
  position: nodePositionSchema,
};

export const agentNodeV2Schema = z.strictObject({
  ...agentLikeShape,
  kind: z.literal("agent"),
});
export type AgentNode = z.infer<typeof agentNodeV2Schema>;

export const decisionNodeV2Schema = z.strictObject({
  ...agentLikeShape,
  kind: z.literal("decision"),
});
export type DecisionNode = z.infer<typeof decisionNodeV2Schema>;

export const checkpointNodeV2Schema = z.strictObject({
  kind: z.literal("checkpoint"),
  id: z.string().min(1),
  name: z.string().min(1),
  mode: z.enum(["automatic", "manual"]),
  groupId: z.string().min(1).optional(),
  position: nodePositionSchema,
});
export type CheckpointNode = z.infer<typeof checkpointNodeV2Schema>;

export const subgraphNodeV2Schema = z.strictObject({
  kind: z.literal("subgraph"),
  id: z.string().min(1),
  name: z.string().min(1),
  graphId: z.string().min(1),
  graphVersion: z.number().int().positive().optional(),
  groupId: z.string().min(1).optional(),
  position: nodePositionSchema,
});
export type SubgraphNode = z.infer<typeof subgraphNodeV2Schema>;

export const graphNodeV2Schema = z.discriminatedUnion("kind", [
  agentNodeV2Schema,
  decisionNodeV2Schema,
  checkpointNodeV2Schema,
  subgraphNodeV2Schema,
]);
export type GraphNode = z.infer<typeof graphNodeV2Schema>;

export const graphEdgeV2Schema = z.strictObject({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  kind: z.enum(["dependency", "handoff", "review", "approval", "escalation"]),
  when: z.enum(["always", "success", "failure", "selected"]),
  label: z.string().min(1),
});
export type GraphEdge = z.infer<typeof graphEdgeV2Schema>;

export const graphGroupSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  parentGroupId: z.string().min(1).optional(),
});
export type GraphGroup = z.infer<typeof graphGroupSchema>;

export const graphDefinitionV2Schema = z
  .strictObject({
    id: z.string().min(1),
    name: z.string().min(1).max(120),
    version: z.number().int().positive(),
    nodes: z.array(graphNodeV2Schema).min(1),
    edges: z.array(graphEdgeV2Schema).default([]),
    groups: z.array(graphGroupSchema).default([]),
    maxSteps: z.number().int().positive().default(100),
    createdAt: z.string().datetime(),
  })
  .superRefine((graph, context) => {
    const nodeIds = new Set<string>();
    for (const node of graph.nodes) {
      if (nodeIds.has(node.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate node id ${node.id}.`,
        });
      }
      nodeIds.add(node.id);
      if (node.kind === "subgraph" && node.graphId === graph.id) {
        context.addIssue({
          code: "custom",
          message: `Subgraph node ${node.id} references its own graph.`,
        });
      }
    }
    const edgeIds = new Set<string>();
    for (const edge of graph.edges) {
      if (edgeIds.has(edge.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate edge id ${edge.id}.`,
        });
      }
      edgeIds.add(edge.id);
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
        context.addIssue({
          code: "custom",
          message: `Edge ${edge.id} references an unknown node.`,
        });
      }
    }
    const groupIds = new Set(graph.groups.map((group) => group.id));
    if (groupIds.size !== graph.groups.length) {
      context.addIssue({
        code: "custom",
        message: "Duplicate group id.",
      });
    }
    for (const group of graph.groups) {
      if (group.parentGroupId && !groupIds.has(group.parentGroupId)) {
        context.addIssue({
          code: "custom",
          message: `Group ${group.id} references an unknown group.`,
        });
      }
    }
    for (const node of graph.nodes) {
      if (node.groupId && !groupIds.has(node.groupId)) {
        context.addIssue({
          code: "custom",
          message: `Node ${node.id} references an unknown group.`,
        });
      }
    }
  });
export type GraphDefinitionV2 = z.infer<typeof graphDefinitionV2Schema>;

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
  graphs: GraphDefinitionV2[];
  runs: RunRecord[];
  activeRunId?: string;
};

export type StartRunInput = {
  graph: GraphDefinition | GraphDefinitionV2;
  repositoryPath: string;
  goal: string;
};

export type UpdateGraphInput = {
  graph: GraphDefinitionV2;
};

export const onboardingSelectionSchema = z.strictObject({
  harnessId: harnessIdSchema,
  modelId: z.string().trim().min(1),
});
export type OnboardingSelection = z.infer<typeof onboardingSelectionSchema>;
