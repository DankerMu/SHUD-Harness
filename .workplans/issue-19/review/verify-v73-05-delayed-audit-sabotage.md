# Verifier Verdict: V73-05-delayed-audit-sabotage

Reviewed head SHA: 73d695c53acc63eff7591baa620d840d42a1c679
Verdict: CONFIRMED
Severity: P1

Evidence: normal successful execution waits for the top-level process and capped pipe drain, appends `tool.completed`, and returns. A delayed background child can move `workspace/tasks` after return. The sandbox profile protects the audit file path, not the canonical audit subtree, and immediate sabotage tests prove the move is otherwise allowed.

Disposition: merge-blocking. The fix must make audit durability true at return and after descendant settle, either through lifecycle containment or stronger evidence-path protection.
