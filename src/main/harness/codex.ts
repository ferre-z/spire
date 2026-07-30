import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ModelOption } from "../../shared/domain";
import type {
  HarnessAdapter,
  HarnessEvent,
  HarnessRunInput,
  HarnessRunResult,
  HarnessSessionRef,
  HarnessStatus,
} from "../../shared/harness";
import {
  createJsonlParser,
  parseModelJson,
  redactSecrets,
} from "./adapter";

const exec = promisify(execFile);

const BINARY = "codex";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 2_000;

export type CodexAdapterOptions = {
  /** Root for temporary output-schema files (Spire run data). */
  dataDir?: string;
  timeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL when terminating a run. */
  killGraceMs?: number;
};

type ActiveRun = {
  proc: ChildProcess;
  aborted: boolean;
  exited: boolean;
  escalation?: NodeJS.Timeout;
};

function composePrompt(input: HarnessRunInput): string {
  return [input.context.trim(), input.job.trim()]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

/**
 * `codex exec` with machine-readable JSONL events and schema-validated output.
 * Parent flags must precede the `resume` subcommand. Sandbox comes from node
 * access; dangerous bypass flags are never used.
 * https://developers.openai.com/codex/noninteractive
 */
function buildArgs(input: HarnessRunInput, schemaPath: string): string[] {
  const args = [
    "exec",
    "--json",
    "--output-schema",
    schemaPath,
    "--cd",
    input.directory,
    "--sandbox",
    input.access.mode === "read-only" ? "read-only" : "workspace-write",
    "--model",
    input.modelId,
  ];
  if (input.session) args.push("resume", input.session.sessionId);
  args.push(composePrompt(input));
  return args;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const TOOL_ITEM_TYPES = new Set(["command_execution", "file_change"]);

/** Translate one `codex exec --json` event into normalized harness events. */
export function translateCodexEvent(raw: unknown): HarnessEvent[] {
  const event = asRecord(raw);
  if (!event) return [];
  if (event.type === "item.started" || event.type === "item.completed") {
    const item = asRecord(event.item);
    if (!item || typeof item.type !== "string") return [];
    if (TOOL_ITEM_TYPES.has(item.type)) {
      const tool = item.type;
      if (event.type === "item.started") {
        const input =
          typeof item.command === "string" ? { command: item.command } : undefined;
        return [{ type: "tool_start", tool, input }];
      }
      const failed =
        item.status === "failed" ||
        (typeof item.exit_code === "number" && item.exit_code !== 0);
      if (failed) {
        return [
          {
            type: "tool_result",
            tool,
            error:
              typeof item.aggregated_output === "string" &&
              item.aggregated_output.length > 0
                ? item.aggregated_output
                : `${tool} failed`,
          },
        ];
      }
      return [
        {
          type: "tool_result",
          tool,
          output: item.aggregated_output ?? item.changes,
        },
      ];
    }
    if (event.type === "item.completed" && item.type === "reasoning") {
      return typeof item.text === "string" && item.text.trim()
        ? [{ type: "reasoning", text: item.text }]
        : [];
    }
    if (event.type === "item.completed" && item.type === "agent_message") {
      return typeof item.text === "string" && item.text.trim()
        ? [{ type: "assistant_text", text: item.text }]
        : [];
    }
    return [];
  }
  if (event.type === "turn.completed") {
    const usage = asRecord(event.usage);
    if (!usage) return [];
    return [
      {
        type: "usage",
        tokens: {
          input: numberField(usage, "input_tokens"),
          output: numberField(usage, "output_tokens"),
          reasoning: numberField(usage, "reasoning_output_tokens"),
          cacheRead: numberField(usage, "cached_input_tokens"),
          cacheWrite: 0,
        },
      },
    ];
  }
  if (event.type === "turn.failed") {
    const message = asRecord(event.error)?.message;
    return [
      {
        type: "error",
        message: typeof message === "string" ? message : "Codex turn failed",
      },
    ];
  }
  return [];
}

export class CodexAdapter implements HarnessAdapter {
  readonly id = "codex" as const;
  private binaryPath?: string;
  private readonly dataDir: string;
  private readonly timeoutMs: number;
  private readonly killGraceMs: number;
  private readonly active = new Map<string, ActiveRun>();

  constructor(options: CodexAdapterOptions = {}) {
    this.dataDir =
      options.dataDir ??
      process.env.SPIRE_USER_DATA ??
      path.join(tmpdir(), "spire");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  }

  async probe(): Promise<HarnessStatus> {
    try {
      const { stdout: whichOutput } = await exec("which", [BINARY]);
      this.binaryPath = whichOutput.trim();
      await access(this.binaryPath);
      const { stdout } = await exec(this.binaryPath, ["--version"]);
      const match = stdout.match(/(\d+\.\d+\.\d+)/);
      const version = match?.[1] ?? stdout.trim();
      let connected = false;
      try {
        await exec(this.binaryPath, ["login", "status"]);
        connected = true;
      } catch {
        connected = false;
      }
      return {
        harnessId: this.id,
        installed: true,
        binaryPath: this.binaryPath,
        version,
        compatible: match !== null,
        connected,
      };
    } catch (error) {
      return {
        harnessId: this.id,
        installed: false,
        compatible: false,
        connected: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async listModels(): Promise<ModelOption[]> {
    // Codex has no non-interactive model listing; ids pass through via --model.
    return [];
  }

  async run(input: HarnessRunInput): Promise<HarnessRunResult> {
    const binary = await this.ensureBinary();
    const schemaDir = path.join(this.dataDir, "harness-schemas");
    await mkdir(schemaDir, { recursive: true });
    const schemaPath = path.join(
      schemaDir,
      `codex-${input.runId}-${input.nodeId}-${randomBytes(6).toString("hex")}.json`,
    );
    await writeFile(schemaPath, JSON.stringify(input.outputSchema), {
      mode: 0o600,
    });
    try {
      const proc = spawn(binary, buildArgs(input, schemaPath), {
        cwd: input.directory,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return await this.consume(proc, input);
    } finally {
      await rm(schemaPath, { force: true }).catch(() => undefined);
    }
  }

  async abort(session: HarnessSessionRef): Promise<void> {
    const run = this.active.get(session.sessionId);
    if (!run) return;
    run.aborted = true;
    this.terminate(run);
  }

  async close(): Promise<void> {
    for (const run of this.active.values()) {
      run.aborted = true;
      this.terminate(run);
    }
    this.active.clear();
  }

  private terminate(run: ActiveRun): void {
    run.proc.kill("SIGTERM");
    run.escalation = setTimeout(() => {
      if (!run.exited) run.proc.kill("SIGKILL");
    }, this.killGraceMs);
  }

  private async ensureBinary(): Promise<string> {
    if (this.binaryPath) return this.binaryPath;
    const status = await this.probe();
    if (!status.installed || !status.compatible || !this.binaryPath) {
      throw new Error("A compatible Codex CLI was not found.");
    }
    return this.binaryPath;
  }

  private consume(
    proc: ChildProcess,
    input: HarnessRunInput,
  ): Promise<HarnessRunResult> {
    return new Promise<HarnessRunResult>((resolve, reject) => {
      const parser = createJsonlParser();
      let session: HarnessSessionRef | undefined;
      let output: unknown;
      let lastAgentMessage: string | undefined;
      let timedOut = false;
      let settled = false;
      const run: ActiveRun = { proc, aborted: false, exited: false };

      const timer = setTimeout(() => {
        timedOut = true;
        this.terminate(run);
      }, this.timeoutMs);

      const finish = (error?: Error, result?: HarnessRunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (run.escalation) clearTimeout(run.escalation);
        if (session) this.active.delete(session.sessionId);
        if (error) reject(error);
        else resolve(result!);
      };

      const handleRaw = (raw: unknown) => {
        const event = asRecord(raw);
        if (event?.type === "thread.started") {
          const threadId =
            typeof event.thread_id === "string" && event.thread_id.length > 0
              ? event.thread_id
              : input.session?.sessionId;
          if (threadId && !session) {
            session = {
              harnessId: this.id,
              sessionId: threadId,
              directory: input.directory,
            };
            this.active.set(session.sessionId, run);
            input.onSession(session);
            input.onEvent({ type: "session", session });
          }
          return;
        }
        if (event?.type === "item.completed") {
          const item = asRecord(event.item);
          if (item?.type === "agent_message" && typeof item.text === "string") {
            lastAgentMessage = item.text;
          }
        }
        for (const translated of translateCodexEvent(raw)) {
          input.onEvent(translated);
        }
      };

      proc.stdout?.on("data", (chunk: Buffer) => {
        for (const line of parser.push(chunk.toString("utf8"))) {
          if (line.kind === "json") handleRaw(line.value);
          else if (line.kind === "oversized") {
            input.onEvent({
              type: "warning",
              message: "Skipped an oversized Codex output line.",
            });
          } else {
            input.onEvent({
              type: "warning",
              message: "Skipped a malformed Codex output line.",
            });
          }
        }
      });
      proc.stderr?.on("data", (chunk: Buffer) => {
        const text = redactSecrets(chunk.toString("utf8")).trim();
        if (text) input.onEvent({ type: "stderr", text });
      });
      proc.once("error", (error) => {
        input.onEvent({ type: "error", message: error.message });
        finish(error);
      });
      proc.once("exit", (code, signal) => {
        run.exited = true;
        for (const line of parser.flush()) {
          if (line.kind === "json") handleRaw(line.value);
        }
        if (lastAgentMessage !== undefined) {
          const parsed = parseModelJson(lastAgentMessage);
          output = parsed === undefined ? lastAgentMessage : parsed;
        }
        if (run.aborted) {
          const error = new Error("Codex run was cancelled.");
          input.onEvent({ type: "cancelled", message: error.message });
          finish(error);
          return;
        }
        if (timedOut) {
          const error = new Error(
            `Codex timed out after ${this.timeoutMs}ms.`,
          );
          input.onEvent({ type: "timeout", message: error.message });
          finish(error);
          return;
        }
        if (code !== 0) {
          const error = new Error(
            `Codex exited with ${signal ?? `code ${code}`}.`,
          );
          input.onEvent({ type: "error", message: error.message });
          finish(error);
          return;
        }
        if (!session) {
          finish(new Error("Codex produced no session."));
          return;
        }
        finish(undefined, { session, output });
      });
    });
  }
}
