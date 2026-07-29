import { z } from "zod";

/**
 * Workspace layout persistence contract.
 *
 * Layouts are keyed by a graph's stable id plus a layout mode, so every
 * version of one graph shares the same desktop and compact arrangements.
 * The serialized `model` is a FlexLayout `IJsonModel` payload; it is treated
 * as opaque JSON here and validated structurally before it is stored or
 * restored.
 */

export type WorkspaceLayoutMode = "desktop" | "compact";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type WorkspaceLayoutRecord = {
  graphId: string;
  mode: WorkspaceLayoutMode;
  schemaVersion: number;
  model: JsonValue;
  updatedAt: string;
};

export type WorkspaceEnvironment = {
  platform: string;
  isWayland: boolean;
};

export const WORKSPACE_LAYOUT_SCHEMA_VERSION = 1;
export const WORKSPACE_LAYOUT_MAX_BYTES = 512 * 1024;
export const WORKSPACE_LAYOUT_MODES: readonly WorkspaceLayoutMode[] = [
  "desktop",
  "compact",
];

const MAX_MODEL_DEPTH = 32;

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const workspaceLayoutRecordSchema = z.object({
  graphId: z.string().min(1),
  mode: z.enum(["desktop", "compact"]),
  schemaVersion: z.number().int().positive(),
  model: jsonValueSchema,
  updatedAt: z.string().datetime(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidTab(node: unknown): boolean {
  if (!isRecord(node)) return false;
  if (node.type !== "tab") return false;
  if (typeof node.id !== "string" || node.id.length === 0) return false;
  if (typeof node.component !== "string" || node.component.length === 0) {
    return false;
  }
  if (node.name !== undefined && typeof node.name !== "string") return false;
  return true;
}

function isValidTabSet(node: unknown, depth: number): boolean {
  if (depth > MAX_MODEL_DEPTH || !isRecord(node)) return false;
  if (node.type !== "tabset") return false;
  if (node.weight !== undefined && !isFiniteNumber(node.weight)) return false;
  if (!Array.isArray(node.children) || node.children.length === 0) return false;
  return node.children.every(isValidTab);
}

function isValidRow(node: unknown, depth: number): boolean {
  if (depth > MAX_MODEL_DEPTH || !isRecord(node)) return false;
  if (node.type !== undefined && node.type !== "row") return false;
  if (node.weight !== undefined && !isFiniteNumber(node.weight)) return false;
  if (!Array.isArray(node.children) || node.children.length === 0) return false;
  return node.children.every(
    (child) => isValidRow(child, depth + 1) || isValidTabSet(child, depth + 1),
  );
}

function isValidRect(rect: unknown): boolean {
  if (!isRecord(rect)) return false;
  return (
    isFiniteNumber(rect.x) &&
    isFiniteNumber(rect.y) &&
    isFiniteNumber(rect.width) &&
    isFiniteNumber(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

/**
 * Structural validation of a serialized FlexLayout model. Unknown attributes
 * are allowed (FlexLayout defines many), but the row/tabset/tab skeleton,
 * weights, and popout rectangles must be well formed.
 */
export function isValidWorkspaceModel(model: unknown): boolean {
  if (!isRecord(model)) return false;
  if (!isValidRow(model.layout, 0)) return false;
  if (model.popouts !== undefined) {
    if (!isRecord(model.popouts)) return false;
    for (const popout of Object.values(model.popouts)) {
      if (!isRecord(popout)) return false;
      if (!isValidRow(popout.layout, 0)) return false;
      if (!isValidRect(popout.rect)) return false;
    }
  }
  return true;
}

export function workspaceModelByteSize(model: JsonValue): number {
  return new TextEncoder().encode(JSON.stringify(model)).length;
}

export type WorkspaceLayoutValidation =
  | { ok: true; record: WorkspaceLayoutRecord }
  | { ok: false; reason: string };

/**
 * Validate a candidate record end to end: envelope shape, known schema
 * version, payload size cap, and structural model validity. Anything that
 * fails is rejected so callers can fall back to a default layout.
 */
export function validateWorkspaceLayoutRecord(
  input: unknown,
): WorkspaceLayoutValidation {
  const parsed = workspaceLayoutRecordSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: "Record failed schema validation." };
  }
  const record = parsed.data;
  if (record.schemaVersion !== WORKSPACE_LAYOUT_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `Unknown schema version ${record.schemaVersion}.`,
    };
  }
  if (workspaceModelByteSize(record.model) > WORKSPACE_LAYOUT_MAX_BYTES) {
    return { ok: false, reason: "Layout payload exceeds 512KB." };
  }
  if (!isValidWorkspaceModel(record.model)) {
    return { ok: false, reason: "Layout model is structurally invalid." };
  }
  return { ok: true, record };
}
