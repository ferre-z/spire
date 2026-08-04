import { describe, expect, it } from "vitest";
import {
  controlRequestSchema,
  controlResponseSchema,
} from "./coordinator-protocol";

describe("coordinator protocol", () => {
  it("rejects unknown operations", () => {
    expect(
      controlRequestSchema.safeParse({ operation: "runs.destroy", input: {} })
        .success,
    ).toBe(false);
  });

  it("requires exactly one response outcome", () => {
    expect(
      controlResponseSchema.safeParse({ ok: true, output: {} }).success,
    ).toBe(true);
    expect(
      controlResponseSchema.safeParse({ ok: false, error: "denied" }).success,
    ).toBe(true);
    expect(
      controlResponseSchema.safeParse({ ok: true, output: {}, error: "bad" })
        .success,
    ).toBe(false);
  });
});
