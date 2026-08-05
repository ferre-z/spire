import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CoordinatorHttpServer } from "./http-server";
import { CoordinatorTlsConfigurationError } from "./server-transport";
import {
  CoordinatorConfigurationError,
  readCoordinatorConfig,
} from "./config";
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
  tls?: Readonly<{
    certificate: Buffer;
    privateKey: Buffer;
  }>;
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
    tls: options.tls,
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
  let tls: CoordinatorStartOptions["tls"];
  if (config.tls) {
    try {
      const [certificate, privateKey] = await Promise.all([
        readFile(config.tls.certificatePath),
        readFile(config.tls.privateKeyPath),
      ]);
      tls = { certificate, privateKey };
    } catch (error: unknown) {
      throw new CoordinatorTlsConfigurationError(
        "Unable to read the coordinator TLS certificate or private key.",
        { cause: error },
      );
    }
  }
  const coordinator = await startCoordinator({ ...config, tls });

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

  process.stdout.write(
    `${coordinator.address.protocol}://${coordinator.address.host}:${coordinator.address.port}\n`,
  );

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
}

export function formatCoordinatorStartupError(error: unknown): string {
  if (
    error instanceof CoordinatorConfigurationError ||
    error instanceof CoordinatorTlsConfigurationError
  ) {
    return `Coordinator failed to start: ${error.message}\n`;
  }
  return "Coordinator failed to start.\n";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runCoordinator().catch((error: unknown) => {
    process.stderr.write(formatCoordinatorStartupError(error));
    process.exitCode = 1;
  });
}
