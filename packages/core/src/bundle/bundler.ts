// packages/core/src/bundle/bundler.ts
// S6: EvidenceBundler — assemble uniquely addressable evidence for the LLM

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { Candidate, EvidenceItem, EvidenceBundle, ChangeFact } from "../types.js";

export interface BundleOptions {
  maxCharsPerCall: number;
  headWorktreePath: string;
}

export class EvidenceBundler {
  async buildBundle(
    runId: string,
    facts: ChangeFact[],
    candidates: Candidate[],
    existingEvidence: EvidenceItem[],   // E1, E2 from classifier
    opts: BundleOptions,
  ): Promise<EvidenceBundle[]> {
    const { maxCharsPerCall, headWorktreePath } = opts;

    // Find E1/E2 (producer before/after)
    const producerBefore = existingEvidence.find((e) => e.role === "producer_before");
    const producerAfter = existingEvidence.find((e) => e.role === "producer_after");

    if (!producerBefore || !producerAfter) {
      throw new Error("Missing producer evidence E1/E2");
    }

    // Build consumer evidence items for each candidate
    let evidenceCounter = existingEvidence.length + 1;
    const updatedCandidates = [...candidates];
    const consumerEvidence: EvidenceItem[] = [];

    for (let i = 0; i < updatedCandidates.length; i++) {
      const candidate = updatedCandidates[i]!;
      const candidateEvidenceIds: string[] = [];

      for (const useSite of candidate.useSites) {
        const evidenceId = `E${evidenceCounter++}`;
        const item = await this.buildConsumerEvidence(
          evidenceId,
          candidate.candidateId,
          useSite.file,
          useSite.line,
          headWorktreePath,
        );
        consumerEvidence.push(item);
        candidateEvidenceIds.push(evidenceId);
      }

      updatedCandidates[i] = {
        ...candidate,
        evidenceIds: candidateEvidenceIds,
      };
    }

    // Build allById map
    const allEvidence = [producerBefore, producerAfter, ...consumerEvidence];
    const allById = new Map(allEvidence.map((e) => [e.evidenceId, e]));

    // Check if we fit in one call
    const totalChars = allEvidence.reduce((s, e) => s + e.content.length, 0);

    if (totalChars <= maxCharsPerCall) {
      return [
        {
          runId,
          producerBefore,
          producerAfter,
          consumerEvidence,
          allById,
          totalChars,
        },
      ];
    }

    // Split by service batch
    const serviceGroups = new Map<string, Candidate[]>();
    for (const c of updatedCandidates) {
      const list = serviceGroups.get(c.service) ?? [];
      list.push(c);
      serviceGroups.set(c.service, list);
    }

    const batches: EvidenceBundle[] = [];
    for (const [_service, serviceCandidates] of serviceGroups) {
      const serviceEvidence = consumerEvidence.filter((e) =>
        serviceCandidates.some((c) => c.evidenceIds.includes(e.evidenceId)),
      );
      const batchById = new Map([
        [producerBefore.evidenceId, producerBefore],
        [producerAfter.evidenceId, producerAfter],
        ...serviceEvidence.map((e) => [e.evidenceId, e] as [string, EvidenceItem]),
      ]);
      const batchChars =
        producerBefore.content.length +
        producerAfter.content.length +
        serviceEvidence.reduce((s, e) => s + e.content.length, 0);

      batches.push({
        runId,
        producerBefore,
        producerAfter,
        consumerEvidence: serviceEvidence,
        allById: batchById,
        totalChars: batchChars,
      });
    }

    return batches;
  }

  private async buildConsumerEvidence(
    evidenceId: string,
    candidateId: string,
    file: string,
    line: number,
    headWorktreePath: string,
  ): Promise<EvidenceItem> {
    const filePath = path.join(headWorktreePath, file);
    let fileContent: string;
    try {
      fileContent = await fs.readFile(filePath, "utf8");
    } catch {
      return {
        evidenceId,
        role: "consumer",
        candidateId,
        file,
        startLine: Math.max(1, line - 8),
        endLine: line + 8,
        content: `(file not found: ${file})`,
        contentHash: sha256(""),
      };
    }

    const lines = fileContent.split("\n");
    const contextStart = Math.max(1, line - 8);
    const contextEnd = Math.min(lines.length, line + 8);

    // Try to expand to enclosing function
    let funcStart = contextStart;
    let funcEnd = contextEnd;
    for (let i = line - 1; i >= 0; i--) {
      const l = lines[i] ?? "";
      if (/function\s|=>\s*\{|async\s/.test(l)) {
        funcStart = Math.max(1, i + 1);
        break;
      }
      if (i < line - 20) break;
    }
    for (let i = line; i < lines.length; i++) {
      const l = lines[i] ?? "";
      if (l.trim() === "}" || l.trim() === "};") {
        funcEnd = Math.min(lines.length, i + 1);
        break;
      }
      if (i > line + 20) break;
    }

    const snippetLines = lines
      .slice(funcStart - 1, funcEnd)
      .map((l, i) => `${funcStart + i}| ${l}`);
    const content = snippetLines.join("\n");

    return {
      evidenceId,
      role: "consumer",
      candidateId,
      file,
      startLine: funcStart,
      endLine: funcEnd,
      content,
      contentHash: sha256(content),
    };
  }
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}
