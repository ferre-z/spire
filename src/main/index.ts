import { app, BrowserWindow, nativeTheme } from "electron";
import path from "node:path";
import { AppService } from "./app-service";
import { SpireDatabase } from "./database";
import { registerIpc, sendRunEvent } from "./ipc";
import { OpenCodeHarness } from "./opencode";
import { RunEngine } from "./run-engine";
import { LocalWorktreeBackend } from "./worktree";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | null = null;
let database: SpireDatabase | undefined;
let harness: OpenCodeHarness | undefined;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: "#090d16",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#090d16",
      symbolColor: "#9aa7bd",
      height: 42,
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(
      path.join(
        __dirname,
        `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
      ),
    );
  }
}

void app.whenReady().then(() => {
  nativeTheme.themeSource = "dark";
  const dataRoot = app.getPath("userData");
  database = new SpireDatabase(path.join(dataRoot, "spire.sqlite"));
  harness = new OpenCodeHarness();
  const backend = new LocalWorktreeBackend(path.join(dataRoot, "worktrees"));
  const engine = new RunEngine(
    database,
    harness,
    backend,
    (event) => sendRunEvent(mainWindow, event),
  );
  const service = new AppService(database, harness, engine, backend);
  registerIpc(service, () => mainWindow);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  harness?.close();
  database?.close();
});
