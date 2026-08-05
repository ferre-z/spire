import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CoordinatorHttpServer } from "./http-server";
import { readCoordinatorConfig } from "./config";
import {
  createCoordinatorRuntime,
  type CoordinatorRuntime,
  type CoordinatorRuntimeOptions,
} from "./runtime";

type CoordinatorResources = Readonly<{
  server: CoordinatorHttpServer;
  runtime: CoordinatorRuntime;
}>;

export type CoordinatorStartOptions = Readonly<{
  dataRoot: string;
  token: string;
  host?: string;
  port?: number;
  registry?: CoordinatorRuntimeOptions["registry"];
  environment?: CoordinatorRuntimeOptions["environment"];
}>;

export type CoordinatorSession = Readonly<{
  address: Awaited<ReturnType<CoordinatorHttpServer["start"]>>;
  close: () => Promise<void>;
}>;

async function closeCoordinator(resources: CoordinatorResources): Promise<void> {
  try {
    await resources.server.close();
  } finally {
    await resources.runtime.close();
  }
}

export async function startCoordinator(
  options: CoordinatorStartOptions,
): Promise<CoordinatorSession> {
  await mkdir(options.dataRoot, { recursive: true });
  const runtime = await createCoordinatorRuntime({
    dataRoot: options.dataRoot,
    registry: options.registry,
    environment: options.environment,
  });
  const server = new CoordinatorHttpServer({
    control: runtime.control,
    events: runtime.events,
    token: options.token,
    host: options.host,
    port: options.port,
  });

  try {
    const address = await server.start();
    return { address, close: () => closeCoordinator({ server, runtime }) };
  } catch (error: unknown) {
    await closeCoordinator({ server, runtime });
    throw error;
  }
}

async function runCoordinator(): Promise<void> {
  const config = readCoordinatorConfig(process.env, process.cwd());
  const coordinator = await startCoordinator(config);

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= coordinator.close();
    return shutdownPromise;
  };
  const handleSignal = (): void => {
    void shutdown().then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.exitCode = 1;
      },
    );
  };

  process.stdout.write(`http://${coordinator.address.host}:${coordinator.address.port}\n`);

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runCoordinator().catch(() => {
    process.exitCode = 1;
  });
}
