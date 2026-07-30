import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  CONTROL_CAPABILITIES,
  type ControlCapability,
  type ControlOperationMap,
  type ControlOperationName,
  type Diagnostics,
  type GraphPage,
  type HarnessStatus,
  type RepositoryValidation,
  type RunPage,
} from "../shared/control";
import type {
  AppSnapshot,
  GraphDefinition,
  ModelOption,
  RunArtifacts,
  RunRecord,
} from "../shared/domain";
import type { TracePage } from "../shared/trace";
import type { WorkspaceLayoutRecord } from "../shared/workspace";
import {
  registerSpireResources,
  traceToLoggingParams,
} from "./resources";
import type { ControlChannel } from "./socket-client";

/**
 * MCP tool surface for the Spire control plane.
 *
 * Every control capability maps to exactly one MCP tool with a stable
 * `spire_*` name. Annotations come straight from the capability metadata and
 * the capability Zod schemas are registered verbatim, so the MCP boundary
 * validates inputs exactly like the socket server does. Tools return
 * `structuredContent` (the operation output; array outputs wrapped as
 * `{ items }` because MCP structured content must be an object) plus a
 * concise one-line text summary.
 */

export const TOOL_NAMES: Record<ControlOperationName, string> = {
  "state.get": "spire_state_get",
  "diagnostics.get": "spire_diagnostics_get",
  "graphs.list": "spire_graphs_list",
  "graphs.get": "spire_graphs_get",
  "graphs.save": "spire_graphs_save",
  "repositories.validate": "spire_repositories_validate",
  "runs.list": "spire_runs_list",
  "runs.get": "spire_runs_get",
  "runs.start": "spire_runs_start",
  "runs.stop": "spire_runs_stop",
  "runs.retry": "spire_runs_retry",
  "runs.artifacts.get": "spire_run_artifacts_get",
  "worktrees.cleanup": "spire_worktrees_cleanup",
  "layouts.list": "spire_layouts_list",
  "layouts.save": "spire_layouts_save",
  "layouts.reset": "spire_layouts_reset",
  "harnesses.list": "spire_harnesses_list",
  "harnesses.models": "spire_harnesses_models",
  "traces.query": "spire_traces_query",
  "traces.tail": "spire_traces_tail",
};

const TOOL_DESCRIPTIONS: Record<ControlOperationName, string> = {
  "state.get": "Get a snapshot of Spire state: graphs, runs, models, and OpenCode status.",
  "diagnostics.get": "Get Spire diagnostics: version, platform, and control-plane counts.",
  "graphs.list": "List saved agent graphs (paginated).",
  "graphs.get": "Get one agent graph by id (optionally a specific version).",
  "graphs.save": "Save (create or update) an agent graph definition.",
  "repositories.validate": "Check whether a path is a usable git repository.",
  "runs.list": "List runs, optionally filtered by graph, repository, or status.",
  "runs.get": "Get one run by id, including its events and status.",
  "runs.start": "Start a new run of a graph against a repository with a goal.",
  "runs.stop": "Stop a running run.",
  "runs.retry": "Retry a failed or stopped run.",
  "runs.artifacts.get": "Get a run's artifacts: diff, changed files, brief, report, verdict.",
  "worktrees.cleanup": "Delete the git worktree(s) of a finished run (destructive).",
  "layouts.list": "List saved workspace layouts for a graph.",
  "layouts.save": "Save a workspace layout for a graph.",
  "layouts.reset": "Reset a graph's saved workspace layouts (destructive).",
  "harnesses.list": "List agent harnesses and their connection status.",
  "harnesses.models": "List the models a harness offers.",
  "traces.query": "Query the redacted execution trace journal with filters.",
  "traces.tail": "Read trace events after a journal sequence number.",
};

export type McpToolDefinition = {
  name: string;
  operation: ControlOperationName;
  description: string;
  annotations: ToolAnnotations;
  inputSchema: ControlCapability["inputSchema"];
  /** Object schema; array capability outputs are wrapped as `{ items }`. */
  outputSchema: z.ZodType;
};

function annotationsFor(
  capability: ControlCapability,
): ToolAnnotations {
  return {
    readOnlyHint: capability.readOnly,
    destructiveHint: capability.destructive,
    idempotentHint: capability.idempotent,
    openWorldHint: false,
  };
}

/** MCP structured content must be an object: wrap array outputs. */
function mcpOutputSchema(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodArray) {
    return z.strictObject({ items: schema });
  }
  return schema;
}

function isArrayOutput(schema: z.ZodType): boolean {
  return schema instanceof z.ZodArray;
}

export const MCP_TOOLS: McpToolDefinition[] = (
  Object.keys(CONTROL_CAPABILITIES) as ControlOperationName[]
).map((operation) => {
  const capability = CONTROL_CAPABILITIES[operation];
  return {
    name: TOOL_NAMES[operation],
    operation,
    description: TOOL_DESCRIPTIONS[operation],
    annotations: annotationsFor(capability),
    inputSchema: capability.inputSchema,
    outputSchema: mcpOutputSchema(capability.outputSchema),
  };
});

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Concise one-line summary of a control output, for tool text content. */
export function summarizeToolResult(
  operation: ControlOperationName,
  output: unknown,
): string {
  switch (operation) {
    case "state.get": {
      const snapshot = output as AppSnapshot;
      return (
        `Spire state: ${plural(snapshot.graphs.length, "graph")}, ` +
        `${plural(snapshot.runs.length, "run")}, active run ` +
        `${snapshot.activeRunId ?? "none"}; OpenCode ` +
        `${snapshot.openCode.connected ? "connected" : "disconnected"}.`
      );
    }
    case "diagnostics.get": {
      const diagnostics = output as Diagnostics;
      return (
        `Spire ${diagnostics.appVersion} on ${diagnostics.platform}: ` +
        `${plural(diagnostics.graphCount, "graph")}, ` +
        `${plural(diagnostics.runCount, "run")}, OpenCode ` +
        `${diagnostics.openCode.connected ? "connected" : "disconnected"}.`
      );
    }
    case "graphs.list": {
      const page = output as GraphPage;
      const names = page.graphs.map((graph) => graph.name).join(", ");
      const more = page.nextCursor ? " (more available)" : "";
      return `${plural(page.graphs.length, "graph")}${names ? `: ${names}` : ""}${more}.`;
    }
    case "graphs.get": {
      const graph = output as GraphDefinition;
      return (
        `Graph "${graph.name}" v${graph.version}: ` +
        `${plural(graph.nodes.length, "node")}, ` +
        `${plural(graph.edges.length, "edge")}.`
      );
    }
    case "graphs.save": {
      const graph = output as GraphDefinition;
      return `Saved graph "${graph.name}" v${graph.version}.`;
    }
    case "repositories.validate": {
      const validation = output as RepositoryValidation;
      return validation.ok
        ? `${validation.path} is a valid repository.`
        : `${validation.path} is not a valid repository: ${validation.reason ?? "unknown reason"}.`;
    }
    case "runs.list": {
      const page = output as RunPage;
      const more = page.nextCursor ? " (more available)" : "";
      return `${plural(page.runs.length, "run")}${more}.`;
    }
    case "runs.get": {
      const run = output as RunRecord;
      return (
        `Run ${run.id} is ${run.status} (graph ${run.graphId} ` +
        `v${run.graphVersion}, iteration ${run.iteration}).`
      );
    }
    case "runs.start": {
      const run = output as RunRecord;
      return `Started run ${run.id} (${run.status}).`;
    }
    case "runs.stop": {
      const run = output as RunRecord;
      return `Stopped run ${run.id} (${run.status}).`;
    }
    case "runs.retry": {
      const run = output as RunRecord;
      return `Retried run ${run.id} (${run.status}).`;
    }
    case "runs.artifacts.get": {
      const artifacts = output as RunArtifacts;
      return (
        `Artifacts: ${plural(artifacts.changedFiles.length, "changed file")} ` +
        `on branch ${artifacts.branch}.`
      );
    }
    case "worktrees.cleanup": {
      const run = output as RunRecord;
      return `Cleaned up worktrees for run ${run.id} (${run.status}).`;
    }
    case "layouts.list": {
      const layouts = output as WorkspaceLayoutRecord[];
      return `${plural(layouts.length, "layout")}.`;
    }
    case "layouts.save":
      return "Layout saved.";
    case "layouts.reset":
      return "Layout reset.";
    case "harnesses.list": {
      const harnesses = output as HarnessStatus[];
      const summary = harnesses
        .map(
          (harness) =>
            `${harness.id}: ${harness.status.connected ? "connected" : "disconnected"}`,
        )
        .join(", ");
      return `${plural(harnesses.length, "harness")} (${summary}).`;
    }
    case "harnesses.models": {
      const models = output as ModelOption[];
      const names = models.map((model) => model.name).join(", ");
      return `${plural(models.length, "model")}${names ? `: ${names}` : ""}.`;
    }
    case "traces.query":
    case "traces.tail": {
      const page = output as TracePage;
      const more = page.nextCursor
        ? `, next cursor ${page.nextCursor.afterSequence}`
        : "";
      return `${plural(page.events.length, "trace event")}${more}.`;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Register one MCP tool per control capability. */
export function registerSpireTools(
  server: McpServer,
  channel: ControlChannel,
): void {
  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      async (input) => {
        try {
          const output = await channel.execute(
            tool.operation,
            input as ControlOperationMap[typeof tool.operation]["input"],
          );
          const structured = isArrayOutput(
            CONTROL_CAPABILITIES[tool.operation].outputSchema,
          )
            ? { items: output }
            : (output as Record<string, unknown>);
          return {
            content: [
              { type: "text" as const, text: summarizeToolResult(tool.operation, output) },
            ],
            structuredContent: structured,
          };
        } catch (error) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: errorMessage(error) }],
          };
        }
      },
    );
  }
}

/**
 * Build the Spire MCP server: all tools, all resources, and live trace
 * events forwarded as MCP logging notifications.
 */
export function createSpireMcpServer(channel: ControlChannel): McpServer {
  const server = new McpServer(
    { name: "spire", version: "0.1.0" },
    { capabilities: { logging: {} } },
  );
  registerSpireTools(server, channel);
  registerSpireResources(server, channel);
  void channel
    .subscribeTraces((event) => {
      void server.sendLoggingMessage(traceToLoggingParams(event));
    })
    .catch(() => {
      // Trace streaming is best-effort; tool calls must keep working.
    });
  return server;
}
