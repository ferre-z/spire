import { dialog, ipcMain, shell } from "electron";
import { writeFile } from "node:fs/promises";
import type { BrowserWindow } from "electron";
import { IPC } from "../shared/api";
import type {
  GraphDefinition,
  ProviderInput,
  RunEvent,
  StartRunInput,
} from "../shared/domain";
import type { WorkspaceEnvironment } from "../shared/workspace";
import type { SpireControl } from "./control/spire-control";

export function detectEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): WorkspaceEnvironment {
  return {
    platform,
    isWayland:
      env.XDG_SESSION_TYPE === "wayland" || Boolean(env.WAYLAND_DISPLAY),
  };
}

/**
 * Electron IPC adapter over the control plane.
 *
 * Every renderer operation dispatches exactly one registered control
 * capability through `SpireControl.execute()` (input validation failures
 * surface as IPC errors). The only exceptions are composed flows whose extra
 * steps are Electron-only or facade concerns: repository selection (native
 * open dialog, then `repositories.validate`), patch export
 * (`runs.artifacts.get`, then a native save dialog), shell/environment
 * operations that have no control capability, and onboarding
 * (`control.connectOpenRouter`). Mutations that the renderer contract answers
 * with an `AppSnapshot` compose it via `control.snapshot()` — the same body
 * as `state.get` — so each handler still dispatches a single capability.
 *
 * Returns an unsubscribe for the trace forwarding subscription.
 */
export function registerIpc(
  control: SpireControl,
  getWindow: () => BrowserWindow | null,
): () => void {
  ipcMain.handle(IPC.snapshot, () => control.execute("state.get"));
  ipcMain.handle(IPC.detectOpenCode, async () => {
    await control.execute("harnesses.list");
    return control.snapshot();
  });
  ipcMain.handle(IPC.connectOpenRouter, (_event, input: ProviderInput) =>
    control.connectOpenRouter(input),
  );
  ipcMain.handle(IPC.chooseRepository, async () => {
    const window = getWindow();
    const options: Electron.OpenDialogOptions = {
      properties: ["openDirectory"],
      title: "Choose a Git repository",
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled) return null;
    const validation = await control.execute("repositories.validate", {
      path: result.filePaths[0],
    });
    return validation.ok ? validation.path : null;
  });
  ipcMain.handle(IPC.saveGraph, async (_event, graph: GraphDefinition) => {
    await control.execute("graphs.save", { graph });
    return control.snapshot();
  });
  ipcMain.handle(IPC.startRun, async (_event, input: StartRunInput) => {
    await control.execute("runs.start", input);
    return control.snapshot();
  });
  ipcMain.handle(IPC.stopRun, async (_event, runId: string) => {
    await control.execute("runs.stop", { runId });
    return control.snapshot();
  });
  ipcMain.handle(IPC.retryRun, async (_event, runId: string) => {
    await control.execute("runs.retry", { runId });
    return control.snapshot();
  });
  ipcMain.handle(IPC.openExternal, async (_event, target: string) => {
    const url = new URL(target);
    if (url.protocol !== "https:" || url.hostname !== "opencode.ai") {
      throw new Error("External URL is not allowed.");
    }
    await shell.openExternal(url.toString());
  });
  ipcMain.handle(IPC.revealPath, async (_event, targetPath: string) => {
    const result = await shell.openPath(targetPath);
    if (result) throw new Error(result);
  });
  ipcMain.handle(IPC.exportPatch, async (_event, runId: string) => {
    const artifacts = await control.execute("runs.artifacts.get", { runId });
    const options: Electron.SaveDialogOptions = {
      title: "Export patch",
      defaultPath: `spire-${runId.slice(0, 8)}.patch`,
      filters: [{ name: "Patch", extensions: ["patch", "diff"] }],
    };
    const window = getWindow();
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, artifacts.diff, "utf8");
    return result.filePath;
  });
  ipcMain.handle(IPC.cleanupWorktree, async (_event, runId: string) => {
    await control.execute("worktrees.cleanup", { runId });
    return control.snapshot();
  });
  ipcMain.handle(IPC.loadWorkspaceLayouts, (_event, graphId: string) =>
    control.execute("layouts.list", { graphId }),
  );
  ipcMain.handle(IPC.saveWorkspaceLayout, (_event, record: unknown) => {
    // The renderer does not await layout saves; layouts.save is synchronous,
    // so execute() throws validation errors synchronously to the renderer.
    // Log async failures instead of leaving an unhandled rejection.
    void control.execute("layouts.save", record).catch((error: unknown) => {
      console.error("layouts.save failed:", error);
    });
  });
  ipcMain.handle(IPC.resetWorkspaceLayouts, (_event, graphId: string) => {
    void control.execute("layouts.reset", { graphId }).catch((error: unknown) => {
      console.error("layouts.reset failed:", error);
    });
  });
  ipcMain.handle(IPC.environment, () => detectEnvironment());

  // Forward trace notifications to the renderer through one dedicated,
  // allowlisted channel.
  return control.subscribe((event) => {
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    window.webContents.send(IPC.traceEvent, event);
  });
}

export function sendRunEvent(
  window: BrowserWindow | null,
  event: RunEvent,
): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.send(IPC.runEvent, event);
}
