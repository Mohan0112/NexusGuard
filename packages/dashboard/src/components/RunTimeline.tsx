// packages/dashboard/src/components/RunTimeline.tsx
"use client";

import { useEffect, useState } from "react";
import type { NexusEventRecord } from "@nexusguard/core";

interface Props {
  runId: string | null;
}

export function RunTimeline({ runId }: Props) {
  const [events, setEvents] = useState<NexusEventRecord[]>([]);

  useEffect(() => {
    if (!runId) return;
    const es = new EventSource(`/api/runs/${runId}/events`);
    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data as string) as NexusEventRecord;
        setEvents((prev) => [...prev, evt]);
      } catch {
        // ignore
      }
    };
    return () => es.close();
  }, [runId]);

  if (!runId) {
    return (
      <div className="p-4 text-gray-400 text-sm">
        No run started yet
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto p-4">
      <h2 className="font-semibold text-gray-900 mb-3">Run Timeline</h2>
      {events.length === 0 && (
        <p className="text-gray-400 text-sm">Waiting for events…</p>
      )}
      <div className="space-y-1">
        {events.map((evt) => (
          <div key={evt.seq} className="text-xs flex gap-2">
            <span className="text-gray-400 font-mono w-6 text-right shrink-0">{evt.seq}</span>
            <span
              className={`font-medium ${
                evt.type === "run.completed"
                  ? "text-green-700"
                  : evt.type === "run.degraded"
                    ? "text-yellow-700"
                    : evt.type === "finding.rejected"
                      ? "text-red-600"
                      : "text-gray-700"
              }`}
            >
              {evt.type}
            </span>
            <span className="text-gray-500 truncate">
              {JSON.stringify(evt.data).slice(0, 60)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
