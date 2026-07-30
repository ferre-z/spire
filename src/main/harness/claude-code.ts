import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import type { ModelOption } from "../../shared/domain";
import type {
  HarnessAdapter,
  HarnessEvent,
  HarnessRunInput,
  HarnessRunResult,
  HarnessSessionRef,
  HarnessProbeStatus,
} from "../../shared/harness";
import {
  createJsonlParser,
  parseModelJson,
  redactSecrets,
} from "./adapter";

const exec = promisify(execFile);

const BINARY = "claude";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Read-only tool surface for nodes without write access; write-capable nodes
 * instead get `--permission-mode acceptEdits` so edits auto-apply in print
 * mode. Never `--dangerously-skip-permissions`.
 * https://code.claude.com/docs/en/cli-reference
 */
const READ_ONLY_TOOLS = "Read,Grep,Glob,WebFetch,WebSearch";

const MODEL_ALIASES: ModelOption[] = [
  { id: "sonnet", name: "Claude Sonnet" },
  { id: "opus", name: "Claude Opus" },
  { id: "haiku", name: "Claude Haiku" },
];

export type ClaudeCodeAdapterOptions = {
  timeoutMs?: number;
};

type ActiveRun = {
  proc: ChildProcess;
  aborted: boolean;
};

function composePrompt(input: HarnessRunInput): string {
  return [input.context.trim(), input.job.trim()]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function buildArgs(input: HarnessRunInput): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    JSON.stringify(input.outputSchema),
    "--model",
    input.modelId,
  ];
  if (input.session) args.push("--resume", input.session.sessionId);
  if (input.access.mode === "read-only") {
    args.push("--tools", READ_ONLY_TOOLS);
  } else {
    args.push("--permission-mode", "acceptEdits");
  }
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

/**
 * Translate one stream-json event into normalized harness events. `toolNames`
 * carries tool_use ids → names across events so tool_result blocks (which only
 * reference the id) resolve to the tool that produced them.
 */
export function translateClaudeEvent(
  raw: unknown,
  toolNames: Map<string, string>,
): HarnessEvent[] {
  const event = asRecord(raw);
  if (!event) return [];
  if (event.type === "assistant") {
    const content = asRecord(event.message)?.content;
    if (!Array.isArray(content)) return [];
    const out: HarnessEvent[] = [];
    for (const block of content) {
      const item = asRecord(block);
      if (!item) continue;
      if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
        out.push({ type: "assistant_text", text: item.text });
      } else if (
        item.type === "thinking" &&
        typeof item.thinking === "string" &&
        item.thinking.trim()
      ) {
        out.push({ type: "reasoning", text: item.thinking });
      } else if (item.type === "tool_use" && typeof item.name === "string") {
        if (typeof item.id === "string") toolNames.set(item.id, item.name);
        out.push({ type: "tool_start", tool: item.name, input: item.input });
      }
    }
    return out;
  }
  if (event.type === "user") {
    const content = asRecord(event.message)?.content;
    if (!Array.isArray(content)) return [];
    const out: HarnessEvent[] = [];
    for (const block of content) {
      const item = asRecord(block);
      if (!item || item.type !== "tool_result") continue;
      const toolUseId = typeof item.tool_use_id === "string" ? item.tool_use_id : "";
      const tool = toolNames.get(toolUseId) ?? "unknown";
      if (item.is_error === true) {
        out.push({
          type: "tool_result",
          tool,
          error:
            typeof item.content === "string" ? item.content : "Tool call failed",
        });
      } else {
        out.push({ type: "tool_result", tool, output: item.content });
      }
    }
    return out;
  }
  if (event.type === "result") {
    const out: HarnessEvent[] = [];
    const usage = asRecord(event.usage);
    if (usage) {
      out.push({
        type: "usage",
        tokens: {
          input: numberField(usage, "input_tokens"),
          output: numberField(usage, "output_tokens"),
          reasoning: 0,
          cacheRead: numberField(usage, "cache_read_input_tokens"),
          cacheWrite: numberField(usage, "cache_creation_input_tokens"),
        },
        cost:
          typeof event.total_cost_usd === "number"
            ? event.total_cost_usd
            : undefined,
      });
    }
    if (event.is_error === true) {
      out.push({
        type: "error",
        message:
          typeof event.result === "string"
            ? event.result
            : "Claude Code reported an error",
      });
    }
    return out;
  }
  return [];
}

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly id = "claude-code" as const;
  private binaryPath?: string;
  private readonly timeoutMs: number;
  private readonly active = new Map<string, ActiveRun>();

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async probe(): Promise<HarnessProbeStatus> {
    try {
      const { stdout: whichOutput } = await exec("which", [BINARY]);
      this.binaryPath = whichOutput.trim();
      await access(this.binaryPath);
      const { stdout } = await exec(this.binaryPath, ["--version"]);
      const match = stdout.match(/(\d+\.\d+\.\d+)/);
      const version = match?.[1] ?? stdout.trim();
      return {
        harnessId: this.id,
        installed: true,
        binaryPath: this.binaryPath,
        version,
        compatible: match !== null,
        connected: Boolean(
          process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_CODE_OAUTH_TOKEN,
        ),
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
    return MODEL_ALIASES;
  }

  async run(input: HarnessRunInput): Promise<HarnessRunResult> {
    const binary = await this.ensureBinary();
    const proc = spawn(binary, buildArgs(input), {
      cwd: input.directory,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return await this.consume(proc, input);
  }

  async abort(session: HarnessSessionRef): Promise<void> {
    const run = this.active.get(session.sessionId);
    if (!run) return;
    run.aborted = true;
    run.proc.kill("SIGTERM");
  }

  async close(): Promise<void> {
    for (const run of this.active.values()) {
      run.aborted = true;
      run.proc.kill("SIGTERM");
    }
    this.active.clear();
  }

  private async ensureBinary(): Promise<string> {
    if (this.binaryPath) return this.binaryPath;
    const status = await this.probe();
    if (!status.installed || !status.compatible || !this.binaryPath) {
      throw new Error("A compatible Claude Code CLI was not found.");
    }
    return this.binaryPath;
  }

  private consume(
    proc: ChildProcess,
    input: HarnessRunInput,
  ): Promise<HarnessRunResult> {
    return new Promise<HarnessRunResult>((resolve, reject) => {
      const parser = createJsonlParser();
      const toolNames = new Map<string, string>();
      let session: HarnessSessionRef | undefined;
      let output: unknown;
      let timedOut = false;
      let settled = false;
      const run: ActiveRun = { proc, aborted: false };

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
      }, this.timeoutMs);

      const finish = (error?: Error, result?: HarnessRunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (session) this.active.delete(session.sessionId);
        if (error) reject(error);
        else resolve(result!);
      };

      const handleRaw = (raw: unknown) => {
        const init = asRecord(raw);
        if (init?.type === "system" && init.subtype === "init") {
          const sessionId =
            typeof init.session_id === "string" && init.session_id.length > 0
              ? init.session_id
              : input.session?.sessionId;
          if (sessionId && !session) {
            session = {
              harnessId: this.id,
              sessionId,
              directory: input.directory,
            };
            this.active.set(session.sessionId, run);
            input.onSession(session);
            input.onEvent({ type: "session", session });
          }
          return;
        }
        if (init?.type === "result") {
          if (init.structured_output !== undefined) {
            output = init.structured_output;
          } else if (typeof init.result === "string") {
            const parsed = parseModelJson(init.result);
            output = parsed === undefined ? init.result : parsed;
          }
        }
        for (const event of translateClaudeEvent(raw, toolNames)) {
          input.onEvent(event);
        }
      };

      proc.stdout?.on("data", (chunk: Buffer) => {
        for (const line of parser.push(chunk.toString("utf8"))) {
          if (line.kind === "json") handleRaw(line.value);
          else if (line.kind === "oversized") {
            input.onEvent({
              type: "warning",
              message: "Skipped an oversized Claude Code output line.",
            });
          } else {
            input.onEvent({
              type: "warning",
              message: "Skipped a malformed Claude Code output line.",
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
        for (const line of parser.flush()) {
          if (line.kind === "json") handleRaw(line.value);
        }
        if (run.aborted) {
          const error = new Error("Claude Code run was cancelled.");
          input.onEvent({ type: "cancelled", message: error.message });
          finish(error);
          return;
        }
        if (timedOut) {
          const error = new Error(
            `Claude Code timed out after ${this.timeoutMs}ms.`,
          );
          input.onEvent({ type: "timeout", message: error.message });
          finish(error);
          return;
        }
        if (code !== 0) {
          const error = new Error(
            `Claude Code exited with ${signal ?? `code ${code}`}.`,
          );
          input.onEvent({ type: "error", message: error.message });
          finish(error);
          return;
        }
        if (!session) {
          finish(new Error("Claude Code produced no session."));
          return;
        }
        finish(undefined, { session, output });
      });
    });
  }
}
