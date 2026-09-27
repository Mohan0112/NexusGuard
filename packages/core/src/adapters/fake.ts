// packages/core/src/adapters/fake.ts
// FakeProvider — scripted outputs for unit-testing the validator and pipeline

import type { ReasoningProvider, ImpactRequest, PatchRequest, CallOptions, RawLLMResult } from "../ports/reasoning.js";

export class FakeProvider implements ReasoningProvider {
  readonly id = "fake" as const;

  private impactResponses: Map<string, string> = new Map();
  private patchResponses: Map<string, string> = new Map();
  private defaultImpact: string | null = null;
  private defaultPatch: string | null = null;

  /** Set a fixed JSON text that will be returned for the next impact call. */
  setImpact(text: string): this {
    this.defaultImpact = text;
    return this;
  }

  /** Set a fixed JSON text that will be returned for the next patch call. */
  setPatch(text: string): this {
    this.defaultPatch = text;
    return this;
  }

  /** Register a response keyed by runId for impact calls. */
  setImpactForRun(runId: string, text: string): this {
    this.impactResponses.set(runId, text);
    return this;
  }

  async analyzeImpact(req: ImpactRequest, _opts: CallOptions): Promise<RawLLMResult> {
    const text =
      this.impactResponses.get(req.runId) ??
      this.defaultImpact ??
      "{}";
    return {
      text,
      latencyMs: 1,
      promptChars: req.promptText.length,
      outputChars: text.length,
      provider: "fake",
      cached: false,
    };
  }

  async proposeEdits(req: PatchRequest, _opts: CallOptions): Promise<RawLLMResult> {
    const text = this.patchResponses.get(req.runId) ?? this.defaultPatch ?? "{}";
    return {
      text,
      latencyMs: 1,
      promptChars: req.promptText.length,
      outputChars: text.length,
      provider: "fake",
      cached: false,
    };
  }
}
