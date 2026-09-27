// packages/dashboard/src/app/api/runs/[runId]/report/route.ts
import { NextRequest, NextResponse } from "next/server";
import * as path from "node:path";
import { RunStore } from "@nexusguard/core";
import { isValidRunId } from "@/lib/guards";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  if (!isValidRunId(runId)) {
    return new Response(JSON.stringify({ error: "Invalid run id" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const repoRoot = process.env["NEXUSGUARD_REPO_ROOT"] ?? process.cwd();
  const nexusguardDir = path.join(repoRoot, ".nexusguard");
  const store = new RunStore(nexusguardDir);
  const report = await store.getReport(runId);
  if (!report) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(report);
}
