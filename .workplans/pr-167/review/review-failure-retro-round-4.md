Review Failure Retro:
PR: #167, current head SHA: 64f548385c9cf3bd6cd7fff3bf244641827a4d61
Failure classes: contract, data-integrity, test-evidence
Rounds affected: Round 1 e984729b30db43bdc22af738ddacc23fbbb8a751; Round 2 618bc86f1708513d3bf2666537fde0359019c800; Round 3 a04f5c379a290ade2fe43a408e613bd95fc88088; Round 4 64f548385c9cf3bd6cd7fff3bf244641827a4d61
Failure shape: breadth
Why Phase 5/6 did not close it:
- Fixture scope gap: yes - the PR absorbed live Git repository/tracked-set authority even though Issue #164's Out of Scope and Minimal mergeable slice assign that surface to #166; separately, the exact depth/item acceptance prose is infeasible against the closed source-record schema.
- Fix prompt too narrow: yes - the Round 3 depth retry treated every live Git snapshot sibling as part of #164 instead of re-reading the issue ownership boundary, so each closure exposed another generation surface.
- Reviewer finding contract vague/inconsistent: no - Round 4 candidates were concrete and all six were independently CONFIRMED/FIX_NOW.
- Missing regression evidence: yes - exact-bound tests did not use otherwise-valid records, and the mandatory red artifacts did not bind an immutable test tree/tool/overlay recipe.
- Cause never diagnosed (no red repro before fixes): no - every runtime candidate has a deterministic reproduction; the missed diagnosis was scope ownership, not reachability.
- PR too broad / should split: yes - Issue #164 explicitly limits the minimal mergeable slice to strict ingress, canonical JSON, exact synthetic oracle and source/platform/decision identity, while Git repository-root/tracked-set authority belongs to existing Issue #166. Review-only evidence is a separate non-runtime surface.
Next corrective action:
- PR split / ownership descope: remove live Git config/index/tracked-set/filesystem-generation authority from PR #167 and route it back to existing #166 without implementing it here; retain only #164's minimal ingress/oracle/identity slice and its no-write current-check oracle validation. Within the retained slice, make the review-only scope allowance explicit, repair immutable red-proof/state evidence, and obtain the required user decision for the infeasible exact depth/item fixture before changing that frozen acceptance contract.
User decision:
- Approved in the Codex task after this retro: execute the ownership descope above; preserve the depth/item ceilings, counting and error codes, and clarify that exact depth/item public evidence reaches strict schema validation rather than claiming an otherwise-valid authority record or exact success.
