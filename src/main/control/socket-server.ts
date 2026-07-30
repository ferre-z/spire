import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import path from "node:path";
import type { TraceEvent } from "../../shared/trace";
import type { SpireControl } from "./spire-control";
import {
  clientFrameSchema,
  type ClientFrame,
  type ResponseFrame,
  type ServerFrame,
} from "./socket-protocol";

/**
 * Authenticated local control socket.
 *
 * Exposes `SpireControl` to same-user local processes (the MCP stdio
 * sidecar is the first client) over a private Unix domain socket beneath
 * Spire's user-data directory: `<baseDir>/control/control.sock`, with a
 * random 32-byte token in `<baseDir>/control/control.token`. The directory
 * is mode 0700 and the token file mode 0600, so any process that can read
 * the token already runs as the owning user and is fully trusted.
 *
 * The module is Electron-free: the base directory is injected so tests can
 * point it at a tmp dir.
 */

export const CONTROL_SOCKET_DIR = "control";
export const CONTROL_SOCKET_FILE = "control.sock";
export const CONTROL_TOKEN_FILE = "control.token";
export const MAX_FRAME_BYTES = 1024 * 1024; // 1 MiB
const DEFAULT_MAX_BUFFERED_EVENT_BYTES = 1024 * 1024; // 1 MiB

export type ControlSocketTarget = Pick<SpireControl, "execute" | "subscribe">;

export type ControlSocketServerOptions = {
  control: ControlSocketTarget;
  baseDir: string;
  maxFrameBytes?: number;
  maxBufferedEventBytes?: number;
};

export type ControlSocketPaths = {
  socketPath: string;
  tokenPath: string;
};

type ClientState = {
  socket: Socket;
  buffer: Buffer;
  subscriptions: Map<string, () => void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Best-effort id extraction for error responses to broken frames. */
function frameId(raw: unknown): string {
  if (typeof raw === "object" && raw !== null && "id" in raw) {
    const id = (raw as { id?: unknown }).id;
    if (typeof id === "string") return id;
  }
  return "";
}

/** Raw token field, checked before any envelope parsing happens. */
function frameToken(raw: unknown): unknown {
  if (typeof raw === "object" && raw !== null && "token" in raw) {
    return (raw as { token?: unknown }).token;
  }
  return undefined;
}

export class ControlSocketServer {
  private readonly maxFrameBytes: number;
  private readonly maxBufferedEventBytes: number;
  private server: Server | undefined;
  private readonly clients = new Set<ClientState>();
  private token: Buffer | undefined;
  private socketPath: string | undefined;
  private tokenPath: string | undefined;
  /** True only while this process owns the bound socket file. */
  private ownsSocketFile = false;

  constructor(private readonly options: ControlSocketServerOptions) {
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
    this.maxBufferedEventBytes =
      options.maxBufferedEventBytes ?? DEFAULT_MAX_BUFFERED_EVENT_BYTES;
  }

  async start(): Promise<ControlSocketPaths> {
    if (this.server) throw new Error("Control socket server already started.");
    const dir = path.join(this.options.baseDir, CONTROL_SOCKET_DIR);
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o700);

    this.socketPath = path.join(dir, CONTROL_SOCKET_FILE);
    this.tokenPath = path.join(dir, CONTROL_TOKEN_FILE);
    // Probe for a live owner first: overwriting the token before this check
    // would clobber the running instance's credential on a rejected start.
    await this.removeStaleSocket();

    this.token = randomBytes(32);
    await writeFile(this.tokenPath, this.token.toString("hex"), {
      mode: 0o600,
    });
    // writeFile mode only applies on creation; enforce on existing files too.
    await chmod(this.tokenPath, 0o600);

    const server = net.createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.ownsSocketFile = true;
    return { socketPath: this.socketPath, tokenPath: this.tokenPath };
  }

  /** Close clients, stop listening, and remove the socket file we own. */
  async close(): Promise<void> {
    for (const client of this.clients) {
      this.dropClient(client);
    }
    const server = this.server;
    this.server = undefined;
    if (server?.listening) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    if (this.ownsSocketFile && this.socketPath) {
      this.ownsSocketFile = false;
      await unlink(this.socketPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  }

  /** Unlink a leftover socket file, but never one owned by a live process. */
  private async removeStaleSocket(): Promise<void> {
    const socketPath = this.socketPath;
    if (!socketPath) return;
    const stale = await new Promise<boolean>((resolve) => {
      const probe = net.createConnection(socketPath);
      probe.once("connect", () => {
        probe.destroy();
        resolve(false); // live owner — do not touch
      });
      probe.once("error", (error: NodeJS.ErrnoException) => {
        resolve(error.code === "ECONNREFUSED" || error.code === "ENOENT");
      });
    });
    if (!stale) {
      throw new Error(`Control socket already in use: ${socketPath}`);
    }
    await unlink(socketPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }

  private accept(socket: Socket): void {
    const client: ClientState = {
      socket,
      buffer: Buffer.alloc(0),
      subscriptions: new Map(),
    };
    this.clients.add(client);
    socket.on("data", (chunk: Buffer) => this.receive(client, chunk));
    socket.on("error", () => undefined); // close follows; cleanup happens there
    socket.on("close", () => this.releaseClient(client));
  }

  private receive(client: ClientState, chunk: Buffer): void {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    let newline = client.buffer.indexOf(0x0a);
    // A frame longer than the cap is rejected as soon as it is known to
    // exceed the limit — before the buffer can grow unboundedly.
    if (newline === -1 && client.buffer.length > this.maxFrameBytes) {
      this.failAndClose(client, "", "frame too large");
      return;
    }
    while (newline !== -1) {
      const line = client.buffer.subarray(0, newline);
      client.buffer = client.buffer.subarray(newline + 1);
      if (line.length > this.maxFrameBytes) {
        this.failAndClose(client, "", "frame too large");
        return;
      }
      if (line.length > 0) this.handleLine(client, line);
      if (!this.clients.has(client)) return; // closed by the frame handler
      newline = client.buffer.indexOf(0x0a);
    }
  }

  private handleLine(client: ClientState, line: Buffer): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line.toString("utf8"));
    } catch {
      this.send(client, {
        type: "response",
        id: "",
        ok: false,
        error: "malformed frame: not JSON",
      });
      return;
    }
    // Authentication happens before the envelope (and its operation
    // payload) is parsed or dispatched. The token is never logged.
    if (!this.isAuthenticated(frameToken(raw))) {
      this.failAndClose(client, frameId(raw), "unauthenticated");
      return;
    }
    const parsed = clientFrameSchema.safeParse(raw);
    if (!parsed.success) {
      this.send(client, {
        type: "response",
        id: frameId(raw),
        ok: false,
        error: "invalid frame",
      });
      return;
    }
    this.handleFrame(client, parsed.data);
  }

  private isAuthenticated(token: unknown): boolean {
    if (typeof token !== "string" || !this.token) return false;
    const presented = Buffer.from(token, "utf8");
    const expected = Buffer.from(this.token.toString("hex"), "utf8");
    return (
      presented.length === expected.length &&
      timingSafeEqual(presented, expected)
    );
  }

  private handleFrame(client: ClientState, frame: ClientFrame): void {
    switch (frame.type) {
      case "ping":
        this.send(client, {
          type: "response",
          id: frame.id,
          ok: true,
          output: { pong: true },
        });
        return;
      case "request": {
        // execute() may throw synchronously; normalize to a rejection so the
        // error always becomes a response frame keyed by the request id.
        void Promise.resolve()
          .then(() => this.options.control.execute(frame.operation, frame.input))
          .then(
            (output) => {
              this.send(client, {
                type: "response",
                id: frame.id,
                ok: true,
                output: output ?? null,
              });
            },
            (error: unknown) => {
              this.send(client, {
                type: "response",
                id: frame.id,
                ok: false,
                error: errorMessage(error),
              });
            },
          );
        return;
      }
      case "subscribe": {
        if (client.subscriptions.has(frame.id)) {
          this.send(client, {
            type: "response",
            id: frame.id,
            ok: false,
            error: `Already subscribed: ${frame.id}`,
          });
          return;
        }
        const unsubscribe = this.options.control.subscribe(
          (event: TraceEvent) => this.sendEvent(client, frame.id, event),
        );
        client.subscriptions.set(frame.id, unsubscribe);
        this.send(client, {
          type: "response",
          id: frame.id,
          ok: true,
          output: { subscription: frame.id },
        });
        return;
      }
      case "unsubscribe": {
        const unsubscribe = client.subscriptions.get(frame.subscription);
        if (!unsubscribe) {
          this.send(client, {
            type: "response",
            id: frame.id,
            ok: false,
            error: `Not subscribed: ${frame.subscription}`,
          });
          return;
        }
        unsubscribe();
        client.subscriptions.delete(frame.subscription);
        this.send(client, { type: "response", id: frame.id, ok: true });
        return;
      }
    }
  }

  private sendEvent(
    client: ClientState,
    subscription: string,
    event: TraceEvent,
  ): void {
    if (!this.clients.has(client)) return;
    // Slow consumer: the client is not draining and its outbound queue has
    // grown past the bound — drop exactly this client, not the others.
    if (client.socket.writableLength > this.maxBufferedEventBytes) {
      this.dropClient(client);
      return;
    }
    this.send(client, { type: "event", subscription, event });
  }

  private send(client: ClientState, frame: ServerFrame): void {
    if (client.socket.destroyed) return;
    // Same slow-consumer bound as sendEvent: a client pipelining large
    // requests without reading must not grow our buffer unboundedly.
    if (client.socket.writableLength > this.maxBufferedEventBytes) {
      this.dropClient(client);
      return;
    }
    client.socket.write(`${JSON.stringify(frame)}\n`);
  }

  /** Send a terminal error, flush it, then close the connection. */
  private failAndClose(
    client: ClientState,
    id: string,
    error: string,
  ): void {
    const frame: ResponseFrame = { type: "response", id, ok: false, error };
    if (!client.socket.destroyed) {
      client.socket.end(`${JSON.stringify(frame)}\n`);
    }
    this.releaseClient(client);
  }

  /** Disconnect a client without a terminal frame (slow consumers). */
  private dropClient(client: ClientState): void {
    client.socket.destroy();
    this.releaseClient(client);
  }

  private releaseClient(client: ClientState): void {
    if (!this.clients.delete(client)) return;
    for (const unsubscribe of client.subscriptions.values()) unsubscribe();
    client.subscriptions.clear();
  }
}
