import { mkdir } from "node:fs/promises";
import { CoordinatorHttpServer } from "./http-server";
import { readCoordinatorConfig } from "./config";
import {
  createCoordinatorRuntime,
  type CoordinatorRuntime,
} from "./runtime";

type CoordinatorResources = Readonly<{
  server: CoordinatorHttpServer;
  runtime: CoordinatorRuntime;
}>;

async function closeCoordinator(resources: CoordinatorResources): Promise<void> {
  try {
    await resources.server.close();
  } finally {
    await resources.runtime.close();
  }
}

export async function startCoordinator(): Promise<void> {
  const config = readCoordinatorConfig(process.env, process.cwd());
  await mkdir(config.dataRoot, { recursive: true });
  const runtime = await createCoordinatorRuntime({ dataRoot: config.dataRoot });
  const server = new CoordinatorHttpServer({
    control: runtime.control,
    events: runtime.events,
    token: config.token,
    host: config.host,
    port: config.port,
  });

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= closeCoordinator({ server, runtime });
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

  try {
    const address = await server.start();
    process.stdout.write(`http://${address.host}:${address.port}\n`);
  } catch (error: unknown) {
    await shutdown();
    throw error;
  }

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
}

void startCoordinator().catch(() => {
  process.exitCode = 1;
});
