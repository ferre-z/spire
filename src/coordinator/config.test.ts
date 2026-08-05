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

  it("permits remote binding when explicitly enabled", () => {
    const config = readCoordinatorConfig(
      {
        SPIRE_COORDINATOR_TOKEN: "test-token",
        SPIRE_COORDINATOR_HOST: "0.0.0.0",
        SPIRE_ALLOW_REMOTE: "1",
      },
      "/srv/spire",
    );

    expect(config.host).toBe("0.0.0.0");
  });
});
