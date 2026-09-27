// packages/core/src/adapters/gitCli.ts
// GitPort implementation using the git CLI

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { GitPort, WorktreeInfo } from "../ports/git.js";

const execFileAsync = promisify(execFile);

async function git(
  args: string[],
  cwd: string,
  timeoutMs = 30000,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
}

export class GitCliAdapter implements GitPort {
  async validateRef(repoRoot: string, ref: string): Promise<string> {
    const { stdout } = await git(
      ["rev-parse", "--verify", ref],
      repoRoot,
    );
    return stdout.trim();
  }

  async diff(repoRoot: string, base: string, head: string): Promise<string> {
    const { stdout } = await git(
      [
        "diff",
        "--unified=0",
        "--no-color",
        "--find-renames",
        base,
        head,
        "--",
        "*.ts",
        "*.tsx",
      ],
      repoRoot,
      60000,
    );
    return stdout;
  }

  async showFile(repoRoot: string, sha: string, filePath: string): Promise<string> {
    const { stdout } = await git(
      ["show", `${sha}:${filePath}`],
      repoRoot,
    );
    return stdout;
  }

  async addWorktree(
    repoRoot: string,
    worktreePath: string,
    sha: string,
    branch?: string,
  ): Promise<WorktreeInfo> {
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    const args = branch
      ? ["worktree", "add", "-b", branch, worktreePath, sha]
      : ["worktree", "add", "--detach", worktreePath, sha];
    await git(args, repoRoot, 30000);
    return { path: worktreePath, sha };
  }

  async removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
    try {
      await git(["worktree", "remove", "--force", worktreePath], repoRoot);
    } catch {
      // best-effort
    }
  }

  async listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
    const { stdout } = await git(["worktree", "list", "--porcelain"], repoRoot);
    const worktrees: WorktreeInfo[] = [];
    let currentPath = "";
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        currentPath = line.slice("worktree ".length).trim();
      } else if (line.startsWith("HEAD ")) {
        const sha = line.slice("HEAD ".length).trim();
        worktrees.push({ path: currentPath, sha });
      }
    }
    return worktrees;
  }

  async worktreeDiff(repoRoot: string, baseSha: string, worktreePath: string): Promise<string> {
    const { stdout } = await git(
      ["diff", "--name-only", baseSha, "HEAD"],
      worktreePath,
    );
    return stdout;
  }

  async commitAll(worktreePath: string, message: string): Promise<string> {
    await git(["add", "-A"], worktreePath);
    await git(["commit", "-m", message], worktreePath);
    const { stdout } = await git(["rev-parse", "HEAD"], worktreePath);
    return stdout.trim();
  }

  async fileExistsAtRef(
    repoRoot: string,
    sha: string,
    filePath: string,
  ): Promise<boolean> {
    try {
      await git(["cat-file", "-e", `${sha}:${filePath}`], repoRoot);
      return true;
    } catch {
      return false;
    }
  }
}
