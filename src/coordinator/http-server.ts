import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
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

export const MAX_CONTROL_REQUEST_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_HOST = "127.0.0.1";

const requestMetadataSchema = z.strictObject({
  method: z.string().optional(),
  url: z.string().optional(),
  authorization: z.unknown(),
});

const bearerTokenSchema = z
  .string()
  .regex(/^Bearer [^\s]+$/)
  .transform((value) => value.slice("Bearer ".length));

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
  token: string;
  host?: string;
  port?: number;
}>;

export type CoordinatorHttpServerAddress = Readonly<{
  host: string;
  port: number;
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
  private server: Server | undefined;
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

    const server = createServer({ requestTimeout: REQUEST_TIMEOUT_MS }, (request, response) => {
      void this.handleRequest(request, response).catch(() => {
        sendError(response, 500, "Internal server error.");
      });
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
      return { host: address.address, port: address.port };
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
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) {
          resolve();
          return;
        }
        reject(error);
      });
    });
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let metadata: z.infer<typeof requestMetadataSchema>;
    try {
      metadata = requestMetadataSchema.parse({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
      });
    } catch {
      sendError(response, 400, "Invalid request.");
      return;
    }
    if (metadata.method === "GET" && metadata.url === "/healthz") {
      sendJson(response, 200, healthResponseSchema.parse({
        status: "ok",
        protocolVersion: COORDINATOR_PROTOCOL_VERSION,
      }));
      return;
    }
    if (metadata.method !== "POST" || metadata.url !== "/v1/control") {
      sendError(response, 404, "Not found.");
      return;
    }

    let token: string;
    try {
      token = bearerTokenSchema.parse(metadata.authorization);
    } catch {
      sendError(response, 401, "Unauthorized.");
      return;
    }
    if (!this.isAuthenticated(token)) {
      sendError(response, 401, "Unauthorized.");
      return;
    }

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
}
