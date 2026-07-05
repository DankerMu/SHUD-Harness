# Verifier Verdict: V73-08-fresh-project-root-audit-layout

Reviewed head SHA: 73d695c53acc63eff7591baa620d840d42a1c679
Verdict: CONFIRMED
Severity: P2

Evidence: project-root adaptation currently requires an existing `workspace/` child. A fresh project root with `data/raw` but no `workspace/` returns the root as the audit workspace and creates `tasks/<task>/audit` directly under it, while the spec and workspace conventions place `tasks/` under `workspace/`.

Disposition: fix in the same audit-root pass; do not defer because it is adjacent and low-cost.
