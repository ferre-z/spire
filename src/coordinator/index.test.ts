import { describe, expect, it } from "vitest";
import { readCoordinatorConfig } from "./config";
import { formatCoordinatorStartupError } from "./index";

describe("coordinator executable startup errors", () => {
  it("reports invalid configuration without exposing environment values", () => {
    const token = "never-print-this-token";
    let startupError: unknown;
    try {
      readCoordinatorConfig({
        SPIRE_COORDINATOR_TOKEN: token,
        SPIRE_COORDINATOR_PORT: "not-a-port",
      }, "/srv/spire");
    } catch (error: unknown) {
      startupError = error;
    }

    const diagnostic = formatCoordinatorStartupError(startupError);

    expect(diagnostic).toContain("SPIRE_COORDINATOR_PORT");
    expect(diagnostic).not.toContain(token);
  });

  it("uses a fixed diagnostic for unexpected startup errors", () => {
    const token = "never-print-this-token";

    const diagnostic = formatCoordinatorStartupError(new Error(`failed with ${token}`));

    expect(diagnostic).toBe("Coordinator failed to start.\n");
  });
});
