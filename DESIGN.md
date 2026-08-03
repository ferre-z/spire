# Spire Renderer Design Contract

## 0. Direction and scope

Spire is a dense, local-first orchestration workbench. The renderer uses quiet charcoal layers, crisp borders, and two semantic accents: blue for selection/input/navigation and orange for execution/output. It is deliberately solid and technical: no glass, liquid, glow, gradient wash, floating decoration, or ornamental motion.

This contract covers onboarding, the fixed workspace shell, graph canvas, reusable controls, overlays, and dialogs.

## 1. Foundations

### Color

| Token | Value | Use |
| --- | --- | --- |
| `--surface-root` | `#0A0B0E` | App background |
| `--surface-rail` | `#0D0F13` | Rails and titlebar |
| `--surface-panel` | `#101216` | Navigation and context panels |
| `--surface-raised` | `#14161B` | Cards, fields, menus, drawers |
| `--surface-active` | `#1A1D24` | Selected and pressed controls |
| `--border` | `#23262E` | Dividers and control outlines |
| `--text-primary` | `#E9EBF1` | Primary copy |
| `--text-secondary` | `#A0A7B4` | Secondary copy |
| `--text-muted` | `#6D7482` | Metadata and disabled copy |
| `--accent-navigation` | `#6EA8FE` | Input focus, selection, navigation |
| `--accent-execution` | `#FF8A3D` | Run actions, execution, output |

Tinted semantic surfaces are mixed from the relevant accent with a charcoal surface; they never emit glow or bloom.

Active renderer CSS consumes semantic aliases for interactive borders, selected surfaces, execution button states, status borders/text, scrims, and neutral shadows. Component rules do not introduce raw color literals outside the root token block. Layout geometry, spacing, and typography use named scale and shell-dimension tokens whenever values repeat across primitives or breakpoints.

Canvas-specific aliases are `--canvas-grid-dot`, `--canvas-edge-idle`, `--canvas-minimap-node`, and `--canvas-minimap-mask`. Canvas geometry uses `--canvas-node-width`, `--canvas-node-height`, `--canvas-group-padding`, `--canvas-group-header-height`, and `--canvas-minimap-width`. Expanded groups add 32px token-aligned containment around member bounds and reserve a 40px header; ReactFlow receives parent-relative child coordinates while the graph persists absolute coordinates. Edge labels use canvas type, spacing, radius, and motion tokens rather than inline visual values. Incoming handles and selection use navigation blue; outgoing handles, active connections, and execution borders use execution orange.

### Typography

Inter Variable is the interface face. JetBrains Mono Variable is reserved for identifiers, status metadata, key hints, and output. Body copy is 13px/1.45; labels are 11px/1.2 with modest tracking; pane headings are 14px/1.3; onboarding headings use a restrained responsive 28–36px scale.

### Spacing, shape, and elevation

Spacing follows a 4px base unit. Common increments are 4, 8, 12, 16, 20, 24, and 32px. Radii are exactly 4px for compact controls/status, 6px for fields/buttons/cards, 8px for menus/panels, and 10px for drawers/dialogs.

Interactive controls use the named 36px control-height token and the 44px coarse-pointer target token. NodeDialog viewport geometry, minimum/maximum bounds, textarea minimum height, shadow blur, type leading/tracking, and compact inset are named root tokens so its responsive rules contain no one-off spacing, type, radius, or motion literals.

Elevation is structural, not luminous:

1. `z-0` canvas/content
2. `z-10` fixed rails and dock
3. `z-20` responsive panel overlays
4. `z-30` drawer scrim and drawer
5. `z-40` command menu and modal dialog
6. `z-50` toast

Raised layers use solid fills, a 1px border, and at most a short neutral shadow.

## 2. Fixed workspace geometry

The application owns the viewport and never scrolls the document. Every panel uses `min-width: 0`, `min-height: 0`, and an explicit bounded scroll area.

- At 1280px and wider, the grid is `56px 248px minmax(0, 1fr) 312px 52px` for activity rail, active navigation panel, canvas, context panel, and utility rail.
- From 1100–1279px, the context panel becomes an overlay opened from the utility rail.
- From 800–1099px, both navigation and context panels become overlays opened from their rails.
- The 64px launch dock persists below the content grid at every supported width.
- The minimal titlebar remains Electron-draggable; interactive children opt out of drag.

Activity destinations are Graph Library, Run History, Harnesses, and Collaboration. Context cards are Graph Settings, Runtime Policy, and selected-run status. Utility destinations open a 440px drawer for Live Stream, Diff, or Result. The graph canvas is always the central workspace and its behavior is unchanged.

## 3. Interaction and motion

Color/background/border tints transition in 120ms. Overlay transform and opacity transition in 180ms. No other properties animate. Motion indicates hover/focus/selection, overlay entrance, or busy state only.

`prefers-reduced-motion: reduce` disables transitions and animation. Focus indicators use the navigation blue and remain visible on every charcoal layer.

Cmd/Ctrl+K opens commands for fixed destinations, launch focus, save version, and each output drawer. F6 cycles major regions in logical order; Shift+F6 cycles backward. The active region receives a visible blue inset marker without moving content.

## 4. Accessibility constraints

- Icon-only controls require an accessible name and visible tooltip via `title`.
- Rail destinations expose current selection with `aria-current`.
- Onboarding harnesses and models are labeled radio groups with real radio inputs.
- Disabled choices remain readable and explain installed, compatible, and connected status.
- Drawers and command menus are labeled dialogs, close on Escape, restore focus, and use a scrim.
- Logical DOM order follows titlebar, activity, navigation, canvas, context, utility, launch dock, then overlays.
- Color is never the sole carrier of readiness or status.

## 5. Reusable primitives and states

### `IconButton`

Square icon action. States: default, hover, focus-visible, active/pressed, disabled. Sizes use 28, 32, or 36px footprints. A label and tooltip are mandatory.

### `RailItem`

Vertical destination control composed from `IconButton` anatomy plus an optional short label. States: default, hover, focus-visible, current, disabled. Current uses a blue edge marker and tinted background.

### `ToolCard`

Solid raised container for a named tool or status summary. States: default, hover when interactive, focus-visible, selected, disabled, loading, empty, and error. Tool cards never float or glow.

### `Field`

Labeled input/select wrapper with optional hint and error. States: default, hover, focus-within, disabled, invalid, loading, and read-only.

### `SegmentedControl`

Single-choice control with shared border. States: default, hover, focus-visible, selected, and disabled. Navigation selection uses blue; execution filters may use orange.

### `StatusBadge`

Compact text status with optional icon/dot. States: neutral, ready/success, warning/running, error, disconnected, and loading. Labels always accompany color.

### `Drawer`

Right-side 440px overlay with scrim, labeled header, close action, bounded body scroll, and optional footer. States: closed, opening, open, and closing. Only transform and opacity animate for 180ms.

### `NodeDialog`

Centered modal for later node editing. Anatomy: title/description, bounded form body, cancel and primary actions. States: create, edit, submitting, validation error, backend error, and destructive confirmation. It shares the drawer scrim and z-40 modal layer. Implementation is intentionally deferred.

### `CanvasNode` and `NodeToolCluster`

`CanvasNode` is a memoized neutral raised surface with compact kind icon, name, description, runtime metadata, and a text-plus-icon execution marker. States: default, hover, selected, running, selected-running, collapsed group, success, waiting, and failure. Names and model identifiers truncate safely without changing node geometry. Group containers bound their descendants, expose a named expand/collapse button, and hide collapsed descendants plus incident edges. `NodeToolCluster` is a vertical group of five 32px icon buttons for agent, decision, checkpoint, subgraph, and group creation. Each button has a visible native tooltip, accessible name, focus state, disabled state, and per-action loading state.

## 6. Onboarding flow

On mount, Spire probes all supported local harnesses: OpenCode, Codex, and Claude Code. Stage one shows skeleton rows while probing, then installed, compatible, and connected status for every harness. Only connected harnesses are selectable. When none are ready, the primary recovery action is Re-scan; authentication remains CLI-owned and the UI contains no credential language or fields.

Selecting a connected harness starts stage two and loads that harness's models. Stage two has explicit loading, empty, and error states. A model must be selected before Enter Spire is enabled. Submission calls `completeOnboarding({ harnessId, modelId })` and applies the returned snapshot.

## 7. Responsive and content rules

Navigation and context overlays retain the same content and accessible names as their wide-layout counterparts. Overlay triggers live on persistent rails so no feature disappears at a breakpoint. Text truncates only for identifiers/paths; goals and errors wrap. All list, pane, drawer, and menu bodies are independently scrollable without horizontal overflow.

## 8. Accepted debt and handoff

- NodeDialog is specified but deferred to the node-modal slice.
- Legacy FlexLayout/layout persistence modules may remain temporarily, but the active renderer must not import or invoke them.
- React diagnostics use a development-only `import.meta.env.DEV` dynamic import so production has no initialization side effect or runtime dependency.
