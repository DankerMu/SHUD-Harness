# Phase 4.5 — test-evidence

Reviewed head SHA: `e984729b30db43bdc22af738ddacc23fbbb8a751`

| Candidate | Verdict | Disposition | Evidence |
|---|---|---|---|
| TE-01 public structural-bound evidence | CONFIRMED | FIX_NOW | Task/spec require public exact/+1 byte/depth/node/item. Only bytes uses `capture`; structural cases call parser directly with non-schema arrays and relaxed sibling limits. Public wiring/receipt regressions are unprotected. Overlaps CT-02 but separately establishes the checked-task evidence overclaim. |
| TE-02 oracle mutations at public seam | CONFIRMED | FIX_NOW | Task names entry count/order/path/mode/content/framing/digest/trailing/truncation as public cases. Internal oracle unit tests cover all, but current-check tests cover only truncation and one same-length mutation, leaving checker wiring regressions unprotected. |

Both cover behavior introduced here; coverage carve-out requires immediate closure.
