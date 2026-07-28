# Spire Professional Dockable UI Redesign

## Summary

Rebuild Spire as a responsive, IDE-style workspace using
`flexlayout-react` 0.8.x. It supports draggable splitters, tab docking,
granular panels, native popout windows, and serializable layouts while fitting
the existing Electron/Vite renderer model.

The visual language remains predominantly charcoal black and grey, with subtle
light-blue structural accents and orange action accents. Glass, mesh gradients,
and liquid-border motion remain selective so the interface feels professional
rather than decorative.

Reference: [FlexLayout](https://github.com/caplin/FlexLayout)

## Design and Workspace Changes

- Define semantic tokens around deep charcoal backgrounds, graphite surfaces,
  translucent glass, restrained borders, light-blue selection/focus, and
  orange execution/CTA states. Preserve green, red, and amber for success,
  failure, and warning semantics.
- Bundle Inter and JetBrains Mono variable fonts for consistent cross-platform
  typography.
- Use low-opacity blue/orange mesh gradients behind the workspace and
  onboarding screen. Keep content panels sufficiently opaque for contrast.
- Apply clean glass treatment to titlebars, menus, docking previews, floating
  controls, and popout chrome; use opaque fallbacks when `backdrop-filter` is
  unavailable.
- Implement a GPU-friendly masked gradient border that flows once for
  450–600ms on hover or keyboard focus. Limit it to agent nodes, primary
  actions, active tabs, and focused panels; reduced-motion users receive a
  static accent.
- Keep the global titlebar and workspace toolbar fixed. Make these ten panes
  independently closable, dockable, resizable, tab-groupable, maximizable, and
  popout-capable:
  - Graph Library
  - Run History
  - Graph Canvas
  - Task Launcher
  - Graph Settings
  - Node Inspector
  - Runtime Policy
  - Live Stream
  - Diff
  - Result
- Use this default desktop layout:
  - Graph Library and Run History on the left.
  - Graph Canvas in the center with Task Launcher below it.
  - Graph Settings, Node Inspector, and Runtime Policy tabbed in the upper-right.
  - Live Stream, Diff, and Result tabbed in the lower-right.
- Add a View/command menu that can reopen panes, move the active pane, resize it
  in fixed increments, pop it out, dock it back, maximize it, or reset the
  layout.
- Use 1px visible splitters with an 8px interaction region. Provide panel-menu
  resize and movement commands as keyboard alternatives to dragging.
- Use `F6` and `Shift+F6` to cycle panes. Use `Ctrl/Cmd+K` to open the layout
  command menu. Focus rings use light blue and remain visible against glass.
- Lower the Electron window minimum to 800×600:
  - At 1100px and wider, use the desktop layout.
  - From 800–1099px, use an independently persisted compact layout with
    collapsed edge groups and tabbed supporting panes.
  - When crossing the breakpoint, save the current mode and restore the other
    without overwriting either.
- Make popout windows resizable with pane-specific minimums. Close them with the
  main application and retain their dimensions. On Wayland, restore size only
  and let the compositor select position.

## Persistence, Security, and Interfaces

- Add a `workspace_layouts` SQLite table keyed by stable `graph_id` and layout
  mode, so every version of one graph shares its desktop and compact
  arrangements.
- Add these shared types:
  - `WorkspaceLayoutMode = "desktop" | "compact"`
  - `JsonValue`
  - `WorkspaceLayoutRecord { graphId, mode, schemaVersion, model, updatedAt }`
- Extend the preload API with:
  - `loadWorkspaceLayouts(graphId)`
  - `saveWorkspaceLayout(record)`
  - `resetWorkspaceLayouts(graphId)`
  - `environment()`, returning platform and Wayland status
- Validate serialized layouts, reject unknown schema versions or payloads over
  512KB, debounce saves by 300ms, and flush before graph switches or application
  shutdown.
- Fall back to the appropriate default layout when persisted data is corrupt or
  outdated without blocking startup.
- Add a blank, CSP-protected `popout.html` to the Vite production bundle.
- Replace the blanket window denial with an exact allowlist for the same-origin
  development or packaged `popout.html`. Keep every other renderer-created
  window denied and retain sandboxing, context isolation, disabled Node
  integration, and navigation blocking.
- When changing graphs, save the current layout, close its live popouts, load
  the target graph’s layout, and restore its saved popouts. If a popout fails,
  keep the pane docked and show a non-blocking error.

Reference:
[Electron window handling](https://www.electronjs.org/docs/latest/api/window-open)

## Test Plan

- Unit-test default desktop and compact models, panel registry completeness,
  schema validation, corrupt-layout fallback, and persistence across graph
  versions.
- Verify separate layouts for two graphs and separate compact/desktop layouts
  for one graph.
- Run Electron UI tests at 800×600, 1024×700, 1440×900, and 1920×1080.
- Exercise resizing, docking, tab grouping, closing/reopening, maximizing,
  graph switching, reset, and native popout/dock-back behavior.
- Verify Graph Canvas correctly refits after resize, docking, and popout.
- Confirm external and cross-origin popup attempts remain denied.
- Validate keyboard-only pane navigation and command-menu alternatives.
- Run contrast checks, reduced-motion tests, overflow checks, and screenshot
  comparisons for onboarding, default workspace, compact workspace, active
  run, and popout windows.
- Run the existing lint, TypeScript, runtime, worktree, and graph-engine tests
  unchanged.
- Use mocked run data for UI tests and never contact OpenRouter.

## Assumptions

- Spire remains a dark-only desktop application; phone-sized layouts are out of
  scope.
- The main visual weight stays black and grey. Blue and orange remain subtle
  accents rather than large saturated surfaces.
- “Everything granular” applies to functional workspace panes, not individual
  form fields or cards.
- Layouts follow the graph’s stable ID, not an individual graph version or
  repository.
- Agent orchestration, OpenCode behavior, and graph execution semantics remain
  unchanged.
