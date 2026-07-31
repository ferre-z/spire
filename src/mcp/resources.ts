import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LoggingMessageNotification } from "@modelcontextprotocol/sdk/types.js";
import { CONTROL_PAGE_MAX_LIMIT } from "../shared/control";
import type { TraceEvent, TraceLevel } from "../shared/trace";
import type { ControlChannel } from "./socket-client";

/**
 * MCP resources for the Spire control plane.
 *
 * `spire://state` serves the live app snapshot; templates expose individual
 * graphs, runs, run artifacts, and per-run trace journals. Every read goes
 * through the same control operations as the tools, so payloads are already
 * redacted by the trace journal before they cross the socket — no redaction
 * happens (or is needed) here.
 */

export const SPIRE_STATE_RESOURCE_URI = "spire://state";

export type SpireResourceTemplate = {
  name: string;
  uriTemplate: string;
  description: string;
};

export const SPIRE_RESOURCE_TEMPLATES: SpireResourceTemplate[] = [
  {
    name: "graph",
    uriTemplate: "spire://graphs/{graphId}",
    description: "One agent graph by id.",
  },
  {
    name: "run",
    uriTemplate: "spire://runs/{runId}",
    description: "One run by id, including status and events.",
  },
  {
    name: "run-artifacts",
    uriTemplate: "spire://runs/{runId}/artifacts",
    description: "A run's artifacts: diff, changed files, brief, report, verdict.",
  },
  {
    name: "run-traces",
    uriTemplate: "spire://traces/{runId}",
    description: "Redacted trace journal events for one run.",
  },
  {
    name: "run-plan",
    uriTemplate: "spire://runs/{runId}/plan",
    description: "The persisted execution plan for a run.",
  },
  {
    name: "run-node",
    uriTemplate: "spire://runs/{runId}/nodes/{nodeId}",
    description: "One node execution from a run's plan.",
  },
  {
    name: "run-messages",
    uriTemplate: "spire://runs/{runId}/messages",
    description: "Collaboration messages for a run (first page).",
  },
  {
    name: "run-patches",
    uriTemplate: "spire://runs/{runId}/patches",
    description: "Applied plan patches for a run.",
  },
];

const JSON_MIME = "application/json";

function jsonContents(uri: string, value: unknown) {
  return {
    contents: [
      {
        uri,
        mimeType: JSON_MIME,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function templateVariable(
  variables: Record<string, unknown>,
  name: string,
): string {
  const value = variables[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing resource variable: ${name}`);
  }
  return value;
}

/** Register the state resource plus the graph/run/artifact/trace templates. */
export function registerSpireResources(
  server: McpServer,
  channel: ControlChannel,
): void {
  server.registerResource(
    "state",
    SPIRE_STATE_RESOURCE_URI,
    {
      title: "Spire state",
      description: "Live snapshot of graphs, runs, models, and OpenCode status.",
      mimeType: JSON_MIME,
    },
    async (uri) => jsonContents(uri.href, await channel.execute("state.get", {})),
  );

  server.registerResource(
    "graph",
    new ResourceTemplate("spire://graphs/{graphId}", { list: undefined }),
    { description: "One agent graph by id.", mimeType: JSON_MIME },
    async (uri, variables) =>
      jsonContents(
        uri.href,
        await channel.execute("graphs.get", {
          graphId: templateVariable(variables, "graphId"),
        }),
      ),
  );

  server.registerResource(
    "run",
    new ResourceTemplate("spire://runs/{runId}", { list: undefined }),
    { description: "One run by id.", mimeType: JSON_MIME },
    async (uri, variables) =>
      jsonContents(
        uri.href,
        await channel.execute("runs.get", {
          runId: templateVariable(variables, "runId"),
        }),
      ),
  );

  server.registerResource(
    "run-artifacts",
    new ResourceTemplate("spire://runs/{runId}/artifacts", { list: undefined }),
    { description: "A run's artifacts.", mimeType: JSON_MIME },
    async (uri, variables) =>
      jsonContents(
        uri.href,
        await channel.execute("runs.artifacts.get", {
          runId: templateVariable(variables, "runId"),
        }),
      ),
  );

  server.registerResource(
    "run-traces",
    new ResourceTemplate("spire://traces/{runId}", { list: undefined }),
    { description: "Trace journal events for one run.", mimeType: JSON_MIME },
    async (uri, variables) =>
      jsonContents(
        uri.href,
        await channel.execute("traces.query", {
          runId: templateVariable(variables, "runId"),
        }),
      ),
  );

  server.registerResource(
    "run-plan",
    new ResourceTemplate("spire://runs/{runId}/plan", {
      list: undefined,
    }),
    {
      description: "The persisted execution plan for a run.",
      mimeType: JSON_MIME,
    },
    async (uri, variables) =>
      jsonContents(
        uri.href,
        await channel.execute("runs.plan.get", {
          runId: templateVariable(variables, "runId"),
        }),
      ),
  );

  server.registerResource(
    "run-node",
    new ResourceTemplate("spire://runs/{runId}/nodes/{nodeId}", {
      list: undefined,
    }),
    {
      description: "One node execution from a run's plan.",
      mimeType: JSON_MIME,
    },
    async (uri, variables) => {
      const runId = templateVariable(variables, "runId");
      const nodeId = templateVariable(variables, "nodeId");
      const page = await channel.execute("runs.nodes.list", {
        runId,
        limit: CONTROL_PAGE_MAX_LIMIT,
      });
      const node = page.nodes.find((item) => item.nodeId === nodeId);
      if (!node) {
        throw new Error(`Node ${nodeId} not found in run ${runId}.`);
      }
      return jsonContents(uri.href, node);
    },
  );

  server.registerResource(
    "run-messages",
    new ResourceTemplate("spire://runs/{runId}/messages", {
      list: undefined,
    }),
    {
      description: "Collaboration messages for a run (first page).",
      mimeType: JSON_MIME,
    },
    async (uri, variables) =>
      jsonContents(
        uri.href,
        await channel.execute("runs.messages.list", {
          runId: templateVariable(variables, "runId"),
          limit: CONTROL_PAGE_MAX_LIMIT,
        }),
      ),
  );

  server.registerResource(
    "run-patches",
    new ResourceTemplate("spire://runs/{runId}/patches", {
      list: undefined,
    }),
    {
      description: "Applied plan patches for a run.",
      mimeType: JSON_MIME,
    },
    async (uri, variables) => {
      const runId = templateVariable(variables, "runId");
      const plan = await channel.execute("runs.plan.get", { runId });
      return jsonContents(uri.href, plan.patches);
    },
  );
}

const TRACE_TO_MCP_LEVEL: Record<
  TraceLevel,
  LoggingMessageNotification["params"]["level"]
> = {
  debug: "debug",
  info: "info",
  warn: "warning",
  error: "error",
};

/** Map a trace event onto an MCP logging notification payload. */
export function traceToLoggingParams(
  event: TraceEvent,
): LoggingMessageNotification["params"] {
  return {
    level: TRACE_TO_MCP_LEVEL[event.level],
    logger: "spire",
    data: event,
  };
}
