# Visual baseline verification

The five Linux baselines in this directory were recaptured and compared against
source revision `e01861baca8e45250da552b393e27de73f156326` on 2026-08-03.

- `DISPLAY=:1 pnpm exec playwright test e2e/visual.spec.ts --timeout 60000 --update-snapshots --reporter=list`: 5 passed.
- `DISPLAY=:1 pnpm exec playwright test e2e/workspace.spec.ts e2e/visual.spec.ts --timeout 60000 --reporter=list`: 15 passed.

The recaptured PNG bytes were unchanged, confirming that the design-token
refactor preserved the approved rendering. The captures were also inspected for
hierarchy, clipping, overflow, long-content containment, and the premium minimal
charcoal direction defined in `DESIGN.md`.
