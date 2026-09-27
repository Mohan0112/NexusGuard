// packages/core/src/remediate/scopeGate.ts
// ScopeGate and DenyList — guardrails checked before any edit is applied

import type { EditOp, Finding, NexusGuardConfig } from "../types.js";

export interface GateResult {
  ok: boolean;
  violations: string[];
}

// Files and patterns that are NEVER editable by the remediator
const FORBIDDEN_PATTERNS = [
  /\.test\.[tj]sx?$/,
  /\.spec\.[tj]sx?$/,
  /\btests\//,
  /__tests__\//,
  /package\.json$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /tsconfig.*\.json$/,
  /\.github\//,
  /\.(config|rc)\.[tj]sx?$/,
  /\.env/,
];

// Deny list patterns for added lines
const DENY_LINE_PATTERNS = [
  /@ts-ignore/,
  /@ts-expect-error/,
  /@ts-nocheck/,
  /\bas\s+any\b/,
  /eslint-disable/,
  /\.(skip|only)\(/,
  /process\.exit/,
  /child_process/,
  /\beval\s*\(/,
  /new\s+Function\s*\(/,
  /fs\.(rm|unlink|writeFile|writeFileSync)\s*\(/,
];

export function checkScope(
  edits: EditOp[],
  findings: Finding[],
  producerFiles: Set<string>,
  config: NexusGuardConfig,
): GateResult {
  const violations: string[] = [];
  const { maxChangedLinesPerAttempt, maxFilesPerAttempt } = config.limits;

  // Allowed files = use-site files of BROKEN findings only
  const allowedFiles = new Set<string>();
  for (const f of findings) {
    if (f.verdict === "BROKEN") {
      allowedFiles.add(f.file);
    }
  }

  // Count total changed lines and distinct files
  let totalChangedLines = 0;
  const editedFiles = new Set<string>();

  for (const edit of edits) {
    // Normalize path separators
    const file = edit.file.split("\\").join("/");

    // Check forbidden patterns
    if (FORBIDDEN_PATTERNS.some((p) => p.test(file))) {
      violations.push(`Forbidden file pattern: ${file}`);
      continue;
    }

    // Check producer files
    if (producerFiles.has(file)) {
      violations.push(`Producer file is not editable: ${file}`);
      continue;
    }

    // Check allowlist
    if (!allowedFiles.has(file) && allowedFiles.size > 0) {
      violations.push(`File ${file} is not in the allowed list (not a BROKEN finding use-site)`);
      continue;
    }

    // Check deny list on replacement lines
    const addedLines = edit.replace.split("\n");
    for (const line of addedLines) {
      for (const pattern of DENY_LINE_PATTERNS) {
        if (pattern.test(line)) {
          violations.push(`DenyList violation in ${file}: "${line.trim().slice(0, 60)}" matches ${pattern}`);
        }
      }
    }

    // Count lines changed
    const removedLineCount = edit.find.split("\n").length;
    const addedLineCount = edit.replace.split("\n").length;
    totalChangedLines += Math.abs(addedLineCount - removedLineCount) + Math.min(removedLineCount, addedLineCount);
    editedFiles.add(file);
  }

  if (totalChangedLines > maxChangedLinesPerAttempt) {
    violations.push(
      `Total changed lines ${totalChangedLines} exceeds limit ${maxChangedLinesPerAttempt}`,
    );
  }

  if (editedFiles.size > maxFilesPerAttempt) {
    violations.push(
      `Editing ${editedFiles.size} files exceeds limit ${maxFilesPerAttempt}`,
    );
  }

  return { ok: violations.length === 0, violations };
}

/** Apply search/replace edits to file contents. Returns the updated content or null if `find` doesn't match exactly once. */
export function applyEdits(
  edits: EditOp[],
  fileContents: Map<string, string>,
): { updated: Map<string, string>; errors: string[] } {
  const updated = new Map(fileContents);
  const errors: string[] = [];

  for (const edit of edits) {
    const file = edit.file.split("\\").join("/");
    const content = updated.get(file);
    if (content === undefined) {
      errors.push(`File not found: ${file}`);
      continue;
    }
    const occurrences = countOccurrences(content, edit.find);
    if (occurrences === 0) {
      errors.push(`find not matched in ${file}: "${edit.find.slice(0, 60)}"`);
      continue;
    }
    if (occurrences > 1) {
      errors.push(`find matched ${occurrences} times in ${file} (must be exactly 1): "${edit.find.slice(0, 60)}"`);
      continue;
    }
    updated.set(file, content.replace(edit.find, edit.replace));
  }

  return { updated, errors };
}

function countOccurrences(text: string, search: string): number {
  if (!search) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(search, pos)) !== -1) {
    count++;
    pos += search.length;
  }
  return count;
}
