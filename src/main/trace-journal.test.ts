import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TraceEvent } from "../shared/trace";
import { SpireDatabase } from "./database";
import { REDACTED, TraceJournal, type TraceAppendInput } from "./trace-journal";

function event(overrides: Partial<TraceAppendInput> = {}): TraceAppendInput {
  return {
    timestamp: new Date().toISOString(),
    correlationId: "corr-1",
    kind: "run.lifecycle",
    level: "info",
    subsystem: "run-engine",
    message: "something happened",
    ...overrides,
  };
}

describe("TraceJournal", () => {
  let root: string;
  let database: SpireDatabase;
  let journal: TraceJournal;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "spire-trace-"));
    database = new SpireDatabase(path.join(root, "test.sqlite"));
    journal = database.createTraceJournal();
  });

  afterEach(async () => {
    journal.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  it("assigns monotonically increasing sequences and returns events in order", () => {
    journal.append(event({ message: "first" }));
    journal.append(event({ message: "second" }));
    journal.append(event({ message: "third" }));
    const page = journal.query({});
    expect(page.events.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(page.events.map((item) => item.message)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it("filters by correlation id and compound filters", () => {
    journal.append(event({ correlationId: "corr-a", runId: "run-1" }));
    journal.append(
      event({ correlationId: "corr-b", runId: "run-2", level: "error" }),
    );
    journal.append(event({ correlationId: "corr-a", runId: "run-2" }));

    const byCorrelation = journal.query({ correlationId: "corr-a" });
    expect(byCorrelation.events).toHaveLength(2);
    expect(
      byCorrelation.events.every((item) => item.correlationId === "corr-a"),
    ).toBe(true);

    const compound = journal.query({ runId: "run-2", level: "error" });
    expect(compound.events).toHaveLength(1);
    expect(compound.events[0].correlationId).toBe("corr-b");
  });

  it("filters by node, harness, provider, request, kind, subsystem, and since", () => {
    const base = Date.now();
    journal.append(
      event({
        timestamp: new Date(base - 60_000).toISOString(),
        correlationId: "corr-old",
        nodeId: "node-1",
      }),
    );
    journal.append(
      event({
        correlationId: "corr-new",
        nodeId: "node-2",
        harnessId: "harness-1",
        providerId: "provider-1",
        requestId: "request-1",
        kind: "provider.response",
        subsystem: "provider",
      }),
    );

    expect(journal.query({ nodeId: "node-2" }).events).toHaveLength(1);
    expect(journal.query({ harnessId: "harness-1" }).events).toHaveLength(1);
    expect(journal.query({ providerId: "provider-1" }).events).toHaveLength(1);
    expect(journal.query({ requestId: "request-1" }).events).toHaveLength(1);
    expect(
      journal.query({ kind: "provider.response" }).events,
    ).toHaveLength(1);
    expect(journal.query({ subsystem: "provider" }).events).toHaveLength(1);
    expect(
      journal.query({ since: new Date(base - 30_000).toISOString() }).events,
    ).toHaveLength(1);
  });

  it("paginates with cursors", () => {
    for (let index = 0; index < 5; index += 1) {
      journal.append(event({ message: `event-${index}` }));
    }

    const seen: string[] = [];
    let cursor = undefined;
    do {
      const page = journal.query({ limit: 2, cursor });
      seen.push(...page.events.map((item) => item.message));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(seen).toEqual([
      "event-0",
      "event-1",
      "event-2",
      "event-3",
      "event-4",
    ]);
  });

  it("notifies subscribers with the persisted redacted event", () => {
    const received: TraceEvent[] = [];
    const unsubscribe = journal.subscribe((item) => received.push(item));

    const appended = journal.append(
      event({ payload: { apiKey: "sk-aaaabbbbccccdddd1111" } }),
    );
    expect(received).toHaveLength(1);
    expect(received[0].sequence).toBe(appended.sequence);
    expect(JSON.stringify(received[0].payload)).not.toContain(
      "sk-aaaabbbbccccdddd1111",
    );

    unsubscribe();
    journal.append(event());
    expect(received).toHaveLength(1);
  });

  it("persists events across restart", () => {
    journal.append(event({ message: "before restart" }));
    journal.close();
    database.close();

    const reopened = new SpireDatabase(path.join(root, "test.sqlite"));
    const journal2 = reopened.createTraceJournal();
    const page = journal2.query({});
    expect(page.events).toHaveLength(1);
    expect(page.events[0].message).toBe("before restart");

    // Sequence continues from the persisted maximum.
    const appended = journal2.append(event({ message: "after restart" }));
    expect(appended.sequence).toBe(2);
    journal2.close();
    reopened.close();
  });

  it("redacts sensitive keys recursively at any depth", () => {
    journal.append(
      event({
        payload: {
          apiKey: "top-secret-api-key",
          nested: {
            password: "hunter2",
            deeper: [{ authorization: "Bearer abc", TOKEN: "tok" }],
          },
          list: ["keep", { Secret: "shh" }],
          keepMe: "visible",
        },
      }),
    );

    const stored = journal.query({}).events[0];
    expect(stored.payload).toEqual({
      apiKey: REDACTED,
      nested: {
        password: REDACTED,
        deeper: [{ authorization: REDACTED, TOKEN: REDACTED }],
      },
      list: ["keep", { Secret: REDACTED }],
      keepMe: "visible",
    });
  });

  it("redacts bearer tokens and api-key shapes inside strings", () => {
    journal.append(
      event({
        message: "authorization failed for Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
        payload: {
          note: "use Bearer sk-aaaabbbbccccddddeeeeffff to authenticate",
          description: "key sk-1234567890abcdefgh was rejected",
          untouched: "no secrets here, bearer of good news",
        },
      }),
    );

    const stored = journal.query({}).events[0];
    const raw = JSON.stringify(stored);
    expect(raw).not.toContain("sk-aaaabbbbccccddddeeeeffff");
    expect(raw).not.toContain("sk-1234567890abcdefgh");
    expect(raw).not.toContain("eyJhbGciOiJIUzI1NiJ9.payload.sig");
    expect(raw).toContain("no secrets here, bearer of good news");
  });

  it("redacts secrets inside stringified JSON leaves", () => {
    journal.append(
      event({
        payload: {
          toolArgs: JSON.stringify({ password: "hunter2", keep: "visible" }),
          nested: JSON.stringify({
            outer: JSON.stringify({ apiKey: "sk-aaaabbbbccccdddd1111" }),
          }),
          listArg: JSON.stringify([{ token: "abc123" }, "plain"]),
          notJson: "{not really json",
          untouched: "just a plain string",
        },
      }),
    );

    const stored = journal.query({}).events[0];
    const payload = stored.payload as Record<string, string>;
    expect(JSON.parse(payload.toolArgs)).toEqual({
      password: REDACTED,
      keep: "visible",
    });
    expect(JSON.parse(JSON.parse(payload.nested).outer)).toEqual({
      apiKey: REDACTED,
    });
    expect(JSON.parse(payload.listArg)).toEqual([
      { token: REDACTED },
      "plain",
    ]);
    expect(payload.notJson).toBe("{not really json");
    expect(payload.untouched).toBe("just a plain string");
    expect(JSON.stringify(stored)).not.toContain("hunter2");
    expect(JSON.stringify(stored)).not.toContain("sk-aaaabbbbccccdddd1111");
  });

  it("redacts additional common sensitive key names", () => {
    journal.append(
      event({
        payload: {
          clientSecret: "a",
          apiSecret: "b",
          client_secret: "c",
          sessionId: "d",
          accessKey: "e",
          secretAccessKey: "f",
          keyboard: "keep-me",
        },
      }),
    );

    const stored = journal.query({}).events[0];
    expect(stored.payload).toEqual({
      clientSecret: REDACTED,
      apiSecret: REDACTED,
      client_secret: REDACTED,
      sessionId: REDACTED,
      accessKey: REDACTED,
      secretAccessKey: REDACTED,
      keyboard: "keep-me",
    });
  });

  it("redacts GitHub token shapes that use underscore separators", () => {
    const pat = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    const oauth = "gho_1234567890abcdefghijklmn";
    journal.append(
      event({
        message: `clone failed with ${pat}`,
        payload: { note: `oauth token ${oauth} expired` },
      }),
    );

    const raw = JSON.stringify(journal.query({}).events[0]);
    expect(raw).not.toContain(pat);
    expect(raw).not.toContain(oauth);
  });

  it("rejects schema-invalid input without persisting anything", () => {
    expect(() =>
      journal.append(event({ level: "bogus" as never })),
    ).toThrow();
    expect(() =>
      journal.append(event({ timestamp: "not-a-date" })),
    ).toThrow();
    expect(journal.query({}).events).toHaveLength(0);
  });

  it("auto-prunes once every 1,000 appends", () => {
    // Zero age retention: any prune pass deletes every row already written
    // (timestamps are in the past), so the row count reveals when the
    // cadence counter fires.
    const past = new Date(Date.now() - 60_000).toISOString();
    const strict = database.createTraceJournal({ retentionMaxAgeMs: 0 });
    try {
      for (let index = 0; index < 999; index += 1) {
        strict.append(event({ timestamp: past }));
      }
      expect(strict.query({}).events).toHaveLength(999);

      strict.append(event({ timestamp: past }));
      expect(strict.query({}).events).toHaveLength(0);
    } finally {
      strict.close();
    }
  });

  it("isolates listener exceptions so remaining listeners still fire", () => {
    const received: TraceEvent[] = [];
    journal.subscribe(() => {
      throw new Error("listener boom");
    });
    journal.subscribe((item) => received.push(item));

    const appended = journal.append(event());
    expect(received).toHaveLength(1);
    expect(received[0].sequence).toBe(appended.sequence);
  });

  it("prunes events older than the retention window", () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    journal.append(event({ timestamp: old, message: "ancient" }));
    journal.append(event({ message: "fresh" }));

    journal.prune();
    const page = journal.query({});
    expect(page.events.map((item) => item.message)).toEqual(["fresh"]);
  });

  it("prunes oldest events first when over the byte budget", () => {
    for (let index = 0; index < 5; index += 1) {
      journal.append(
        event({ message: `event-${index}`, payload: { data: "x".repeat(64) } }),
      );
    }

    const bytes = (items: TraceEvent[]) =>
      items.reduce(
        (total, item) =>
          total + Buffer.byteLength(JSON.stringify(item.payload ?? null), "utf8"),
        0,
      );
    const all = journal.query({}).events;
    const kept = all.slice(2);
    journal.prune({ maxBytes: bytes(kept) });

    const remaining = journal.query({}).events;
    expect(remaining.map((item) => item.message)).toEqual(
      kept.map((item) => item.message),
    );
  });

  it("prunes on startup with the configured retention", () => {
    // Ten days old: inside the default 30-day window, outside a strict one.
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    journal.append(event({ timestamp: old, message: "aging" }));
    journal.append(event({ message: "fresh" }));

    // A journal with default retention keeps both at startup.
    const lenient = database.createTraceJournal();
    expect(lenient.query({}).events).toHaveLength(2);
    lenient.close();

    // A journal with a strict retention prunes during construction.
    const strict = database.createTraceJournal({ retentionMaxAgeMs: 1000 });
    strict.close();
    const page = journal.query({});
    expect(page.events.map((item) => item.message)).toEqual(["fresh"]);
  });

  it("keeps secrets out of the raw SQLite file bytes", async () => {
    const apiKey = "sk-zzz9zzz8zzz7zzz6zzz5zzz4";
    const password = "sup3r-s3cret-passphrase";
    journal.append(
      event({
        message: `Authorization: Bearer ${apiKey}`,
        payload: {
          credentials: { apiKey, password },
          note: `the token Bearer ${apiKey} was used`,
        },
      }),
    );
    journal.close();
    database.close();

    const candidates = ["test.sqlite", "test.sqlite-wal", "test.sqlite-shm"];
    for (const name of candidates) {
      let contents: Buffer;
      try {
        contents = await readFile(path.join(root, name));
      } catch {
        continue;
      }
      const text = contents.toString("latin1");
      expect(text).not.toContain(apiKey);
      expect(text).not.toContain(password);
    }
  });
});
