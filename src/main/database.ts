import Database from "better-sqlite3";
import type { GraphDefinition, RunRecord } from "../shared/domain";

type SettingRow = { value: string };
type JsonRow = { json: string };

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
    `);
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

  close(): void {
    this.db.close();
  }
}
