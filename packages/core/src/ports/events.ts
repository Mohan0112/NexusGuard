// packages/core/src/ports/events.ts
// EventSink port — adapters write to file; dashboard reads via SSE

import type { NexusEvent } from "../types.js";

export interface EventSink {
  emit(runId: string, event: NexusEvent): Promise<void>;
  close(): Promise<void>;
}

/** No-op sink for testing */
export class NullEventSink implements EventSink {
  readonly events: Array<{ runId: string; event: NexusEvent }> = [];
  async emit(runId: string, event: NexusEvent): Promise<void> {
    this.events.push({ runId, event });
  }
  async close(): Promise<void> {}
}
