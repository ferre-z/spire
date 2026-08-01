import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { AgentNode } from "../../shared/domain";
import {
  NodeWorkspaceCoordinator,
  ScopeViolationError,
} from "./node-worktree";

const exec = promisify(execFile);

type NodeAccess = AgentNode["access"];

const READ_ONLY: NodeAccess = { mode: "read-only", writeScopes: [] };
const SRC_WRITE: NodeAccess = { mode: "workspace-write", writeScopes: ["src"] };

// --- Fixtures ---------------------------------------------------------------

/**
 * A real source repository plus the run's integration worktree, mimicking
 * what RunEngine/LocalWorktreeBackend prepare before the scheduler starts.
 */
async function setupRepo() {
  const root = await mkdtemp(path.join(tmpdir(), "spire-nodewt-"));
  const repository = path.join(root, "repository");
  await mkdir(repository);
  await exec("git", ["init", "-b", "main"], { cwd: repository });
  await exec("git", ["config", "user.email", "spire@example.test"], {
    cwd: repository,
  });
  await exec("git", ["config", "user.name", "Spire Test"], { cwd: repository });
  await mkdir(path.join(repository, "src"));
  await mkdir(path.join(repository, "docs"));
  await writeFile(path.join(repository, "README.md"), "# Fixture\n");
  await writeFile(path.join(repository, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(path.join(repository, "src", "b.ts"), "export const b = 1;\n");
  await writeFile(path.join(repository, "shared.txt"), "line\n");
  await writeFile(path.join(repository, "docs", "notes.md"), "# Notes\n");
  await exec("git", ["add", "."], { cwd: repository });
  await exec("git", ["commit", "-m", "fixture"], { cwd: repository });
  const { stdout: head } = await exec("git", ["rev-parse", "HEAD"], {
    cwd: repository,
  });

  const integrationPath = path.join(root, "integration");
  const integrationBranch = "spire/run-testrun";
  await exec(
    "git",
    ["worktree", "add", "-b", integrationBranch, integrationPath, "HEAD"],
    { cwd: repository },
  );

  const coordinator = new NodeWorkspaceCoordinator({
    repositoryPath: repository,
    integrationPath,
    integrationBranch,
    runId: "test-run-id-123",
    rootDir: path.join(root, "nodes"),
  });
  return { root, repository, head: head.trim(), integrationPath, integrationBranch, coordinator };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return stdout.trim();
}

async function nodeBranches(repository: string): Promise<string[]> {
  const out = await git(repository, [
    "branch",
    "--list",
    "spire/node/testrunid1/*",
    "--format=%(refname:short)",
  ]);
  return out ? out.split("\n") : [];
}

// --- Tests ------------------------------------------------------------------

describe("NodeWorkspaceCoordinator", () => {
  it("gives read-only nodes the integration worktree without a branch", async () => {
    const { integrationPath, coordinator } = await setupRepo();
    const prepared = await coordinator.prepareNode({
      nodeId: "reader",
      visit: 1,
      access: READ_ONLY,
    });
    expect(prepared.directory).toBe(integrationPath);
    expect(prepared.branch).toBeUndefined();
  });

  it("merges parallel non-overlapping node changes at a checkpoint", async () => {
    const { repository, integrationPath, coordinator } = await setupRepo();
    const first = await coordinator.prepareNode({
      nodeId: "b-node",
      visit: 1,
      access: { mode: "workspace-write", writeScopes: ["src"] },
    });
    const second = await coordinator.prepareNode({
      nodeId: "a-node",
      visit: 1,
      access: { mode: "workspace-write", writeScopes: ["docs"] },
    });
    expect(first.directory).not.toBe(integrationPath);
    expect(second.directory).not.toBe(integrationPath);

    await writeFile(path.join(first.directory, "src", "a.ts"), "export const a = 2;\n");
    await writeFile(path.join(second.directory, "docs", "new.md"), "# New\n");
    await coordinator.commitNode("b-node");
    await coordinator.commitNode("a-node");

    const result = await coordinator.mergeAtCheckpoint();
    // Deterministic merge order: node-id order, not commit order.
    expect(result.merged).toEqual(["a-node", "b-node"]);
    expect(result.conflicts).toEqual([]);
    expect(await readFile(path.join(integrationPath, "src", "a.ts"), "utf8")).toBe(
      "export const a = 2;\n",
    );
    expect(await readFile(path.join(integrationPath, "docs", "new.md"), "utf8")).toBe(
      "# New\n",
    );
    // Merged node branches are cleaned out of the source repository.
    expect(await nodeBranches(repository)).toEqual([]);
  });

  it("rejects out-of-scope edits as a scope violation and discards them", async () => {
    const { integrationPath, coordinator } = await setupRepo();
    const prepared = await coordinator.prepareNode({
      nodeId: "writer",
      visit: 1,
      access: SRC_WRITE,
    });
    await writeFile(path.join(prepared.directory, "src", "a.ts"), "export const a = 2;\n");
    await writeFile(path.join(prepared.directory, "README.md"), "# Pwned\n");

    const failure = await coordinator.commitNode("writer").catch((e) => e);
    expect(failure).toBeInstanceOf(ScopeViolationError);
    expect((failure as ScopeViolationError).nodeId).toBe("writer");
    expect((failure as ScopeViolationError).paths).toEqual(["README.md"]);
    expect((failure as Error).message).toContain("README.md");

    await coordinator.discardNode("writer");
    const merge = await coordinator.mergeAtCheckpoint();
    expect(merge.merged).toEqual([]);
    // The integration worktree never saw the in-scope edit either.
    expect(await readFile(path.join(integrationPath, "src", "a.ts"), "utf8")).toBe(
      "export const a = 1;\n",
    );
    expect(await git(integrationPath, ["status", "--porcelain"])).toBe("");
  });

  it("reports a merge conflict for the later node and keeps the earlier merge", async () => {
    const { integrationPath, coordinator } = await setupRepo();
    const first = await coordinator.prepareNode({
      nodeId: "a-first",
      visit: 1,
      access: { mode: "workspace-write", writeScopes: ["shared.txt"] },
    });
    const second = await coordinator.prepareNode({
      nodeId: "b-second",
      visit: 1,
      access: { mode: "workspace-write", writeScopes: ["shared.txt"] },
    });
    await writeFile(path.join(first.directory, "shared.txt"), "first\n");
    await writeFile(path.join(second.directory, "shared.txt"), "second\n");
    await coordinator.commitNode("a-first");
    await coordinator.commitNode("b-second");

    const result = await coordinator.mergeAtCheckpoint();
    expect(result.merged).toEqual(["a-first"]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].nodeId).toBe("b-second");
    expect(result.conflicts[0].files).toContain("shared.txt");
    // The merge was aborted cleanly: integration keeps the first node's work.
    expect(await readFile(path.join(integrationPath, "shared.txt"), "utf8")).toBe(
      "first\n",
    );
    expect(await git(integrationPath, ["status", "--porcelain"])).toBe("");
  });

  it("cleans up a failed node's worktree and branch", async () => {
    const { repository, coordinator } = await setupRepo();
    const prepared = await coordinator.prepareNode({
      nodeId: "doomed",
      visit: 1,
      access: SRC_WRITE,
    });
    expect(prepared.branch).toBeDefined();
    await writeFile(path.join(prepared.directory, "src", "a.ts"), "export const a = 9;\n");

    await coordinator.discardNode("doomed");
    await expect(stat(prepared.directory)).rejects.toThrow();
    expect(await nodeBranches(repository)).toEqual([]);
  });

  it("preserves the source repository across the whole cycle", async () => {
    const { repository, head, coordinator } = await setupRepo();
    const prepared = await coordinator.prepareNode({
      nodeId: "writer",
      visit: 1,
      access: SRC_WRITE,
    });
    await writeFile(path.join(prepared.directory, "src", "a.ts"), "export const a = 2;\n");
    await coordinator.commitNode("writer");
    await coordinator.mergeAtCheckpoint();
    await coordinator.finalDiff();

    expect(await git(repository, ["rev-parse", "HEAD"])).toBe(head);
    expect(await git(repository, ["branch", "--show-current"])).toBe("main");
    expect(await git(repository, ["status", "--porcelain"])).toBe("");
    expect(await nodeBranches(repository)).toEqual([]);
  });

  it("treats a node with no changes as a no-op commit with nothing to merge", async () => {
    const { coordinator } = await setupRepo();
    await coordinator.prepareNode({ nodeId: "idle", visit: 1, access: SRC_WRITE });
    const committed = await coordinator.commitNode("idle");
    expect(committed.changedFiles).toEqual([]);
    const result = await coordinator.mergeAtCheckpoint();
    expect(result.merged).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it("produces a final run diff covering every merged change", async () => {
    const { coordinator } = await setupRepo();
    const prepared = await coordinator.prepareNode({
      nodeId: "writer",
      visit: 1,
      access: { mode: "workspace-write", writeScopes: ["src", "docs"] },
    });
    await writeFile(path.join(prepared.directory, "src", "a.ts"), "export const a = 2;\n");
    await writeFile(path.join(prepared.directory, "docs", "new.md"), "# New\n");
    await coordinator.commitNode("writer");
    await coordinator.mergeAtCheckpoint();

    const final = await coordinator.finalDiff();
    expect(final.changedFiles.sort()).toEqual(["docs/new.md", "src/a.ts"]);
    expect(final.diff).toContain("+export const a = 2;");
    expect(final.diff).toContain("+# New");
  });
});
