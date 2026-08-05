import { app, BrowserWindow, nativeTheme } from "electron";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  createCoordinatorRuntime,
  type CoordinatorRuntime,
} from "../coordinator/runtime";
import { ControlSocketServer } from "./control/socket-server";
import { SpireDatabase } from "./database";
import { detectEnvironment, registerIpc, sendRunEvent } from "./ipc";
import { isAllowedPopoutUrl } from "./window-policy";
import type { GraphDefinition, GraphDefinitionV2, HarnessId, RunRecord } from "../shared/domain";
import type { ExecutionPlan } from "../shared/execution";
import type { HarnessRegistry } from "../shared/harness";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | null = null;
let runtime: CoordinatorRuntime | undefined;
let controlSocket: ControlSocketServer | undefined;
let shutdownStarted = false;

/**
 * Shape of the JSON seed fixture applied at boot via SPIRE_SEED.
 *
 * `graphsV2` seeds graph-native v2 definitions (saved via saveGraphV2);
 * `harnessFixtures` seeds predetermined harness outputs so E2E suites can
 * exercise the full scheduler without installed CLI dependencies.
 */
type SeedFixture = {
  settings?: Record<string, string>;
  graphs?: GraphDefinition[];
  graphsV2?: GraphDefinitionV2[];
  runs?: RunRecord[];
  plans?: ExecutionPlan[];
  harnessFixtures?: Record<string, FixtureHarnessConfig>;
};

/** JSON-compatible view of the fixture harness config (read from seed JSON). */
type FixtureHarnessConfig = {
  nodes: Record<string, Array<{ output: unknown; events?: unknown; sideEffect?: unknown }>>;
};

function seedFromFixture(
  database: SpireDatabase,
  fixturePath: string,
): SeedFixture | undefined {
  try {
    const fixture = JSON.parse(
      readFileSync(fixturePath, "utf8"),
    ) as SeedFixture;
    for (const [key, value] of Object.entries(fixture.settings ?? {})) {
      database.setSetting(key, value);
    }
    for (const graph of fixture.graphs ?? []) database.saveGraph(graph);
    for (const graph of fixture.graphsV2 ?? []) database.saveGraphV2(graph);
    for (const run of fixture.runs ?? []) database.saveRun(run);
    for (const plan of fixture.plans ?? []) database.saveExecutionPlan(plan);
    return fixture;
  } catch (error) {
    console.error("Failed to apply SPIRE_SEED fixture:", error);
    return undefined;
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

void app.whenReady().then(async () => {
  nativeTheme.themeSource = "dark";
  // SPIRE_USER_DATA lets E2E tests run against an isolated, pre-seeded
  // database instead of the real user profile.
  const dataRoot = process.env.SPIRE_USER_DATA ?? app.getPath("userData");
  // E2E-only fixture seeding: SPIRE_SEED points at a JSON file with
  // settings/graphs/runs so UI tests never touch OpenRouter.
  let seed: SeedFixture | undefined;
  if (process.env.SPIRE_SEED) {
    const seedDatabase = new SpireDatabase(path.join(dataRoot, "spire.sqlite"));
    seed = seedFromFixture(seedDatabase, process.env.SPIRE_SEED);
    seedDatabase.close();
  }
  let registry: HarnessRegistry | undefined;
  if (seed?.harnessFixtures) {
    // Fixture harnesses: deterministic, CLI-free run execution for E2E tests.
    // Loaded dynamically so test-only code never ships in the production bundle.
    const { createFixtureHarnessRegistry } = await import("./harness/fixture");
    registry = createFixtureHarnessRegistry(
      seed.harnessFixtures as Record<HarnessId, import("./harness/fixture").FixtureHarnessConfig>,
    );
  }
  runtime = await createCoordinatorRuntime({
    dataRoot,
    registry,
    environment: { appVersion: app.getVersion(), ...detectEnvironment() },
    notify: (event) => sendRunEvent(mainWindow, event),
  });
  registerIpc(runtime.control, () => mainWindow);
  // Local control socket for same-user processes (the MCP stdio sidecar).
  // Failure to bind must not take down the app — control stays over IPC.
  controlSocket = new ControlSocketServer({ control: runtime.control, baseDir: dataRoot });
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
  // The control socket closes before the coordinator runtime's database:
  // before-quit is synchronous, so defer the quit once while they shut down.
  if (!shutdownStarted) {
    shutdownStarted = true;
    event.preventDefault();
    void (controlSocket?.close() ?? Promise.resolve())
      // Quit even if socket teardown fails — never hang shutdown.
      .then(
        () => runtime?.close(),
        () => runtime?.close(),
      )
      .then(
        () => app.quit(),
        () => app.quit(),
      );
  }
});
