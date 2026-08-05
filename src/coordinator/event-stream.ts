import type { RunEvent } from "../shared/domain";

const MAX_REPLAY_ENTRIES = 1_000;

export type CoordinatorEventStreamEntry = Readonly<{
  readonly type: "event";
  readonly sequence: number;
  readonly event: RunEvent;
}>;

export type CoordinatorEventStreamReset = Readonly<{
  readonly type: "reset";
}>;

export type CoordinatorEventStreamNotification =
  | CoordinatorEventStreamEntry
  | CoordinatorEventStreamReset;

export type CoordinatorEventStreamSubscription = Readonly<{
  close(): void;
}>;

export type CoordinatorEventStreamSubscriber = (
  notification: CoordinatorEventStreamNotification,
) => void;

export class CoordinatorEventStream {
  private nextSequence = 1;
  private entries: CoordinatorEventStreamEntry[] = [];
  private readonly subscribers = new Set<CoordinatorEventStreamSubscriber>();

  publish(event: RunEvent): void {
    const entry: CoordinatorEventStreamEntry = {
      type: "event",
      sequence: this.nextSequence,
      event,
    };
    this.nextSequence += 1;
    this.entries.push(entry);
    if (this.entries.length > MAX_REPLAY_ENTRIES) this.entries.shift();
    for (const subscriber of this.subscribers) subscriber(entry);
  }

  replayAfter(afterSequence: number): readonly CoordinatorEventStreamEntry[] {
    return this.entries.filter((entry) => entry.sequence > afterSequence);
  }

  subscribe(
    afterSequence: number | undefined,
    subscriber: CoordinatorEventStreamSubscriber,
  ): CoordinatorEventStreamSubscription {
    const cursor = afterSequence ?? this.nextSequence - 1;
    if (this.requiresReset(cursor)) {
      subscriber({ type: "reset" });
    } else {
      for (const entry of this.replayAfter(cursor)) subscriber(entry);
    }
    this.subscribers.add(subscriber);
    let closed = false;

    return {
      close: () => {
        if (closed) return;
        closed = true;
        this.subscribers.delete(subscriber);
      },
    };
  }

  private requiresReset(afterSequence: number): boolean {
    const oldestSequence = this.entries[0]?.sequence;
    return oldestSequence !== undefined && afterSequence < oldestSequence - 1;
  }
}
