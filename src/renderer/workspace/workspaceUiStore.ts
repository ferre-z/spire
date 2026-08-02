import { create } from "zustand";

export const NAVIGATION_DESTINATIONS = [
  "graph-library",
  "run-history",
  "harnesses",
  "collaboration",
] as const;
export type NavigationDestination = (typeof NAVIGATION_DESTINATIONS)[number];

export const DRAWER_DESTINATIONS = ["live-stream", "diff", "result"] as const;
export type DrawerDestination = (typeof DRAWER_DESTINATIONS)[number];

type WorkspaceUiState = {
  activeNavigation: NavigationDestination;
  navigationOpen: boolean;
  contextOpen: boolean;
  drawer?: DrawerDestination;
  commandMenuOpen: boolean;
  openNavigation(destination: NavigationDestination): void;
  setNavigationOpen(open: boolean): void;
  setContextOpen(open: boolean): void;
  openDrawer(destination: DrawerDestination): void;
  closeDrawer(): void;
  setCommandMenuOpen(open: boolean): void;
};

export const useWorkspaceUiStore = create<WorkspaceUiState>((set) => ({
  activeNavigation: "graph-library",
  navigationOpen: false,
  contextOpen: false,
  drawer: undefined,
  commandMenuOpen: false,
  openNavigation(activeNavigation) {
    set({ activeNavigation, navigationOpen: true, contextOpen: false });
  },
  setNavigationOpen(navigationOpen) {
    set({ navigationOpen });
  },
  setContextOpen(contextOpen) {
    set((state) => ({
      contextOpen,
      navigationOpen: contextOpen ? false : state.navigationOpen,
    }));
  },
  openDrawer(drawer) {
    set({ drawer });
  },
  closeDrawer() {
    set({ drawer: undefined });
  },
  setCommandMenuOpen(commandMenuOpen) {
    set({ commandMenuOpen });
  },
}));
