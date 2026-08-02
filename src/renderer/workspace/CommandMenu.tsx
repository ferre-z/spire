import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  Bot,
  GitBranch,
  History,
  Library,
  MessageSquare,
  Play,
  Save,
  Search,
  ScrollText,
} from "lucide-react";
import { useAppStore } from "../store";
import {
  type DrawerDestination,
  type NavigationDestination,
  useWorkspaceUiStore,
} from "./workspaceUiStore";

type CommandItem = {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly icon: ReactNode;
  readonly run: () => void;
};

const NAVIGATION_COMMANDS: readonly {
  readonly id: NavigationDestination;
  readonly label: string;
  readonly icon: ReactNode;
}[] = [
  { id: "graph-library", label: "Graph Library", icon: <Library size={15} /> },
  { id: "run-history", label: "Run History", icon: <History size={15} /> },
  { id: "harnesses", label: "Harnesses", icon: <Bot size={15} /> },
  { id: "collaboration", label: "Collaboration", icon: <MessageSquare size={15} /> },
] as const;

const DRAWER_COMMANDS: readonly {
  readonly id: DrawerDestination;
  readonly label: string;
  readonly icon: ReactNode;
}[] = [
  { id: "live-stream", label: "Live Stream", icon: <Activity size={15} /> },
  { id: "diff", label: "Diff", icon: <GitBranch size={15} /> },
  { id: "result", label: "Result", icon: <ScrollText size={15} /> },
] as const;

export function CommandMenu() {
  const open = useWorkspaceUiStore((state) => state.commandMenuOpen);
  if (!open) return null;
  return <CommandMenuDialog />;
}

function CommandMenuDialog() {
  const setOpen = useWorkspaceUiStore((state) => state.setCommandMenuOpen);
  const openNavigation = useWorkspaceUiStore((state) => state.openNavigation);
  const openDrawer = useWorkspaceUiStore((state) => state.openDrawer);
  const saveCurrentGraph = useAppStore((state) => state.saveCurrentGraph);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const items = useMemo<readonly CommandItem[]>(() => {
    const destinations = NAVIGATION_COMMANDS.map((command) => ({
      id: `navigation-${command.id}`,
      label: `Open ${command.label}`,
      hint: "navigation",
      icon: command.icon,
      run: () => openNavigation(command.id),
    }));
    const drawers = DRAWER_COMMANDS.map((command) => ({
      id: `drawer-${command.id}`,
      label: `Open ${command.label}`,
      hint: "output",
      icon: command.icon,
      run: () => openDrawer(command.id),
    }));
    return [
      ...destinations,
      {
        id: "focus-launch",
        label: "Focus launch goal",
        hint: "launch",
        icon: <Play size={15} />,
        run: () => document.querySelector<HTMLInputElement>("[aria-label='Launch goal']")?.focus(),
      },
      {
        id: "save-version",
        label: "Save graph version",
        hint: "graph",
        icon: <Save size={15} />,
        run: () => void saveCurrentGraph(),
      },
      ...drawers,
    ];
  }, [openDrawer, openNavigation, saveCurrentGraph]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? items.filter((item) => item.label.toLowerCase().includes(needle))
      : items;
  }, [items, query]);
  const activeIndex = Math.min(index, Math.max(filtered.length - 1, 0));

  function execute(item: CommandItem | undefined): void {
    if (!item) return;
    setOpen(false);
    item.run();
  }

  return (
    <div
      className="command-menu-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div className="command-menu" role="dialog" aria-modal="true" aria-label="Spire commands">
        <div className="command-menu-input">
          <Search size={15} />
          <input
            ref={inputRef}
            value={query}
            aria-label="Filter commands"
            placeholder="Type a command…"
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setOpen(false);
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                setIndex((value) => Math.min(value + 1, filtered.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setIndex((value) => Math.max(value - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                execute(filtered[activeIndex]);
              }
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div className="command-menu-list" role="listbox" aria-label="Commands">
          {filtered.length === 0 ? (
            <div className="command-menu-empty">No matching commands.</div>
          ) : (
            filtered.map((item, position) => (
              <button
                type="button"
                key={item.id}
                role="option"
                aria-selected={position === activeIndex}
                className={position === activeIndex ? "is-active" : undefined}
                onMouseEnter={() => setIndex(position)}
                onClick={() => execute(item)}
              >
                {item.icon}
                <span>{item.label}</span>
                <small>{item.hint}</small>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
