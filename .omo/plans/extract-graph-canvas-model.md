# Extract Graph Canvas Model Builders

## TL;DR
> Summary:      Move the two pure React Flow projection builders into a focused model module while leaving the pane as the stable import facade and interaction owner.
> Deliverables: `GraphCanvasModel.ts`; a sub-200-pure-LOC `GraphCanvasPane.tsx`; unchanged public/test import behavior
> Effort:       Quick
> Risk:         Low - the logic is pure and covered, but the move crosses the pane/model module boundary and must preserve runtime `MarkerType` values and re-exports exactly.

## Scope
### Must have
- Extract `buildCanvasNodes` and `buildCanvasEdges`, their private edge color constants, and their model-only dependencies from `src/renderer/panes/GraphCanvasPane.tsx:47-164` into `src/renderer/panes/GraphCanvasModel.ts` without changing function names, parameters, defaults, return shapes, ordering, styling, or marker values.
- Keep `GraphCanvasPane` as the stable facade: its callers and `GraphCanvasPane.test.tsx:81-87` continue importing `GraphCanvasPane`, `buildCanvasNodes`, `buildCanvasEdges`, and palette exports from `./GraphCanvasPane`.
- Keep React/store/render registration and drag behavior in the pane; finish with fewer than 200 nonblank, non-comment lines in `GraphCanvasPane.tsx`.

### Must NOT have (guardrails, anti-slop, scope boundaries)
- No behavior, CSS, graph layout, domain schema, store, component, dependency, or test-expectation changes.
- Do not move `NODE_TYPES`, `EDGE_TYPES`, `CanvasEdgeRenderer`, hooks, `CanvasView`, or drag/selection/fit-view behavior into the model.
- Do not import undeclared `@xyflow/system`; retain the existing declared `@xyflow/react` runtime source for `MarkerType` and use `import type` for `Node`.
- Do not update current test imports to the new module; the compatibility re-export is part of the contract.
- Do not add assertions, casts, `any`, non-null assertions, ignore directives, or new dependencies.

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after + Vitest; existing characterization coverage remains unchanged and must stay green.
- QA policy: every task has agent-executed scenarios
- Evidence: `<attemptDir>/task-<N>-<slug>.<ext>` — under ulw-loop, `<attemptDir>` is the `currentAttemptDir` from `omo ulw-loop status --json` (`.omo/evidence/ulw/<session>/<goalId>/a<attempt>`); outside ulw-loop use `.omo/evidence/`

## Execution strategy
### Parallel execution waves
> Target 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks to maximize parallelism.

Wave 1 (no dependencies):
- Task 1: perform the single cross-file extraction and compatibility wiring

Wave 2 (after Wave 1):
- None; final verification follows Task 1.

Critical path: Task 1 -> F1/F2/F3/F4

### Dependency matrix
| Task | Depends on | Blocks | Can parallelize with |
|------|------------|--------|----------------------|
| 1    | none       | F1-F4  | none                 |

### Team Staffing Recommendation
- total_atomic_steps: 1
- file_independent_steps: 0
- cross_file_dependent_steps: 1
- per_step_assignment: `[{step_id: 1, assigned_to: 'unspecified-low', blockedBy: [], rationale: 'Logic-preserving extraction with a cross-file import/re-export contract; requires reasoning beyond a mechanical move.'}]`
- dispatch_path_recommendation: `legacy` - fewer than three file-independent steps; one worker avoids cross-file merge races.
- rationale for the composition: One `unspecified-low` worker owns both the new model and pane facade so the repository never lands in a half-moved state; separate parallel workers would contend on the same export/import boundary.

## Todos
> Implementation + Test = ONE task. Never separate.
> Every task MUST have: References + Acceptance Criteria + QA Scenarios + Commit.

- [ ] 1. Extract the canvas projection model behind the existing pane facade

  What to do: First run the focused test and typecheck as the baseline. Create `src/renderer/panes/GraphCanvasModel.ts` and move `EDGE_IDLE`, `EDGE_EXECUTING`, the private `CanvasFlowNode = Node` alias, and the bodies/signatures of `buildCanvasNodes` and `buildCanvasEdges` from `GraphCanvasPane.tsx:47-164` unchanged. In the new module use type-only imports for `GraphDefinitionV2`, `ExecutionPlan`, `Node`, and `CanvasEdge`; retain the runtime `MarkerType` import from the already-declared `@xyflow/react`; import `calculateGroupLayouts`, `CANVAS_METRICS`, `isGroupHidden`, `isNodeHidden`, and `visibleNodeIds` from `GraphCanvasLayout`. In `GraphCanvasPane.tsx`, import both builders for its internal calls and re-export the same names from `./GraphCanvasModel`; keep the existing palette re-exports and `GraphCanvasPane` export untouched. Keep or replace the pane-local `CanvasFlowNode` typing with `Node` so `useNodesState` and `OnNodeDrag` remain strictly typed. Do not edit test imports or assertions. Measure pure LOC and run all verification commands before the single commit.

  Must NOT do: Do not reformat or rewrite the builder logic, change `MarkerType.ArrowClosed`, consolidate maps/sets, alter array ordering or collapsed-group behavior, move renderer registrations, or touch files outside the two listed implementation paths.

  Parallelization: Can parallel: NO | Wave 1 | Blocks: [F1, F2, F3, F4] | Blocked by: []

  References (executor has NO interview context - be exhaustive):
  - Pattern:  `src/renderer/panes/GraphCanvasPane.tsx:40-45` - existing facade re-export pattern that must also expose the moved builders.
  - Pattern:  `src/renderer/panes/GraphCanvasLayout.ts:1-145` - adjacent pure canvas module boundary and helper contracts consumed by the builders.
  - API/Type: `src/renderer/panes/GraphCanvasPane.tsx:61-164` - exact builder signatures and bodies to preserve.
  - API/Type: `src/renderer/components/CanvasEdge.tsx:10-17` - readonly edge data and `CanvasEdge` return contract.
  - Test:     `src/renderer/panes/GraphCanvasPane.test.tsx:81-87` - import contract that must remain unchanged.
  - Test:     `src/renderer/panes/GraphCanvasPane.test.tsx:244-282` - current node/edge projection characterization tests.
  - External: `https://reactflow.dev/api-reference/types/marker-type` - `MarkerType.ArrowClosed` runtime marker contract.

  Acceptance criteria (agent-executable only):
  - [ ] `pnpm vitest run src/renderer/panes/GraphCanvasPane.test.tsx` exits 0 with the current 24 tests passing and no test-import edits.
  - [ ] `pnpm typecheck` exits 0 with no casts, `any`, non-null assertions, or TypeScript suppression directives introduced.
  - [ ] `pnpm lint` exits 0.
  - [ ] `test "$(awk '!/^[[:space:]]*$/ && !/^[[:space:]]*\/\//' src/renderer/panes/GraphCanvasPane.tsx | wc -l)" -lt 200` exits 0.
  - [ ] `rg -n 'buildCanvasNodes|buildCanvasEdges' src/renderer/panes/GraphCanvasPane.test.tsx` still shows the imports from `./GraphCanvasPane`, while `rg -n '^export function buildCanvas(Nodes|Edges)' src/renderer/panes/GraphCanvasModel.ts` finds both definitions.
  - [ ] `git diff -- src/renderer/panes/GraphCanvasPane.tsx src/renderer/panes/GraphCanvasModel.ts src/renderer/panes/GraphCanvasPane.test.tsx` shows a logic-preserving move, facade wiring, and no test changes.

  QA scenarios (MANDATORY - task incomplete without these):
  > Name the exact tool AND its exact invocation - not "verify it works". Browser use: in Codex, use `browser:control-in-app-browser` first when available and no authenticated/persistent user browser profile is required; otherwise use Chrome to drive the page, or agent-browser (https://github.com/vercel-labs/agent-browser) when Chrome is unavailable. Computer use: OS-level GUI automation for a non-browser desktop app.
  ```
  Scenario: Existing canvas projection and pane interactions remain identical
    Tool:     bash
    Steps:    Run `pnpm vitest run src/renderer/panes/GraphCanvasPane.test.tsx` from the repository root.
    Expected: Exit code 0; 24/24 tests pass, including grouped positions, collapsed-edge filtering, execution styling, collapse/expand, selection, drag, and fit-view cases.
    Evidence: <attemptDir>/task-1-canvas-model-test.txt   (attemptDir = currentAttemptDir from `omo ulw-loop status --json`, .omo/evidence/ulw/<session>/<goalId>/a<attempt>)

  Scenario: Strict module boundary rejects an incomplete or mistyped move
    Tool:     bash
    Steps:    Run `pnpm typecheck && pnpm lint && test "$(awk '!/^[[:space:]]*$/ && !/^[[:space:]]*\/\//' src/renderer/panes/GraphCanvasPane.tsx | wc -l)" -lt 200`.
    Expected: All commands exit 0; missing imports/re-exports, invalid React Flow types, lint regressions, or a pane at/above 200 pure LOC fail the scenario.
    Evidence: <attemptDir>/task-1-canvas-model-error.txt
  ```

  Commit: YES | Message: `refactor(canvas): extract graph canvas model builders` | Files: [src/renderer/panes/GraphCanvasModel.ts, src/renderer/panes/GraphCanvasPane.tsx]

  Rollback: Because the extraction is one atomic commit and changes no persisted data, run `git revert <commit-sha>` if any focused/full verification regresses; do not partially delete the facade re-export or new module. Before commit, reverse only the extraction hunks from the worker's captured patch and delete `src/renderer/panes/GraphCanvasModel.ts` only after confirming it was created by this task. The worktree is already dirty, so never use whole-file `git restore`/checkout on `GraphCanvasPane.tsx` or the test file.

## Final verification wave (MANDATORY - after all implementation tasks)
> Runs in PARALLEL. ALL must APPROVE. Surface results to the caller and wait for an explicit "okay" before declaring complete.
- [ ] F1. Plan compliance audit - confirm the move is exact, pane imports remain stable, and only the two implementation files changed for this task.
- [ ] F2. Code quality review - run `pnpm typecheck`, `pnpm lint`, and the pure-LOC assertion; confirm model imports are type-only where possible and pane stays under 200.
- [ ] F3. Real manual QA - run `pnpm vitest run src/renderer/panes/GraphCanvasPane.test.tsx` and `pnpm test`; capture command output as evidence.
- [ ] F4. Scope fidelity - inspect `git diff --stat` and `git diff -- src/renderer/panes/GraphCanvasPane.tsx src/renderer/panes/GraphCanvasModel.ts src/renderer/panes/GraphCanvasPane.test.tsx`; reject logic/test/CSS/dependency changes.

## Commit strategy
- One logical change per commit. Conventional Commits (`<type>(<scope>): <subject>` body + footer).
- Atomic: every commit builds and passes tests on its own.
- No "WIP" / "fix typo squash later" commits on the final branch - clean up before merge.
- Reference the plan file path in the final commit footer: `Plan: .omo/plans/extract-graph-canvas-model.md`.

## Success criteria
- All Must-Have shipped; all QA scenarios pass with captured evidence; F1-F4 approved; commit history clean.
