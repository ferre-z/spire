import type { Server, ServerResponse } from "node:http";

const SSE_SHUTDOWN_GRACE_MS = 250;

export class SseConnectionRegistry {
  private readonly responses = new Set<ServerResponse>();

  register(response: ServerResponse): () => void {
    this.responses.add(response);
    let isRegistered = true;
    return () => {
      if (!isRegistered) return;
      isRegistered = false;
      this.responses.delete(response);
    };
  }

  beginShutdown(): () => void {
    for (const response of this.responses) response.end();
    const forceClose = setTimeout(() => {
      for (const response of this.responses) response.destroy();
    }, SSE_SHUTDOWN_GRACE_MS);
    forceClose.unref();
    return () => clearTimeout(forceClose);
  }
}

export async function closeHttpServer(
  server: Server | undefined,
  connections: SseConnectionRegistry,
): Promise<void> {
  if (!server?.listening) return;
  const cancelForceClose = connections.beginShutdown();
  try {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) {
          resolve();
          return;
        }
        reject(error);
      });
    });
  } finally {
    cancelForceClose();
  }
}
