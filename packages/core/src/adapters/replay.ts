// packages/core/src/adapters/replay.ts
// ReplayProvider — returns stored raw LLM outputs by cache key (for evals and CI)

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ReasoningProvider, ImpactRequest, PatchRequest, CallOptions, RawLLMResult } from "../ports/reasoning.js";

export class ReplayProvider implements ReasoningProvider {
  readonly id = "replay" as const;

  constructor(private readonly cacheDir: string) {}

  private async load(promptHash: string, kind: "impact" | "patch"): Promise<string> {
    const file = path.join(this.cacheDir, `${kind}-${promptHash}.raw.txt`);
    try {
      return await fs.readFile(file, "utf8");
    } catch {
      throw new Error(
        `[ReplayProvider] No cached result for ${kind}-${promptHash} at ${file}. ` +
          `Run with a live provider first to populate the cache.`,
      );
    }
  }

  async analyzeImpact(req: ImpactRequest, _opts: CallOptions): Promise<RawLLMResult> {
    const hash = hashStr(req.promptText);
    const text = await this.load(hash, "impact");
    return {
      text,
      latencyMs: 0,
      promptChars: req.promptText.length,
      outputChars: text.length,
      provider: "replay",
      cached: true,
    };
  }

  async proposeEdits(req: PatchRequest, _opts: CallOptions): Promise<RawLLMResult> {
    const hash = hashStr(req.promptText);
    const text = await this.load(hash, "patch");
    return {
      text,
      latencyMs: 0,
      promptChars: req.promptText.length,
      outputChars: text.length,
      provider: "replay",
      cached: true,
    };
  }
}

/** Simple deterministic string hash (djb2 hex) for cache keys. */
function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ (s.codePointAt(i) ?? 0);
    h >>>= 0;
  }
  return h.toString(16).padStart(8, "0");
}
