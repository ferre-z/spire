import Database from "better-sqlite3";
import { collaborationMessageSchema } from "../shared/collaboration";
import type { CollaborationMessage } from "../shared/collaboration";
import {
  graphDefinitionV2Schema,
  type GraphDefinition,
  type GraphDefinitionV2,
  type RunRecord,
} from "../shared/domain";
import {
  appliedPlanPatchSchema,
  executionPlanSchema,
  nodeExecutionSchema,
  type AppliedPlanPatch,
  type ExecutionPlan,
  type NodeExecution,
} from "../shared/execution";
import {
  harnessSessionSchema,
  type HarnessSession,
} from "../shared/harness";
import type {
  WorkspaceLayoutMode,
  WorkspaceLayoutRecord,
} from "../shared/workspace";
import { readGraphDefinition } from "./graph-migration";
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
      CREATE TABLE IF NOT EXISTS execution_plans (
        run_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS node_executions (
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        status TEXT NOT NULL,
        visits INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (run_id, node_id)
      );
      CREATE TABLE IF NOT EXISTS collaboration_messages (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS plan_patches (
        run_id TEXT NOT NULL,
        applied_revision INTEGER NOT NULL,
        id TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (run_id, applied_revision)
      );
      CREATE TABLE IF NOT EXISTS harness_sessions (
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        directory TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (run_id, node_id)
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

  /** Save a graph in the v2 format; legacy input must be migrated first. */
  saveGraphV2(graph: GraphDefinitionV2): void {
    const validated = graphDefinitionV2Schema.parse(graph);
    this.db
      .prepare(
        `INSERT INTO graphs (id, version, created_at, json) VALUES (?, ?, ?, ?)
         ON CONFLICT(id, version) DO UPDATE SET json = excluded.json`,
      )
      .run(
        validated.id,
        validated.version,
        validated.createdAt,
        JSON.stringify(validated),
      );
  }

  /**
   * List every stored graph as graph v2. Rows saved by legacy callers are
   * normalized on read; rows saved via saveGraphV2 are returned as-is.
   */
  listGraphsV2(): GraphDefinitionV2[] {
    return (
      this.db
        .prepare("SELECT json FROM graphs ORDER BY created_at DESC")
        .all() as JsonRow[]
    ).map((row) => readGraphDefinition(JSON.parse(row.json)));
  }

  saveExecutionPlan(plan: ExecutionPlan): void {
    const validated = executionPlanSchema.parse(plan);
    this.db
      .prepare(
        `INSERT INTO execution_plans (run_id, revision, updated_at, json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           revision = excluded.revision,
           updated_at = excluded.updated_at,
           json = excluded.json`,
      )
      .run(
        validated.runId,
        validated.revision,
        validated.updatedAt,
        JSON.stringify(validated),
      );
  }

  getExecutionPlan(runId: string): ExecutionPlan | undefined {
    const row = this.db
      .prepare("SELECT json FROM execution_plans WHERE run_id = ?")
      .get(runId) as JsonRow | undefined;
    return row ? executionPlanSchema.parse(JSON.parse(row.json)) : undefined;
  }

  saveNodeExecution(runId: string, node: NodeExecution): void {
    const validated = nodeExecutionSchema.parse(node);
    this.db
      .prepare(
        `INSERT INTO node_executions (run_id, node_id, status, visits, json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id, node_id) DO UPDATE SET
           status = excluded.status,
           visits = excluded.visits,
           json = excluded.json`,
      )
      .run(
        runId,
        validated.nodeId,
        validated.status,
        validated.visits,
        JSON.stringify(validated),
      );
  }

  listNodeExecutions(runId: string): NodeExecution[] {
    return (
      this.db
        .prepare(
          `SELECT json FROM node_executions WHERE run_id = ?
           ORDER BY node_id ASC`,
        )
        .all(runId) as JsonRow[]
    ).map((row) => nodeExecutionSchema.parse(JSON.parse(row.json)));
  }

  /**
   * Persist a new plan revision and one node's state atomically: either both
   * writes land or neither does.
   */
  savePlanAndNodeExecution(plan: ExecutionPlan, node: NodeExecution): void {
    this.db.transaction(() => {
      this.saveExecutionPlan(plan);
      this.saveNodeExecution(plan.runId, node);
    })();
  }

  appendCollaborationMessage(message: CollaborationMessage): void {
    const validated = collaborationMessageSchema.parse(message);
    this.db
      .prepare(
        `INSERT INTO collaboration_messages (run_id, sequence, created_at, json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        validated.runId,
        validated.sequence,
        validated.createdAt,
        JSON.stringify(validated),
      );
  }

  listCollaborationMessages(runId: string): CollaborationMessage[] {
    return (
      this.db
        .prepare(
          `SELECT json FROM collaboration_messages WHERE run_id = ?
           ORDER BY sequence ASC`,
        )
        .all(runId) as JsonRow[]
    ).map((row) => collaborationMessageSchema.parse(JSON.parse(row.json)));
  }

  savePlanPatch(runId: string, patch: AppliedPlanPatch): void {
    const validated = appliedPlanPatchSchema.parse(patch);
    this.db
      .prepare(
        `INSERT INTO plan_patches (run_id, applied_revision, id, applied_at, json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        validated.appliedRevision,
        validated.id,
        validated.appliedAt,
        JSON.stringify(validated),
      );
  }

  listPlanPatches(runId: string): AppliedPlanPatch[] {
    return (
      this.db
        .prepare(
          `SELECT json FROM plan_patches WHERE run_id = ?
           ORDER BY applied_revision ASC`,
        )
        .all(runId) as JsonRow[]
    ).map((row) => appliedPlanPatchSchema.parse(JSON.parse(row.json)));
  }

  saveHarnessSession(session: HarnessSession): void {
    const validated = harnessSessionSchema.parse(session);
    this.db
      .prepare(
        `INSERT INTO harness_sessions (run_id, node_id, directory, json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(run_id, node_id) DO UPDATE SET
           directory = excluded.directory,
           json = excluded.json`,
      )
      .run(
        validated.runId,
        validated.nodeId,
        validated.directory,
        JSON.stringify(validated),
      );
  }

  getHarnessSession(runId: string, nodeId: string): HarnessSession | undefined {
    const row = this.db
      .prepare(
        "SELECT json FROM harness_sessions WHERE run_id = ? AND node_id = ?",
      )
      .get(runId, nodeId) as JsonRow | undefined;
    return row ? harnessSessionSchema.parse(JSON.parse(row.json)) : undefined;
  }

  close(): void {
    this.db.close();
  }
}
