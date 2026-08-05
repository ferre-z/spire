import type { ServerResponse } from "node:http";
import {
  type CoordinatorEventStreamNotification,
  CoordinatorEventStream,
} from "./event-stream";
import { SseConnectionRegistry } from "./sse-connections";

function sseFrame(notification: CoordinatorEventStreamNotification): string {
  switch (notification.type) {
    case "event":
      return `id: ${notification.sequence}\nevent: run.event\ndata: ${JSON.stringify(notification.event)}\n\n`;
    case "reset":
      return 'event: reset\ndata: {"action":"fetch_snapshot"}\n\n';
    default: {
      const exhaustiveNotification: never = notification;
      throw new Error(`Unexpected event stream notification: ${exhaustiveNotification}`);
    }
  }
}

export function streamCoordinatorEvents(
  response: ServerResponse,
  events: CoordinatorEventStream,
  connections: SseConnectionRegistry,
  afterSequence: number | undefined,
): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();
  const unregister = connections.register(response);
  const state: {
    subscription?: ReturnType<CoordinatorEventStream["subscribe"]>;
    heartbeat?: NodeJS.Timeout;
    released: boolean;
  } = { released: false };
  const release = (): void => {
    if (state.released) return;
    state.released = true;
    unregister();
    if (state.heartbeat) clearInterval(state.heartbeat);
    state.subscription?.close();
    if (!response.destroyed) response.destroy();
  };
  const write = (payload: string): void => {
    if (state.released || response.writableEnded || response.destroyed) return;
    if (!response.write(payload)) release();
  };
  state.subscription = events.subscribe(afterSequence, (notification) => {
    write(sseFrame(notification));
  });
  if (state.released) {
    state.subscription.close();
    return;
  }
  state.heartbeat = setInterval(() => write(": heartbeat\n\n"), 15_000);
  state.heartbeat.unref();
  response.once("close", release);
}
