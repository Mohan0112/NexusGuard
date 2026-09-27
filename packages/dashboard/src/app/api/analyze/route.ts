// packages/dashboard/src/app/api/analyze/route.ts
import { NextRequest, NextResponse } from "next/server";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
  Pipeline,
  RunStore,
  GitCliAdapter,
  NodeRunnerAdapter,
  BobShellProvider,
  DEFAULT_CONFIG,
  type NexusGuardConfig,
} from "@nexusguard/core";
import { analyzeEnabled, isAllowedRepo, publicError } from "@/lib/guards";

const SHA_RE = /^[0-9a-f]{7,40}$|^[a-zA-Z][a-zA-Z0-9/_.-]{0,100}$/;

// One pipeline at a time: each run spawns git worktrees, tsc, vitest and Bob Shell.
let running = false;

export async function POST(req: NextRequest) {
  if (!analyzeEnabled()) {
    return NextResponse.json({ error: "Live analysis is disabled on this deployment" }, { status: 403 });
  }
  if (running) {
    return NextResponse.json({ error: "An analysis is already running, try again shortly" }, { status: 429 });
  }
  try {
    const body = await req.json() as { repoPath: string; base: string; head: string; mode?: string };
    const { repoPath, base, head } = body;

    if (!repoPath || !base || !head) {
      return NextResponse.json({ error: "repoPath, base, head are required" }, { status: 400 });
    }

    if (!SHA_RE.test(base) || !SHA_RE.test(head)) {
      return NextResponse.json({ error: "Invalid ref format" }, { status: 400 });
    }

    const repoRoot = path.resolve(repoPath);
    if (!isAllowedRepo(repoRoot)) {
      return NextResponse.json({ error: "Repository is not allowed on this deployment" }, { status: 403 });
    }
    const nexusguardDir = path.join(repoRoot, ".nexusguard");
    await fs.mkdir(nexusguardDir, { recursive: true });

    const config = await loadConfig(path.join(repoRoot, "nexusguard.config.json"));
    const git = new GitCliAdapter();
    const runner = new NodeRunnerAdapter();
    const store = new RunStore(nexusguardDir);
    const provider = new BobShellProvider();
    const pipeline = new Pipeline(provider, git, runner, store, config);

    running = true;
    const runId = await pipeline
      .run({ repoRoot, base, head, mode: "live" })
      .then((r) => r.runId)
      .catch((e) => {
        console.error("Pipeline error:", e);
        return null;
      })
      .finally(() => {
        running = false;
      });

    if (!runId) {
      return NextResponse.json({ error: "Pipeline failed" }, { status: 500 });
    }

    return NextResponse.json({ runId }, { status: 202 });
  } catch (e) {
    running = false;
    return NextResponse.json({ error: publicError(e) }, { status: 500 });
  }
}

async function loadConfig(configPath: string): Promise<NexusGuardConfig> {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<NexusGuardConfig>) };
  } catch {
    return DEFAULT_CONFIG;
  }
}
