import path from "node:path";
import { describe, expect, it } from "vitest";
import { readCoordinatorConfig } from "./config";

describe("readCoordinatorConfig", () => {
  it("uses loopback, the coordinator port, and a cwd-local data root by default", () => {
    const config = readCoordinatorConfig(
      { SPIRE_COORDINATOR_TOKEN: "test-token" },
      "/srv/spire",
    );

    expect(config).toEqual({
      token: "test-token",
      host: "127.0.0.1",
      port: 43110,
      dataRoot: path.join("/srv/spire", ".spire-data"),
      tls: undefined,
    });
  });

  it("rejects a missing coordinator token", () => {
    expect(() => readCoordinatorConfig({}, "/srv/spire")).toThrow(
      /SPIRE_COORDINATOR_TOKEN/,
    );
  });

  it("rejects port zero outside tests", () => {
    expect(() =>
      readCoordinatorConfig(
        {
          SPIRE_COORDINATOR_TOKEN: "test-token",
          SPIRE_COORDINATOR_PORT: "0",
          NODE_ENV: "production",
        },
        "/srv/spire",
      ),
    ).toThrow(/SPIRE_COORDINATOR_PORT/);
  });

  it("rejects a non-integer port", () => {
    expect(() =>
      readCoordinatorConfig(
        {
          SPIRE_COORDINATOR_TOKEN: "test-token",
          SPIRE_COORDINATOR_PORT: "43110.5",
        },
        "/srv/spire",
      ),
    ).toThrow(/SPIRE_COORDINATOR_PORT/);
  });

  it("rejects remote binding unless explicitly enabled", () => {
    expect(() =>
      readCoordinatorConfig(
        {
          SPIRE_COORDINATOR_TOKEN: "test-token",
          SPIRE_COORDINATOR_HOST: "0.0.0.0",
        },
        "/srv/spire",
      ),
    ).toThrow(/SPIRE_ALLOW_REMOTE/);
  });

  it("rejects remote binding without a paired TLS certificate and key", () => {
    expect(() =>
      readCoordinatorConfig(
        {
          SPIRE_COORDINATOR_TOKEN: "test-token",
          SPIRE_COORDINATOR_HOST: "0.0.0.0",
          SPIRE_ALLOW_REMOTE: "1",
        },
        "/srv/spire",
      ),
    ).toThrow(/SPIRE_COORDINATOR_TLS_CERT/);
  });

  it("rejects an unpaired TLS certificate path", () => {
    expect(() =>
      readCoordinatorConfig(
        {
          SPIRE_COORDINATOR_TOKEN: "test-token",
          SPIRE_COORDINATOR_TLS_CERT: "/run/secrets/coordinator.crt",
        },
        "/srv/spire",
      ),
    ).toThrow(/SPIRE_COORDINATOR_TLS_KEY/);
  });

  it("permits remote binding with explicit opt-in and paired TLS paths", () => {
    const config = readCoordinatorConfig({
      SPIRE_COORDINATOR_TOKEN: "test-token",
      SPIRE_COORDINATOR_HOST: "0.0.0.0",
      SPIRE_ALLOW_REMOTE: "1",
      SPIRE_COORDINATOR_TLS_CERT: "/run/secrets/coordinator.crt",
      SPIRE_COORDINATOR_TLS_KEY: "/run/secrets/coordinator.key",
    }, "/srv/spire");

    expect(config.tls).toEqual({
      certificatePath: "/run/secrets/coordinator.crt",
      privateKeyPath: "/run/secrets/coordinator.key",
    });
  });
});
