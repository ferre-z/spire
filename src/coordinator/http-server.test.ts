import { afterEach, describe, expect, it } from "vitest";
import {
  CoordinatorHttpServer,
  type CoordinatorControl,
} from "./http-server";

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
    token: TOKEN,
    host: "127.0.0.1",
    port: 0,
  });
  const { host, port } = await server.start();
  return { server, baseUrl: `http://${host}:${port}` };
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
});
