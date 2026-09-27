// packages/dashboard/src/app/page.tsx
"use client";

import { useState } from "react";
import { BlastRadiusGraph } from "@/components/BlastRadiusGraph";
import { FindingPanel } from "@/components/FindingPanel";
import { RunTimeline } from "@/components/RunTimeline";
import { useRunStream } from "@/hooks/useRunStream";
import type { BlastRadiusReport } from "@nexusguard/core";

export default function HomePage() {
  const [repoPath, setRepoPath] = useState("");
  const [base, setBase] = useState("");
  const [head, setHead] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [report, setReport] = useState<BlastRadiusReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [nodeStatuses, setNodeStatuses] = useState<Record<string, string>>({});

  // SSE stream for live updates
  useRunStream(runId, {
    onNodeStatus: (id, status) => {
      setNodeStatuses((prev) => ({ ...prev, [id]: status }));
    },
    onRunCompleted: async (rid) => {
      const res = await fetch(`/api/runs/${rid}/report`);
      if (res.ok) {
        const data = await res.json() as BlastRadiusReport;
        setReport(data);
      }
    },
  });

  const handleAnalyze = async () => {
    if (!repoPath || !base || !head) return;
    setLoading(true);
    setError(null);
    setReport(null);
    setNodeStatuses({});
    setRunId(null);

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoPath, base, head, mode: "live" }),
      });
      const data = await res.json() as { runId?: string; error?: string };
      if (!res.ok || data.error) {
        setError(data.error ?? "Analysis failed");
        return;
      }
      setRunId(data.runId ?? null);
    } finally {
      setLoading(false);
    }
  };

  const handleRemediate = async () => {
    if (!runId) return;
    setLoading(true);
    try {
      const res = await fetch("/api/remediate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId }),
      });
      const data = await res.json() as { runId?: string; error?: string };
      if (!res.ok || data.error) {
        setError(data.error ?? "Remediation failed");
      }
    } finally {
      setLoading(false);
    }
  };

  const selectedFinding = report?.findings.find((f) => f.findingId === selectedFindingId);
  const riskColor =
    report?.riskLevel === "CRITICAL"
      ? "text-red-600"
      : report?.riskLevel === "WARNING"
        ? "text-amber-600"
        : "text-green-600";

  return (
    <div className="min-h-screen flex flex-col bg-white">
      {/* Header */}
      <header className="border-b border-gray-200 px-6 py-4 flex items-center gap-4">
        <span className="font-semibold text-gray-900 text-lg">⚡ NexusGuard</span>
        <span className="text-gray-400 text-sm">IBM Bob-powered blast-radius analysis</span>
        {report && (
          <div className="ml-auto flex items-center gap-4">
            <span className={`font-bold text-2xl ${riskColor}`}>
              {report.score}/100
            </span>
            <span
              className={`px-3 py-1 rounded-full text-sm font-medium ${
                report.riskLevel === "CRITICAL"
                  ? "bg-red-100 text-red-700"
                  : report.riskLevel === "WARNING"
                    ? "bg-amber-100 text-amber-700"
                    : "bg-green-100 text-green-700"
              }`}
            >
              {report.riskLevel}
            </span>
            {report.semanticStatus === "DEGRADED" && (
              <span className="px-3 py-1 rounded-full text-sm bg-yellow-100 text-yellow-800">
                ⚠ Semantic DEGRADED
              </span>
            )}
          </div>
        )}
      </header>

      {/* Input bar */}
      <div className="border-b border-gray-200 px-6 py-3 flex gap-3 items-center bg-gray-50">
        <input
          className="border border-gray-300 rounded px-3 py-1.5 text-sm w-64"
          placeholder="Repo path"
          value={repoPath}
          onChange={(e) => setRepoPath(e.target.value)}
        />
        <input
          className="border border-gray-300 rounded px-3 py-1.5 text-sm w-32 font-mono"
          placeholder="base SHA"
          value={base}
          onChange={(e) => setBase(e.target.value)}
        />
        <span className="text-gray-400">→</span>
        <input
          className="border border-gray-300 rounded px-3 py-1.5 text-sm w-32 font-mono"
          placeholder="head SHA"
          value={head}
          onChange={(e) => setHead(e.target.value)}
        />
        <button
          className="bg-blue-600 text-white px-4 py-1.5 rounded text-sm font-medium disabled:opacity-50"
          onClick={handleAnalyze}
          disabled={loading || !repoPath || !base || !head}
        >
          {loading ? "Analyzing…" : "Analyze"}
        </button>
        {runId && report?.findings.some((f) => f.verdict === "BROKEN") && (
          <button
            className="bg-green-600 text-white px-4 py-1.5 rounded text-sm font-medium disabled:opacity-50"
            onClick={handleRemediate}
            disabled={loading}
          >
            🔧 Execute Verified Remediation
          </button>
        )}
        {error && <span className="text-red-600 text-sm">{error}</span>}
      </div>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Graph */}
        <div className="flex-1 overflow-hidden">
          {(report || Object.keys(nodeStatuses).length > 0) ? (
            <BlastRadiusGraph
              nodes={report?.graph.nodes ?? []}
              edges={report?.graph.edges ?? []}
              liveStatuses={nodeStatuses}
              onNodeClick={(nodeId) => {
                const finding = report?.findings.find((f) => f.file === nodeId || f.candidateId === nodeId);
                if (finding) setSelectedFindingId(finding.findingId);
              }}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-gray-400">
              <div className="text-center">
                <p className="text-5xl mb-4">⚡</p>
                <p className="text-lg font-medium">Enter repo + SHAs and click Analyze</p>
                <p className="text-sm mt-2">NexusGuard + IBM Bob will find what changed and what broke</p>
              </div>
            </div>
          )}
        </div>

        {/* Side panel */}
        <div className="w-96 border-l border-gray-200 flex flex-col overflow-hidden">
          {selectedFinding ? (
            <FindingPanel finding={selectedFinding} onClose={() => setSelectedFindingId(null)} />
          ) : report ? (
            <div className="p-4 overflow-y-auto">
              <h2 className="font-semibold text-gray-900 mb-3">
                Findings ({report.findings.length})
              </h2>
              <div className="space-y-2">
                {report.findings.map((f) => (
                  <button
                    key={f.findingId}
                    className="w-full text-left p-3 rounded border border-gray-200 hover:bg-gray-50 transition-colors"
                    onClick={() => setSelectedFindingId(f.findingId)}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-lg">
                        {f.verdict === "BROKEN" ? "🔴" : f.verdict === "AT_RISK" ? "🟡" : f.verdict === "SAFE" ? "🟢" : "🟣"}
                      </span>
                      <span className="font-medium text-sm text-gray-900">{f.service}</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1 truncate">{f.file}:{f.line}</p>
                    <p className="text-xs text-gray-600 mt-1 truncate">{f.reason}</p>
                    <span
                      className={`mt-1 inline-block text-xs px-1.5 py-0.5 rounded ${
                        f.confirmation === "CONFIRMED_BY_COMPILER" || f.confirmation === "CONFIRMED_BY_TEST"
                          ? "bg-green-100 text-green-700"
                          : f.confirmation === "LLM_GROUNDED"
                            ? "bg-blue-100 text-blue-700"
                            : "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {f.confirmation}
                    </span>
                  </button>
                ))}
              </div>
              {report.rejectedClaims.length > 0 && (
                <div className="mt-4">
                  <h3 className="font-medium text-gray-700 text-sm mb-2">
                    Rejected claims ({report.rejectedClaims.length})
                  </h3>
                  {report.rejectedClaims.map((r, i) => (
                    <div key={i} className="text-xs text-gray-500 bg-gray-50 rounded p-2 mb-1">
                      <span className="font-mono text-red-600">[{r.code}]</span>{" "}
                      {r.candidateId && <span>{r.candidateId}: </span>}
                      {r.detail}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <RunTimeline runId={runId} />
          )}
        </div>
      </div>
    </div>
  );
}
