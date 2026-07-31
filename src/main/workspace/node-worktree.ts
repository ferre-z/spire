import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentNode } from "../../shared/domain";
import { safeSegment } from "../collaboration/workspace";

const exec = promisify(execFile);

/**
 * Per-node workspace isolation on top of a run's integration worktree.
 *
 * Read-only nodes run directly in the integration worktree. Each
 * workspace-write node attempt branches a private node worktree from the
 * integration branch's current HEAD (the "current checkpoint"), so parallel
 * nodes never see each other's uncommitted edits. After a successful attempt
 * the changed paths are validated against the node's `writeScopes` and
 * committed on the node branch; out-of-scope edits raise a
 * `ScopeViolationError` and are discarded. Node branches are merged into the
 * integration branch only at checkpoints, in ascending node-id order
 * (deterministic when several branches merge at one checkpoint). A merge
 * conflict is reported per node — the scheduler turns it into a node failure
 * eligible for failure routing — and the integration worktree is left clean.
 *
 * Node worktrees and branches live under the coordinator's `rootDir` and the
 * `spire/run-<id>/node-*` branch namespace; both are removed after merge or
 * discard so the source repository is left exactly as the run found it.
 */

export type NodeAccess = AgentNode["access"];

export type NodeWorkspaceCoordinatorOptions = {
  /** Source repository (owns the worktree/branch refs). */
  repositoryPath: string;
  /** The run's integration worktree path. */
  integrationPath: string;
  /** The run's integration branch (node branches fork from its HEAD). */
  integrationBranch: string;
  runId: string;
  /** Directory node worktrees are created under. */
  rootDir: string;
};

export type PreparedNodeWorkspace = {
  nodeId: string;
  /** Directory the harness must run in for this attempt. */
  directory: string;
  /** Node branch name (workspace-write attempts only). */
  branch?: string;
};

export type MergeConflict = {
  nodeId: string;
  branch: string;
  /** Files left unmerged before the merge was aborted. */
  files: string[];
};

export type CheckpointMergeResult = {
  /** Node ids merged into the integration branch, in node-id order. */
  merged: string[];
  conflicts: MergeConflict[];
};

export class ScopeViolationError extends Error {
  constructor(
    readonly nodeId: string,
    /** Changed paths outside the node's write scopes. */
    readonly paths: string[],
    readonly scopes: string[],
  ) {
    super(
      `Node ${nodeId} changed paths outside its write scopes: ${paths.join(", ")} ` +
        `(allowed: ${scopes.join(", ") || "none"}).`,
    );
    this.name = "ScopeViolationError";
  }
}

type TrackedNode = {
  nodeId: string;
  visit: number;
  directory: string;
  branch: string;
  access: NodeAccess;
  committed: boolean;
  hasChanges: boolean;
};

/** A scope is a repo-relative path prefix: `src` covers everything under it. */
function inScope(changedPath: string, scopes: string[]): boolean {
  return scopes.some((raw) => {
    const scope = raw.replace(/\/+$/, "");
    if (scope === "" || scope === ".") return true;
    return changedPath === scope || changedPath.startsWith(`${scope}/`);
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

export class NodeWorkspaceCoordinator {
  private readonly options: NodeWorkspaceCoordinatorOptions;
  private readonly shortRunId: string;
  private readonly nodes = new Map<string, TrackedNode>();
  /** Base revision of the integration branch when the run started. */
  private baseRevision?: string;
  /**
   * Serializes all git operations: the scheduler runs parallel node attempts
   * concurrently, and concurrent worktree/branch/index operations on one
   * repository race on git's file locks.
   */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(options: NodeWorkspaceCoordinatorOptions) {
    this.options = options;
    this.shortRunId = options.runId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10);
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lock.then(operation, operation);
    this.lock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Resolve the working directory for a node attempt. Read-only nodes get
   * the integration worktree; workspace-write nodes get a fresh node
   * worktree branched from the integration branch's current HEAD.
   */
  async prepareNode(input: {
    nodeId: string;
    visit: number;
    access: NodeAccess;
  }): Promise<PreparedNodeWorkspace> {
    return this.serialized(async () => {
      // Pin the run's base revision before any node branch can merge.
      await this.base();
      if (input.access.mode === "read-only") {
        return {
          nodeId: input.nodeId,
          directory: this.options.integrationPath,
        };
      }
      // A previous unmerged attempt for this node (e.g. a retry after a
      // failure) is discarded before branching again.
      if (this.nodes.has(input.nodeId)) {
        await this.discardNodeInner(input.nodeId);
      }
      const safe = safeSegment(input.nodeId);
      const branch = `spire/run-${this.shortRunId}/node-${safe}-v${input.visit}`;
      const directory = path.join(
        this.options.rootDir,
        `${safe}-v${input.visit}`,
      );
      await mkdir(this.options.rootDir, { recursive: true });
      await git(this.options.repositoryPath, [
        "worktree",
        "add",
        "-b",
        branch,
        directory,
        this.options.integrationBranch,
      ]);
      this.nodes.set(input.nodeId, {
        nodeId: input.nodeId,
        visit: input.visit,
        directory,
        branch,
        access: input.access,
        committed: false,
        hasChanges: false,
      });
      return { nodeId: input.nodeId, directory, branch };
    });
  }

  /**
   * Validate a finished attempt's changed paths against its write scopes and
   * commit them on the node branch. Throws ScopeViolationError when any
   * changed path is out of scope; the attempt is then the caller's to
   * discard. A change-free attempt commits nothing.
   */
  async commitNode(nodeId: string): Promise<{ changedFiles: string[] }> {
    return this.serialized(async () => {
      const tracked = this.requireTracked(nodeId);
      const { writeScopes } = tracked.access;
      const changedFiles = await this.changedFiles(tracked.directory);
      const violations = changedFiles.filter(
        (file) => !inScope(file, writeScopes),
      );
      if (violations.length > 0) {
        throw new ScopeViolationError(nodeId, violations, writeScopes);
      }
      tracked.hasChanges = changedFiles.length > 0;
      if (tracked.hasChanges) {
        await git(tracked.directory, ["add", "--all"]);
        await git(tracked.directory, [
          "commit",
          "-m",
          `spire: node ${nodeId} visit ${tracked.visit}`,
        ]);
      }
      tracked.committed = true;
      // The branch now holds the work; the worktree is no longer needed.
      await this.removeWorktree(tracked.directory);
      return { changedFiles };
    });
  }

  /** Remove a node's worktree and branch without merging (failed attempt). */
  async discardNode(nodeId: string): Promise<void> {
    return this.serialized(() => this.discardNodeInner(nodeId));
  }

  private async discardNodeInner(nodeId: string): Promise<void> {
    const tracked = this.nodes.get(nodeId);
    if (!tracked) return;
    this.nodes.delete(nodeId);
    await this.removeWorktree(tracked.directory);
    await git(this.options.repositoryPath, [
      "branch",
      "-D",
      tracked.branch,
    ]).catch(() => undefined);
  }

  /**
   * Merge every committed, not-yet-merged node branch into the integration
   * branch, in ascending node-id order. A conflicting merge is aborted, the
   * conflict is reported for that node (its branch is discarded), and the
   * remaining merges continue.
   */
  async mergeAtCheckpoint(): Promise<CheckpointMergeResult> {
    return this.serialized(async () => {
      const pending = [...this.nodes.values()]
        .filter((tracked) => tracked.committed && tracked.hasChanges)
        .sort((a, b) =>
          a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0,
        );
      const merged: string[] = [];
      const conflicts: MergeConflict[] = [];
      for (const tracked of pending) {
        this.nodes.delete(tracked.nodeId);
        try {
          await git(this.options.integrationPath, [
            "merge",
            "--no-ff",
            "--no-edit",
            tracked.branch,
          ]);
          merged.push(tracked.nodeId);
        } catch {
          const unmerged = await git(this.options.integrationPath, [
            "diff",
            "--name-only",
            "--diff-filter=U",
          ]).catch(() => "");
          await git(this.options.integrationPath, ["merge", "--abort"]).catch(
            () => undefined,
          );
          conflicts.push({
            nodeId: tracked.nodeId,
            branch: tracked.branch,
            files: unmerged.split("\n").filter(Boolean),
          });
        }
        await git(this.options.repositoryPath, [
          "branch",
          "-D",
          tracked.branch,
        ]).catch(() => undefined);
      }
      return { merged, conflicts };
    });
  }

  /**
   * Diff of the integration worktree against the run's base revision (the
   * integration branch HEAD pinned before any node branch could merge) —
   * the full run diff once checkpoints merged.
   */
  async finalDiff(): Promise<{ diff: string; changedFiles: string[] }> {
    return this.serialized(async () => {
      const base = await this.base();
      // Surface untracked files in the diff without staging real content.
      await git(this.options.integrationPath, [
        "add",
        "--intent-to-add",
        "--all",
      ]);
      const [diff, names] = await Promise.all([
        git(this.options.integrationPath, [
          "diff",
          "--no-ext-diff",
          "--binary",
          base,
        ]),
        git(this.options.integrationPath, ["diff", "--name-only", base]),
      ]);
      return { diff, changedFiles: names.split("\n").filter(Boolean) };
    });
  }

  // --- Internals ------------------------------------------------------------

  private requireTracked(nodeId: string): TrackedNode {
    const tracked = this.nodes.get(nodeId);
    if (!tracked) {
      throw new Error(`Node ${nodeId} has no prepared workspace.`);
    }
    return tracked;
  }

  private async base(): Promise<string> {
    if (!this.baseRevision) {
      this.baseRevision = (
        await git(this.options.integrationPath, ["rev-parse", "HEAD"])
      ).trim();
    }
    return this.baseRevision;
  }

  private async changedFiles(directory: string): Promise<string[]> {
    await git(directory, ["add", "--intent-to-add", "--all"]);
    const status = await git(directory, ["status", "--porcelain"]);
    return status
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).trim());
  }

  private async removeWorktree(directory: string): Promise<void> {
    await git(this.options.repositoryPath, [
      "worktree",
      "remove",
      "--force",
      directory,
    ]).catch(() => undefined);
  }
}
