import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinatorEventStream } from "./event-stream";
import { CoordinatorHttpServer, type CoordinatorControl } from "./http-server";

const TOKEN = "test-control-token";
const executeFile = promisify(execFile);

class StubControl implements CoordinatorControl {
  async execute(): Promise<unknown> {
    return { ready: true };
  }
}

async function createTestTlsIdentity(): Promise<Readonly<{
  certificate: Buffer;
  privateKey: Buffer;
}>> {
  const directory = await mkdtemp(path.join(tmpdir(), "spire-coordinator-tls-"));
  const certificatePath = path.join(directory, "certificate.pem");
  const privateKeyPath = path.join(directory, "private-key.pem");
  await executeFile("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", privateKeyPath,
    "-out", certificatePath,
    "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1",
    "-days", "1",
  ]);
  try {
    return {
      certificate: await readFile(certificatePath),
      privateKey: await readFile(privateKeyPath),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function requestHttpsHealth(
  host: string,
  port: number,
  certificate: Buffer,
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const healthRequest = request({
      host,
      port,
      path: "/healthz",
      ca: certificate,
      rejectUnauthorized: true,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    healthRequest.once("error", reject);
    healthRequest.end();
  });
}

function createServer(tls?: Readonly<{
  certificate: Buffer;
  privateKey: Buffer;
}>): CoordinatorHttpServer {
  return new CoordinatorHttpServer({
    control: new StubControl(),
    events: new CoordinatorEventStream(),
    token: TOKEN,
    host: "127.0.0.1",
    port: 0,
    tls,
  });
}

describe("CoordinatorHttpServer TLS", () => {
  const servers: CoordinatorHttpServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("serves HTTPS with a validated certificate and private key", async () => {
    const tls = await createTestTlsIdentity();
    const server = createServer(tls);
    const address = await server.start();
    servers.push(server);

    const status = await requestHttpsHealth(address.host, address.port, tls.certificate);

    expect(address.protocol).toBe("https");
    expect(status).toBe(200);
  });

  it("rejects a certificate and private key that do not match", async () => {
    const firstIdentity = await createTestTlsIdentity();
    const secondIdentity = await createTestTlsIdentity();
    const server = createServer({
      certificate: firstIdentity.certificate,
      privateKey: secondIdentity.privateKey,
    });

    await expect(server.start()).rejects.toThrow(/certificate|key/i);
  });

  it("rejects a non-loopback listener without TLS", async () => {
    const server = new CoordinatorHttpServer({
      control: new StubControl(),
      events: new CoordinatorEventStream(),
      token: TOKEN,
      host: "0.0.0.0",
      port: 0,
    });

    await expect(server.start()).rejects.toThrow(/TLS/);
  });
});
