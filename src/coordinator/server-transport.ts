import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createSecureContext } from "node:tls";
import { isLoopbackHost } from "./config";

export type CoordinatorTlsOptions = Readonly<{
  certificate: Buffer;
  privateKey: Buffer;
}>;

export type CoordinatorServerProtocol = "http" | "https";

export class CoordinatorTlsConfigurationError extends Error {
  override readonly name = "CoordinatorTlsConfigurationError";

  constructor(
    message = "Coordinator TLS certificate and private key are invalid or do not match.",
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function createCoordinatorNodeServer(options: Readonly<{
  host: string;
  requestTimeout: number;
  tls: CoordinatorTlsOptions | undefined;
  handleRequest(request: IncomingMessage, response: ServerResponse): void;
}>): Readonly<{ server: Server; protocol: CoordinatorServerProtocol }> {
  if (!options.tls && !isLoopbackHost(options.host)) {
    throw new CoordinatorTlsConfigurationError(
      "Coordinator TLS is required for a non-loopback listener.",
    );
  }
  if (!options.tls) {
    return {
      server: createHttpServer(
        { requestTimeout: options.requestTimeout },
        options.handleRequest,
      ),
      protocol: "http",
    };
  }
  const tlsOptions = {
    cert: options.tls.certificate,
    key: options.tls.privateKey,
  };
  try {
    createSecureContext(tlsOptions);
    return {
      server: createHttpsServer(
        { ...tlsOptions, requestTimeout: options.requestTimeout },
        options.handleRequest,
      ),
      protocol: "https",
    };
  } catch (error: unknown) {
    throw new CoordinatorTlsConfigurationError(undefined, { cause: error });
  }
}
