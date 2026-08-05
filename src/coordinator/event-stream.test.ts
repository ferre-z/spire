import { describe, expect, it } from "vitest";
import type { RunEvent } from "../shared/domain";
import { CoordinatorEventStream } from "./event-stream";

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

describe("CoordinatorEventStream", () => {
  it("assigns monotonic IDs and replays entries after the supplied cursor", () => {
    const stream = new CoordinatorEventStream();

    stream.publish(runEvent("one"));
    stream.publish(runEvent("two"));
    stream.publish(runEvent("three"));

    expect(stream.replayAfter(1).map((entry) => entry.sequence)).toEqual([2, 3]);
  });

  it("delivers future entries to a subscriber until it is closed", () => {
    const stream = new CoordinatorEventStream();
    const received: number[] = [];
    const subscription = stream.subscribe(undefined, (entry) => {
      if (entry.type === "event") received.push(entry.sequence);
    });

    stream.publish(runEvent("one"));
    subscription.close();
    stream.publish(runEvent("two"));

    expect(received).toEqual([1]);
  });

  it("sends reset when a replay cursor predates the retained window", () => {
    const stream = new CoordinatorEventStream();
    for (let index = 0; index < 1_001; index += 1) {
      stream.publish(runEvent(String(index)));
    }
    const received: string[] = [];

    const subscription = stream.subscribe(0, (entry) => received.push(entry.type));
    subscription.close();

    expect(received).toEqual(["reset"]);
  });
});
