// packages/dashboard/src/app/api/runs/[runId]/events/route.ts
// SSE endpoint — tails events.jsonl and streams to client
import { NextRequest } from "next/server";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { RunStore } from "@nexusguard/core";
import { isValidRunId } from "@/lib/guards";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  if (!isValidRunId(runId)) {
    return new Response(JSON.stringify({ error: "Invalid run id" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const repoRoot = process.env["NEXUSGUARD_REPO_ROOT"] ?? process.cwd();
  const nexusguardDir = path.join(repoRoot, ".nexusguard");
  const store = new RunStore(nexusguardDir);

  const lastEventId = parseInt(req.headers.get("Last-Event-ID") ?? "0", 10);

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      let seq = lastEventId;

      const poll = async () => {
        if (closed) return;
        try {
          const events = await store.readEvents(runId, seq);
          for (const evt of events) {
            seq = evt.seq;
            const data = `id: ${evt.seq}\ndata: ${JSON.stringify(evt)}\n\n`;
            controller.enqueue(encoder.encode(data));
          }
          // Check if run is completed
          const lastEvt = events[events.length - 1];
          if (lastEvt?.type === "run.completed") {
            controller.close();
            return;
          }
        } catch {
          // file may not exist yet
        }
        setTimeout(poll, 500);
      };

      await poll();
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
