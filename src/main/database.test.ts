import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_LAYOUT_SCHEMA_VERSION,
  type WorkspaceLayoutRecord,
} from "../shared/workspace";
import { SpireDatabase } from "./database";

describe("SpireDatabase trace events", () => {
  let root: string;
  let database: SpireDatabase;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "spire-db-"));
    database = new SpireDatabase(path.join(root, "test.sqlite"));
  });

  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  it("creates the trace_events table alongside the existing tables", () => {
    const journal = database.createTraceJournal();
    journal.append({
      timestamp: new Date().toISOString(),
      correlationId: "corr-1",
      kind: "run.lifecycle",
      level: "info",
      subsystem: "run-engine",
      message: "stored in the same database file",
    });
    journal.close();
    expect(journal.query({}).events).toHaveLength(1);
  });
});

function record(
  graphId: string,
  mode: "desktop" | "compact",
  marker: string,
): WorkspaceLayoutRecord {
  return {
    graphId,
    mode,
    schemaVersion: WORKSPACE_LAYOUT_SCHEMA_VERSION,
    model: {
      layout: {
        type: "row",
        children: [
          {
            type: "tabset",
            children: [
              {
                type: "tab",
                id: "graph-canvas",
                name: marker,
                component: "graph-canvas",
              },
            ],
          },
        ],
      },
    },
    updatedAt: new Date().toISOString(),
  };
}

describe("SpireDatabase workspace layouts", () => {
  let root: string;
  let database: SpireDatabase;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "spire-db-"));
    database = new SpireDatabase(path.join(root, "test.sqlite"));
  });

  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  it("saves and loads a layout round trip", () => {
    database.saveWorkspaceLayout(record("graph-1", "desktop", "saved"));
    const layouts = database.listWorkspaceLayouts("graph-1");
    expect(layouts).toHaveLength(1);
    expect(layouts[0].mode).toBe("desktop");
    expect(layouts[0].schemaVersion).toBe(WORKSPACE_LAYOUT_SCHEMA_VERSION);
    expect(JSON.stringify(layouts[0].model)).toContain("saved");
  });

  it("keeps desktop and compact layouts for one graph separate", () => {
    database.saveWorkspaceLayout(record("graph-1", "desktop", "wide"));
    database.saveWorkspaceLayout(record("graph-1", "compact", "narrow"));
    const layouts = database.listWorkspaceLayouts("graph-1");
    expect(layouts).toHaveLength(2);
    const desktop = layouts.find((item) => item.mode === "desktop");
    const compact = layouts.find((item) => item.mode === "compact");
    expect(JSON.stringify(desktop?.model)).toContain("wide");
    expect(JSON.stringify(compact?.model)).toContain("narrow");
  });

  it("keeps layouts for two graphs separate", () => {
    database.saveWorkspaceLayout(record("graph-1", "desktop", "one"));
    database.saveWorkspaceLayout(record("graph-2", "desktop", "two"));
    expect(database.listWorkspaceLayouts("graph-1")).toHaveLength(1);
    expect(database.listWorkspaceLayouts("graph-2")).toHaveLength(1);
    expect(
      JSON.stringify(database.listWorkspaceLayouts("graph-1")[0].model),
    ).toContain("one");
    expect(
      JSON.stringify(database.listWorkspaceLayouts("graph-2")[0].model),
    ).toContain("two");
  });

  it("shares one layout across every version of a graph", () => {
    const base = new Date().toISOString();
    const graph = {
      id: "graph-1",
      name: "Build & Review",
      maxIterations: 3,
      nodes: [],
      edges: [],
    };
    database.saveGraph({ ...graph, version: 1, createdAt: base } as never);
    database.saveWorkspaceLayout(record("graph-1", "desktop", "shared"));
    database.saveGraph({ ...graph, version: 2, createdAt: base } as never);
    database.saveGraph({ ...graph, version: 3, createdAt: base } as never);
    // Three stored versions, still a single layout keyed by the stable id.
    expect(database.listGraphs()).toHaveLength(3);
    expect(database.listWorkspaceLayouts("graph-1")).toHaveLength(1);
    expect(
      JSON.stringify(database.listWorkspaceLayouts("graph-1")[0].model),
    ).toContain("shared");
  });

  it("overwrites the layout for the same graph and mode", () => {
    database.saveWorkspaceLayout(record("graph-1", "desktop", "first"));
    database.saveWorkspaceLayout(record("graph-1", "desktop", "second"));
    const layouts = database.listWorkspaceLayouts("graph-1");
    expect(layouts).toHaveLength(1);
    expect(JSON.stringify(layouts[0].model)).toContain("second");
  });

  it("resets only the layouts of the given graph", () => {
    database.saveWorkspaceLayout(record("graph-1", "desktop", "one"));
    database.saveWorkspaceLayout(record("graph-1", "compact", "one-c"));
    database.saveWorkspaceLayout(record("graph-2", "desktop", "two"));
    database.resetWorkspaceLayouts("graph-1");
    expect(database.listWorkspaceLayouts("graph-1")).toHaveLength(0);
    expect(database.listWorkspaceLayouts("graph-2")).toHaveLength(1);
  });
});
