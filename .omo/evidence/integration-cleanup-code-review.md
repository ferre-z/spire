# Code review: integration cleanup (0f0e08e)

## Result

- `codeQualityStatus`: **WATCH**
- `recommendation`: **APPROVE**
- `blockers`: none

The fixed-shell cleanup is functionally coherent. FlexLayout is gone from the
manifest, lockfile, renderer import graph, and active renderer code; the old
renderer modules and popout E2E coverage are deleted; no current renderer
consumer remains. Shared, main, preload, and database workspace-layout
persistence remain, while the renderer no longer calls the persistence API.

## Findings

### CRITICAL

None.

### HIGH

None.

### MEDIUM

1. **Dead FlexLayout theme CSS remains after the renderer and package removal.**
   [src/renderer/styles.css:140](../../src/renderer/styles.css:140) and
   [src/renderer/styles.css:351](../../src/renderer/styles.css:351) through
   [src/renderer/styles.css:520](../../src/renderer/styles.css:520) still
   contain the removed renderer's `.flexlayout__*` selectors. Repository-wide
   search finds no remaining FlexLayout package, import, DOM producer, or test
   consumer. This is harmless at runtime but is obsolete production styling and
   makes a later reader believe the dockable workspace still exists. Remove the
   selectors as a follow-up.

2. **The issue ledger presents packaged E2E files as verification without
   recording the known execution gap for the node-dialog/fixed-shell claims.**
   [docs/issues/todo.md:28](../../docs/issues/todo.md:28) and
   [docs/issues/todo.md:43](../../docs/issues/todo.md:43) list
   `e2e/workspace.spec.ts` and `e2e/visual.spec.ts` as verification. The
   supplied focused-E2E evidence instead records a timeout before Electron
   opened a window because the manually built package had the inspect fuse
   disabled. The harness gap is not evidence of a product defect, but the
   ledger should link or qualify that limitation so its verification claims are
   accurate.

### LOW

1. **Lockfile has unrelated normalization churn.**
   [pnpm-lock.yaml:365](../../pnpm-lock.yaml:365) and the Rollup package entries
   add `gitHosted`/`libc` metadata unrelated to removing `flexlayout-react`.
   This is probably the package-manager version's serialization, but it makes
   this cleanup noisier than necessary.

## Verification inspected

- Independently ran `pnpm test`: 37 files / 609 tests passed.
- Independently ran `pnpm typecheck` and `pnpm lint`: both passed.
- Inspected the supplied build/native evidence: packaged Linux build succeeded;
  the Node ABI was rebuilt and `better-sqlite3` completed an in-memory query.
- Inspected the focused E2E trace/evidence: it timed out at Electron launch;
  this is the documented missing-inspect-fuse harness limitation, not a
  regression finding.
- Confirmed all nine documentation commit references resolve.
- Confirmed `seedGraph` and the MCP state fixture use complete typed v2 graph
  objects. The v2 contract remains the strict `graphDefinitionV2Schema`; no
  schema weakening was introduced.
- `NODE_ENV=test` is appropriate for this Linux-first repository and the native
  addon rebuild/restore evidence accounts for the Node/Electron ABI boundary.

## Skill-perspective check

Ran the required `omo:programming` and `omo:remove-ai-slops` reviews. The diff
does not introduce untyped escapes, boundary parsing/normalization, needless
abstractions, brittle prose/prompt tests, tautological tests, or
implementation-mirroring tests. Deleting tests for the removed popout feature
is appropriate; the updated seed and E2E specs exercise observable fixed-shell
behavior with v2 data. The remaining FlexLayout CSS is a dead-code violation of
the anti-slop perspective, and the documentation evidence wording above is a
maintainability/evidence-quality concern.
