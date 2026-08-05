import { createHash, timingSafeEqual } from "node:crypto";
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { z } from "zod";
import {
  COORDINATOR_PROTOCOL_VERSION,
  controlRequestSchema,
  controlResponseSchema,
  type ControlRequest,
} from "../shared/coordinator-protocol";
import { CoordinatorEventStream } from "./event-stream";
import { closeHttpServer, SseConnectionRegistry } from "./sse-connections";
import {
  createCoordinatorNodeServer,
  type CoordinatorTlsOptions,
} from "./server-transport";
import { streamCoordinatorEvents } from "./sse-response";

export const MAX_CONTROL_REQUEST_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_HOST = "127.0.0.1";

const bearerTokenSchema = z
  .string()
  .regex(/^Bearer [^\s]+$/)
  .transform((value) => value.slice("Bearer ".length));

const lastEventIdSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .transform(Number)
  .refine(Number.isSafeInteger)
  .optional();

const healthResponseSchema = z.strictObject({
  status: z.literal("ok"),
  protocolVersion: z.literal(COORDINATOR_PROTOCOL_VERSION),
});

export type CoordinatorControl = Readonly<{
  execute(
    operation: ControlRequest["operation"],
    input: unknown,
  ): Promise<unknown>;
}>;

export type CoordinatorHttpServerOptions = Readonly<{
  control: CoordinatorControl;
  events: CoordinatorEventStream;
  token: string;
  host?: string;
  port?: number;
  tls?: CoordinatorTlsOptions;
}>;

export type CoordinatorHttpServerAddress = Readonly<{
  host: string;
  port: number;
  protocol: "http" | "https";
}>;

class RequestBodyTooLargeError extends Error {
  override readonly name = "RequestBodyTooLargeError";
}

function digestToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return;
  const payload = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(payload);
}

function sendError(response: ServerResponse, status: number, error: string): void {
  sendJson(response, status, controlResponseSchema.parse({ ok: false, error }));
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += bytes.length;
    if (byteLength > MAX_CONTROL_REQUEST_BYTES) {
      request.resume();
      throw new RequestBodyTooLargeError("Request body exceeds one MiB.");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, byteLength);
}

export class CoordinatorHttpServer {
  private readonly host: string;
  private readonly port: number;
  private readonly tokenDigest: Buffer;
  private readonly sseConnections = new SseConnectionRegistry();
  private server: Server | undefined;
  private closePromise: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly options: CoordinatorHttpServerOptions) {
    this.host = options.host ?? DEFAULT_HOST;
    this.port = options.port ?? 0;
    this.tokenDigest = digestToken(options.token);
  }

  async start(): Promise<CoordinatorHttpServerAddress> {
    if (this.server || this.closed) {
      throw new Error("Coordinator HTTP server cannot be started again.");
    }
    const handleRequest = (request: IncomingMessage, response: ServerResponse): void => {
      void this.handleRequest(request, response).catch(() => {
        sendError(response, 500, "Internal server error.");
      });
    };
    const { server, protocol } = createCoordinatorNodeServer({
      host: this.host,
      requestTimeout: REQUEST_TIMEOUT_MS,
      tls: this.options.tls,
      handleRequest,
    });
    this.server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: this.host, port: this.port }, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Coordinator HTTP server did not bind a TCP address.");
      }
      return {
        host: address.address,
        port: address.port,
        protocol,
      };
    } catch (error: unknown) {
      this.server = undefined;
      server.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.closed = true;
    this.closePromise ??= closeHttpServer(server, this.sseConnections);
    return this.closePromise;
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method === "GET" && request.url === "/healthz") {
      sendJson(response, 200, healthResponseSchema.parse({
        status: "ok",
        protocolVersion: COORDINATOR_PROTOCOL_VERSION,
      }));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/events") {
      const token = this.readBearerToken(request, response);
      if (token === undefined) return;
      let afterSequence: number | undefined;
      try {
        afterSequence = lastEventIdSchema.parse(request.headers["last-event-id"]);
      } catch {
        sendError(response, 400, "Invalid Last-Event-ID.");
        return;
      }
      this.streamEvents(response, afterSequence);
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/control") {
      sendError(response, 404, "Not found.");
      return;
    }

    if (this.readBearerToken(request, response) === undefined) return;

    let rawRequest: unknown;
    try {
      rawRequest = JSON.parse((await readRequestBody(request)).toString("utf8"));
    } catch (error: unknown) {
      if (error instanceof RequestBodyTooLargeError) {
        sendError(response, 413, "Payload too large.");
        return;
      }
      sendError(response, 400, "Invalid request body.");
      return;
    }

    let controlRequest: ControlRequest;
    try {
      controlRequest = controlRequestSchema.parse(rawRequest);
    } catch {
      sendError(response, 400, "Invalid control request.");
      return;
    }

    try {
      const output = await this.options.control.execute(
        controlRequest.operation,
        controlRequest.input,
      );
      sendJson(response, 200, controlResponseSchema.parse({ ok: true, output }));
    } catch {
      sendError(response, 500, "Internal server error.");
    }
  }

  private isAuthenticated(token: string): boolean {
    return timingSafeEqual(digestToken(token), this.tokenDigest);
  }

  private readBearerToken(
    request: IncomingMessage,
    response: ServerResponse,
  ): string | undefined {
    let token: string;
    try {
      token = bearerTokenSchema.parse(request.headers.authorization);
    } catch {
      sendError(response, 401, "Unauthorized.");
      return undefined;
    }
    if (!this.isAuthenticated(token)) {
      sendError(response, 401, "Unauthorized.");
      return undefined;
    }
    return token;
  }

  private streamEvents(response: ServerResponse, afterSequence: number | undefined): void {
    streamCoordinatorEvents(
      response,
      this.options.events,
      this.sseConnections,
      afterSequence,
    );
  }
}
