# Hour-0 Findings

> Fill this in at Hour 0 before building anything downstream.

## Q1 — Bob Shell non-interactive mode

**Status:** ⚠️ VERIFY

**How to check:** `bob --help | grep -i print` and try a one-shot prompt

**Flags (from docs):** `--print`, `--auth-method api-key`, `--mode ask`

**Result:** TBD

**Decision:** If yes → Mode B available. If no → Mode A only.

---

## Q2 — Read-only enforcement (Ask mode)

**Status:** ⚠️ VERIFY

**Result:** TBD

---

## Q3 — Output format (JSON fence in stdout)

**Status:** ⚠️ VERIFY

**Fallback:** Extract last ```json fence with regex (already implemented in `llm/parse.ts`)

**Result:** TBD

---

## Q4 — MCP server support in Bob IDE

**Status:** ⚠️ VERIFY

**How to check:** Register a hello-world MCP tool, call it from Bob IDE

**Fallback:** CLI-in-terminal (`npx nexusguard analyze --json`) called from Bob's terminal

**Result:** TBD

---

## Q5 — Custom modes / rules files in Bob IDE

**Status:** ⚠️ VERIFY

**Config location:** TBD (check Bob IDE settings)

**Fallback:** Put rules in a workspace `.bobrc` or rules file

**Result:** TBD

---

## Q6 — Latency: p50/p95 for small and large prompts

**Measurements:**

| Prompt size | p50 | p95 | Action |
|---|---|---|---|
| ~1k tokens | TBD | TBD | |
| ~10k tokens | TBD | TBD | |

**Timeout set to:** TBD (currently 60s — update after measurement)

---

## Q7 — Quota/credits

**Available credits:** TBD

**Eval budget:** 14 scenarios × 3 repeats × ~3 calls = ~126 calls

**Decision:** TBD

---

## Q8 — Submission requirements

**Video length:** TBD
**Proof of Bob usage required:** TBD
**Public repo:** TBD

---

## Q9 — Model/temperature control

**Can set temperature:** TBD

**Mitigation:** Rely on closed-world schema + validators + oracles (already implemented)

---

## Gate G0 Decision

- [ ] Q1 ✅ and Q4 ✅ → full plan
- [ ] Q1 ❌ → skip Mode B
- [ ] Q4 ❌ → use CLI-in-terminal fallback
- [ ] Q1 ❌ and Q4 ❌ → escalate to mentors immediately
