# Phase 4.5 — contract

Reviewed head SHA: `e984729b30db43bdc22af738ddacc23fbbb8a751`

| Candidate | Verdict | Disposition | Evidence |
|---|---|---|---|
| CT-01 cross-entry joint identity | REFUTED | — | OpenSpec defines three independent seams and mutually exclusive checker modes. Four peers bind within identity projection; aggregation and final source binding belong later. `input_kind`-only receipts are frozen. |
| CT-02 independent node bound | CONFIRMED | FIX_NOW | Frozen profiles use nodes/items 2048/512 and 32768/8192. Parser makes each non-root node also consume one item, so item limit always wins; real-profile probes return item-limit. Tests reach node only by replacing sibling limit, contradicting public exact/+1 requirements. |

CT-02 requires an executable frozen public node boundary and real-profile exact/+1 public evidence.
