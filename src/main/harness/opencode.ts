import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import {
  createOpencodeClient,
  type Event,
  type OpencodeClient,
  type Part,
} from "@opencode-ai/sdk";
import type { ModelOption, OpenCodeStatus } from "../../shared/domain";
import type {
  HarnessAdapter,
  HarnessEvent,
  HarnessRunInput,
  HarnessRunResult,
  HarnessSessionRef,
  HarnessProbeStatus,
} from "../../shared/harness";
import { parseModelJson } from "./adapter";
import { jsonOnly } from "../prompts";

const exec = promisify(execFile);

export type HarnessPrompt = {
  directory: string;
  sessionId?: string;
  title: string;
  model: string;
  system: string;
  prompt: string;
  readOnly: boolean;
  onSession?: (sessionId: string) => void;
  onEvent: (kind: string, message: string, payload?: unknown) => void;
};

export type HarnessResponse = {
  sessionId: string;
  text: string;
};

export interface AgentHarness {
  detect(): Promise<OpenCodeStatus>;
  connectOpenRouter(apiKey: string): Promise<void>;
  models(): Promise<ModelOption[]>;
  prompt(input: HarnessPrompt): Promise<HarnessResponse>;
  abort(sessionId: string, directory: string): Promise<void>;
  close(): void;
}

/** Prompt shape shared by the adapter run path and the legacy facade. */
type OpenCodePrompt = {
  directory: string;
  sessionId?: string;
  title: string;
  model: string;
  system?: string;
  prompt: string;
  readOnly: boolean;
  onSession?: (sessionId: string) => void;
  onEvent: (event: HarnessEvent, raw?: unknown) => void;
};

/**
 * Translate a single OpenCode SDK event into the normalized harness event
 * stream. Returns undefined for events with no normalized counterpart.
 */
export function translateOpencodeEvent(
  event: Event,
  directory: string,
): HarnessEvent | undefined {
  if (event.type === "session.created") {
    return {
      type: "session",
      session: {
        harnessId: "opencode",
        sessionId: event.properties.info.id,
        directory,
      },
    };
  }
  if (event.type === "message.part.updated") {
    const part = event.properties.part;
    if (part.type === "tool") {
      switch (part.state.status) {
        case "pending":
          return {
            type: "tool_start",
            tool: part.tool,
            input: part.state.input,
          };
        case "running":
          return {
            type: "tool_progress",
            tool: part.tool,
            message: part.state.title ?? `${part.tool} running`,
          };
        case "completed":
          return {
            type: "tool_result",
            tool: part.tool,
            output: part.state.output,
          };
        case "error":
          return { type: "tool_result", tool: part.tool, error: part.state.error };
      }
    }
    if (part.type === "text" && part.text.trim()) {
      return { type: "assistant_text", text: part.text.slice(-500) };
    }
    if (part.type === "reasoning" && part.text.trim()) {
      return { type: "reasoning", text: part.text.slice(-500) };
    }
    return undefined;
  }
  if (event.type === "message.updated") {
    const info = event.properties.info;
    if (info.role === "assistant" && info.time.completed !== undefined) {
      return {
        type: "usage",
        tokens: {
          input: info.tokens.input,
          output: info.tokens.output,
          reasoning: info.tokens.reasoning,
          cacheRead: info.tokens.cache.read,
          cacheWrite: info.tokens.cache.write,
        },
        cost: info.cost,
      };
    }
    return undefined;
  }
  if (event.type === "permission.updated") {
    const permission = event.properties;
    return {
      type: "approval",
      id: permission.id,
      permission: permission.type,
      title: permission.title,
      pattern: permission.pattern,
    };
  }
  if (event.type === "session.status") {
    const status = event.properties.status;
    if (status.type === "retry") {
      return { type: "warning", message: status.message };
    }
    return undefined;
  }
  if (event.type === "session.error") {
    const error = event.properties.error;
    if (error?.name === "MessageAbortedError") {
      return { type: "cancelled", message: error.data.message };
    }
    const message =
      error && "message" in error.data && typeof error.data.message === "string"
        ? error.data.message
        : "OpenCode session error";
    return { type: "error", message };
  }
  if (event.type === "session.idle") {
    return { type: "status", message: "Agent finished" };
  }
  return undefined;
}

function composeRunPrompt(input: HarnessRunInput): string {
  return [
    input.context.trim(),
    input.job.trim(),
    jsonOnly(JSON.stringify(input.outputSchema, null, 2)),
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

export class OpenCodeAdapter implements HarnessAdapter {
  readonly id = "opencode" as const;
  private binaryPath?: string;
  private version?: string;
  private server?: ChildProcess;
  private client?: OpencodeClient;
  private serverUrl?: string;
  private authorization?: string;
  private connected = false;

  async probe(): Promise<HarnessProbeStatus> {
    try {
      const { stdout: whichOutput } = await exec("which", ["opencode"]);
      this.binaryPath = whichOutput.trim();
      await access(this.binaryPath);
      const { stdout } = await exec(this.binaryPath, ["--version"]);
      this.version = stdout.trim();
      const major = Number(this.version.split(".")[0]);
      return {
        harnessId: this.id,
        installed: true,
        binaryPath: this.binaryPath,
        version: this.version,
        compatible: Number.isFinite(major) && major >= 1,
        connected: this.connected,
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

  async connectOpenRouter(apiKey: string): Promise<void> {
    const client = await this.ensureClient();
    await client.auth.set({
      path: { id: "openrouter" },
      body: { type: "api", key: apiKey },
      throwOnError: true,
    });
    this.connected = true;
  }

  async listModels(): Promise<ModelOption[]> {
    const client = await this.ensureClient();
    const result = await client.provider.list({ throwOnError: true });
    const provider = result.data.all.find((item) => item.id === "openrouter");
    if (!provider) return [];
    return Object.values(provider.models)
      .filter((model) => model.status !== "deprecated")
      .map((model) => ({
        id: `openrouter/${model.id}`,
        name: model.name,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async run(input: HarnessRunInput): Promise<HarnessRunResult> {
    const { sessionId, text } = await this.runPrompt({
      directory: input.directory,
      sessionId: input.session?.sessionId,
      title: `${input.nodeId} (${input.runId})`,
      model: input.modelId,
      prompt: composeRunPrompt(input),
      readOnly: input.access.mode === "read-only",
      onSession: (createdSessionId) => {
        const session: HarnessSessionRef = {
          harnessId: this.id,
          sessionId: createdSessionId,
          directory: input.directory,
        };
        input.onSession(session);
        input.onEvent({ type: "session", session });
      },
      // The session event is emitted exactly once via onSession above; the
      // SDK's own session.created broadcast would only duplicate it.
      onEvent: (event) => {
        if (event.type !== "session") input.onEvent(event);
      },
    });
    const parsed = parseModelJson(text);
    const session: HarnessSessionRef = {
      harnessId: this.id,
      sessionId,
      directory: input.directory,
    };
    return { session, output: parsed === undefined ? text : parsed };
  }

  async runPrompt(
    input: OpenCodePrompt,
  ): Promise<{ sessionId: string; text: string }> {
    await this.ensureClient();
    const scopedClient = createOpencodeClient({
      baseUrl: this.serverUrl,
      directory: input.directory,
      headers: this.clientHeaders(),
    });
    const sessionId =
      input.sessionId ??
      (
        await scopedClient.session.create({
          body: { title: input.title },
          throwOnError: true,
        })
      ).data.id;
    input.onSession?.(sessionId);

    const streamAbort = new AbortController();
    void this.forwardEvents(
      scopedClient,
      sessionId,
      input.directory,
      input.onEvent,
      streamAbort.signal,
    );
    const [providerID, ...modelParts] = input.model.split("/");
    try {
      const response = await scopedClient.session.prompt({
        path: { id: sessionId },
        body: {
          model: { providerID, modelID: modelParts.join("/") },
          system: input.system,
          tools: input.readOnly
            ? {
                write: false,
                edit: false,
                patch: false,
                apply_patch: false,
                bash: false,
              }
            : undefined,
          parts: [{ type: "text", text: input.prompt }],
        },
        throwOnError: true,
      });
      const text = response.data.parts
        .filter(
          (part): part is Extract<Part, { type: "text" }> =>
            part.type === "text",
        )
        .map((part) => part.text)
        .join("\n");
      return { sessionId, text };
    } finally {
      streamAbort.abort();
    }
  }

  async abort(session: HarnessSessionRef): Promise<void> {
    const client = await this.scopedClient(session.directory);
    await client.session.abort({
      path: { id: session.sessionId },
      throwOnError: true,
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.client = undefined;
    this.serverUrl = undefined;
    this.authorization = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      let finished = false;
      let forceTimer: NodeJS.Timeout | undefined;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (forceTimer) clearTimeout(forceTimer);
        server.removeListener("exit", finish);
        resolve();
      };
      server.once("exit", finish);
      if (!server.kill("SIGTERM")) {
        finish();
        return;
      }
      if (!finished) {
        forceTimer = setTimeout(() => {
          server.kill("SIGKILL");
          finish();
        }, 1_000);
      }
    });
  }

  private async ensureClient(): Promise<OpencodeClient> {
    if (this.client) return this.client;
    if (!this.binaryPath) {
      const status = await this.probe();
      if (!status.installed || !status.compatible) {
        throw new Error("A compatible OpenCode CLI was not found.");
      }
    }
    const password = randomBytes(24).toString("base64url");
    const binary = this.binaryPath!;
    const server = spawn(
      binary,
      ["serve", "--hostname=127.0.0.1", "--port=0"],
      {
        env: {
          ...process.env,
          OPENCODE_SERVER_PASSWORD: password,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            permission: {
              "*": "allow",
              external_directory: "deny",
              question: "deny",
              doom_loop: "deny",
              bash: {
                "*": "allow",
                "git push*": "deny",
              },
            },
          }),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.server = server;
    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out starting OpenCode.")),
        10_000,
      );
      let output = "";
      const handle = (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(
          /opencode server listening.*?(https?:\/\/[^\s]+)/,
        );
        if (match) {
          clearTimeout(timeout);
          resolve(match[1]);
        }
      };
      server.stdout?.on("data", handle);
      server.stderr?.on("data", handle);
      server.once("error", reject);
      server.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`OpenCode exited with code ${code}: ${output}`));
      });
    });
    const auth = Buffer.from(`opencode:${password}`).toString("base64");
    this.serverUrl = url;
    this.authorization = `Basic ${auth}`;
    this.client = createOpencodeClient({
      baseUrl: url,
      headers: this.clientHeaders(),
    });
    return this.client;
  }

  private clientHeaders(): Record<string, string> {
    return this.authorization
      ? { Authorization: this.authorization }
      : {};
  }

  private async scopedClient(directory: string): Promise<OpencodeClient> {
    await this.ensureClient();
    return createOpencodeClient({
      baseUrl: this.serverUrl,
      directory,
      headers: this.clientHeaders(),
    });
  }

  private async forwardEvents(
    client: OpencodeClient,
    sessionId: string,
    directory: string,
    onEvent: (event: HarnessEvent, raw?: unknown) => void,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const events = await client.event.subscribe({ signal });
      for await (const event of events.stream) {
        if (signal.aborted) break;
        const serialized = JSON.stringify(event);
        if (!serialized.includes(sessionId)) continue;
        const normalized = translateOpencodeEvent(event, directory);
        if (normalized) onEvent(normalized, event);
      }
    } catch {
      // The prompt response remains authoritative if the SSE connection closes.
    }
  }
}

/**
 * Map a normalized event back to the legacy `(kind, message)` stream the
 * pre-registry consumers (run engine, journals) were built against. Only the
 * kinds the legacy integration emitted are forwarded; richer normalized kinds
 * (reasoning, usage, approval, warning) stay exclusive to the adapter path.
 * A cancelled session surfaces as the same fixed "error" the old translation
 * produced for aborts, keeping legacy behavior byte-identical.
 */
function toLegacyEvent(
  event: HarnessEvent,
): { kind: string; message: string } | undefined {
  switch (event.type) {
    case "tool_start":
      return { kind: "tool", message: `${event.tool} pending` };
    case "tool_progress":
      return { kind: "tool", message: `${event.tool} running` };
    case "tool_result":
      return {
        kind: "tool",
        message: event.error ? `${event.tool} error` : `${event.tool} completed`,
      };
    case "assistant_text":
      return { kind: "message", message: event.text };
    case "error":
    case "cancelled":
      return { kind: "error", message: "OpenCode session error" };
    case "status":
      return { kind: "status", message: event.message };
    default:
      return undefined;
  }
}

/**
 * Legacy facade over OpenCodeAdapter preserving the pre-registry AgentHarness
 * contract for existing consumers (run engine, control layer, IPC tests).
 * New code should depend on HarnessAdapter / the registry instead.
 */
export class OpenCodeHarness implements AgentHarness {
  constructor(private readonly adapter = new OpenCodeAdapter()) {}

  async detect(): Promise<OpenCodeStatus> {
    const { harnessId, ...status } = await this.adapter.probe();
    void harnessId;
    return status;
  }

  connectOpenRouter(apiKey: string): Promise<void> {
    return this.adapter.connectOpenRouter(apiKey);
  }

  models(): Promise<ModelOption[]> {
    return this.adapter.listModels();
  }

  prompt(input: HarnessPrompt): Promise<HarnessResponse> {
    return this.adapter.runPrompt({
      directory: input.directory,
      sessionId: input.sessionId,
      title: input.title,
      model: input.model,
      system: input.system,
      prompt: input.prompt,
      readOnly: input.readOnly,
      onSession: input.onSession,
      onEvent: (event, raw) => {
        const legacy = toLegacyEvent(event);
        if (legacy) input.onEvent(legacy.kind, legacy.message, raw);
      },
    });
  }

  abort(sessionId: string, directory: string): Promise<void> {
    return this.adapter.abort({
      harnessId: "opencode",
      sessionId,
      directory,
    });
  }

  close(): void {
    void this.adapter.close();
  }
}
