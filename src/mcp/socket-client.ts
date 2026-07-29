import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import net, { type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import type {
  ControlOperationMap,
  ControlOperationName,
} from "../shared/control";
import type { TraceListener } from "../shared/trace";
import {
  CONTROL_SOCKET_DIR,
  CONTROL_SOCKET_FILE,
  CONTROL_TOKEN_FILE,
} from "../main/control/socket-server";
import type { ClientFrame, ServerFrame } from "../main/control/socket-protocol";

/**
 * Client side of the Spire control socket.
 *
 * Speaks the NDJSON envelope protocol from `main/control/socket-protocol.ts`
 * against the Unix domain socket the running Spire app publishes beneath its
 * user-data directory. The per-launch token is read from the mode-0600 token
 * file on every (re)connect and is never logged or included in errors. When
 * the socket drops, the next operation transparently reconnects — re-reading
 * the token, since an app restart rotates it — and trace subscriptions are
 * re-established.
 *
 * The module is Electron-free: paths are injected so tests can point it at a
 * tmp dir.
 */

export type ControlSocketPaths = {
  socketPath: string;
  tokenPath: string;
};

export type ControlSocketClientOptions = ControlSocketPaths & {
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
};

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Control operations plus live trace delivery, as MCP registrations need. */
export type ControlChannel = {
  execute<Name extends ControlOperationName>(
    operation: Name,
    input?: ControlOperationMap[Name]["input"],
  ): Promise<ControlOperationMap[Name]["output"]>;
  subscribeTraces(listener: TraceListener): Promise<() => Promise<void>>;
};

/** Socket/token locations beneath a Spire user-data directory. */
export function resolveControlPaths(baseDir: string): ControlSocketPaths {
  return {
    socketPath: path.join(baseDir, CONTROL_SOCKET_DIR, CONTROL_SOCKET_FILE),
    tokenPath: path.join(baseDir, CONTROL_SOCKET_DIR, CONTROL_TOKEN_FILE),
  };
}

/** Default user-data dir, matching how the Electron app resolves it. */
export function defaultUserDataDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.SPIRE_USER_DATA) return env.SPIRE_USER_DATA;
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "Spire");
    case "win32":
      return path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Spire");
    default:
      return path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "Spire");
  }
}

/** Single actionable failure for "Spire is not running". Never carries the token. */
export class SpireNotRunningError extends Error {
  constructor(
    readonly socketPath: string,
    options?: { cause?: unknown },
  ) {
    super(
      `Spire is not running: no control socket at ${socketPath}. ` +
        `Launch Spire first (\`pnpm start\` in the Spire checkout, or open the Spire app), then retry.`,
      options,
    );
    this.name = "SpireNotRunningError";
  }
}

type PendingRequest = {
  resolve: (frame: ServerFrame & { type: "response" }) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/** Client frame before the per-frame token is attached at write time. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
type OutgoingFrame = DistributiveOmit<ClientFrame, "token">;

function isNotRunning(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "EACCES";
}

export class ControlSocketClient implements ControlChannel {
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private socket: Socket | undefined;
  private buffer = Buffer.alloc(0);
  private counter = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly subscriptions = new Map<string, TraceListener>();
  private connecting: Promise<void> | undefined;

  constructor(private readonly options: ControlSocketClientOptions) {
    this.connectTimeoutMs =
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  get socketPath(): string {
    return this.options.socketPath;
  }

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    this.connecting ??= this.open()
      .catch((error: unknown) => {
        if (error instanceof SpireNotRunningError) throw error;
        if (isNotRunning(error)) {
          throw new SpireNotRunningError(this.options.socketPath, {
            cause: error,
          });
        }
        throw error;
      })
      .finally(() => {
        this.connecting = undefined;
      });
    await this.connecting;
    // A reconnect after an app restart must re-establish trace
    // subscriptions on the fresh socket.
    if (this.subscriptions.size > 0) await this.restoreSubscriptions();
  }

  /** Read the token and open the socket. The token never leaves this frame. */
  private async open(): Promise<void> {
    let token: string;
    try {
      token = (await readFile(this.options.tokenPath, "utf8")).trim();
    } catch (error) {
      throw new SpireNotRunningError(this.options.socketPath, { cause: error });
    }
    const socket = net.createConnection(this.options.socketPath);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("Timed out connecting to the Spire control socket."));
        }, this.connectTimeoutMs);
        timer.unref();
        socket.once("connect", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
    } catch (error) {
      socket.destroy();
      throw error;
    }
    this.attach(socket, token);
  }

  private attach(socket: Socket, token: string): void {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    const send = (frame: OutgoingFrame): void => {
      socket.write(`${JSON.stringify({ ...frame, token })}\n`);
    };
    this.send = send;
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("error", () => undefined); // close follows; cleanup happens there
    socket.on("close", () => this.handleClose());
  }

  private send: (frame: OutgoingFrame) => void = () => {
    throw new SpireNotRunningError(this.options.socketPath);
  };

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let newline = this.buffer.indexOf(0x0a);
    while (newline !== -1) {
      const line = this.buffer.subarray(0, newline).toString("utf8");
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.length === 0) {
        // skip empty lines
      } else {
        try {
          this.handleFrame(JSON.parse(line) as ServerFrame);
        } catch {
          // Ignore undeliverable/malformed frames; the socket is a trusted
          // local peer, but a bad line must not crash the sidecar.
        }
      }
      newline = this.buffer.indexOf(0x0a);
    }
  }

  private handleFrame(frame: ServerFrame): void {
    if (frame.type === "event") {
      this.subscriptions.get(frame.subscription)?.(frame.event);
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    pending.resolve(frame);
  }

  private handleClose(): void {
    this.socket = undefined;
    this.send = () => {
      throw new SpireNotRunningError(this.options.socketPath);
    };
    const error = new Error("Spire control socket connection lost.");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    // Subscription listeners stay registered: the next request reconnects
    // and re-subscribes them against the new socket.
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}-${randomBytes(4).toString("hex")}`;
  }

  private async request(
    frame: OutgoingFrame,
  ): Promise<ServerFrame & { type: "response" }> {
    await this.connect();
    const id = frame.id;
    const response = new Promise<ServerFrame & { type: "response" }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Timed out waiting for control response: ${id}`));
        }, this.requestTimeoutMs);
        timer.unref();
        this.pending.set(id, { resolve, reject, timer });
      },
    );
    this.send(frame);
    return response;
  }

  async ping(): Promise<boolean> {
    const response = await this.request({ type: "ping", id: this.nextId("ping") });
    return response.ok;
  }

  async execute<Name extends ControlOperationName>(
    operation: Name,
    input?: ControlOperationMap[Name]["input"],
  ): Promise<ControlOperationMap[Name]["output"]> {
    const response = await this.request({
      type: "request",
      id: this.nextId("req"),
      operation,
      input: input ?? {},
    });
    if (!response.ok) {
      throw new Error(response.error ?? `Control operation failed: ${operation}`);
    }
    return response.output as ControlOperationMap[Name]["output"];
  }

  async subscribeTraces(listener: TraceListener): Promise<() => Promise<void>> {
    const id = this.nextId("sub");
    const response = await this.request({ type: "subscribe", id });
    if (!response.ok) {
      throw new Error(response.error ?? "Trace subscription failed.");
    }
    this.subscriptions.set(id, listener);
    return async () => {
      this.subscriptions.delete(id);
      if (!this.socket || this.socket.destroyed) return;
      await this.request({
        type: "unsubscribe",
        id: this.nextId("unsub"),
        subscription: id,
      });
    };
  }

  /** Re-subscribe live listeners after a reconnect. */
  private async restoreSubscriptions(): Promise<void> {
    for (const id of this.subscriptions.keys()) {
      const response = await this.request({ type: "subscribe", id }).catch(
        () => undefined,
      );
      if (!response?.ok) this.subscriptions.delete(id);
    }
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    this.subscriptions.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Control socket client closed."));
    }
    this.pending.clear();
    if (socket && !socket.destroyed) {
      socket.destroy();
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
      });
    }
  }
}
