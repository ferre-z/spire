import type {
  HarnessAdapter,
  HarnessRunInput,
  HarnessSessionRef,
} from "../../shared/harness";
import { parseJson, repairPrompt } from "../prompts";

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
