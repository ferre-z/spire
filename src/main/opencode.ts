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
import type { ModelOption, OpenCodeStatus } from "../shared/domain";

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

export class OpenCodeHarness implements AgentHarness {
  private binaryPath?: string;
  private version?: string;
  private server?: ChildProcess;
  private client?: OpencodeClient;
  private serverUrl?: string;
  private authorization?: string;
  private connected = false;

  async detect(): Promise<OpenCodeStatus> {
    try {
      const { stdout: whichOutput } = await exec("which", ["opencode"]);
      this.binaryPath = whichOutput.trim();
      await access(this.binaryPath);
      const { stdout } = await exec(this.binaryPath, ["--version"]);
      this.version = stdout.trim();
      const major = Number(this.version.split(".")[0]);
      return {
        installed: true,
        binaryPath: this.binaryPath,
        version: this.version,
        compatible: Number.isFinite(major) && major >= 1,
        connected: this.connected,
      };
    } catch (error) {
      return {
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

  async models(): Promise<ModelOption[]> {
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

  async prompt(input: HarnessPrompt): Promise<HarnessResponse> {
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

  async abort(sessionId: string, directory: string): Promise<void> {
    const client = await this.scopedClient(directory);
    await client.session.abort({
      path: { id: sessionId },
      throwOnError: true,
    });
  }

  close(): void {
    this.server?.kill("SIGTERM");
    this.server = undefined;
    this.client = undefined;
    this.serverUrl = undefined;
    this.authorization = undefined;
  }

  private async ensureClient(): Promise<OpencodeClient> {
    if (this.client) return this.client;
    if (!this.binaryPath) {
      const status = await this.detect();
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
    onEvent: HarnessPrompt["onEvent"],
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const events = await client.event.subscribe({ signal });
      for await (const event of events.stream) {
        if (signal.aborted) break;
        const serialized = JSON.stringify(event);
        if (!serialized.includes(sessionId)) continue;
        const normalized = this.describeEvent(event);
        if (normalized) onEvent(normalized.kind, normalized.message, event);
      }
    } catch {
      // The prompt response remains authoritative if the SSE connection closes.
    }
  }

  private describeEvent(
    event: Event,
  ): { kind: string; message: string } | undefined {
    if (event.type === "message.part.updated") {
      const part = event.properties.part;
      if (part.type === "tool") {
        return {
          kind: "tool",
          message:
            part.state.status === "completed"
              ? `${part.tool} completed`
              : `${part.tool} ${part.state.status}`,
        };
      }
      if (part.type === "text" && part.text.trim()) {
        return { kind: "message", message: part.text.slice(-500) };
      }
    }
    if (event.type === "session.error") {
      return { kind: "error", message: "OpenCode session error" };
    }
    if (event.type === "session.idle") {
      return { kind: "status", message: "Agent finished" };
    }
    return undefined;
  }
}
