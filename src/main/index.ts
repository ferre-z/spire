import { app, BrowserWindow, nativeTheme } from "electron";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ControlSocketServer } from "./control/socket-server";
import { SpireControl } from "./control/spire-control";
import { SpireDatabase } from "./database";
import { detectEnvironment, registerIpc, sendRunEvent } from "./ipc";
import { OpenCodeHarness } from "./opencode";
import { RunEngine } from "./run-engine";
import { isAllowedPopoutUrl } from "./window-policy";
import { LocalWorktreeBackend } from "./worktree";
import type { GraphDefinition, RunRecord } from "../shared/domain";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | null = null;
let database: SpireDatabase | undefined;
let harness: OpenCodeHarness | undefined;
let controlSocket: ControlSocketServer | undefined;
let shutdownStarted = false;

type SeedFixture = {
  settings?: Record<string, string>;
  graphs?: GraphDefinition[];
  runs?: RunRecord[];
};

function seedFromFixture(database: SpireDatabase, fixturePath: string): void {
  try {
    const fixture = JSON.parse(
      readFileSync(fixturePath, "utf8"),
    ) as SeedFixture;
    for (const [key, value] of Object.entries(fixture.settings ?? {})) {
      database.setSetting(key, value);
    }
    for (const graph of fixture.graphs ?? []) database.saveGraph(graph);
    for (const run of fixture.runs ?? []) database.saveRun(run);
  } catch (error) {
    console.error("Failed to apply SPIRE_SEED fixture:", error);
  }
}

const POPOUT_MIN_WIDTH = 360;
const POPOUT_MIN_HEIGHT = 260;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#0a0b0e",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#0a0b0e",
      symbolColor: "#8b93a3",
      height: 42,
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (
      isAllowedPopoutUrl(
        url,
        MAIN_WINDOW_VITE_DEV_SERVER_URL,
        MAIN_WINDOW_VITE_NAME,
      )
    ) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          minWidth: POPOUT_MIN_WIDTH,
          minHeight: POPOUT_MIN_HEIGHT,
          autoHideMenuBar: true,
          backgroundColor: "#0a0b0e",
        },
      };
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());

  // Popout windows are extensions of the workspace: close them when the
  // main window goes away so none outlive the application shell.
  mainWindow.on("closed", () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.close();
    }
    mainWindow = null;
  });

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
  // SPIRE_USER_DATA lets E2E tests run against an isolated, pre-seeded
  // database instead of the real user profile.
  const dataRoot = process.env.SPIRE_USER_DATA ?? app.getPath("userData");
  database = new SpireDatabase(path.join(dataRoot, "spire.sqlite"));
  // E2E-only fixture seeding: SPIRE_SEED points at a JSON file with
  // settings/graphs/runs so UI tests never touch OpenRouter.
  if (process.env.SPIRE_SEED) {
    seedFromFixture(database, process.env.SPIRE_SEED);
  }
  harness = new OpenCodeHarness();
  const backend = new LocalWorktreeBackend(path.join(dataRoot, "worktrees"));
  const engine = new RunEngine(
    database,
    harness,
    backend,
    (event) => sendRunEvent(mainWindow, event),
  );
  const control = new SpireControl({
    database,
    engine,
    harness,
    backend,
    journal: database.createTraceJournal(),
    environment: { appVersion: app.getVersion(), ...detectEnvironment() },
  });
  registerIpc(control, () => mainWindow);
  // Local control socket for same-user processes (the MCP stdio sidecar).
  // Failure to bind must not take down the app — control stays over IPC.
  controlSocket = new ControlSocketServer({ control, baseDir: dataRoot });
  void controlSocket.start().catch((error: unknown) => {
    console.error("Failed to start the control socket:", error);
  });
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  // The control socket closes before the database: before-quit is
  // synchronous, so defer the quit once while the socket shuts down.
  if (controlSocket && !shutdownStarted) {
    shutdownStarted = true;
    event.preventDefault();
    void controlSocket
      .close()
      // Quit even if socket teardown fails — never hang shutdown.
      .then(
        () => app.quit(),
        () => app.quit(),
      );
    return;
  }
  harness?.close();
  database?.close();
});
