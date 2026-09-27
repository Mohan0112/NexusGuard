// packages/dashboard/src/hooks/useRunStream.ts
"use client";

import { useEffect, useRef } from "react";

interface Options {
  onNodeStatus: (id: string, status: string) => void;
  onRunCompleted: (runId: string) => void;
}

export function useRunStream(runId: string | null, opts: Options) {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (!runId) return;
    let es: EventSource | null = null;

    const connect = () => {
      es = new EventSource(`/api/runs/${runId}/events`);
      es.onmessage = (e) => {
        try {
          const evt = JSON.parse(e.data as string) as { type: string; data: unknown };
          if (evt.type === "node.status") {
            const d = evt.data as { id: string; status: string };
            optsRef.current.onNodeStatus(d.id, d.status);
          } else if (evt.type === "run.completed") {
            optsRef.current.onRunCompleted(runId);
          }
        } catch {
          // ignore
        }
      };
      es.onerror = () => {
        es?.close();
        // Reconnect after a brief delay
        setTimeout(connect, 2000);
      };
    };

    connect();
    return () => es?.close();
  }, [runId]);
}
