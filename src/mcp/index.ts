import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSpireMcpServer } from "./tool-registry";
import {
  ControlSocketClient,
  defaultUserDataDir,
  resolveControlPaths,
} from "./socket-client";

/**
 * Spire MCP stdio sidecar entry point.
 *
 * Connects to the running Spire app's control socket and serves the full
 * control plane (tools, resources, live trace logs) over MCP stdio. This
 * process is plain Node — no Electron — so MCP clients (Claude Code, IDEs)
 * can spawn it directly. If Spire is not running it exits with one actionable
 * error naming the expected socket path and how to launch the app.
 */

export async function main(): Promise<void> {
  const paths = resolveControlPaths(defaultUserDataDir());
  const channel = new ControlSocketClient(paths);
  await channel.connect();
  const server = createSpireMcpServer(channel);
  await server.connect(new StdioServerTransport());
}

void main().catch((error: unknown) => {
  // stderr only: stdout is the MCP transport and must stay clean JSON-RPC.
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
