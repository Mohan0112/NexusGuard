// packages/dashboard/src/components/BlastRadiusGraph.tsx
"use client";

import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  Position,
} from "reactflow";
import "reactflow/dist/style.css";
import type { GraphNode, GraphEdge } from "@nexusguard/core";

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  liveStatuses: Record<string, string>;
  onNodeClick: (nodeId: string) => void;
}

const STATUS_COLORS: Record<string, string> = {
  clean: "#e5e7eb",
  modified: "#fb923c",         // orange
  broken: "#ef4444",           // red
  at_risk: "#f59e0b",          // amber
  uncertain: "#a855f7",        // purple
  healed: "#22c55e",           // green
  import_only_unaffected: "#d1fae5",
};

const STATUS_TEXT: Record<string, string> = {
  clean: "#57606a",
  modified: "#fff",
  broken: "#fff",
  at_risk: "#fff",
  uncertain: "#fff",
  healed: "#fff",
  import_only_unaffected: "#166534",
};

export function BlastRadiusGraph({ nodes, edges, liveStatuses, onNodeClick }: Props) {
  // Layout nodes using a simple column layout (dagre would be ideal, but this works for MVP)
  const rfNodes: Node[] = nodes.map((n, i) => {
    const status = liveStatuses[n.id] ?? n.status;
    const bg = STATUS_COLORS[status] ?? "#e5e7eb";
    const color = STATUS_TEXT[status] ?? "#1f2328";

    // Group by kind for simple layout
    const kindCol: Record<string, number> = { service: 0, route: 1, file: 2, symbol: 3 };
    const col = kindCol[n.kind] ?? 2;
    const row = i;

    return {
      id: n.id,
      data: {
        label: (
          <div style={{ fontSize: 11, lineHeight: 1.4, maxWidth: 160, overflow: "hidden" }}>
            <div style={{ fontWeight: 600, fontSize: 10, opacity: 0.7, textTransform: "uppercase" }}>
              {n.kind}
            </div>
            <div title={n.label} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {n.label}
            </div>
            {status !== "clean" && (
              <div style={{ fontSize: 9, marginTop: 2 }}>
                {status.replace(/_/g, " ").toUpperCase()}
              </div>
            )}
          </div>
        ),
      },
      position: { x: col * 240, y: row * 80 },
      style: {
        background: bg,
        color,
        border: `2px solid ${bg === "#e5e7eb" ? "#d1d5db" : bg}`,
        borderRadius: 8,
        padding: "8px 12px",
        minWidth: 160,
        cursor: "pointer",
        transition: "all 0.3s ease",
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    };
  });

  const rfEdges: Edge[] = edges.map((e, i) => ({
    id: `e-${i}`,
    source: e.source,
    target: e.target,
    label: e.type,
    style: { stroke: e.type === "HTTP_CALLS" ? "#3b82f6" : "#d1d5db" },
    labelStyle: { fontSize: 9, fill: "#57606a" },
    animated: e.type === "HTTP_CALLS",
    type: "smoothstep",
  }));

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        fitView
        onNodeClick={(_: React.MouseEvent, node: Node) => onNodeClick(node.id)}
        nodesDraggable={true}
        nodesConnectable={false}
        elementsSelectable={true}
      >
        <Background />
        <Controls />
        <MiniMap
          nodeColor={(n: Node) => {
            const status = (liveStatuses[n.id] ?? n.style?.background ?? "#e5e7eb") as string;
            return STATUS_COLORS[status] ?? "#e5e7eb";
          }}
        />
      </ReactFlow>

      {/* Legend */}
      <div
        style={{
          position: "absolute",
          bottom: 16,
          left: 16,
          background: "rgba(255,255,255,0.95)",
          border: "1px solid #e5e7eb",
          borderRadius: 8,
          padding: "8px 12px",
          fontSize: 11,
          zIndex: 10,
        }}
      >
        {Object.entries(STATUS_COLORS)
          .filter(([k]) => k !== "clean" && k !== "import_only_unaffected")
          .map(([status, color]) => (
            <div key={status} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
              <div
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 3,
                  background: color,
                  border: "1px solid rgba(0,0,0,0.1)",
                }}
              />
              <span style={{ color: "#57606a" }}>{status.replace(/_/g, " ")}</span>
            </div>
          ))}
      </div>
    </div>
  );
}
