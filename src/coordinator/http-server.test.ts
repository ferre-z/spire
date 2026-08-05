import { afterEach, describe, expect, it } from "vitest";
import {
  CoordinatorHttpServer,
  type CoordinatorControl,
} from "./http-server";
import { CoordinatorEventStream } from "./event-stream";
import type { RunEvent } from "../shared/domain";

const TOKEN = "test-control-token";

class StubControl implements CoordinatorControl {
  async execute(operation: string, input: unknown): Promise<unknown> {
    if (operation === "state.get" && JSON.stringify(input) === "{}") {
      return { ready: true };
    }
    throw new Error("Unexpected control request.");
  }
}

type TestServer = {
  readonly server: CoordinatorHttpServer;
  readonly baseUrl: string;
};

async function startTestServer(): Promise<TestServer> {
  const server = new CoordinatorHttpServer({
    control: new StubControl(),
    events: new CoordinatorEventStream(),
    token: TOKEN,
    host: "127.0.0.1",
    port: 0,
  });
  const { host, port } = await server.start();
  return { server, baseUrl: `http://${host}:${port}` };
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

function authorizedFetch(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/v1/control`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("CoordinatorHttpServer", () => {
  const servers: CoordinatorHttpServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("serves authenticated coordinator control over a real HTTP socket", async () => {
    const testServer = await startTestServer();
    servers.push(testServer.server);

    expect((await fetch(`${testServer.baseUrl}/healthz`)).status).toBe(200);
    expect(
      (await fetch(`${testServer.baseUrl}/v1/control`, { method: "POST" })).status,
    ).toBe(401);
    expect(
      (await authorizedFetch(testServer.baseUrl, { operation: "runs.destroy", input: {} }))
        .status,
    ).toBe(400);
    expect(
      await (
        await authorizedFetch(testServer.baseUrl, {
          operation: "state.get",
          input: {},
        })
      ).json(),
    ).toEqual({ ok: true, output: { ready: true } });
  });

  it("returns the health payload over a real HTTP socket", async () => {
    const testServer = await startTestServer();
    servers.push(testServer.server);

    const response = await fetch(`${testServer.baseUrl}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", protocolVersion: 1 });
  });

  it("rejects an invalid bearer token over a real HTTP socket", async () => {
    const testServer = await startTestServer();
    servers.push(testServer.server);

    const response = await fetch(`${testServer.baseUrl}/v1/control`, {
      method: "POST",
      headers: {
        Authorization: "Bearer invalid-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ operation: "state.get", input: {} }),
    });

    expect(response.status).toBe(401);
  });

  it("rejects invalid JSON over a real HTTP socket", async () => {
    const testServer = await startTestServer();
    servers.push(testServer.server);

    const response = await fetch(`${testServer.baseUrl}/v1/control`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: "not-json",
    });

    expect(response.status).toBe(400);
  });

  it("returns 404 for an unsupported route over a real HTTP socket", async () => {
    const testServer = await startTestServer();
    servers.push(testServer.server);

    expect((await fetch(`${testServer.baseUrl}/not-found`)).status).toBe(404);
  });

  it("does not expose control handler errors over a real HTTP socket", async () => {
    const testServer = await startTestServer();
    servers.push(testServer.server);

    const response = await authorizedFetch(testServer.baseUrl, {
      operation: "diagnostics.get",
      input: {},
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Internal server error.",
    });
  });

  it("rejects a request body larger than one MiB", async () => {
    const testServer = await startTestServer();
    servers.push(testServer.server);

    const response = await fetch(`${testServer.baseUrl}/v1/control`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: "x".repeat(1_048_577),
    });

    expect(response.status).toBe(413);
  });

  it("closes idempotently", async () => {
    const testServer = await startTestServer();

    await testServer.server.close();
    await expect(testServer.server.close()).resolves.toBeUndefined();
  });

  it("streams authenticated run events as SSE frames over a real HTTP socket", async () => {
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

    const response = await fetch(`http://${host}:${port}/v1/events`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("SSE response body is unavailable.");
    events.publish(runEvent("first"));
    const frame = await reader.read();

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(new TextDecoder().decode(frame.value)).toContain(
      'id: 1\nevent: run.event\ndata: {"id":"event-first","runId":"run-1","sequence":0,"timestamp":"2026-08-05T10:00:00.000Z","kind":"status","phase":"preparing","message":"first"}\n\n',
    );

    await reader.cancel();
  });

  it("replays events after Last-Event-ID over a real HTTP socket", async () => {
    const events = new CoordinatorEventStream();
    events.publish(runEvent("first"));
    events.publish(runEvent("second"));
    events.publish(runEvent("third"));
    const server = new CoordinatorHttpServer({
      control: new StubControl(),
      events,
      token: TOKEN,
      host: "127.0.0.1",
      port: 0,
    });
    const { host, port } = await server.start();
    servers.push(server);

    const response = await fetch(`http://${host}:${port}/v1/events`, {
      headers: { Authorization: `Bearer ${TOKEN}`, "Last-Event-ID": "1" },
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("SSE response body is unavailable.");
    try {
      const nextFrame = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("Expected replay frames.")), 100);
        }),
      ]);
      const frames = new TextDecoder().decode(nextFrame.value);

      expect(frames).toContain('id: 2\nevent: run.event\ndata: {"id":"event-second"');
      expect(frames).toContain('id: 3\nevent: run.event\ndata: {"id":"event-third"');
    } finally {
      await reader.cancel();
    }
  });
});
