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
import type { AppService } from "./app-service";

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

export function registerIpc(
  service: AppService,
  getWindow: () => BrowserWindow | null,
): void {
  ipcMain.handle(IPC.snapshot, () => service.snapshot());
  ipcMain.handle(IPC.detectOpenCode, () => service.detectOpenCode());
  ipcMain.handle(
    IPC.connectOpenRouter,
    (_event, input: ProviderInput) => service.connectOpenRouter(input),
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
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle(IPC.saveGraph, (_event, graph: GraphDefinition) =>
    service.saveGraph(graph),
  );
  ipcMain.handle(IPC.startRun, (_event, input: StartRunInput) =>
    service.startRun(input),
  );
  ipcMain.handle(IPC.stopRun, (_event, runId: string) =>
    service.stopRun(runId),
  );
  ipcMain.handle(IPC.retryRun, (_event, runId: string) =>
    service.retryRun(runId),
  );
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
    const run = service.getRun(runId);
    if (!run?.artifacts) throw new Error("No patch is available.");
    const options: Electron.SaveDialogOptions = {
      title: "Export patch",
      defaultPath: `spire-${run.id.slice(0, 8)}.patch`,
      filters: [{ name: "Patch", extensions: ["patch", "diff"] }],
    };
    const window = getWindow();
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, run.artifacts.diff, "utf8");
    return result.filePath;
  });
  ipcMain.handle(IPC.cleanupWorktree, (_event, runId: string) =>
    service.cleanupWorktree(runId),
  );
  ipcMain.handle(IPC.loadWorkspaceLayouts, (_event, graphId: string) =>
    service.listWorkspaceLayouts(graphId),
  );
  ipcMain.handle(IPC.saveWorkspaceLayout, (_event, record: unknown) => {
    service.saveWorkspaceLayout(record);
  });
  ipcMain.handle(IPC.resetWorkspaceLayouts, (_event, graphId: string) => {
    service.resetWorkspaceLayouts(graphId);
  });
  ipcMain.handle(IPC.environment, () => detectEnvironment());
}

export function sendRunEvent(
  window: BrowserWindow | null,
  event: RunEvent,
): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.send(IPC.runEvent, event);
}
