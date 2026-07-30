# Renderer crash on rapid window resize

## Summary

The Electron renderer process crashes (GPU process fatal) when the user rapidly drags a pane resize handle.

## Reproduction

1. Start the app (`pnpm start`)
2. Drag a pane splitter quickly back and forth
3. Renderer crashes within seconds

## Crash signature

```
FATAL:content/browser/gpu/gpu_data_manager_impl_private.cc:415] GPU process isn't usable. Goodbye.
```

Preceded by repeated `GPU process launch failed: error_code=1002` errors.

## Root cause

`WorkspaceLayout.tsx` renders FlexLayout with `realtimeResize` enabled. This fires `onModelChange` on **every pixel** of mouse movement during a drag-resize. The handler calls `publishStatus(changed)` which:

1. Calls `target.toJson()` — serializes the entire layout model to a JSON tree
2. Walks the full node tree via `collectPaneIds()`
3. Traverses tabsets and popout maps
4. Triggers a React state update (`setLayoutStatus`)

During rapid resizing, steps 1–4 execute hundreds of times per second, creating a CPU storm that overwhelms the renderer process and cascades into a GPU process crash.

## Key code paths

- `src/renderer/workspace/WorkspaceLayout.tsx:509-516` — `<Layout realtimeResize>`
- `src/renderer/workspace/WorkspaceLayout.tsx:263-280` — `handleModelChange` calls `publishStatus`
- `src/renderer/workspace/WorkspaceLayout.tsx:217-229` — `publishStatus` does expensive JSON serialization and tree traversal

## Proposed fix

Debounce `publishStatus` so it runs at most once every ~100ms during rapid layout changes. The `scheduleSave` is already debounced (300ms); `publishStatus` needs the same treatment.

```tsx
const publishStatusDebounced = useCallback(
  debounce((target: Model) => {
    const open = collectPaneIds(target.toJson());
    const activeTabset = target.getActiveTabset();
    setLayoutStatus({
      closedPanes: PANE_IDS.filter((id) => !open.has(id)),
      hasActivePane: Boolean(activeTabset?.getSelectedNode()),
      hasPopouts: target.getwindowsMap().size > 1,
      isMaximized: Boolean(target.getMaximizedTabset()),
    });
  }, 100),
  [setLayoutStatus],
);
```

## Status

- Reported: 2026-07-30
- Priority: High (app crash on common user action)
- Fix: Pending
