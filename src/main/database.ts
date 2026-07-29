import Database from "better-sqlite3";
import type { GraphDefinition, RunRecord } from "../shared/domain";
import type {
  WorkspaceLayoutMode,
  WorkspaceLayoutRecord,
} from "../shared/workspace";
import { TraceJournal, type TraceJournalOptions } from "./trace-journal";

type SettingRow = { value: string };
type JsonRow = { json: string };
type WorkspaceLayoutRow = {
  graph_id: string;
  mode: string;
  schema_version: number;
  model: string;
  updated_at: string;
};

export class SpireDatabase {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS graphs (
        id TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (id, version)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_layouts (
        graph_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        model TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (graph_id, mode)
      );
      CREATE TABLE IF NOT EXISTS trace_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        run_id TEXT,
        node_id TEXT,
        harness_id TEXT,
        provider_id TEXT,
        request_id TEXT,
        kind TEXT NOT NULL,
        level TEXT NOT NULL,
        subsystem TEXT NOT NULL,
        message TEXT NOT NULL,
        payload TEXT,
        payload_bytes INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_trace_events_timestamp
        ON trace_events (timestamp);
      CREATE INDEX IF NOT EXISTS idx_trace_events_correlation_id
        ON trace_events (correlation_id);
      CREATE INDEX IF NOT EXISTS idx_trace_events_run_id
        ON trace_events (run_id);
      CREATE INDEX IF NOT EXISTS idx_trace_events_node_id
        ON trace_events (node_id);
      CREATE INDEX IF NOT EXISTS idx_trace_events_harness_id
        ON trace_events (harness_id);
      CREATE INDEX IF NOT EXISTS idx_trace_events_provider_id
        ON trace_events (provider_id);
      CREATE INDEX IF NOT EXISTS idx_trace_events_request_id
        ON trace_events (request_id);
    `);
  }

  createTraceJournal(options?: TraceJournalOptions): TraceJournal {
    return new TraceJournal(this.db, options);
  }

  getSetting(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as SettingRow | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  listGraphs(): GraphDefinition[] {
    return (
      this.db
        .prepare("SELECT json FROM graphs ORDER BY created_at DESC")
        .all() as JsonRow[]
    ).map((row) => JSON.parse(row.json) as GraphDefinition);
  }

  saveGraph(graph: GraphDefinition): void {
    this.db
      .prepare(
        `INSERT INTO graphs (id, version, created_at, json) VALUES (?, ?, ?, ?)
         ON CONFLICT(id, version) DO UPDATE SET json = excluded.json`,
      )
      .run(graph.id, graph.version, graph.createdAt, JSON.stringify(graph));
  }

  listRuns(): RunRecord[] {
    return (
      this.db
        .prepare("SELECT json FROM runs ORDER BY updated_at DESC")
        .all() as JsonRow[]
    ).map((row) => JSON.parse(row.json) as RunRecord);
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.db
      .prepare("SELECT json FROM runs WHERE id = ?")
      .get(id) as JsonRow | undefined;
    return row ? (JSON.parse(row.json) as RunRecord) : undefined;
  }

  saveRun(run: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, updated_at, json) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           updated_at = excluded.updated_at,
           json = excluded.json`,
      )
      .run(run.id, new Date().toISOString(), JSON.stringify(run));
  }

  listWorkspaceLayouts(graphId: string): WorkspaceLayoutRecord[] {
    const rows = this.db
      .prepare(
        `SELECT graph_id, mode, schema_version, model, updated_at
         FROM workspace_layouts WHERE graph_id = ?`,
      )
      .all(graphId) as WorkspaceLayoutRow[];
    return rows.map((row) => ({
      graphId: row.graph_id,
      mode: row.mode as WorkspaceLayoutMode,
      schemaVersion: row.schema_version,
      model: JSON.parse(row.model) as WorkspaceLayoutRecord["model"],
      updatedAt: row.updated_at,
    }));
  }

  saveWorkspaceLayout(record: WorkspaceLayoutRecord): void {
    this.db
      .prepare(
        `INSERT INTO workspace_layouts
           (graph_id, mode, schema_version, model, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(graph_id, mode) DO UPDATE SET
           schema_version = excluded.schema_version,
           model = excluded.model,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.graphId,
        record.mode,
        record.schemaVersion,
        JSON.stringify(record.model),
        record.updatedAt,
      );
  }

  resetWorkspaceLayouts(graphId: string): void {
    this.db
      .prepare("DELETE FROM workspace_layouts WHERE graph_id = ?")
      .run(graphId);
  }

  close(): void {
    this.db.close();
  }
}
