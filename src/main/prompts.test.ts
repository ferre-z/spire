import { describe, expect, it } from "vitest";
import { taskBriefSchema } from "../shared/domain";
import { parseJson } from "./prompts";

describe("parseJson", () => {
  it("parses raw structured output", () => {
    const result = parseJson(
      JSON.stringify({
        goal: "Add a health check",
        constraints: [],
        acceptanceChecks: ["returns ok"],
        implementationNotes: [],
      }),
      taskBriefSchema,
    );
    expect(result.goal).toBe("Add a health check");
  });

  it("tolerates a markdown fence for repair resilience", () => {
    const result = parseJson(
      '```json\n{"goal":"x","constraints":[],"acceptanceChecks":["y"],"implementationNotes":[]}\n```',
      taskBriefSchema,
    );
    expect(result.acceptanceChecks).toEqual(["y"]);
  });

  it("rejects missing required fields", () => {
    expect(() => parseJson('{"goal":"x"}', taskBriefSchema)).toThrow();
  });
});
