// packages/dashboard/src/lib/guards.ts
// Guards for the dashboard API when it is reachable beyond localhost.
// Live analysis spawns git, tsc, vitest and Bob Shell (with BOB_API_KEY),
// so a public deployment must not let arbitrary visitors trigger it.

import * as path from "node:path";

const IS_PROD = process.env["NODE_ENV"] === "production";
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

/** Run IDs become directory names under .nexusguard/runs — reject anything that could traverse. */
export function isValidRunId(runId: string): boolean {
  return RUN_ID_RE.test(runId);
}

/** Off in production unless NEXUSGUARD_ENABLE_ANALYZE=true; on in local dev unless set to false. */
export function analyzeEnabled(): boolean {
  const flag = process.env["NEXUSGUARD_ENABLE_ANALYZE"];
  return flag ? flag === "true" : !IS_PROD;
}

/** In production only repos listed in NEXUSGUARD_ALLOWED_REPOS (comma-separated) may be analyzed. */
export function isAllowedRepo(repoRoot: string): boolean {
  const allowed = (process.env["NEXUSGUARD_ALLOWED_REPOS"] ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));
  if (allowed.length === 0) return !IS_PROD;
  return allowed.includes(path.resolve(repoRoot));
}

/** Never leak stack traces or filesystem paths to the browser in production. */
export function publicError(e: unknown): string {
  return IS_PROD ? "Internal error" : String(e);
}
