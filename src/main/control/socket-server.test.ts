import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ControlOperationMap,
  ControlOperationName,
} from "../../shared/control";
import type { TraceEvent, TraceListener } from "../../shared/trace";
import type { ResponseFrame, ServerFrame } from "./socket-protocol";
import {
  CONTROL_SOCKET_DIR,
  CONTROL_SOCKET_FILE,
  CONTROL_TOKEN_FILE,
  ControlSocketServer,
  MAX_FRAME_BYTES,
  type ControlSocketTarget,
} from "./socket-server";

function makeTraceEvent(sequence = 1): TraceEvent {
  return {
    sequence,
    timestamp: new Date().toISOString(),
    correlationId: `corr-${sequence}`,
    kind: "control.start",
    level: "info",
    subsystem: "control",
    message: `event ${sequence}`,
  };
}

/** In-memory SpireControl stand-in: controllable execute + fan-out subscribe. */
class StubControl implements ControlSocketTarget {
  private readonly handlers = new Map<
    string,
    (input: unknown) => unknown | Promise<unknown>
  >();
  private readonly listeners = new Set<TraceListener>();

  on(
    operation: ControlOperationName,
    handler: (input: unknown) => unknown | Promise<unknown>,
  ): void {
    this.handlers.set(operation, handler);
  }

  execute<Name extends ControlOperationName>(
    name: Name,
    rawInput?: unknown,
  ): Promise<ControlOperationMap[Name]["output"]> {
    const handler = this.handlers.get(name);
    if (!handler) return Promise.reject(new Error(`Unknown op: ${name}`));
    return Promise.resolve().then(
      () => handler(rawInput) as ControlOperationMap[Name]["output"],
    );
  }

  subscribe(listener: TraceListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: TraceEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

/** NDJSON test client over a real Unix socket. */
class TestClient {
  private buffer = Buffer.alloc(0);
  private readonly frames: ServerFrame[] = [];
  private readonly waiters: {
    pred: (frame: ServerFrame) => boolean;
    resolve: (frame: ServerFrame) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }[] = [];
  readonly closed: Promise<void>;

  static async connect(socketPath: string): Promise<TestClient> {
    const socket = net.createConnection(socketPath);
    await once(socket, "connect");
    return new TestClient(socket);
  }

  private constructor(private readonly socket: net.Socket) {
    this.closed = new Promise<void>((resolve) => {
      socket.on("close", () => {
        for (const waiter of this.waiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error("Connection closed."));
        }
        resolve();
      });
    });
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      let newline = this.buffer.indexOf(0x0a);
      while (newline !== -1) {
        const line = this.buffer.subarray(0, newline).toString("utf8");
        this.buffer = this.buffer.subarray(newline + 1);
        this.pushFrame(JSON.parse(line) as ServerFrame);
        newline = this.buffer.indexOf(0x0a);
      }
    });
  }

  private pushFrame(frame: ServerFrame): void {
    const index = this.waiters.findIndex((waiter) => waiter.pred(frame));
    if (index !== -1) {
      const [waiter] = this.waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
      return;
    }
    this.frames.push(frame);
  }

  send(frame: unknown): void {
    this.socket.write(`${JSON.stringify(frame)}\n`);
  }

  sendRaw(data: string): void {
    this.socket.write(data);
  }

  /** Wait for the next matching frame; frames are consumed in arrival order. */
  nextFrame<T extends ServerFrame>(
    pred: (frame: ServerFrame) => frame is T,
    timeoutMs?: number,
  ): Promise<T>;
  nextFrame(
    pred?: (frame: ServerFrame) => boolean,
    timeoutMs?: number,
  ): Promise<ServerFrame>;
  nextFrame(
    pred: (frame: ServerFrame) => boolean = () => true,
    timeoutMs = 5000,
  ): Promise<ServerFrame> {
    const index = this.frames.findIndex(pred);
    if (index !== -1) {
      const [frame] = this.frames.splice(index, 1);
      return Promise.resolve(frame);
    }
    return new Promise<ServerFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = this.waiters.findIndex(
          (waiter) => waiter.resolve === resolve,
        );
        if (at !== -1) this.waiters.splice(at, 1);
        reject(new Error("Timed out waiting for a frame."));
      }, timeoutMs);
      timer.unref();
      this.waiters.push({ pred, resolve, reject, timer });
    });
  }

  /** True when a matching frame arrived without consuming it. */
  hasFrame(pred: (frame: ServerFrame) => boolean): boolean {
    return this.frames.some(pred);
  }

  async close(): Promise<void> {
    this.socket.destroy();
    await this.closed;
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const isResponse = (frame: ServerFrame): frame is ResponseFrame =>
  frame.type === "response";

describe("ControlSocketServer", () => {
  let baseDir: string;
  let control: StubControl;
  let server: ControlSocketServer;
  const clients: TestClient[] = [];

  async function startServer(
    options: Partial<
      ConstructorParameters<typeof ControlSocketServer>[0]
    > = {},
  ) {
    server = new ControlSocketServer({ control, baseDir, ...options });
    return server.start();
  }

  async function connect(socketPath: string): Promise<TestClient> {
    const client = await TestClient.connect(socketPath);
    clients.push(client);
    return client;
  }

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), "spire-socket-test-"));
    control = new StubControl();
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await server?.close();
    await rm(baseDir, { recursive: true, force: true });
  });

  it("creates the socket dir (0700), socket file, and token file (0600)", async () => {
    const paths = await startServer();
    const dir = path.join(baseDir, CONTROL_SOCKET_DIR);

    expect(paths.socketPath).toBe(path.join(dir, CONTROL_SOCKET_FILE));
    expect(paths.tokenPath).toBe(path.join(dir, CONTROL_TOKEN_FILE));
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.tokenPath)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.socketPath)).isSocket()).toBe(true);

    const token = await readFile(paths.tokenPath, "utf8");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("executes authenticated requests and echoes request ids", async () => {
    const paths = await startServer();
    const token = await readFile(paths.tokenPath, "utf8");
    control.on("diagnostics.get", () => ({ marker: "diag" }));

    const client = await connect(paths.socketPath);
    client.send({
      type: "request",
      id: "req-1",
      token,
      operation: "diagnostics.get",
    });
    const response = await client.nextFrame(
      (frame) => frame.type === "response" && frame.id === "req-1",
    );
    expect(response).toMatchObject({
      type: "response",
      id: "req-1",
      ok: true,
      output: { marker: "diag" },
    });
  });

  it("rejects a wrong token before parsing the operation payload", async () => {
    const paths = await startServer();
    const client = await connect(paths.socketPath);

    client.send({
      type: "request",
      id: "evil-1",
      token: "0".repeat(64),
      operation: "not.a.real.operation",
      input: { not: "json-schema-valid" },
    });
    const response = await client.nextFrame(isResponse);
    expect(response).toMatchObject({ ok: false });
    expect(response.ok === false && response.error).toMatch(/unauthenticated/);
    // The connection is closed after an authentication failure.
    await client.closed;
    expect(control.listenerCount()).toBe(0);
  });

  it("rejects frames without a token field as unauthenticated", async () => {
    const paths = await startServer();
    const client = await connect(paths.socketPath);
    client.send({ type: "ping", id: "p1" });
    const response = await client.nextFrame(
      (frame) => frame.type === "response",
    );
    expect(response).toMatchObject({ ok: false });
    await client.closed;
  });

  it("reports operation failures as error responses keyed by id", async () => {
    const paths = await startServer();
    const token = await readFile(paths.tokenPath, "utf8");
    control.on("runs.get", () => {
      throw new Error("Run not found.");
    });

    const client = await connect(paths.socketPath);
    client.send({
      type: "request",
      id: "req-fail",
      token,
      operation: "runs.get",
      input: { runId: "missing" },
    });
    const response = await client.nextFrame(
      (frame) => frame.type === "response",
    );
    expect(response).toMatchObject({
      type: "response",
      id: "req-fail",
      ok: false,
      error: "Run not found.",
    });
  });

  it("rejects envelopes with unknown operations as invalid frames", async () => {
    const paths = await startServer();
    const token = await readFile(paths.tokenPath, "utf8");

    const client = await connect(paths.socketPath);
    client.send({
      type: "request",
      id: "bad-op",
      token,
      operation: "filesystem.delete",
    });
    const response = await client.nextFrame(isResponse);
    expect(response).toMatchObject({ id: "bad-op", ok: false });
    expect(response.ok === false && response.error).toMatch(/invalid frame/);
    // Protocol errors do not kill the connection.
    client.send({ type: "ping", id: "still-alive", token });
    const pong = await client.nextFrame(
      (frame) => frame.type === "response" && frame.id === "still-alive",
    );
    expect(pong).toMatchObject({ ok: true });
  });

  it("serves concurrent requests keyed by id, completing out of order", async () => {
    const paths = await startServer();
    const token = await readFile(paths.tokenPath, "utf8");
    const slow = deferred<unknown>();
    control.on("traces.tail", () => slow.promise);
    control.on("diagnostics.get", () => ({ fast: true }));

    const client = await connect(paths.socketPath);
    client.send({ type: "request", id: "slow", token, operation: "traces.tail", input: { afterSequence: 0 } });
    client.send({ type: "request", id: "fast", token, operation: "diagnostics.get" });

    const fastResponse = await client.nextFrame(
      (frame) => frame.type === "response" && frame.id === "fast",
    );
    expect(fastResponse).toMatchObject({ ok: true, output: { fast: true } });
    expect(
      client.hasFrame(
        (frame) => frame.type === "response" && frame.id === "slow",
      ),
    ).toBe(false);

    slow.resolve({ events: [] });
    const slowResponse = await client.nextFrame(
      (frame) => frame.type === "response" && frame.id === "slow",
    );
    expect(slowResponse).toMatchObject({ ok: true, output: { events: [] } });
  });

  it("answers ping frames", async () => {
    const paths = await startServer();
    const token = await readFile(paths.tokenPath, "utf8");
    const client = await connect(paths.socketPath);
    client.send({ type: "ping", id: "ping-1", token });
    const response = await client.nextFrame(
      (frame) => frame.type === "response",
    );
    expect(response).toMatchObject({ id: "ping-1", ok: true });
  });

  it("streams trace events to subscribers until unsubscribe", async () => {
    const paths = await startServer();
    const token = await readFile(paths.tokenPath, "utf8");
    const client = await connect(paths.socketPath);

    client.send({ type: "subscribe", id: "sub-1", token });
    const ack = await client.nextFrame((frame) => frame.type === "response");
    expect(ack).toMatchObject({ id: "sub-1", ok: true });
    expect(control.listenerCount()).toBe(1);

    control.emit(makeTraceEvent(1));
    const event = await client.nextFrame((frame) => frame.type === "event");
    expect(event).toMatchObject({ type: "event", subscription: "sub-1" });
    expect(event.type === "event" && event.event.sequence).toBe(1);

    client.send({ type: "unsubscribe", id: "unsub-1", token, subscription: "sub-1" });
    const unsubAck = await client.nextFrame(
      (frame) => frame.type === "response",
    );
    expect(unsubAck).toMatchObject({ id: "unsub-1", ok: true });
    expect(control.listenerCount()).toBe(0);

    // Frames on one connection are ordered: if a stray event were queued it
    // would arrive before this ping response.
    control.emit(makeTraceEvent(2));
    client.send({ type: "ping", id: "after-unsub", token });
    const pong = await client.nextFrame(
      (frame) => frame.type === "response" && frame.id === "after-unsub",
    );
    expect(pong).toMatchObject({ ok: true });
    expect(client.hasFrame((frame) => frame.type === "event")).toBe(false);
  });

  it("drops subscriptions when a client disconnects", async () => {
    const paths = await startServer();
    const token = await readFile(paths.tokenPath, "utf8");
    const client = await connect(paths.socketPath);
    client.send({ type: "subscribe", id: "sub-gone", token });
    await client.nextFrame((frame) => frame.type === "response");
    expect(control.listenerCount()).toBe(1);

    await client.close();
    // The server learns about the disconnect asynchronously; poll instead of
    // racing its close event.
    await vi.waitFor(() => {
      expect(control.listenerCount()).toBe(0);
    });
  });

  it("replies to malformed frames and keeps the connection open", async () => {
    const paths = await startServer();
    const token = await readFile(paths.tokenPath, "utf8");
    const client = await connect(paths.socketPath);

    client.sendRaw("{definitely not json\n");
    const error = await client.nextFrame(isResponse);
    expect(error).toMatchObject({ ok: false });
    expect(error.ok === false && error.error).toMatch(/malformed frame/);

    client.send({ type: "ping", id: "after-garbage", token });
    const pong = await client.nextFrame(
      (frame) => frame.type === "response" && frame.id === "after-garbage",
    );
    expect(pong).toMatchObject({ ok: true });
  });

  it("disconnects clients that exceed the frame cap", async () => {
    const paths = await startServer();

    // One line larger than the cap.
    const oversized = await connect(paths.socketPath);
    oversized.sendRaw(`${"x".repeat(MAX_FRAME_BYTES + 16)}\n`);
    await oversized.closed;

    // A never-terminated frame that grows past the cap without a newline.
    const unterminated = await connect(paths.socketPath);
    unterminated.sendRaw("y".repeat(MAX_FRAME_BYTES + 16));
    await unterminated.closed;
  });

  it(
    "disconnects slow consumers while keeping responsive subscribers",
    async () => {
      const paths = await startServer({ maxBufferedEventBytes: 4 * 1024 });
      const token = await readFile(paths.tokenPath, "utf8");

      // A raw socket that never reads: once its kernel buffers fill, the
      // server's writableLength for this client grows past the bounded
      // event queue.
      const slowSocket = net.createConnection(paths.socketPath);
      await once(slowSocket, "connect");
      slowSocket.write(
        `${JSON.stringify({ type: "subscribe", id: "slow-sub", token })}\n`,
      );
      const fast = await connect(paths.socketPath);
      fast.send({ type: "subscribe", id: "fast-sub", token });
      await fast.nextFrame((frame) => frame.type === "response");
      // Wait until the server has registered the slow client's subscription;
      // it never reads, so it cannot ack directly.
      await vi.waitFor(() => {
        expect(control.listenerCount()).toBe(2);
      });

      // ~1 KiB payloads: the slow client's kernel buffers fill after a few
      // hundred events even with generous OS tuning. Yield between small
      // batches so the responsive client gets event-loop time to drain —
      // otherwise even a reading client looks slow during a blocking burst.
      // (A client that never reads never sees a close event — the FIN waits
      // behind its unread kernel buffer — so assert the server-side signal:
      // the dropped client's subscription disappears.)
      let sequence = 0;
      const fatEvent = (): TraceEvent => ({
        ...makeTraceEvent(sequence++),
        message: "m".repeat(1024),
      });
      while (control.listenerCount() === 2) {
        for (let i = 0; i < 20; i += 1) control.emit(fatEvent());
        if (sequence > 500_000) {
          throw new Error("Slow consumer was never disconnected.");
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      slowSocket.destroy();
      expect(control.listenerCount()).toBe(1);

      // The responsive subscriber is untouched and still receives events.
      control.emit(makeTraceEvent(sequence));
      const event = await fast.nextFrame((frame) => frame.type === "event");
      expect(event.type === "event" && event.subscription).toBe("fast-sub");
      expect(control.listenerCount()).toBe(1);
    },
    30_000,
  );

  it("accepts clients reconnecting after disconnect", async () => {
    const paths = await startServer();
    const token = await readFile(paths.tokenPath, "utf8");

    const first = await connect(paths.socketPath);
    first.send({ type: "ping", id: "first", token });
    await first.nextFrame((frame) => frame.type === "response");
    await first.close();

    const second = await connect(paths.socketPath);
    second.send({ type: "ping", id: "second", token });
    const response = await second.nextFrame(
      (frame) => frame.type === "response",
    );
    expect(response).toMatchObject({ id: "second", ok: true });
  });

  it("refuses to start over a live socket and removes a stale one", async () => {
    const dir = path.join(baseDir, CONTROL_SOCKET_DIR);
    await mkdir(dir, { recursive: true });
    const socketPath = path.join(dir, CONTROL_SOCKET_FILE);

    // A live owner: starting must fail without touching the socket file or
    // the live instance's token file.
    const occupant = net.createServer();
    await new Promise<void>((resolve) => {
      occupant.listen(socketPath, () => resolve());
    });
    const tokenPath = path.join(dir, CONTROL_TOKEN_FILE);
    const liveToken = "a".repeat(64);
    await writeFile(tokenPath, liveToken, { mode: 0o600 });
    server = new ControlSocketServer({ control, baseDir });
    await expect(server.start()).rejects.toThrow(/in use/);
    expect(await readFile(tokenPath, "utf8")).toBe(liveToken);
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    await new Promise<void>((resolve) => {
      occupant.close(() => resolve());
    });
    await server.close();

    // A stale file at the socket path (previous unclean shutdown): removed.
    await writeFile(socketPath, "");
    const paths = await startServer();
    expect((await stat(paths.socketPath)).isSocket()).toBe(true);
    const token = await readFile(paths.tokenPath, "utf8");
    const client = await connect(paths.socketPath);
    client.send({ type: "ping", id: "stale-check", token });
    const response = await client.nextFrame(
      (frame) => frame.type === "response",
    );
    expect(response).toMatchObject({ ok: true });
  });

  it("close disconnects clients, removes only the owned socket file", async () => {
    const paths = await startServer();
    const token = await readFile(paths.tokenPath, "utf8");
    const client = await connect(paths.socketPath);
    client.send({ type: "subscribe", id: "sub-close", token });
    await client.nextFrame((frame) => frame.type === "response");

    await server.close();
    await client.closed; // existing clients are disconnected
    expect(control.listenerCount()).toBe(0);
    await expect(stat(paths.socketPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    // The token file belongs to the app, not to a socket session.
    expect((await stat(paths.tokenPath)).mode & 0o777).toBe(0o600);
    // New connections fail after shutdown.
    await expect(TestClient.connect(paths.socketPath)).rejects.toThrow();
    // close() is idempotent.
    await server.close();
  });
});
