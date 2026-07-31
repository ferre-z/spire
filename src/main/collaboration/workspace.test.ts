import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { CollaborationMessage } from "../../shared/collaboration";
import type { AgentNode } from "../../shared/domain";
import { CollaborationWorkspace } from "./workspace";

const exec = promisify(execFile);

// --- Fixtures ---------------------------------------------------------------

const NODES = [
  { id: "planner", name: "Planner", groupId: "team" },
  { id: "implementer", name: "Implementer", groupId: "team" },
  { id: "reviewer", name: "Reviewer" },
  { id: "S/p", name: "Sub planner" },
];

const EDGES = [
  { source: "planner", target: "implementer" },
  { source: "planner", target: "reviewer" },
  { source: "implementer", target: "reviewer" },
];

function message(overrides: Partial<CollaborationMessage> = {}): CollaborationMessage {
  return {
    id: "run-1:0",
    runId: "run-1",
    senderNodeId: "planner",
    sequence: 0,
    createdAt: "2026-07-31T10:00:00.000Z",
    recipient: { kind: "node", id: "implementer" },
    kind: "handoff",
    subject: "Take over the schema work",
    body: "The plan is ready; implement the schema.",
    artifactPaths: [],
    ...overrides,
  };
}

async function setup() {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "spire-collab-"));
  const workspace = new CollaborationWorkspace({
    userDataDir,
    runId: "run-1",
    goal: "Ship the schema migration",
    nodes: NODES,
    edges: EDGES,
  });
  return { userDataDir, workspace };
}

function packetNode(id: string, overrides: Partial<AgentNode> = {}): AgentNode {
  return {
    kind: "agent",
    id,
    name: id,
    job: `job-${id}`,
    harnessId: "opencode",
    modelId: "test-model",
    access: { mode: "read-only", writeScopes: [] },
    authority: { scope: "self", actions: [] },
    activation: "all",
    maxVisits: 3,
    position: { x: 0, y: 0 },
    ...overrides,
  };
}

// --- Tests ------------------------------------------------------------------

describe("CollaborationWorkspace", () => {
  it("creates the run collaboration directory under userData", async () => {
    const { userDataDir, workspace } = await setup();
    expect(workspace.root).toBe(
      path.join(userDataDir, "runs", "run-1", "collaboration"),
    );
    await workspace.deliver(message());
    const entries = await readdir(workspace.root);
    expect(entries).toContain("inbox");
    expect(entries).toContain("index.md");
  });

  it("delivers a node-recipient message to that node's inbox only", async () => {
    const { workspace } = await setup();
    await workspace.deliver(message());

    const inbox = await readFile(
      path.join(workspace.root, "inbox", "implementer.md"),
      "utf8",
    );
    expect(inbox).toContain("Take over the schema work");
    expect(inbox).toContain("The plan is ready; implement the schema.");
    expect(inbox).toContain("planner");

    await expect(
      readFile(path.join(workspace.root, "inbox", "reviewer.md"), "utf8"),
    ).rejects.toThrow();
  });

  it("writes handoff/decision/report documents at deterministic safe paths", async () => {
    const { workspace } = await setup();
    const first = await setup();
    const handoff = message({ subject: "Handoff: schema" });
    const [a, b] = await Promise.all([
      workspace.deliver(handoff),
      first.workspace.deliver(handoff),
    ]);
    // Same message → same relative document path across instances.
    expect(a.map((p) => path.relative(workspace.root, p))).toEqual(
      b.map((p) => path.relative(first.workspace.root, p)),
    );
    expect(path.relative(workspace.root, a[0])).toBe(
      path.join("handoffs", "000000-planner-handoff-schema.md"),
    );

    const decision = await workspace.deliver(
      message({ sequence: 1, kind: "decision", subject: "Use zod" }),
    );
    expect(path.relative(workspace.root, decision[0])).toBe(
      path.join("decisions", "000001-planner-use-zod.md"),
    );
    const report = await workspace.deliver(
      message({ sequence: 2, kind: "report", subject: "Status" }),
    );
    expect(path.relative(workspace.root, report[0])).toBe(
      path.join("reports", "000002-planner-status.md"),
    );
  });

  it("sanitizes namespaced node ids and hostile subjects in filenames", async () => {
    const { workspace } = await setup();
    const written = await workspace.deliver(
      message({
        senderNodeId: "S/p",
        subject: "../../etc/passwd: steal it",
        recipient: { kind: "node", id: "S/p" },
      }),
    );
    for (const file of written) {
      const relative = path.relative(workspace.root, file);
      expect(relative.startsWith("..")).toBe(false);
      expect(path.isAbsolute(relative)).toBe(false);
      // The filename segment itself contains no path separators.
      expect(path.basename(file)).not.toMatch(/[/\\]/);
      expect(path.basename(file)).not.toContain("..");
    }
    // The namespaced recipient inbox is a flat, safe file.
    const inboxNames = await readdir(path.join(workspace.root, "inbox"));
    expect(inboxNames).toHaveLength(1);
    expect(inboxNames[0]).not.toContain("/");
    expect(inboxNames[0]).toMatch(/\.md$/);
  });

  it("delivers group-recipient messages to every group member", async () => {
    const { workspace } = await setup();
    await workspace.deliver(
      message({ recipient: { kind: "group", id: "team" } }),
    );
    const names = (await readdir(path.join(workspace.root, "inbox"))).sort();
    expect(names).toEqual(["implementer.md", "planner.md"]);
  });

  it("delivers successors-recipient messages to the sender's edge targets", async () => {
    const { workspace } = await setup();
    await workspace.deliver(message({ recipient: { kind: "successors" } }));
    const names = (await readdir(path.join(workspace.root, "inbox"))).sort();
    // planner's successors: implementer and reviewer.
    expect(names).toEqual(["implementer.md", "reviewer.md"]);
  });

  it("keeps a chronological index linking every document", async () => {
    const { workspace } = await setup();
    await workspace.deliver(message({ sequence: 0, subject: "First" }));
    await workspace.deliver(
      message({ sequence: 1, kind: "decision", subject: "Second" }),
    );
    await workspace.recordCheckpoint({
      nodeId: "gate",
      name: "Gate",
      summary: "Gate passed.",
    });
    const index = await readFile(path.join(workspace.root, "index.md"), "utf8");
    const firstPos = index.indexOf("First");
    const secondPos = index.indexOf("Second");
    const gatePos = index.indexOf("Gate");
    expect(firstPos).toBeGreaterThanOrEqual(0);
    expect(secondPos).toBeGreaterThan(firstPos);
    expect(gatePos).toBeGreaterThan(secondPos);
    expect(index).toContain("handoffs/000000-planner-first.md");
    expect(index).toContain("decisions/000001-planner-second.md");
    expect(index).toContain("checkpoints/");
  });

  it("renders artifact paths as Markdown links in inboxes and documents", async () => {
    const { workspace } = await setup();
    const [doc] = await workspace.deliver(
      message({ artifactPaths: ["docs/plan.md", "dist/schema.sql"] }),
    );
    const inbox = await readFile(
      path.join(workspace.root, "inbox", "implementer.md"),
      "utf8",
    );
    expect(inbox).toContain("[docs/plan.md](docs/plan.md)");
    expect(inbox).toContain("[dist/schema.sql](dist/schema.sql)");
    const document = await readFile(doc, "utf8");
    expect(document).toContain("[docs/plan.md](docs/plan.md)");
  });

  it("does not write a document for question messages", async () => {
    const { workspace } = await setup();
    const written = await workspace.deliver(message({ kind: "question" }));
    expect(written).toEqual([]);
    const inbox = await readFile(
      path.join(workspace.root, "inbox", "implementer.md"),
      "utf8",
    );
    expect(inbox).toContain("Take over the schema work");
  });

  it("assembles a context packet filtered to the requesting node", async () => {
    const { workspace } = await setup();
    await workspace.deliver(
      message({ recipient: { kind: "node", id: "implementer" } }),
    );
    await workspace.deliver(
      message({
        sequence: 1,
        subject: "Reviewer only",
        recipient: { kind: "node", id: "reviewer" },
      }),
    );
    const packet = await workspace.buildContextPacket({
      node: packetNode("implementer", {
        access: { mode: "workspace-write", writeScopes: ["src/schema"] },
        authority: { scope: "connected", actions: ["retry"] },
      }),
      directory: "/tmp/worktrees/run-1",
      predecessors: [
        {
          nodeId: "planner",
          name: "Planner",
          status: "succeeded",
          summary: "Plan ready.",
          artifacts: [{ name: "plan", path: "docs/plan.md" }],
        },
        { nodeId: "reviewer", name: "Reviewer", status: "waiting" },
      ],
    });

    expect(packet).toContain("Ship the schema migration"); // run objective
    expect(packet).toContain("job-implementer"); // node job
    expect(packet).toContain("/tmp/worktrees/run-1"); // working directory
    expect(packet).toContain("src/schema"); // accessible write paths
    expect(packet).toContain("connected"); // authority scope
    expect(packet).toContain("retry"); // authority actions
    // Incoming messages: only this node's inbox.
    expect(packet).toContain("Take over the schema work");
    expect(packet).not.toContain("Reviewer only");
    // Relevant outputs: predecessor summaries + artifact links.
    expect(packet).toContain("Plan ready.");
    expect(packet).toContain("[plan](docs/plan.md)");
  });

  it("survives an app restart: a fresh instance sees prior inbox and continues numbering", async () => {
    const { userDataDir, workspace } = await setup();
    await workspace.deliver(message());
    await workspace.recordCheckpoint({
      nodeId: "gate",
      name: "Gate",
      summary: "First pass.",
    });

    const restarted = new CollaborationWorkspace({
      userDataDir,
      runId: "run-1",
      goal: "Ship the schema migration",
      nodes: NODES,
      edges: EDGES,
    });
    const packet = await restarted.buildContextPacket({
      node: packetNode("implementer"),
      directory: "/tmp/worktrees/run-1",
      predecessors: [],
    });
    expect(packet).toContain("Take over the schema work");

    const checkpointPath = await restarted.recordCheckpoint({
      nodeId: "gate",
      name: "Gate",
      summary: "Second pass.",
    });
    // Numbering continues instead of clobbering the first checkpoint doc.
    expect(path.basename(checkpointPath)).not.toBe(
      path.basename(
        (await readdir(path.join(restarted.root, "checkpoints"))).sort()[0],
      ),
    );
    const checkpoints = await readdir(path.join(restarted.root, "checkpoints"));
    expect(checkpoints).toHaveLength(2);
  });

  it("keeps communication files outside Git status of the run worktree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "spire-collab-git-"));
    const repository = path.join(root, "repository");
    const { workspace } = await setup();
    await exec("git", ["init", repository]);
    await exec("git", ["config", "user.email", "spire@example.test"], {
      cwd: repository,
    });
    await exec("git", ["config", "user.name", "Spire Test"], {
      cwd: repository,
    });

    await workspace.deliver(message());
    await workspace.recordCheckpoint({
      nodeId: "gate",
      name: "Gate",
      summary: "Passed.",
    });

    const { stdout } = await exec("git", ["status", "--porcelain"], {
      cwd: repository,
    });
    expect(stdout.trim()).toBe("");
  });
});
