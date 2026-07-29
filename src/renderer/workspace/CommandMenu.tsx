import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  ExternalLink,
  LayoutGrid,
  Maximize2,
  PictureInPicture2,
  Search,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { PANE_META } from "./paneIds";
import { useLayoutStore, type LayoutCommandId } from "./layoutStore";

type CommandItem = {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
};

export function CommandMenu() {
  const open = useLayoutStore((state) => state.commandMenuOpen);
  if (!open) return null;
  return <CommandMenuDialog />;
}

function CommandMenuDialog() {
  const setOpen = useLayoutStore((state) => state.setCommandMenuOpen);
  const closedPanes = useLayoutStore((state) => state.closedPanes);
  const hasActivePane = useLayoutStore((state) => state.hasActivePane);
  const hasPopouts = useLayoutStore((state) => state.hasPopouts);
  const isMaximized = useLayoutStore((state) => state.isMaximized);
  const reopenPane = useLayoutStore((state) => state.reopenPane);
  const runCommand = useLayoutStore((state) => state.runCommand);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const items = useMemo<CommandItem[]>(() => {
    const list: CommandItem[] = [];
    for (const pane of closedPanes) {
      list.push({
        id: `reopen-${pane}`,
        label: `Reopen ${PANE_META[pane].title}`,
        hint: "pane",
        icon: <LayoutGrid size={15} />,
        run: () => reopenPane(pane),
      });
    }
    if (hasActivePane) {
      const moves: Array<[LayoutCommandId, string, React.ReactNode]> = [
        ["move-left", "Move active pane left", <ArrowLeftToLine size={15} />],
        ["move-right", "Move active pane right", <ArrowRightToLine size={15} />],
        ["move-up", "Move active pane up", <ArrowUpToLine size={15} />],
        ["move-down", "Move active pane down", <ArrowDownToLine size={15} />],
        ["grow", "Resize active pane larger", <ZoomIn size={15} />],
        ["shrink", "Resize active pane smaller", <ZoomOut size={15} />],
      ];
      for (const [command, label, icon] of moves) {
        list.push({
          id: command,
          label,
          hint: "layout",
          icon,
          run: () => runCommand(command),
        });
      }
      list.push({
        id: "popout-active",
        label: "Pop out active pane",
        hint: "window",
        icon: <PictureInPicture2 size={15} />,
        run: () => runCommand("popout-active"),
      });
      list.push({
        id: "maximize-active",
        label: isMaximized ? "Restore active pane" : "Maximize active pane",
        hint: "layout",
        icon: <Maximize2 size={15} />,
        run: () => runCommand("maximize-active"),
      });
    }
    if (hasPopouts) {
      list.push({
        id: "dock-all",
        label: "Dock all popouts back",
        hint: "window",
        icon: <ExternalLink size={15} />,
        run: () => runCommand("dock-all"),
      });
    }
    list.push({
      id: "reset-layout",
      label: "Reset layout to defaults",
      hint: "layout",
      icon: <LayoutGrid size={15} />,
      run: () => runCommand("reset-layout"),
    });
    return list;
  }, [closedPanes, hasActivePane, hasPopouts, isMaximized, reopenPane, runCommand]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) => item.label.toLowerCase().includes(needle));
  }, [items, query]);

  const activeIndex = Math.min(index, Math.max(filtered.length - 1, 0));

  function execute(item: CommandItem | undefined) {
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
      <div className="command-menu glass" role="dialog" aria-label="Layout commands">
        <div className="command-menu-input">
          <Search size={15} />
          <input
            ref={inputRef}
            value={query}
            placeholder="Layout command…"
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
        <div className="command-menu-list" role="listbox">
          {filtered.length === 0 ? (
            <div className="command-menu-empty">No matching commands.</div>
          ) : (
            filtered.map((item, position) => (
              <button
                key={item.id}
                role="option"
                aria-selected={position === activeIndex}
                className={`command-menu-item ${position === activeIndex ? "active" : ""}`}
                onMouseEnter={() => setIndex(position)}
                onClick={() => execute(item)}
              >
                {item.icon}
                <span>{item.label}</span>
                {item.hint && <small>{item.hint}</small>}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
