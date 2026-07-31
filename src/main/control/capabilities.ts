import {
  CONTROL_CAPABILITIES,
  type ControlCapability,
  type ControlOperationMap,
  type ControlOperationName,
} from "../../shared/control";
import type { SpireControl } from "./spire-control";

/**
 * Capability-driven dispatch registry.
 *
 * Every operation in `ControlOperationMap` is registered exactly once: the
 * schemas and annotations come from `CONTROL_CAPABILITIES` (the shared
 * contract), and the handler binds to the matching `SpireControl` method.
 * The mapped type makes a missing or misspelled operation a compile error.
 */

export type ControlOperationHandler<Name extends ControlOperationName> = (
  input: ControlOperationMap[Name]["input"],
) =>
  | Promise<ControlOperationMap[Name]["output"]>
  | ControlOperationMap[Name]["output"];

export type RegisteredOperation<Name extends ControlOperationName> =
  ControlCapability<
    ControlOperationMap[Name]["input"],
    ControlOperationMap[Name]["output"]
  > & {
    handler: ControlOperationHandler<Name>;
  };

export type ControlRegistry = {
  [Name in ControlOperationName]: RegisteredOperation<Name>;
};

export function createControlRegistry(control: SpireControl): ControlRegistry {
  return {
    "state.get": {
      ...CONTROL_CAPABILITIES["state.get"],
      handler: () => control.handleStateGet(),
    },
    "diagnostics.get": {
      ...CONTROL_CAPABILITIES["diagnostics.get"],
      handler: () => control.handleDiagnosticsGet(),
    },
    "graphs.list": {
      ...CONTROL_CAPABILITIES["graphs.list"],
      handler: (input) => control.handleGraphsList(input),
    },
    "graphs.get": {
      ...CONTROL_CAPABILITIES["graphs.get"],
      handler: (input) => control.handleGraphsGet(input),
    },
    "graphs.save": {
      ...CONTROL_CAPABILITIES["graphs.save"],
      handler: (input) => control.handleGraphsSave(input),
    },
    "repositories.validate": {
      ...CONTROL_CAPABILITIES["repositories.validate"],
      handler: (input) => control.handleRepositoriesValidate(input),
    },
    "runs.list": {
      ...CONTROL_CAPABILITIES["runs.list"],
      handler: (input) => control.handleRunsList(input),
    },
    "runs.get": {
      ...CONTROL_CAPABILITIES["runs.get"],
      handler: (input) => control.handleRunsGet(input),
    },
    "runs.start": {
      ...CONTROL_CAPABILITIES["runs.start"],
      handler: (input) => control.handleRunsStart(input),
    },
    "runs.stop": {
      ...CONTROL_CAPABILITIES["runs.stop"],
      handler: (input) => control.handleRunsStop(input),
    },
    "runs.retry": {
      ...CONTROL_CAPABILITIES["runs.retry"],
      handler: (input) => control.handleRunsRetry(input),
    },
    "runs.artifacts.get": {
      ...CONTROL_CAPABILITIES["runs.artifacts.get"],
      handler: (input) => control.handleRunsArtifactsGet(input),
    },
    "worktrees.cleanup": {
      ...CONTROL_CAPABILITIES["worktrees.cleanup"],
      handler: (input) => control.handleWorktreesCleanup(input),
    },
    "layouts.list": {
      ...CONTROL_CAPABILITIES["layouts.list"],
      handler: (input) => control.handleLayoutsList(input),
    },
    "layouts.save": {
      ...CONTROL_CAPABILITIES["layouts.save"],
      handler: (input) => control.handleLayoutsSave(input),
    },
    "layouts.reset": {
      ...CONTROL_CAPABILITIES["layouts.reset"],
      handler: (input) => control.handleLayoutsReset(input),
    },
    "harnesses.list": {
      ...CONTROL_CAPABILITIES["harnesses.list"],
      handler: () => control.handleHarnessesList(),
    },
    "harnesses.models": {
      ...CONTROL_CAPABILITIES["harnesses.models"],
      handler: (input) => control.handleHarnessesModels(input),
    },
    "traces.query": {
      ...CONTROL_CAPABILITIES["traces.query"],
      handler: (input) => control.handleTracesQuery(input),
    },
    "traces.tail": {
      ...CONTROL_CAPABILITIES["traces.tail"],
      handler: (input) => control.handleTracesTail(input),
    },
    "graphs.validate": {
      ...CONTROL_CAPABILITIES["graphs.validate"],
      handler: (input) => control.handleGraphsValidate(input),
    },
    "runs.plan.get": {
      ...CONTROL_CAPABILITIES["runs.plan.get"],
      handler: (input) => control.handleRunsPlanGet(input),
    },
    "runs.nodes.list": {
      ...CONTROL_CAPABILITIES["runs.nodes.list"],
      handler: (input) => control.handleRunsNodesList(input),
    },
    "runs.messages.list": {
      ...CONTROL_CAPABILITIES["runs.messages.list"],
      handler: (input) => control.handleRunsMessagesList(input),
    },
    "runs.messages.send": {
      ...CONTROL_CAPABILITIES["runs.messages.send"],
      handler: (input) => control.handleRunsMessagesSend(input),
    },
    "runs.plan.patch": {
      ...CONTROL_CAPABILITIES["runs.plan.patch"],
      handler: (input) => control.handleRunsPlanPatch(input),
    },
    "runs.plan.rollback": {
      ...CONTROL_CAPABILITIES["runs.plan.rollback"],
      handler: (input) => control.handleRunsPlanRollback(input),
    },
    "runs.checkpoint.resume": {
      ...CONTROL_CAPABILITIES["runs.checkpoint.resume"],
      handler: (input) => control.handleRunsCheckpointResume(input),
    },
    "runs.plan.promote": {
      ...CONTROL_CAPABILITIES["runs.plan.promote"],
      handler: (input) => control.handleRunsPlanPromote(input),
    },
  };
}
