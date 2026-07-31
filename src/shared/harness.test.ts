import { describe, expect, it } from "vitest";
import { harnessEventSchema } from "./harness";

const session = {
  harnessId: "opencode",
  sessionId: "ses_1",
  directory: "/tmp/work",
};

describe("harnessEventSchema", () => {
  it("accepts a session-created event with a full session ref", () => {
    const event = { type: "session", session };
    expect(harnessEventSchema.parse(event)).toEqual(event);
  });

  it("accepts an assistant text event", () => {
    const event = { type: "assistant_text", text: "Hello" };
    expect(harnessEventSchema.parse(event)).toEqual(event);
  });

  it("accepts a reasoning event", () => {
    const event = { type: "reasoning", text: "Thinking..." };
    expect(harnessEventSchema.parse(event)).toEqual(event);
  });

  it("accepts a tool start event with input", () => {
    const event = {
      type: "tool_start",
      tool: "bash",
      input: { command: "ls" },
    };
    expect(harnessEventSchema.parse(event)).toEqual(event);
  });

  it("accepts a tool progress event", () => {
    const event = { type: "tool_progress", tool: "bash", message: "Running ls" };
    expect(harnessEventSchema.parse(event)).toEqual(event);
  });

  it("accepts a tool result event with output", () => {
    const event = { type: "tool_result", tool: "bash", output: "file.txt" };
    expect(harnessEventSchema.parse(event)).toEqual(event);
  });

  it("accepts a tool result event with an error", () => {
    const event = { type: "tool_result", tool: "bash", error: "exit 1" };
    expect(harnessEventSchema.parse(event)).toEqual(event);
  });

  it("accepts an approval event", () => {
    const event = {
      type: "approval",
      id: "per_1",
      permission: "bash",
      title: "Run ls",
      pattern: "ls *",
    };
    expect(harnessEventSchema.parse(event)).toEqual(event);
  });

  it("accepts a usage event with token counts", () => {
    const event = {
      type: "usage",
      tokens: { input: 10, output: 5, reasoning: 2, cacheRead: 1, cacheWrite: 0 },
      cost: 0.01,
    };
    expect(harnessEventSchema.parse(event)).toEqual(event);
  });

  it("accepts stdout and stderr events", () => {
    expect(harnessEventSchema.parse({ type: "stdout", text: "out" })).toEqual({
      type: "stdout",
      text: "out",
    });
    expect(harnessEventSchema.parse({ type: "stderr", text: "err" })).toEqual({
      type: "stderr",
      text: "err",
    });
  });

  it("accepts a warning event", () => {
    const event = { type: "warning", message: "Retrying request" };
    expect(harnessEventSchema.parse(event)).toEqual(event);
  });

  it("accepts an error event", () => {
    const event = { type: "error", message: "Provider failed" };
    expect(harnessEventSchema.parse(event)).toEqual(event);
  });

  it("accepts a timeout event", () => {
    const event = { type: "timeout", message: "Timed out starting harness" };
    expect(harnessEventSchema.parse(event)).toEqual(event);
  });

  it("accepts a cancellation event", () => {
    const event = { type: "cancelled", message: "Aborted by user" };
    expect(harnessEventSchema.parse(event)).toEqual(event);
  });

  it("rejects an unknown event type", () => {
    expect(() =>
      harnessEventSchema.parse({ type: "mystery", message: "?" }),
    ).toThrow();
  });

  it("rejects a malformed session ref", () => {
    expect(() =>
      harnessEventSchema.parse({
        type: "session",
        session: { harnessId: "opencode", sessionId: "ses_1" },
      }),
    ).toThrow();
  });
});
