// packages/core/src/ports/git.ts
// Git port — thin abstraction over git CLI operations

export interface WorktreeInfo {
  path: string;
  sha: string;
}

export interface GitPort {
  /** Validate that a ref/sha exists. Throws if not. */
  validateRef(repoRoot: string, ref: string): Promise<string>; // returns full sha

  /** Run `git diff --unified=0` and return raw patch text. */
  diff(repoRoot: string, base: string, head: string): Promise<string>;

  /** Show a file at a specific sha. */
  showFile(repoRoot: string, sha: string, filePath: string): Promise<string>;

  /** Create a worktree. Returns the path. */
  addWorktree(
    repoRoot: string,
    worktreePath: string,
    sha: string,
    branch?: string,
  ): Promise<WorktreeInfo>;

  /** Remove a worktree. */
  removeWorktree(repoRoot: string, worktreePath: string): Promise<void>;

  /** List all worktrees. */
  listWorktrees(repoRoot: string): Promise<WorktreeInfo[]>;

  /** Get the diff of a worktree against its base sha. */
  worktreeDiff(repoRoot: string, baseSha: string, worktreePath: string): Promise<string>;

  /** Create a commit in a worktree and return the new sha. */
  commitAll(worktreePath: string, message: string): Promise<string>;

  /** Run `git show` to check if a file exists at a ref. */
  fileExistsAtRef(repoRoot: string, sha: string, filePath: string): Promise<boolean>;
}
