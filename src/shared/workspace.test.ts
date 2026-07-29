import { describe, expect, it } from "vitest";
import {
  WORKSPACE_LAYOUT_MAX_BYTES,
  WORKSPACE_LAYOUT_SCHEMA_VERSION,
  isValidWorkspaceModel,
  validateWorkspaceLayoutRecord,
  workspaceModelByteSize,
  type WorkspaceLayoutRecord,
} from "./workspace";

function minimalModel() {
  return {
    global: { splitterSize: 8 },
    layout: {
      type: "row",
      children: [
        {
          type: "tabset",
          weight: 100,
          children: [
            {
              type: "tab",
              id: "graph-canvas",
              name: "Graph Canvas",
              component: "graph-canvas",
            },
          ],
        },
      ],
    },
  };
}

function validRecord(): WorkspaceLayoutRecord {
  return {
    graphId: "graph-1",
    mode: "desktop",
    schemaVersion: WORKSPACE_LAYOUT_SCHEMA_VERSION,
    model: minimalModel(),
    updatedAt: new Date().toISOString(),
  };
}

describe("isValidWorkspaceModel", () => {
  it("accepts a minimal valid model", () => {
    expect(isValidWorkspaceModel(minimalModel())).toBe(true);
  });

  it("accepts nested rows and popouts", () => {
    const model = {
      layout: {
        type: "row",
        children: [
          {
            type: "row",
            weight: 50,
            children: [
              {
                type: "tabset",
                children: [
                  { type: "tab", id: "a", component: "a", name: "A" },
                ],
              },
            ],
          },
          {
            type: "tabset",
            children: [{ type: "tab", id: "b", component: "b", name: "B" }],
          },
        ],
      },
      popouts: {
        "window-1": {
          rect: { x: 10, y: 10, width: 400, height: 300 },
          layout: {
            type: "row",
            children: [
              {
                type: "tabset",
                children: [
                  { type: "tab", id: "c", component: "c", name: "C" },
                ],
              },
            ],
          },
        },
      },
    };
    expect(isValidWorkspaceModel(model)).toBe(true);
  });

  it("rejects models without a row layout", () => {
    expect(isValidWorkspaceModel({})).toBe(false);
    expect(isValidWorkspaceModel({ layout: { type: "tab" } })).toBe(false);
    expect(isValidWorkspaceModel(null)).toBe(false);
    expect(isValidWorkspaceModel("layout")).toBe(false);
  });

  it("rejects tabs without id or component", () => {
    const model = minimalModel() as {
      layout: { children: { children: unknown[] }[] };
    };
    model.layout.children[0].children = [{ type: "tab", id: "x" }];
    expect(isValidWorkspaceModel(model)).toBe(false);
  });

  it("rejects empty tabsets and rows", () => {
    expect(
      isValidWorkspaceModel({
        layout: { type: "row", children: [{ type: "tabset", children: [] }] },
      }),
    ).toBe(false);
    expect(isValidWorkspaceModel({ layout: { type: "row", children: [] } })).toBe(
      false,
    );
  });

  it("rejects malformed popout rectangles", () => {
    const model = {
      ...minimalModel(),
      popouts: {
        "window-1": {
          rect: { x: 0, y: 0, width: -5, height: 100 },
          layout: minimalModel().layout,
        },
      },
    };
    expect(isValidWorkspaceModel(model)).toBe(false);
  });

  it("rejects pathologically deep nesting", () => {
    let row: unknown = {
      type: "tabset",
      children: [{ type: "tab", id: "a", component: "a", name: "A" }],
    };
    for (let i = 0; i < 64; i += 1) {
      row = { type: "row", children: [row] };
    }
    expect(isValidWorkspaceModel({ layout: row })).toBe(false);
  });
});

describe("validateWorkspaceLayoutRecord", () => {
  it("accepts a valid record", () => {
    const result = validateWorkspaceLayoutRecord(validRecord());
    expect(result.ok).toBe(true);
  });

  it("rejects unknown schema versions", () => {
    const result = validateWorkspaceLayoutRecord({
      ...validRecord(),
      schemaVersion: WORKSPACE_LAYOUT_SCHEMA_VERSION + 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("schema version");
  });

  it("rejects payloads over 512KB", () => {
    const model = minimalModel() as {
      layout: { children: { children: { name: string }[] }[] };
    };
    model.layout.children[0].children[0].name = "x".repeat(
      WORKSPACE_LAYOUT_MAX_BYTES,
    );
    const record = { ...validRecord(), model };
    expect(workspaceModelByteSize(model)).toBeGreaterThan(
      WORKSPACE_LAYOUT_MAX_BYTES,
    );
    expect(validateWorkspaceLayoutRecord(record).ok).toBe(false);
  });

  it("rejects structurally invalid models", () => {
    const result = validateWorkspaceLayoutRecord({
      ...validRecord(),
      model: { layout: { type: "row", children: [] } },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects malformed envelopes", () => {
    expect(validateWorkspaceLayoutRecord(null).ok).toBe(false);
    expect(validateWorkspaceLayoutRecord({}).ok).toBe(false);
    expect(
      validateWorkspaceLayoutRecord({ ...validRecord(), mode: "wide" }).ok,
    ).toBe(false);
    expect(
      validateWorkspaceLayoutRecord({ ...validRecord(), updatedAt: "soon" }).ok,
    ).toBe(false);
  });
});
