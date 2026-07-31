import type {
  HarnessAdapter,
  HarnessRunInput,
  HarnessSessionRef,
} from "../../shared/harness";
import { parseJson, repairPrompt } from "../prompts";

/** Maximum size of a single JSONL line from a harness process stream. */
export const MAX_JSONL_LINE_BYTES = 1024 * 1024;

export type JsonlLine =
  | { kind: "json"; value: unknown }
  | { kind: "malformed"; text: string }
  | { kind: "oversized" };

/**
 * Incremental JSONL parser shared by the process-based harness adapters.
 * Buffers partial chunks, tolerates malformed lines (reported, never thrown),
 * and drops lines over the 1 MiB cap so a runaway stream cannot exhaust
 * memory. Call `flush` when the stream ends to drain any trailing line.
 */
export function createJsonlParser(): {
  push(chunk: string): JsonlLine[];
  flush(): JsonlLine[];
} {
  let buffer = "";
  let skippingOversized = false;

  function classify(line: string): JsonlLine {
    if (line.length === 0) return { kind: "malformed", text: line };
    try {
      return { kind: "json", value: JSON.parse(line) as unknown };
    } catch {
      return { kind: "malformed", text: line };
    }
  }

  function push(chunk: string): JsonlLine[] {
    const out: JsonlLine[] = [];
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (skippingOversized) {
        skippingOversized = false;
        continue;
      }
      if (line.length > MAX_JSONL_LINE_BYTES) {
        out.push({ kind: "oversized" });
        continue;
      }
      if (line.length > 0) out.push(classify(line));
    }
    if (buffer.length > MAX_JSONL_LINE_BYTES) {
      // No newline yet and the line already exceeds the cap: drop it and skip
      // everything up to the next newline.
      buffer = "";
      skippingOversized = true;
      out.push({ kind: "oversized" });
    }
    return out;
  }

  function flush(): JsonlLine[] {
    const line = buffer;
    buffer = "";
    if (skippingOversized) {
      skippingOversized = false;
      return [];
    }
    if (line.length === 0) return [];
    if (line.length > MAX_JSONL_LINE_BYTES) return [{ kind: "oversized" }];
    return [classify(line)];
  }

  return { push, flush };
}

/** Redact credential-looking values from harness stderr before emitting it. */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /(api[_-]?key|token|password)([=:]\s*)\S+/gi,
      (_match, key: string, sep: string) => `${key}${sep}[redacted]`,
    );
}

/** Parse model text into JSON when possible; undefined when it is not JSON. */
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(withoutFence) as unknown;
  } catch {
    return undefined;
  }
}

function coerce<T>(
  output: unknown,
  parse: (value: unknown) => T,
): { ok: true; value: T } | { ok: false; error: unknown } {
  try {
    if (typeof output === "string") {
      return { ok: true, value: parseJson(output, { parse }) };
    }
    return { ok: true, value: parse(output) };
  } catch (error) {
    return { ok: false, error };
  }
}

function asText(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

/**
 * Adapter-independent structured-output runner: runs the harness once against
 * the requested schema and, when the output does not validate, makes exactly
 * ONE repair attempt on the same session. Every harness adapter shares this
 * caller — adapters themselves never retry structured output.
 */
export async function runHarnessStructured<T>(options: {
  adapter: HarnessAdapter;
  input: HarnessRunInput;
  parse: (value: unknown) => T;
  schemaName: string;
}): Promise<{ session: HarnessSessionRef; output: T }> {
  const { adapter, input, parse, schemaName } = options;
  const first = await adapter.run(input);
  const direct = coerce(first.output, parse);
  if (direct.ok) return { session: first.session, output: direct.value };
  input.onEvent({
    type: "warning",
    message: `Invalid ${schemaName} output; requesting one repair.`,
  });
  const repaired = await adapter.run({
    ...input,
    session: first.session,
    context: "",
    job: repairPrompt(schemaName, asText(first.output)),
  });
  const second = coerce(repaired.output, parse);
  if (!second.ok) throw second.error;
  return { session: repaired.session, output: second.value };
}
