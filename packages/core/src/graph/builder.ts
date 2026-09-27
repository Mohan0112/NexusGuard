// packages/core/src/graph/builder.ts
// S2: WorkspaceGraphBuilder — deterministic dependency graph using ts-morph

import { Project, SyntaxKind, Node, SourceFile } from "ts-morph";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { DependencyGraph, GraphNode, GraphEdge, NodeId } from "../types.js";

export interface WorkspaceInfo {
  name: string;
  root: string;
  tier: number;
}

export interface BuildGraphOptions {
  headWorktreePath: string;
  tsconfigPath: string;        // path to root tsconfig.json in the worktree
  services: Record<string, { tier: number }>;
  /** Changed symbols — lazy ref analysis is only run for these */
  changedSymbolIds?: Set<NodeId>;
}

/** Normalize a file path to POSIX style relative to a root */
export function normalizePath(filePath: string, root: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

export class WorkspaceGraphBuilder {
  async build(opts: BuildGraphOptions): Promise<DependencyGraph> {
    const { headWorktreePath, tsconfigPath, services, changedSymbolIds } = opts;

    const nodes = new Map<NodeId, GraphNode>();
    const edges: GraphEdge[] = [];
    const reverseAdj = new Map<NodeId, GraphEdge[]>();
    const forwardAdj = new Map<NodeId, GraphEdge[]>();

    // Map from service name to root path (for resolving which service a file belongs to)
    const serviceRoots = this.buildServiceRoots(headWorktreePath, services);

    // Step 1: Load project
    const project = new Project({
      tsConfigFilePath: tsconfigPath,
      skipAddingFilesFromTsConfig: false,
    });

    const sourceFiles = project.getSourceFiles().filter(
      (sf) => !sf.getFilePath().includes("node_modules"),
    );

    // Step 2: Create service nodes and file nodes; collect IMPORTS edges
    for (const sf of sourceFiles) {
      const filePath = sf.getFilePath();
      const relPath = normalizePath(filePath, headWorktreePath);
      const service = this.fileToService(relPath, serviceRoots);
      const fileId = `file:${relPath}`;

      // Ensure service node
      if (service && !nodes.has(`service:${service}`)) {
        nodes.set(`service:${service}`, {
          id: `service:${service}`,
          label: service,
          kind: "service",
          service,
          status: "clean",
        });
      }

      // File node
      nodes.set(fileId, {
        id: fileId,
        label: relPath,
        kind: "file",
        service: service ?? "<root>",
        status: "clean",
      });

      // CONTAINS edge: service → file
      if (service) {
        const svcId = `service:${service}`;
        addEdge(edges, forwardAdj, reverseAdj, {
          source: svcId,
          target: fileId,
          type: "CONTAINS",
        });
      }

      // IMPORTS edges (file → file)
      for (const importDecl of sf.getImportDeclarations()) {
        const resolvedSf = importDecl.getModuleSpecifierSourceFile();
        if (!resolvedSf) continue;
        const importedPath = resolvedSf.getFilePath();
        if (importedPath.includes("node_modules")) continue;
        const importedRelPath = normalizePath(importedPath, headWorktreePath);
        addEdge(edges, forwardAdj, reverseAdj, {
          source: fileId,
          target: `file:${importedRelPath}`,
          type: "IMPORTS",
        });
      }

      // Export symbol nodes (CONTAINS: file → symbol)
      for (const [name, exportedDeclarations] of sf.getExportedDeclarations()) {
        const symbolId = `symbol:${relPath}#${name}`;
        const decl = exportedDeclarations[0];
        if (!decl) continue;
        nodes.set(symbolId, {
          id: symbolId,
          label: name,
          kind: "symbol",
          service: service ?? "<root>",
          status: "clean",
        });
        addEdge(edges, forwardAdj, reverseAdj, {
          source: fileId,
          target: symbolId,
          type: "CONTAINS",
        });
      }
    }

    // Step 3: HTTP route extraction
    for (const sf of sourceFiles) {
      const filePath = sf.getFilePath();
      const relPath = normalizePath(filePath, headWorktreePath);
      const service = this.fileToService(relPath, serviceRoots) ?? "<root>";
      this.extractRoutes(sf, relPath, service, nodes, edges, forwardAdj, reverseAdj, headWorktreePath);
    }

    // Step 4: Lazy reference analysis for changed symbols
    if (changedSymbolIds && changedSymbolIds.size > 0) {
      for (const sf of sourceFiles) {
        const relPath = normalizePath(sf.getFilePath(), headWorktreePath);
        for (const [name, decls] of sf.getExportedDeclarations()) {
          const symbolId = `symbol:${relPath}#${name}`;
          if (!changedSymbolIds.has(symbolId)) continue;
          const decl = decls[0];
          if (!decl) continue;
          // Find references across the project
          // Use the Language Service to find all references
          try {
            // ts-morph: getLanguageService().findReferences() returns ReferencedSymbol[]
            const lang = project.getLanguageService();
            const referencedSymbols = lang.findReferences(decl as import("ts-morph").Node);
            const refs = referencedSymbols.flatMap((rs) =>
              rs.getReferences().map((ref) => ref.getNode()),
            );
            for (const ref of refs) {
              const refSf = ref.getSourceFile();
              const refPath = normalizePath(refSf.getFilePath(), headWorktreePath);
              if (refPath === relPath) continue; // skip self
              if (refPath.includes("node_modules")) continue;
              const refService = this.fileToService(refPath, serviceRoots) ?? "<root>";
              // Find enclosing exported symbol at the use site
              const enclosingSymbol = this.findEnclosingExportedSymbol(ref);
              const refSymbolId = enclosingSymbol
                ? `symbol:${refPath}#${enclosingSymbol}`
                : `file:${refPath}`;
              const pos = ref.getStartLineNumber();
              addEdge(edges, forwardAdj, reverseAdj, {
                source: refSymbolId,
                target: symbolId,
                type: "REFERENCES",
                file: refPath,
                line: pos,
                col: ref.getStartLinePos(),
              });
              // Ensure the ref symbol/file node exists
              if (!nodes.has(refSymbolId) && enclosingSymbol) {
                nodes.set(refSymbolId, {
                  id: refSymbolId,
                  label: enclosingSymbol,
                  kind: "symbol",
                  service: refService,
                  status: "clean",
                });
              }
            }
          } catch {
            // ts-morph can throw on type errors; best-effort
          }
        }
      }
    }

    return { nodes, edges, reverseAdj, forwardAdj };
  }

  private buildServiceRoots(
    repoRoot: string,
    services: Record<string, { tier: number }>,
  ): Array<{ name: string; prefix: string; tier: number }> {
    return Object.entries(services).map(([name, cfg]) => ({
      name,
      // Convert package name to relative path prefix (heuristic)
      prefix: name.replace(/^@[^/]+\//, "").replace(/-/g, "-"),
      tier: cfg.tier,
    }));
  }

  private fileToService(
    relPath: string,
    serviceRoots: Array<{ name: string; prefix: string; tier: number }>,
  ): string | null {
    for (const svc of serviceRoots) {
      // Match by directory prefix heuristic
      if (
        relPath.includes(`/${svc.prefix}/`) ||
        relPath.startsWith(`${svc.prefix}/`) ||
        relPath.includes(`/packages/${svc.prefix}/`) ||
        relPath.includes(`/services/${svc.prefix}/`)
      ) {
        return svc.name;
      }
    }
    return null;
  }

  private extractRoutes(
    sf: SourceFile,
    relPath: string,
    service: string,
    nodes: Map<NodeId, GraphNode>,
    edges: GraphEdge[],
    forwardAdj: Map<NodeId, GraphEdge[]>,
    reverseAdj: Map<NodeId, GraphEdge[]>,
    repoRoot: string,
  ): void {
    sf.forEachDescendant((node) => {
      if (node.getKind() !== SyntaxKind.CallExpression) return;
      // Server-side: (app|router).(get|post|put|patch|delete)(path, handler)
      const callExpr = node.asKind(SyntaxKind.CallExpression);
      if (!callExpr) return;
      const expr = callExpr.getExpression();
      const exprText = expr.getText();
      const routeMatch =
        /\b(app|router)\.(get|post|put|patch|delete)\s*$/.test(exprText);
      if (routeMatch) {
        const args = callExpr.getArguments();
        const routeArg = args[0];
        if (routeArg && Node.isStringLiteral(routeArg)) {
          const routePath = routeArg.getLiteralValue();
          const method = /\.(get|post|put|patch|delete)\s*$/.exec(exprText)?.[1]?.toUpperCase() ?? "GET";
          const routeId = `route:${service}:${method} ${routePath}`;
          nodes.set(routeId, {
            id: routeId,
            label: `${method} ${routePath}`,
            kind: "route",
            service,
            status: "clean",
          });
          // HANDLES: route → handler symbol (heuristic: enclosing function)
          const handler = args[1];
          if (handler) {
            const handlerSymbol = `symbol:${relPath}#${routePath.replace(/\//g, "_")}`;
            addEdge(edges, forwardAdj, reverseAdj, {
              source: routeId,
              target: handlerSymbol,
              type: "HANDLES",
              file: relPath,
            });
          }
        }
      }

      // Client-side: fetch(<url>)
      if (exprText === "fetch" || exprText.endsWith(".fetch")) {
        const urlArg = callExpr.getArguments()[0];
        if (urlArg) {
          const urlExpr = urlArg.getText();
          const normalized = normalizeUrlPattern(urlExpr);
          if (normalized) {
            const routeId = `route:${service}:GET ${normalized}`;
            addEdge(edges, forwardAdj, reverseAdj, {
              source: `file:${relPath}`,
              target: routeId,
              type: "HTTP_CALLS",
              file: relPath,
              line: callExpr.getStartLineNumber(),
            });
          }
        }
      }
    });
  }

  private findEnclosingExportedSymbol(node: Node): string | null {
    let current: Node | undefined = node.getParent();
    while (current) {
      if (
        Node.isFunctionDeclaration(current) ||
        Node.isVariableStatement(current) ||
        Node.isClassDeclaration(current)
      ) {
        const exported = current
          .getModifiers?.()
          ?.some((m) => m.getKind() === SyntaxKind.ExportKeyword);
        if (exported) {
          if (Node.isFunctionDeclaration(current)) {
            return current.getName() ?? null;
          }
          if (Node.isVariableStatement(current)) {
            const decls = current.getDeclarationList().getDeclarations();
            return decls[0]?.getName() ?? null;
          }
          if (Node.isClassDeclaration(current)) {
            return current.getName() ?? null;
          }
        }
      }
      current = current.getParent();
    }
    return null;
  }
}

function addEdge(
  edges: GraphEdge[],
  forwardAdj: Map<NodeId, GraphEdge[]>,
  reverseAdj: Map<NodeId, GraphEdge[]>,
  edge: GraphEdge,
): void {
  // Deduplicate
  const key = `${edge.source}→${edge.target}→${edge.type}`;
  if (edges.some((e) => `${e.source}→${e.target}→${e.type}` === key)) return;
  edges.push(edge);
  getOrSet(forwardAdj, edge.source, []).push(edge);
  getOrSet(reverseAdj, edge.target, []).push(edge);
}

function getOrSet<K, V>(map: Map<K, V>, key: K, defaultVal: V): V {
  if (!map.has(key)) map.set(key, defaultVal);
  return map.get(key)!;
}

function normalizeUrlPattern(urlExpr: string): string | null {
  // Strip template literal backticks and ${...} → :param
  const stripped = urlExpr
    .replace(/^[`'"]+|[`'"]+$/g, "")
    .replace(/\$\{[^}]+\}/g, ":param");
  // Remove base URL if it looks like a ${VAR}/path
  const match = /\/([a-zA-Z].*$)/.exec(stripped);
  return match ? `/${match[1]}` : null;
}
