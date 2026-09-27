// packages/dashboard/src/components/FindingPanel.tsx
"use client";

import type { Finding } from "@nexusguard/core";

const VERDICT_COLORS: Record<string, string> = {
  BROKEN: "text-red-600 bg-red-50",
  AT_RISK: "text-amber-700 bg-amber-50",
  SAFE: "text-green-700 bg-green-50",
  UNCERTAIN: "text-purple-700 bg-purple-50",
};

const CONFIRMATION_LABELS: Record<string, string> = {
  CONFIRMED_BY_COMPILER: "Compiler confirmed",
  CONFIRMED_BY_TEST: "Test confirmed",
  LLM_GROUNDED: "IBM Bob (grounded)",
  UNCERTAIN: "Unverified",
};

interface Props {
  finding: Finding;
  onClose: () => void;
}

export function FindingPanel({ finding, onClose }: Props) {
  return (
    <div className="flex flex-col h-full overflow-y-auto p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold text-gray-900">Finding Detail</h2>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 text-xl leading-none"
        >
          ×
        </button>
      </div>

      {/* Verdict badge */}
      <div className="mb-4">
        <span
          className={`inline-block px-3 py-1 rounded-full font-semibold text-sm ${VERDICT_COLORS[finding.verdict] ?? ""}`}
        >
          {finding.verdict}
        </span>
        <span className="ml-2 text-sm text-gray-500">{finding.severity} severity</span>
      </div>

      {/* Confirmation badge */}
      <div className="mb-4">
        <span
          className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
            finding.confirmation === "CONFIRMED_BY_COMPILER" || finding.confirmation === "CONFIRMED_BY_TEST"
              ? "bg-green-100 text-green-800"
              : finding.confirmation === "LLM_GROUNDED"
                ? "bg-blue-100 text-blue-800"
                : "bg-gray-100 text-gray-700"
          }`}
        >
          {CONFIRMATION_LABELS[finding.confirmation] ?? finding.confirmation}
        </span>
      </div>

      {/* Service and file */}
      <div className="mb-3">
        <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Service</p>
        <p className="text-sm font-mono text-gray-800">{finding.service}</p>
      </div>
      <div className="mb-3">
        <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">File</p>
        <p className="text-sm font-mono text-gray-800 break-all">
          {finding.file}:{finding.line}
        </p>
      </div>

      {/* Quote */}
      {finding.quote && (
        <div className="mb-3">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Evidence quote</p>
          <pre className="text-xs font-mono bg-gray-50 border border-gray-200 rounded p-2 overflow-x-auto whitespace-pre-wrap">
            {finding.quote}
          </pre>
        </div>
      )}

      {/* Reason */}
      <div className="mb-3">
        <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Reason</p>
        <p className="text-sm text-gray-700">{finding.reason}</p>
      </div>

      {/* Suggested fix */}
      {finding.suggestedFix && (
        <div className="mb-3">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Suggested fix</p>
          <p className="text-sm text-gray-700 italic">{finding.suggestedFix}</p>
        </div>
      )}

      {/* Score factors */}
      {finding.scoreFactors && (
        <div className="mt-auto pt-3 border-t border-gray-200">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">Score factors</p>
          <div className="grid grid-cols-3 gap-2 text-xs text-center">
            {Object.entries(finding.scoreFactors)
              .filter(([k]) => k !== "w")
              .map(([k, v]) => (
                <div key={k} className="bg-gray-50 rounded p-1.5">
                  <div className="font-semibold text-gray-600">{k}</div>
                  <div className="text-gray-800">{(v as number).toFixed(2)}</div>
                </div>
              ))}
          </div>
          <p className="text-center text-xs mt-2 text-gray-500">
            weight w = {finding.scoreFactors.w.toFixed(4)}
          </p>
        </div>
      )}

      {/* Resolution */}
      {finding.resolution && (
        <div className="mt-3 p-2 rounded bg-green-50 text-green-700 text-sm">
          ✓ {finding.resolution === "healed" ? "Healed" : "Resolved by upstream fix"}
        </div>
      )}
    </div>
  );
}
