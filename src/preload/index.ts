import { contextBridge, ipcRenderer } from "electron";
import { IPC, type SpireApi } from "../shared/api";
import type {
  GraphDefinition,
  ProviderInput,
  RunEvent,
  StartRunInput,
} from "../shared/domain";

const api: SpireApi = {
  snapshot: () => ipcRenderer.invoke(IPC.snapshot),
  detectOpenCode: () => ipcRenderer.invoke(IPC.detectOpenCode),
  connectOpenRouter: (input: ProviderInput) =>
    ipcRenderer.invoke(IPC.connectOpenRouter, input),
  chooseRepository: () => ipcRenderer.invoke(IPC.chooseRepository),
  saveGraph: (graph: GraphDefinition) =>
    ipcRenderer.invoke(IPC.saveGraph, graph),
  startRun: (input: StartRunInput) =>
    ipcRenderer.invoke(IPC.startRun, input),
  stopRun: (runId: string) => ipcRenderer.invoke(IPC.stopRun, runId),
  retryRun: (runId: string) => ipcRenderer.invoke(IPC.retryRun, runId),
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
  revealPath: (path: string) => ipcRenderer.invoke(IPC.revealPath, path),
  exportPatch: (runId: string) =>
    ipcRenderer.invoke(IPC.exportPatch, runId),
  cleanupWorktree: (runId: string) =>
    ipcRenderer.invoke(IPC.cleanupWorktree, runId),
  onRunEvent: (listener: (event: RunEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, event: RunEvent) =>
      listener(event);
    ipcRenderer.on(IPC.runEvent, handler);
    return () => ipcRenderer.removeListener(IPC.runEvent, handler);
  },
};

contextBridge.exposeInMainWorld("spire", api);
