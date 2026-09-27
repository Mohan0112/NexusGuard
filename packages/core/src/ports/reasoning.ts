// packages/core/src/ports/reasoning.ts
// ReasoningProvider port — the only place the LLM is called

export interface ImpactRequest {
  runId: string;
  promptText: string;   // fully-rendered prompt
  promptVersion: string;
}

export interface PatchRequest {
  runId: string;
  promptText: string;
  promptVersion: string;
  attemptN: number;
}

export interface CallOptions {
  timeoutMs: number;
  runId: string;
  attempt: number;
  signal?: AbortSignal;
}

export interface RawLLMResult {
  text: string;            // raw stdout / response, stored verbatim
  latencyMs: number;
  promptChars: number;
  outputChars: number;
  provider: string;
  cached: boolean;
}

export interface ReasoningProvider {
  readonly id: "bob-shell" | "bob-ide-mcp" | "replay" | "fake";
  analyzeImpact(req: ImpactRequest, opts: CallOptions): Promise<RawLLMResult>;
  proposeEdits(req: PatchRequest, opts: CallOptions): Promise<RawLLMResult>;
}
