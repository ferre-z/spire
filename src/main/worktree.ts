import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type PreparedWorkspace = {
  path: string;
  branch: string;
  dirtySource: boolean;
};

export interface ExecutionBackend {
  prepare(repositoryPath: string, runId: string): Promise<PreparedWorkspace>;
  inspect(workspacePath: string): Promise<{
    diff: string;
    changedFiles: string[];
  }>;
  cleanup(workspacePath: string, repositoryPath: string): Promise<void>;
  exportPatch(workspacePath: string, destination: string): Promise<void>;
}

export class LocalWorktreeBackend implements ExecutionBackend {
  constructor(private readonly root: string) {}

  async prepare(
    repositoryPath: string,
    runId: string,
  ): Promise<PreparedWorkspace> {
    await exec("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repositoryPath,
    });
    const { stdout: status } = await exec("git", ["status", "--porcelain"], {
      cwd: repositoryPath,
    });
    const shortId = runId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10);
    const branch = `spire/run-${shortId}`;
    const workspacePath = path.join(this.root, shortId);
    await mkdir(this.root, { recursive: true });
    await exec(
      "git",
      ["worktree", "add", "-b", branch, workspacePath, "HEAD"],
      { cwd: repositoryPath },
    );
    return {
      path: workspacePath,
      branch,
      dirtySource: status.trim().length > 0,
    };
  }

  async inspect(
    workspacePath: string,
  ): Promise<{ diff: string; changedFiles: string[] }> {
    this.assertManaged(workspacePath);
    await exec("git", ["add", "--intent-to-add", "--all"], {
      cwd: workspacePath,
    });
    const [{ stdout: unstaged }, { stdout: staged }, { stdout: status }] =
      await Promise.all([
        exec("git", ["diff", "--no-ext-diff", "--binary"], {
          cwd: workspacePath,
          maxBuffer: 20 * 1024 * 1024,
        }),
        exec("git", ["diff", "--no-ext-diff", "--binary", "--cached"], {
          cwd: workspacePath,
          maxBuffer: 20 * 1024 * 1024,
        }),
        exec("git", ["status", "--porcelain"], { cwd: workspacePath }),
      ]);
    const changedFiles = status
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).trim());
    return {
      diff: [staged, unstaged].filter(Boolean).join("\n"),
      changedFiles,
    };
  }

  async cleanup(
    workspacePath: string,
    repositoryPath: string,
  ): Promise<void> {
    this.assertManaged(workspacePath);
    await exec("git", ["worktree", "remove", "--force", workspacePath], {
      cwd: repositoryPath,
    });
  }

  async exportPatch(
    workspacePath: string,
    destination: string,
  ): Promise<void> {
    const { diff } = await this.inspect(workspacePath);
    await writeFile(destination, diff, "utf8");
  }

  private assertManaged(workspacePath: string): void {
    const relative = path.relative(this.root, workspacePath);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      relative.length === 0
    ) {
      throw new Error("Refusing to operate outside Spire's worktree directory.");
    }
  }
}
