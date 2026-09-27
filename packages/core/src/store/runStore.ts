// packages/core/src/store/runStore.ts
// Run store — filesystem-based, under .nexusguard/runs/<runId>/

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BlastRadiusReport, NexusEventRecord } from "../types.js";
import type { EventSink, EventSink as IEventSink } from "../ports/events.js";
import type { NexusEvent } from "../types.js";

export class RunStore implements IEventSink {
  private seqCounters = new Map<string, number>();

  constructor(private readonly nexusguardDir: string) {}

  runDir(runId: string): string {
    return path.join(this.nexusguardDir, "runs", runId);
  }

  async initRun(runId: string, input: unknown): Promise<void> {
    const dir = this.runDir(runId);
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(path.join(dir, "llm"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "input.json"),
      JSON.stringify(input, null, 2),
      "utf8",
    );
    this.seqCounters.set(runId, 0);
  }

  async emit(runId: string, event: NexusEvent): Promise<void> {
    const seq = (this.seqCounters.get(runId) ?? 0) + 1;
    this.seqCounters.set(runId, seq);

    const record: NexusEventRecord = {
      ts: new Date().toISOString(),
      runId,
      seq,
      type: event.type,
      data: event.data,
    };

    const eventsFile = path.join(this.runDir(runId), "events.jsonl");
    await fs.appendFile(eventsFile, JSON.stringify(record) + "\n", "utf8");
  }

  async close(): Promise<void> {}

  async saveReport(runId: string, report: BlastRadiusReport): Promise<void> {
    const file = path.join(this.runDir(runId), "report.json");
    await fs.writeFile(file, JSON.stringify(report, null, 2), "utf8");
  }

  async saveLlmPrompt(runId: string, kind: string, n: number, text: string): Promise<void> {
    const file = path.join(this.runDir(runId), "llm", `${kind}-${n}.prompt.txt`);
    await fs.writeFile(file, text, "utf8");
  }

  async saveLlmRaw(runId: string, kind: string, n: number, text: string): Promise<void> {
    const file = path.join(this.runDir(runId), "llm", `${kind}-${n}.raw.txt`);
    await fs.writeFile(file, text, "utf8");
  }

  async saveLlmValidation(runId: string, kind: string, n: number, data: unknown): Promise<void> {
    const file = path.join(this.runDir(runId), "llm", `${kind}-${n}.validation.json`);
    await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
  }

  async getReport(runId: string): Promise<BlastRadiusReport | null> {
    try {
      const raw = await fs.readFile(path.join(this.runDir(runId), "report.json"), "utf8");
      return JSON.parse(raw) as BlastRadiusReport;
    } catch {
      return null;
    }
  }

  async listRuns(): Promise<string[]> {
    try {
      const entries = await fs.readdir(path.join(this.nexusguardDir, "runs"));
      return entries.sort().reverse().slice(0, 50);
    } catch {
      return [];
    }
  }

  /** Read events from a run starting at a given seq number (for SSE). */
  async readEvents(runId: string, afterSeq = 0): Promise<NexusEventRecord[]> {
    const file = path.join(this.runDir(runId), "events.jsonl");
    try {
      const raw = await fs.readFile(file, "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as NexusEventRecord)
        .filter((e) => e.seq > afterSeq);
    } catch {
      return [];
    }
  }
}
