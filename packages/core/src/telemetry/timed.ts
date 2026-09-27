// packages/core/src/telemetry/timed.ts
// timed() wrapper — emits stage.started / stage.completed events

import type { EventSink } from "../ports/events.js";

export interface TimedResult<T> {
  result: T;
  ms: number;
  status: "ok" | "timeout" | "error" | "skipped";
}

export async function timed<T>(
  stage: string,
  runId: string,
  sink: EventSink,
  fn: () => Promise<T>,
): Promise<TimedResult<T>> {
  await sink.emit(runId, { type: "stage.started", data: { stage } });
  const start = Date.now();
  let status: "ok" | "timeout" | "error" | "skipped" = "ok";
  try {
    const result = await fn();
    const ms = Date.now() - start;
    await sink.emit(runId, {
      type: "stage.completed",
      data: { stage, ms, status: "ok" },
    });
    return { result, ms, status: "ok" };
  } catch (err) {
    const ms = Date.now() - start;
    status = err instanceof TimeoutError ? "timeout" : "error";
    await sink.emit(runId, {
      type: "stage.completed",
      data: { stage, ms, status },
    });
    throw err;
  }
}

export class TimeoutError extends Error {
  constructor(stage: string, ms: number) {
    super(`Stage ${stage} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/** Redact sensitive values (API keys, paths) from strings before they go into events/prompts */
export function redact(text: string): string {
  return text
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[REDACTED]")    // long tokens
    .replace(/BOB_API_KEY=[^\s&]*/g, "BOB_API_KEY=[REDACTED]")
    .replace(/GH_TOKEN=[^\s&]*/g, "GH_TOKEN=[REDACTED]");
}
