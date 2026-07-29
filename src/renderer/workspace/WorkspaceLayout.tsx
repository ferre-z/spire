import { useCallback, useEffect, useRef, useState } from "react";
import {
  Actions,
  DockLocation,
  Layout,
  Model,
  TabNode,
  TabSetNode,
  type Action,
  type IJsonModel,
  type Node as LayoutNode,
} from "flexlayout-react";
import type {
  JsonValue,
  WorkspaceEnvironment,
  WorkspaceLayoutMode,
  WorkspaceLayoutRecord,
} from "../../shared/workspace";
import {
  WORKSPACE_LAYOUT_SCHEMA_VERSION,
  validateWorkspaceLayoutRecord,
} from "../../shared/workspace";
import { useAppStore } from "../store";
import { defaultLayoutForMode, paneTabJson } from "./defaultLayouts";
import { collectPaneIds, sanitizePopoutRects } from "./layoutUtils";
import {
  registerLayoutCommands,
  useLayoutStore,
  type LayoutCommandId,
} from "./layoutStore";
import { PANE_IDS, isPaneId, type PaneId } from "./paneIds";
import { renderPane } from "./panels";
import { CommandMenu } from "./CommandMenu";

const DESKTOP_MIN_WIDTH = 1100;
const SAVE_DEBOUNCE_MS = 300;
const RESIZE_STEP = 10;
const POPOUT_URL = "popout.html";

type WorkspaceState = {
  graphId: string;
  environment: WorkspaceEnvironment;
  records: Partial<Record<WorkspaceLayoutMode, WorkspaceLayoutRecord>>;
  models: Partial<Record<WorkspaceLayoutMode, Model>>;
};

function currentMode(): WorkspaceLayoutMode {
  return window.innerWidth >= DESKTOP_MIN_WIDTH ? "desktop" : "compact";
}

export function WorkspaceLayout() {
  const graph = useAppStore((state) => state.graph)!;
  const setError = useAppStore((state) => state.setError);
  const setLayoutStatus = useLayoutStore((state) => state.setLayoutStatus);
  const [mode, setMode] = useState<WorkspaceLayoutMode>(currentMode);
  const [model, setModel] = useState<Model | null>(null);
  const stateRef = useRef<WorkspaceState | null>(null);
  const pendingSave = useRef<{ mode: WorkspaceLayoutMode; model: Model } | null>(
    null,
  );
  const saveTimer = useRef(0);

  const persist = useCallback(
    (targetMode: WorkspaceLayoutMode, targetModel: Model) => {
      const state = stateRef.current;
      if (!state) return;
      const record: WorkspaceLayoutRecord = {
        graphId: state.graphId,
        mode: targetMode,
        schemaVersion: WORKSPACE_LAYOUT_SCHEMA_VERSION,
        model: targetModel.toJson() as unknown as JsonValue,
        updatedAt: new Date().toISOString(),
      };
      state.records[targetMode] = record;
      window.spire.saveWorkspaceLayout(record).catch((error: unknown) => {
        setError(
          error instanceof Error ? error.message : "Layout save failed.",
        );
      });
    },
    [setError],
  );

  const flushSave = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    const pending = pendingSave.current;
    if (pending) {
      pendingSave.current = null;
      persist(pending.mode, pending.model);
    }
  }, [persist]);

  const scheduleSave = useCallback(
    (targetMode: WorkspaceLayoutMode, targetModel: Model) => {
      pendingSave.current = { mode: targetMode, model: targetModel };
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        const pending = pendingSave.current;
        if (pending) {
          pendingSave.current = null;
          persist(pending.mode, pending.model);
        }
      }, SAVE_DEBOUNCE_MS);
    },
    [persist],
  );

  const buildModel = useCallback((targetMode: WorkspaceLayoutMode): Model => {
    const state = stateRef.current;
    const fallback = () =>
      Model.fromJson(defaultLayoutForMode(targetMode) as unknown as IJsonModel);
    if (!state) return fallback();
    const cached = state.models[targetMode];
    if (cached) return cached;
    let built: Model | null = null;
    const record = state.records[targetMode];
    if (record) {
      // Corrupt or outdated payloads fall back to defaults without
      // blocking startup.
      const validation = validateWorkspaceLayoutRecord(record);
      if (validation.ok) {
        try {
          const sanitized = sanitizePopoutRects(validation.record.model, {
            isWayland: state.environment.isWayland,
          });
          built = Model.fromJson(sanitized as unknown as IJsonModel);
        } catch {
          built = null;
        }
      }
    }
    const result = built ?? fallback();
    state.models[targetMode] = result;
    return result;
  }, []);

  // Load layouts when the active graph changes: flush the previous graph's
  // pending save, close its live popouts, then restore the target graph.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      flushSave();
      const previous = stateRef.current;
      if (previous) {
        for (const entry of Object.values(previous.models)) {
          closePopoutWindows(entry);
        }
      }
      stateRef.current = null;
      setModel(null);
      try {
        const [environment, records] = await Promise.all([
          window.spire.environment(),
          window.spire.loadWorkspaceLayouts(graph.id),
        ]);
        if (cancelled) return;
        const indexed: WorkspaceState["records"] = {};
        for (const record of records) {
          indexed[record.mode] = record;
        }
        stateRef.current = {
          graphId: graph.id,
          environment,
          records: indexed,
          models: {},
        };
        setModel(buildModel(currentMode()));
      } catch (error) {
        if (cancelled) return;
        setError(
          error instanceof Error
            ? error.message
            : "Workspace layout failed to load.",
        );
        stateRef.current = {
          graphId: graph.id,
          environment: { platform: "unknown", isWayland: false },
          records: {},
          models: {},
        };
        setModel(buildModel(currentMode()));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [graph.id, buildModel, flushSave, setError]);

  // Track the desktop/compact breakpoint. Each mode keeps its own persisted
  // model; crossing the breakpoint saves the current mode and restores the
  // other without overwriting either.
  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${DESKTOP_MIN_WIDTH}px)`);
    const onChange = (event: MediaQueryListEvent) => {
      flushSave();
      setMode(event.matches ? "desktop" : "compact");
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [flushSave]);

  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    flushSave();
    setModel(buildModel(mode));
  }, [mode, buildModel, flushSave]);

  // Flush pending saves before application shutdown.
  useEffect(() => {
    const onUnload = () => flushSave();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [flushSave]);

  const publishStatus = useCallback(
    (target: Model) => {
      const open = collectPaneIds(target.toJson());
      const activeTabset = target.getActiveTabset();
      setLayoutStatus({
        closedPanes: PANE_IDS.filter((id) => !open.has(id)),
        hasActivePane: Boolean(activeTabset?.getSelectedNode()),
        hasPopouts: target.getwindowsMap().size > 1,
        isMaximized: Boolean(target.getMaximizedTabset()),
      });
    },
    [setLayoutStatus],
  );

  // Popouts that failed to open (window.open denied) keep their tabs in a
  // windowless popout node; dock them back and surface a non-blocking error.
  const recoverFailedPopouts = useCallback(
    (target: Model) => {
      const failed: string[] = [];
      for (const [windowId, layoutWindow] of target.getwindowsMap()) {
        if (windowId === Model.MAIN_WINDOW_ID) continue;
        if (layoutWindow.window && !layoutWindow.window.closed) continue;
        failed.push(windowId);
      }
      for (const windowId of failed) {
        const layoutWindow = target.getwindowsMap().get(windowId);
        if (!layoutWindow) continue;
        const tabs: string[] = [];
        layoutWindow.visitNodes((node) => {
          if (node instanceof TabNode) tabs.push(node.getId());
        });
        const destination = firstTabSet(target);
        if (destination) {
          for (const tabId of tabs) {
            target.doAction(
              Actions.moveNode(tabId, destination.getId(), DockLocation.CENTER, -1, true),
            );
          }
        }
        target.doAction(Actions.closeWindow(windowId));
        setError("A popout window could not be opened; its pane stays docked.");
      }
    },
    [setError],
  );

  const handleModelChange = useCallback(
    (changed: Model, action: Action) => {
      scheduleSave(mode, changed);
      publishStatus(changed);
      const type = action.type;
      if (
        type === Actions.POPOUT_TAB ||
        type === Actions.POPOUT_TABSET ||
        type === Actions.CREATE_WINDOW
      ) {
        window.setTimeout(() => {
          recoverFailedPopouts(changed);
          publishStatus(changed);
        }, 250);
      }
    },
    [mode, scheduleSave, publishStatus, recoverFailedPopouts],
  );

  // Verify restored popouts actually opened once the layout has mounted.
  useEffect(() => {
    if (!model) return;
    publishStatus(model);
    const timer = window.setTimeout(() => {
      recoverFailedPopouts(model);
      publishStatus(model);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [model, publishStatus, recoverFailedPopouts]);

  const findDirectionalTabSet = useCallback(
    (target: Model, direction: "left" | "right" | "up" | "down") => {
      const active = target.getActiveTabset();
      if (!active) return undefined;
      const origin = active.getRect();
      const ox = origin.x + origin.width / 2;
      const oy = origin.y + origin.height / 2;
      let best: TabSetNode | undefined;
      let bestDistance = Number.POSITIVE_INFINITY;
      target.visitNodes((node) => {
        if (!(node instanceof TabSetNode) || node.getId() === active.getId()) {
          return;
        }
        const rect = node.getRect();
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;
        const dx = cx - ox;
        const dy = cy - oy;
        const aligned =
          (direction === "left" && dx < -1 && Math.abs(dx) >= Math.abs(dy)) ||
          (direction === "right" && dx > 1 && Math.abs(dx) >= Math.abs(dy)) ||
          (direction === "up" && dy < -1 && Math.abs(dy) > Math.abs(dx)) ||
          (direction === "down" && dy > 1 && Math.abs(dy) > Math.abs(dx));
        if (!aligned) return;
        const distance = Math.hypot(dx, dy);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = node;
        }
      });
      return best;
    },
    [],
  );

  const runCommand = useCallback(
    (command: LayoutCommandId) => {
      const target = stateRef.current?.models[mode];
      if (!target) return;
      const activeTabset = target.getActiveTabset();
      const activeTab = activeTabset?.getSelectedNode();
      switch (command) {
        case "move-left":
        case "move-right":
        case "move-up":
        case "move-down": {
          if (!activeTab) break;
          const direction = command.slice(5) as "left" | "right" | "up" | "down";
          const destination = findDirectionalTabSet(target, direction);
          if (destination) {
            target.doAction(
              Actions.moveNode(
                activeTab.getId(),
                destination.getId(),
                DockLocation.CENTER,
                -1,
                true,
              ),
            );
          }
          break;
        }
        case "grow":
        case "shrink": {
          if (!activeTabset) break;
          const delta = command === "grow" ? RESIZE_STEP : -RESIZE_STEP;
          const weight = Math.min(
            95,
            Math.max(5, activeTabset.getWeight() + delta),
          );
          target.doAction(
            Actions.updateNodeAttributes(activeTabset.getId(), { weight }),
          );
          break;
        }
        case "popout-active": {
          if (activeTab) target.doAction(Actions.popoutTab(activeTab.getId()));
          break;
        }
        case "dock-all": {
          for (const windowId of target.getwindowsMap().keys()) {
            if (windowId !== Model.MAIN_WINDOW_ID) {
              target.doAction(Actions.closeWindow(windowId));
            }
          }
          break;
        }
        case "maximize-active": {
          if (activeTabset) {
            target.doAction(Actions.maximizeToggle(activeTabset.getId()));
          }
          break;
        }
        case "reset-layout": {
          const state = stateRef.current;
          if (!state) break;
          for (const entry of Object.values(state.models)) {
            closePopoutWindows(entry);
          }
          state.records = {};
          state.models = {};
          void window.spire.resetWorkspaceLayouts(state.graphId).catch(() => {
            setError("Layout reset failed to persist.");
          });
          setModel(buildModel(mode));
          break;
        }
      }
    },
    [mode, buildModel, findDirectionalTabSet, setError],
  );

  const reopenPane = useCallback(
    (pane: PaneId) => {
      const target = stateRef.current?.models[mode];
      if (!target) return;
      const existing = target.getNodeById(pane);
      if (existing instanceof TabNode) {
        target.doAction(Actions.selectTab(existing.getId()));
        const parent = existing.getParent();
        if (parent instanceof TabSetNode) {
          target.doAction(Actions.setActiveTabset(parent.getId()));
        }
        return;
      }
      const destination = target.getActiveTabset() ?? firstTabSet(target);
      if (!destination) return;
      target.doAction(
        Actions.addNode(
          paneTabJson(pane),
          destination.getId(),
          DockLocation.CENTER,
          -1,
          true,
        ),
      );
    },
    [mode],
  );

  const cyclePane = useCallback(
    (direction: 1 | -1) => {
      const target = stateRef.current?.models[mode];
      if (!target) return;
      const tabsets: TabSetNode[] = [];
      target.visitNodes((node) => {
        if (node instanceof TabSetNode) tabsets.push(node);
      });
      const tabs = tabsets.flatMap((tabset) =>
        (tabset.getChildren() as LayoutNode[])
          .filter((node): node is TabNode => node instanceof TabNode)
          .map((node) => node),
      );
      if (tabs.length === 0) return;
      const activeTab = target.getActiveTabset()?.getSelectedNode();
      const index = activeTab
        ? tabs.findIndex((tab) => tab.getId() === activeTab.getId())
        : -1;
      const next =
        tabs[(index + direction + tabs.length) % tabs.length] ?? tabs[0];
      target.doAction(Actions.selectTab(next.getId()));
      const parent = next.getParent();
      if (parent instanceof TabSetNode) {
        target.doAction(Actions.setActiveTabset(parent.getId()));
      }
    },
    [mode],
  );

  // Publish the command surface for the View menu and command menu.
  useEffect(
    () => registerLayoutCommands({ reopenPane, runCommand, cyclePane }),
    [reopenPane, runCommand, cyclePane],
  );

  // Keyboard: F6 / Shift+F6 cycles panes, Ctrl/Cmd+K opens the command menu.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "F6") {
        event.preventDefault();
        cyclePane(event.shiftKey ? -1 : 1);
        return;
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        useLayoutStore.getState().setCommandMenuOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cyclePane]);

  const factory = useCallback((node: TabNode) => {
    const component = node.getComponent();
    if (isPaneId(component)) return renderPane(component);
    return <div className="pane pane-empty">Unknown pane: {component}</div>;
  }, []);

  if (!model) {
    return (
      <div className="app-loading">
        <div className="spire-loader">
          <span />
          <span />
          <span />
        </div>
      </div>
    );
  }

  return (
    <div className="workspace-dock" data-layout-mode={mode}>
      <Layout
        model={model}
        factory={factory}
        onModelChange={handleModelChange}
        supportsPopout
        popoutURL={POPOUT_URL}
        realtimeResize
      />
      <CommandMenu />
    </div>
  );
}

function firstTabSet(model: Model): TabSetNode | undefined {
  try {
    return model.getFirstTabSet();
  } catch {
    return undefined;
  }
}

function closePopoutWindows(model: Model): void {
  for (const [windowId, layoutWindow] of model.getwindowsMap()) {
    if (windowId === Model.MAIN_WINDOW_ID) continue;
    try {
      layoutWindow.window?.close();
    } catch {
      // The window may already be gone; nothing to close.
    }
  }
}
