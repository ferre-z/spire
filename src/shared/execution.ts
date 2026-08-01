import { z } from "zod";
import { graphEdgeV2Schema, graphNodeV2Schema } from "./domain";

export const nodeExecutionStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
]);
export type NodeExecutionStatus = z.infer<typeof nodeExecutionStatusSchema>;

export const collaborationMessageDraftSchema = z.strictObject({
  recipient: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("node"), id: z.string().min(1) }),
    z.strictObject({ kind: z.literal("group"), id: z.string().min(1) }),
    z.strictObject({ kind: z.literal("successors") }),
  ]),
  kind: z.enum(["question", "handoff", "report", "decision"]),
  subject: z.string().min(1),
  body: z.string(),
  artifactPaths: z.array(z.string()),
});
export type CollaborationMessageDraft = z.infer<
  typeof collaborationMessageDraftSchema
>;

export const planPatchOperationSchema = z.union([
  z.strictObject({
    action: z.enum(["retry", "skip", "remove"]),
    nodeId: z.string().min(1),
  }),
  z.strictObject({
    action: z.literal("reorder"),
    nodeId: z.string().min(1),
    beforeNodeId: z.string().min(1),
  }),
  z.strictObject({
    action: z.literal("reroute"),
    enableEdgeIds: z.array(z.string().min(1)),
    disableEdgeIds: z.array(z.string().min(1)),
  }),
  z.strictObject({
    action: z.literal("pause"),
    reason: z.string().min(1),
  }),
  z.strictObject({
    action: z.literal("replace"),
    nodeId: z.string().min(1),
    replacement: graphNodeV2Schema,
  }),
  z.strictObject({
    action: z.literal("insert"),
    node: graphNodeV2Schema,
    edges: z.array(graphEdgeV2Schema),
  }),
  z.strictObject({
    action: z.literal("edit"),
    nodeId: z.string().min(1),
    replacement: graphNodeV2Schema,
  }),
]);
export type PlanPatchOperation = z.infer<typeof planPatchOperationSchema>;

export const planPatchDraftSchema = z.strictObject({
  baseRevision: z.number().int().nonnegative(),
  reason: z.string().min(1),
  operations: z.array(planPatchOperationSchema).min(1),
});
export type PlanPatchDraft = z.infer<typeof planPatchDraftSchema>;

export const appliedPlanPatchSchema = z
  .strictObject({
    baseRevision: z.number().int().nonnegative(),
    reason: z.string().min(1),
    operations: z.array(planPatchOperationSchema).min(1),
    id: z.string().min(1),
    actorNodeId: z.string().min(1),
    appliedRevision: z.number().int().nonnegative(),
    appliedAt: z.string().datetime(),
    rolledBackBy: z.string().min(1).optional(),
  })
  .superRefine((patch, context) => {
    if (patch.appliedRevision <= patch.baseRevision) {
      context.addIssue({
        code: "custom",
        message: `Stale patch ${patch.id}: applied at revision ${patch.appliedRevision} but based on revision ${patch.baseRevision}.`,
      });
    }
  });
export type AppliedPlanPatch = z.infer<typeof appliedPlanPatchSchema>;

export const nodeOutcomeSchema = z.strictObject({
  status: z.enum(["succeeded", "failed"]),
  summary: z.string(),
  artifacts: z.array(
    z.strictObject({
      name: z.string().min(1),
      path: z.string().min(1),
      mediaType: z.string().optional(),
    }),
  ),
  messages: z.array(collaborationMessageDraftSchema),
  selectedEdgeIds: z.array(z.string().min(1)),
  patch: planPatchDraftSchema.optional(),
});
export type NodeOutcome = z.infer<typeof nodeOutcomeSchema>;

export const nodeExecutionSchema = z.strictObject({
  nodeId: z.string().min(1),
  status: nodeExecutionStatusSchema,
  visits: z.number().int().nonnegative(),
  /**
   * Per-edge count of tokens this node has offered on outgoing edges across
   * its completed visits. For `success`/`failure`/`selected` edges, only visits
   * whose outcome satisfies the condition offer a token; for `always` edges,
   * every completed visit offers one. This per-visit, per-edge precision
   * prevents phantom tokens: a node that failed then succeeded does not
   * retroactively offer a success token from its failed visit. Absent for
   * executions created before this field existed; the scheduler falls back to
   * the `completedVisits` approximation for backward compatibility.
   */
  tokensOffered: z.record(z.string(), z.number().int().nonnegative()).optional(),
  /**
   * Per-edge count of tokens this node has consumed from incoming edges. Each
   * node visit consumes one token from each incoming edge that has an unspent
   * token, so a condition edge that offered a token but was not the actual
   * trigger for this visit does not lose its token to a later unaffordably-high
   * `target.visits` count. Absent for executions created before this field
   * existed; the scheduler falls back to per-visit consumption.
   */
  tokensConsumed: z.record(z.string(), z.number().int().nonnegative()).optional(),
  outcome: nodeOutcomeSchema.optional(),
  error: z.string().optional(),
});
export type NodeExecution = z.infer<typeof nodeExecutionSchema>;

export const executionPlanSchema = z
  .strictObject({
    runId: z.string().min(1),
    graphId: z.string().min(1),
    graphVersion: z.number().int().positive(),
    revision: z.number().int().nonnegative(),
    status: z.enum(["running", "paused", "succeeded", "failed", "needs_attention"]),
    stepCount: z.number().int().nonnegative(),
    nodes: z.array(nodeExecutionSchema),
    edges: z.array(graphEdgeV2Schema),
    patches: z.array(appliedPlanPatchSchema),
    updatedAt: z.string().datetime(),
  })
  .superRefine((plan, context) => {
    for (const patch of plan.patches) {
      if (patch.appliedRevision > plan.revision) {
        context.addIssue({
          code: "custom",
          message: `Patch ${patch.id} applied at revision ${patch.appliedRevision}, beyond the plan revision ${plan.revision}.`,
        });
      }
    }
  });
export type ExecutionPlan = z.infer<typeof executionPlanSchema>;
