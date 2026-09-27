// packages/core/src/diff/ingestor.ts
// S1: DiffIngestor — turn base..head into precise ChangedRegion[]

import type { GitPort } from "../ports/git.js";
import type { ChangedRegion } from "../types.js";
import * as path from "node:path";
import * as fs from "node:fs/promises";

export interface IngestResult {
  regions: ChangedRegion[];
  basePath: string;
  headPath: string;
  changedLineCount: number;
}

/**
 * Parse a unified diff into ChangedRegion[].
 * Each @@ hunk header contributes one region per side.
 */
export function parseDiff(diffText: string): ChangedRegion[] {
  const regions: ChangedRegion[] = [];
  let currentFile = "";

  for (const line of diffText.split("\n")) {
    // File header: +++ b/services/billing-service/src/invoice.ts
    const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line);
    if (fileMatch) {
      currentFile = fileMatch[1] ?? "";
      continue;
    }

    // Hunk header: @@ -a,b +c,d @@
    const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunkMatch || !currentFile) continue;

    const baseLine = parseInt(hunkMatch[1] ?? "1", 10);
    const baseLen = parseInt(hunkMatch[2] ?? "1", 10);
    const headLine = parseInt(hunkMatch[3] ?? "1", 10);
    const headLen = parseInt(hunkMatch[4] ?? "1", 10);

    const ext = path.extname(currentFile).toLowerCase();
    if (ext !== ".ts" && ext !== ".tsx") continue;

    if (headLen > 0) {
      regions.push({
        file: currentFile,
        side: "head",
        startLine: headLine,
        endLine: headLine + headLen - 1,
        kind: baseLen === 0 ? "add" : "mod",
      });
    }
    if (baseLen > 0) {
      regions.push({
        file: currentFile,
        side: "base",
        startLine: baseLine,
        endLine: baseLine + baseLen - 1,
        kind: headLen === 0 ? "del" : "mod",
      });
    }
  }

  return regions;
}

export class DiffIngestor {
  constructor(
    private readonly git: GitPort,
    private readonly repoRoot: string,
    private readonly nexusguardDir: string,
  ) {}

  async ingest(
    runId: string,
    base: string,
    head: string,
    maxDiffLines: number,
  ): Promise<IngestResult> {
    // Validate refs
    const baseSha = await this.git.validateRef(this.repoRoot, base);
    const headSha = await this.git.validateRef(this.repoRoot, head);

    // Get diff text
    const diffText = await this.git.diff(this.repoRoot, baseSha, headSha);

    // Count changed lines
    const changedLineCount = diffText
      .split("\n")
      .filter((l) => l.startsWith("+") || l.startsWith("-"))
      .filter((l) => !l.startsWith("+++") && !l.startsWith("---"))
      .length;

    // Parse regions
    const regions = parseDiff(diffText);

    // Create worktrees
    const wtBase = path.join(this.nexusguardDir, "wt", `${runId}-base`);
    const wtHead = path.join(this.nexusguardDir, "wt", `${runId}-head`);

    await fs.mkdir(path.join(this.nexusguardDir, "wt"), { recursive: true });

    await this.git.addWorktree(this.repoRoot, wtBase, baseSha);
    await this.git.addWorktree(this.repoRoot, wtHead, headSha);

    if (changedLineCount > maxDiffLines) {
      return { regions, basePath: wtBase, headPath: wtHead, changedLineCount };
    }

    return { regions, basePath: wtBase, headPath: wtHead, changedLineCount };
  }
}
