// packages/core/src/expand/expander.ts
// S4: CandidateExpander — reverse BFS to find everything affected, with why

import type {
  DependencyGraph,
  ChangeFact,
  Candidate,
  NodeId,
  GraphEdge,
  UseSite,
} from "../types.js";
import type { NexusGuardConfig } from "../types.js";

export interface ExpandResult {
  candidates: Candidate[];
  importOnlyUnaffected: NodeId[];
  limitsHit: string[];
}

export function expandCandidates(
  facts: ChangeFact[],
  graph: DependencyGraph,
  config: NexusGuardConfig,
): ExpandResult {
  const { maxCandidates, maxServiceHops } = config.limits;
  const limitsHit: string[] = [];

  // Seeds = symbols with non-cosmetic facts
  const seeds: NodeId[] = facts
    .filter((f) => f.type !== "COSMETIC_ONLY" && f.type !== "EXPORT_ADDED")
    .map((f) => f.symbolId);

  const seedFactMap = new Map<NodeId, string[]>();
  for (const f of facts) {
    const list = seedFactMap.get(f.symbolId) ?? [];
    list.push(f.factId);
    seedFactMap.set(f.symbolId, list);
  }

  const visited = new Set<NodeId>();
  const candidates: Candidate[] = [];
  const importOnlyUnaffected: NodeId[] = [];
  let candidateCounter = 1;

  // Queue entries: { nodeId, path, serviceHops, seedFactIds }
  const queue: Array<{
    nodeId: NodeId;
    path: NodeId[];
    serviceHops: number;
    seedFactIds: string[];
    seedServiceId: string | null;
  }> = seeds.map((s) => ({
    nodeId: s,
    path: [s],
    serviceHops: 0,
    seedFactIds: seedFactMap.get(s) ?? [],
    seedServiceId: graph.nodes.get(s)?.service ?? null,
  }));

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    const { nodeId, path, serviceHops, seedFactIds, seedServiceId } = item;

    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    // Find all reverse edges (who references this node)
    const reverseEdges = graph.reverseAdj.get(nodeId) ?? [];

    for (const edge of reverseEdges) {
      if (
        edge.type !== "REFERENCES" &&
        edge.type !== "HTTP_CALLS" &&
        edge.type !== "HANDLES"
      ) {
        continue;
      }

      const callerNode = graph.nodes.get(edge.source);
      if (!callerNode) continue;
      if (path.includes(edge.source)) continue; // cycle guard

      const callerService = callerNode.service;
      const seedService = seedServiceId;
      const crossedBoundary =
        callerService !== seedService && callerService !== "<root>";
      const newHops = crossedBoundary ? serviceHops + 1 : serviceHops;

      if (newHops > maxServiceHops) {
        limitsHit.push(`maxServiceHops(${maxServiceHops}) reached at ${edge.source}`);
        continue;
      }

      const newPath = [...path, edge.source];
      const useSite: UseSite = {
        file: edge.file ?? callerNode.id,
        line: edge.line ?? 0,
        col: edge.col ?? 0,
      };

      // Check if this caller is a symbol node (REFERENCES edge) or file (import only)
      if (edge.type === "REFERENCES") {
        if (candidates.length >= maxCandidates) {
          limitsHit.push(
            `maxCandidates(${maxCandidates}) reached; truncating remaining candidates`,
          );
          break;
        }

        // Only symbol-level references make a candidate
        candidates.push({
          candidateId: `C${candidateCounter++}`,
          consumerSymbolId: edge.source,
          service: callerService,
          useSites: [useSite],
          path: newPath,
          serviceHops: newHops,
          seedFactIds,
          evidenceIds: [],   // filled by EvidenceBundler
        });
      } else if (edge.type === "HTTP_CALLS") {
        candidates.push({
          candidateId: `C${candidateCounter++}`,
          consumerSymbolId: edge.source,
          service: callerService,
          useSites: [useSite],
          path: newPath,
          serviceHops: newHops,
          seedFactIds,
          evidenceIds: [],
        });
      }

      // Continue BFS
      if (newHops <= maxServiceHops) {
        queue.push({
          nodeId: edge.source,
          path: newPath,
          serviceHops: newHops,
          seedFactIds,
          seedServiceId: seedService,
        });
      }
    }

    // Check for IMPORTS-only edges (import but no REFERENCES) → import_only_unaffected
    const importEdges = graph.reverseAdj.get(nodeId)?.filter((e) => e.type === "IMPORTS") ?? [];
    for (const edge of importEdges) {
      const refEdges = graph.reverseAdj.get(nodeId)?.filter(
        (e) => e.type === "REFERENCES" && e.source === edge.source,
      );
      if (!refEdges?.length) {
        const caller = graph.nodes.get(edge.source);
        if (caller && !visited.has(edge.source)) {
          importOnlyUnaffected.push(edge.source);
        }
      }
    }
  }

  // Deduplicate importOnlyUnaffected vs actual candidates
  const candidateIds = new Set(candidates.map((c) => c.consumerSymbolId));
  const filteredImportOnly = importOnlyUnaffected.filter(
    (id) => !candidateIds.has(id),
  );

  return { candidates, importOnlyUnaffected: [...new Set(filteredImportOnly)], limitsHit };
}
