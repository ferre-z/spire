import { create } from "zustand";
import type { PaneId } from "./paneIds";

export type LayoutCommandId =
  | "move-left"
  | "move-right"
  | "move-up"
  | "move-down"
  | "grow"
  | "shrink"
  | "popout-active"
  | "dock-all"
  | "maximize-active"
  | "reset-layout";

/**
 * Command surface implemented by the WorkspaceLayout host and consumed by
 * the titlebar View menu and the Ctrl/Cmd+K command menu. The host registers
 * its implementation on mount; menus stay decoupled from FlexLayout.
 */
export interface LayoutCommands {
  reopenPane(pane: PaneId): void;
  runCommand(command: LayoutCommandId): void;
  cyclePane(direction: 1 | -1): void;
}

let registered: LayoutCommands | null = null;

export function registerLayoutCommands(commands: LayoutCommands): () => void {
  registered = commands;
  return () => {
    if (registered === commands) registered = null;
  };
}

type LayoutUiState = {
  commandMenuOpen: boolean;
  closedPanes: PaneId[];
  hasActivePane: boolean;
  hasPopouts: boolean;
  isMaximized: boolean;
  setCommandMenuOpen(open: boolean): void;
  setLayoutStatus(status: {
    closedPanes: PaneId[];
    hasActivePane: boolean;
    hasPopouts: boolean;
    isMaximized: boolean;
  }): void;
  reopenPane(pane: PaneId): void;
  runCommand(command: LayoutCommandId): void;
  cyclePane(direction: 1 | -1): void;
};

export const useLayoutStore = create<LayoutUiState>((set) => ({
  commandMenuOpen: false,
  closedPanes: [],
  hasActivePane: false,
  hasPopouts: false,
  isMaximized: false,
  setCommandMenuOpen(commandMenuOpen) {
    set({ commandMenuOpen });
  },
  setLayoutStatus(status) {
    set(status);
  },
  reopenPane(pane) {
    registered?.reopenPane(pane);
  },
  runCommand(command) {
    registered?.runCommand(command);
  },
  cyclePane(direction) {
    registered?.cyclePane(direction);
  },
}));
