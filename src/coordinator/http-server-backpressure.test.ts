import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { RunEvent } from "../shared/domain";
import { CoordinatorEventStream } from "./event-stream";
import { CoordinatorHttpServer, type CoordinatorControl } from "./http-server";

const TOKEN = "test-control-token";

class StubControl implements CoordinatorControl {
  async execute(): Promise<unknown> {
    return { ready: true };
  }
}

function runEvent(message: string): RunEvent {
  return {
    id: `event-${message}`,
    runId: "run-1",
    sequence: 0,
    timestamp: "2026-08-05T10:00:00.000Z",
    kind: "status",
    phase: "preparing",
    message,
  };
}

describe("CoordinatorHttpServer SSE backpressure", () => {
  const servers: CoordinatorHttpServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("disconnects a backpressured client without blocking later subscribers", async () => {
    const events = new CoordinatorEventStream();
    const server = new CoordinatorHttpServer({
      control: new StubControl(),
      events,
      token: TOKEN,
      host: "127.0.0.1",
      port: 0,
    });
    const { host, port } = await server.start();
    servers.push(server);
    const socket = connect({ host, port });
    socket.write([
      "GET /v1/events HTTP/1.1",
      `Host: ${host}:${port}`,
      `Authorization: Bearer ${TOKEN}`,
      "Connection: keep-alive",
      "",
      "",
    ].join("\r\n"));
    await new Promise<void>((resolve) => socket.once("data", () => resolve()));
    socket.pause();

    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    events.publish(runEvent("x".repeat(256 * 1024)));
    await expect(Promise.race([
      closed.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
    ])).resolves.toBe(true);

    const response = await fetch(`http://${host}:${port}/v1/events`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("SSE response body is unavailable.");
    events.publish(runEvent("responsive"));
    const frame = await reader.read();
    expect(new TextDecoder().decode(frame.value)).toContain('"message":"responsive"');
    await reader.cancel();
  });
});
