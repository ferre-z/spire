import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { LocalWorktreeBackend } from "./worktree";

const exec = promisify(execFile);

describe("LocalWorktreeBackend", () => {
  it("creates an isolated branch and reports real changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "spire-git-"));
    const repository = path.join(root, "repository");
    const worktrees = path.join(root, "worktrees");
    await mkdir(repository);
    await exec("git", ["init"], { cwd: repository });
    await exec("git", ["config", "user.email", "spire@example.test"], {
      cwd: repository,
    });
    await exec("git", ["config", "user.name", "Spire Test"], {
      cwd: repository,
    });
    await writeFile(path.join(repository, "README.md"), "# Fixture\n");
    await exec("git", ["add", "."], { cwd: repository });
    await exec("git", ["commit", "-m", "fixture"], { cwd: repository });

    const backend = new LocalWorktreeBackend(worktrees);
    const prepared = await backend.prepare(repository, "abc-123");
    await writeFile(path.join(prepared.path, "README.md"), "# Changed\n");
    const inspection = await backend.inspect(prepared.path);

    expect(prepared.branch).toBe("spire/run-abc123");
    expect(inspection.changedFiles).toEqual(["README.md"]);
    expect(inspection.diff).toContain("+# Changed");
    await backend.cleanup(prepared.path, repository);
  });
});
