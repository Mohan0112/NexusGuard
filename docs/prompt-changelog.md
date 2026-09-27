# Prompt Changelog

## impact-v1 (initial)

**Date:** Part 1

**Changes:** Initial version

**Rationale:**
- UNCERTAIN is explicitly allowed as a legitimate answer to reduce forced guesses
- Candidates go at the end (closest to the output) so the model keeps them in view
- Evidence is labeled "trusted" to anchor the model on deterministic truth
- Single-line verbatim quotes are easy to verify mechanically

**Metrics (TBD after evals):**

| Metric | Value |
|---|---|
| Schema validity (1st try) | TBD |
| Grounding pass rate (1st try) | TBD |
| Grounding pass rate (after re-prompt) | TBD |
| Finding precision | TBD |
| Finding recall | TBD |
| Negative-control FP | TBD |
| Surviving hallucinations | 0 (by construction) |

---

## patch-v1 (initial)

**Date:** Part 1

**Changes:** Initial version

**Rationale:**
- Full file content with line numbers (numbered) reduces "find not matched" failures
- 30-line limit prevents over-engineered patches
- Exact-match edits are self-grounding (no broken diff hunks)

**Metrics (TBD after evals):**

| Metric | Value |
|---|---|
| Heal success@3 | TBD |
| Edit-apply failure rate | TBD |
| Scope violations applied | 0 (by construction) |
