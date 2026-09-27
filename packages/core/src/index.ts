// packages/core/src/index.ts
// Public API for @nexusguard/core

export * from "./types.js";
export * from "./pipeline.js";
export * from "./ports/reasoning.js";
export * from "./ports/events.js";
export * from "./ports/git.js";
export * from "./ports/runner.js";
export * from "./adapters/gitCli.js";
export * from "./adapters/nodeRunner.js";
export * from "./adapters/fake.js";
export * from "./adapters/replay.js";
// BobShellProvider re-exports extractJsonFence which conflicts with llm/parse; be explicit
export { BobShellProvider, sanitizeForPrompt } from "./adapters/bobShell.js";
export * from "./store/runStore.js";
// schemas re-exports Verdict/Severity which conflict with types.ts; be explicit
export { ImpactVerdictSet, PatchProposal } from "./llm/schemas.js";
export type { ImpactVerdictSetType, PatchProposalType } from "./llm/schemas.js";
export * from "./llm/prompts.js";
export { extractJsonFence, tryParseJson } from "./llm/parse.js";
export * from "./validate/validator.js";
export * from "./score/scorer.js";
export * from "./remediate/scopeGate.js";
export * from "./diff/ingestor.js";
export * from "./graph/builder.js";
export * from "./classify/classifier.js";
export * from "./expand/expander.js";
export * from "./oracles/compiler.js";
export * from "./oracles/tests.js";
export * from "./bundle/bundler.js";
export * from "./telemetry/timed.js";
