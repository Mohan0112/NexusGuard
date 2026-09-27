// packages/core/src/classify/classifier.ts
// S3: ChangeClassifier — produce trusted ChangeFact[] from changed regions

import { Project, SyntaxKind, Node as MorphNode } from "ts-morph";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { ChangedRegion, ChangeFact, ChangeFactType, EvidenceItem } from "../types.js";
import type { GitPort } from "../ports/git.js";

export interface ClassifyResult {
  facts: ChangeFact[];
  evidence: EvidenceItem[];   // E1/E2 pairs for each changed symbol
}

export class ChangeClassifier {
  constructor(private readonly git: GitPort, private readonly repoRoot: string) {}

  async classify(
    regions: ChangedRegion[],
    baseSha: string,
    baseWorktreePath: string,
    headWorktreePath: string,
  ): Promise<ClassifyResult> {
    const facts: ChangeFact[] = [];
    const evidence: EvidenceItem[] = [];

    // Group head regions by file
    const headRegionsByFile = new Map<string, ChangedRegion[]>();
    for (const r of regions) {
      if (r.side !== "head") continue;
      const list = headRegionsByFile.get(r.file) ?? [];
      list.push(r);
      headRegionsByFile.set(r.file, list);
    }

    let factCounter = 1;
    let evidenceCounter = 1;

    for (const [file, _regions] of headRegionsByFile) {
      const ext = path.extname(file).toLowerCase();
      if (ext !== ".ts" && ext !== ".tsx") continue;

      const headFilePath = path.join(headWorktreePath, file);
      const baseFilePath = path.join(baseWorktreePath, file);

      let headContent: string;
      let baseContent: string | null;

      try {
        headContent = await readFileOrEmpty(headFilePath);
      } catch {
        continue;
      }

      try {
        baseContent = await readFileOrEmpty(baseFilePath);
      } catch {
        baseContent = null; // new file
      }

      if (!baseContent && !headContent) continue;

      // Create in-memory ts-morph projects for this file
      const headProject = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true } });
      const headSf = headProject.createSourceFile(file, headContent);

      let baseSf = null;
      if (baseContent) {
        const baseProject = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true } });
        baseSf = baseProject.createSourceFile(file, baseContent);
      }

      // Get all top-level exported declarations from head
      const headExports = new Map(headSf.getExportedDeclarations());
      const baseExports = baseSf
        ? new Map(baseSf.getExportedDeclarations())
        : new Map();

      // Detect removed exports
      for (const [name] of baseExports) {
        if (!headExports.has(name)) {
          const factId = `F${factCounter++}`;
          const beforeEvidenceId = `E${evidenceCounter++}`;
          const afterEvidenceId = `E${evidenceCounter++}`;
          const baseSnippet = getExportSnippet(baseSf!, name, baseContent!);
          facts.push({
            factId,
            symbolId: `symbol:${file}#${name}`,
            type: "EXPORT_REMOVED",
            beforeSignature: baseSnippet.signature,
            beforeEvidenceId,
            afterEvidenceId,
            beforeSnippet: baseSnippet.text,
          });
          evidence.push(makeEvidenceItem(beforeEvidenceId, "producer_before", file, baseSnippet));
          evidence.push(makeEvidenceItem(afterEvidenceId, "producer_after", file, { text: "(removed)", signature: "", startLine: 1, endLine: 1 }));
        }
      }

      // Detect added and changed exports
      for (const [name, headDecls] of headExports) {
        const headDecl = headDecls[0];
        if (!headDecl) continue;

        const factId = `F${factCounter++}`;
        const beforeEvidenceId = `E${evidenceCounter++}`;
        const afterEvidenceId = `E${evidenceCounter++}`;

        const headSnippet = getExportSnippet(headSf, name, headContent);

        if (!baseExports.has(name)) {
          // New export
          facts.push({
            factId,
            symbolId: `symbol:${file}#${name}`,
            type: "EXPORT_ADDED",
            afterSignature: headSnippet.signature,
            beforeEvidenceId,
            afterEvidenceId,
          });
          evidence.push(makeEvidenceItem(beforeEvidenceId, "producer_before", file, { text: "(new)", signature: "", startLine: 1, endLine: 1 }));
          evidence.push(makeEvidenceItem(afterEvidenceId, "producer_after", file, headSnippet));
          continue;
        }

        const baseDecls = baseExports.get(name);
        const baseDecl = baseDecls?.[0];
        if (!baseDecl || !baseSf || !baseContent) continue;

        const baseSnippet = getExportSnippet(baseSf, name, baseContent);

        // Stripped AST comparison (cosmetic)
        const headNorm = normalizeAst(headDecl);
        const baseNorm = normalizeAst(baseDecl);
        if (headNorm === baseNorm) {
          facts.push({
            factId,
            symbolId: `symbol:${file}#${name}`,
            type: "COSMETIC_ONLY",
            beforeEvidenceId,
            afterEvidenceId,
          });
          evidence.push(makeEvidenceItem(beforeEvidenceId, "producer_before", file, baseSnippet));
          evidence.push(makeEvidenceItem(afterEvidenceId, "producer_after", file, headSnippet));
          continue;
        }

        // Signature comparison
        const headSig = headSnippet.signature;
        const baseSig = baseSnippet.signature;

        let factType: ChangeFactType;

        if (headSig !== baseSig) {
          // Check if it's a type shape change vs signature change
          if (isTypeDeclaration(headDecl)) {
            factType = "TYPE_SHAPE_CHANGED";
          } else {
            factType = "SIGNATURE_CHANGED";
          }
        } else if (isLiteralValueChange(headDecl, baseDecl)) {
          factType = "LITERAL_VALUE_CHANGED";
        } else {
          factType = "BODY_CHANGED_SAME_SIGNATURE";
        }

        facts.push({
          factId,
          symbolId: `symbol:${file}#${name}`,
          type: factType,
          beforeSignature: baseSig,
          afterSignature: headSig,
          beforeEvidenceId,
          afterEvidenceId,
          beforeSnippet: baseSnippet.text,
          afterSnippet: headSnippet.text,
        });
        evidence.push(makeEvidenceItem(beforeEvidenceId, "producer_before", file, baseSnippet));
        evidence.push(makeEvidenceItem(afterEvidenceId, "producer_after", file, headSnippet));
      }
    }

    return { facts, evidence };
  }
}

interface Snippet {
  text: string;
  signature: string;
  startLine: number;
  endLine: number;
}

function getExportSnippet(sf: ReturnType<Project["createSourceFile"]>, name: string, fullContent: string): Snippet {
  const decls = sf.getExportedDeclarations().get(name);
  const decl = decls?.[0];
  if (!decl) return { text: "", signature: "", startLine: 1, endLine: 1 };

  const start = decl.getStartLineNumber();
  const end = decl.getEndLineNumber();
  const lines = fullContent.split("\n");
  const snippetLines = lines
    .slice(start - 1, end)
    .map((l, i) => `${start + i}| ${l}`);

  let signature = "";
  if (MorphNode.isFunctionDeclaration(decl)) {
    signature = decl.getSignature().getDeclaration().getText().split("{")[0]?.trim() ?? "";
  } else if (MorphNode.isVariableDeclaration(decl)) {
    const typeNode = decl.getTypeNode();
    signature = typeNode
      ? `${decl.getName()}: ${typeNode.getText()}`
      : `${decl.getName()} = ${decl.getInitializer()?.getText().slice(0, 60) ?? "?"}`;
  } else {
    signature = decl.getText().split("\n")[0]?.trim() ?? "";
  }

  return { text: snippetLines.join("\n"), signature, startLine: start, endLine: end };
}

function makeEvidenceItem(
  evidenceId: string,
  role: "producer_before" | "producer_after",
  file: string,
  snippet: Snippet,
): EvidenceItem {
  return {
    evidenceId,
    role,
    file,
    startLine: snippet.startLine,
    endLine: snippet.endLine,
    content: snippet.text,
    contentHash: sha256(snippet.text),
  };
}

function normalizeAst(decl: MorphNode): string {
  return decl.getText().replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim();
}

function isTypeDeclaration(decl: MorphNode): boolean {
  return (
    MorphNode.isInterfaceDeclaration(decl) ||
    MorphNode.isTypeAliasDeclaration(decl) ||
    MorphNode.isEnumDeclaration(decl)
  );
}

function isLiteralValueChange(head: MorphNode, base: MorphNode): boolean {
  if (MorphNode.isVariableDeclaration(head) && MorphNode.isVariableDeclaration(base)) {
    const headInit = head.getInitializer();
    const baseInit = base.getInitializer();
    if (headInit && baseInit) {
      return (
        (MorphNode.isStringLiteral(headInit) ||
          MorphNode.isNumericLiteral(headInit) ||
          MorphNode.isNoSubstitutionTemplateLiteral(headInit)) &&
        headInit.getText() !== baseInit.getText()
      );
    }
  }
  return false;
}

async function readFileOrEmpty(p: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(p, "utf8");
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

