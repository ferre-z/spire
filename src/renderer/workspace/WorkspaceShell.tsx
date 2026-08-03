import { useEffect } from "react";
import {
  Activity,
  GitBranch,
  ScrollText,
  Settings2,
} from "lucide-react";
import { Drawer, RailItem, SegmentedControl, ToolCard } from "../components/UiPrimitives";
import { GraphCanvasPane } from "../panes/GraphCanvasPane";
import { GraphSettingsPane } from "../panes/GraphSettingsPane";
import { RuntimePolicyPane } from "../panes/RuntimePolicyPane";
import { TaskLauncherPane } from "../panes/TaskLauncherPane";
import { NodeDialog } from "../node-dialog/NodeDialog";
import { CommandMenu } from "./CommandMenu";
import {
  DRAWER_LABELS,
  NAVIGATION_ITEMS,
  PanelHeader,
  SelectedRunSummary,
  navigationTitle,
  renderDrawer,
  renderNavigation,
} from "./WorkspacePanels";
import {
  DRAWER_DESTINATIONS,
  useWorkspaceUiStore,
} from "./workspaceUiStore";

export function WorkspaceShell() {
  const activeNavigation = useWorkspaceUiStore((state) => state.activeNavigation);
  const navigationOpen = useWorkspaceUiStore((state) => state.navigationOpen);
  const contextOpen = useWorkspaceUiStore((state) => state.contextOpen);
  const drawer = useWorkspaceUiStore((state) => state.drawer);
  const openNavigation = useWorkspaceUiStore((state) => state.openNavigation);
  const setNavigationOpen = useWorkspaceUiStore((state) => state.setNavigationOpen);
  const setContextOpen = useWorkspaceUiStore((state) => state.setContextOpen);
  const openDrawer = useWorkspaceUiStore((state) => state.openDrawer);
  const closeDrawer = useWorkspaceUiStore((state) => state.closeDrawer);
  const setCommandMenuOpen = useWorkspaceUiStore((state) => state.setCommandMenuOpen);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandMenuOpen(true);
        return;
      }
      if (event.key === "Escape") {
        closeDrawer();
        setNavigationOpen(false);
        setContextOpen(false);
        return;
      }
      if (event.key !== "F6") return;
      event.preventDefault();
      const regions = [...document.querySelectorAll<HTMLElement>("[data-major-region]")];
      if (regions.length === 0) return;
      const current = regions.findIndex((region) => region === document.activeElement);
      const delta = event.shiftKey ? -1 : 1;
      const nextIndex = current < 0
        ? event.shiftKey
          ? regions.length - 1
          : 0
        : (current + delta + regions.length) % regions.length;
      regions[nextIndex]?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeDrawer, setCommandMenuOpen, setContextOpen, setNavigationOpen]);

  return (
    <div className="workspace-shell">
      <nav
        className="activity-rail major-region"
        aria-label="Activity destinations"
        data-major-region
        tabIndex={-1}
      >
        {NAVIGATION_ITEMS.map((item) => (
          <RailItem
            key={item.id}
            label={item.label}
            text={item.label}
            current={activeNavigation === item.id}
            onClick={() => openNavigation(item.id)}
          >
            {item.icon}
          </RailItem>
        ))}
      </nav>

      <aside
        className={`navigation-panel major-region ${navigationOpen ? "is-open" : ""}`}
        aria-label="Graph navigation"
        data-major-region
        tabIndex={-1}
      >
        <PanelHeader eyebrow="NAVIGATION" title={navigationTitle(activeNavigation)} />
        <div className="workspace-scroll">{renderNavigation(activeNavigation)}</div>
      </aside>

      <section
        className="canvas-region major-region"
        aria-label="Graph canvas"
        data-major-region
        tabIndex={-1}
      >
        <GraphCanvasPane />
      </section>

      <aside
        className={`context-panel major-region ${contextOpen ? "is-open" : ""}`}
        aria-label="Graph context"
        data-major-region
        tabIndex={-1}
      >
        <PanelHeader eyebrow="CONTEXT" title="Graph controls" />
        <div className="context-scroll">
          <ToolCard title="Graph Settings"><GraphSettingsPane /></ToolCard>
          <ToolCard title="Runtime Policy"><RuntimePolicyPane /></ToolCard>
          <SelectedRunSummary />
        </div>
      </aside>

      <nav
        className="utility-rail major-region"
        aria-label="Output utilities"
        data-major-region
        tabIndex={-1}
      >
        <RailItem label="Context" onClick={() => setContextOpen(true)}>
          <Settings2 size={18} />
        </RailItem>
        <span className="utility-spacer" />
        <RailItem label="Live Stream" current={drawer === "live-stream"} onClick={() => openDrawer("live-stream")}>
          <Activity size={18} />
        </RailItem>
        <RailItem label="Diff" current={drawer === "diff"} onClick={() => openDrawer("diff")}>
          <GitBranch size={18} />
        </RailItem>
        <RailItem label="Result" current={drawer === "result"} onClick={() => openDrawer("result")}>
          <ScrollText size={18} />
        </RailItem>
      </nav>

      <section
        className="launch-dock major-region"
        aria-label="Launch graph"
        data-major-region
        tabIndex={-1}
      >
        <TaskLauncherPane />
      </section>

      <button
        type="button"
        className={`responsive-scrim ${navigationOpen || contextOpen ? "is-visible" : ""}`}
        aria-label="Close workspace panel"
        onClick={() => {
          setNavigationOpen(false);
          setContextOpen(false);
        }}
      />

      <Drawer
        open={drawer !== undefined}
        title={drawer ? DRAWER_LABELS[drawer] : "Output"}
        onClose={closeDrawer}
        controls={drawer ? (
          <SegmentedControl
            label="Output view"
            value={drawer}
            options={DRAWER_DESTINATIONS.map((id) => ({ id, label: DRAWER_LABELS[id] }))}
            onChange={openDrawer}
          />
        ) : undefined}
      >
        {drawer ? renderDrawer(drawer) : null}
      </Drawer>
      <CommandMenu />
      <NodeDialog />
    </div>
  );
}
