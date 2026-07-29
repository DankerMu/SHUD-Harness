# Round 3 verifier table

Reviewed SHA: `a04f5c379a290ade2fe43a408e613bd95fc88088`

| Candidate | Verdict | Disposition |
|---|---|---|
| r3-compat-01 unknown repository extension | CONFIRMED | FIX_NOW |
| r3-contract-01 invalid noncandidate index mode | CONFIRMED | FIX_NOW |
| r3-contract-02 stale risk/evidence fixture | CONFIRMED | FIX_NOW |
| r3-contract-03 quoted object-format whitespace | CONFIRMED | FIX_NOW |
| r3-data-01 lstat/read pathname replacement | PLAUSIBLE | FIX_NOW |
| r3-data-02 CR/LF source path mismatch | CONFIRMED | FIX_NOW |
| r3-evidence-01 missing auditable batched red proof | CONFIRMED | FIX_NOW |

Each candidate passed reachability, observable-impact and project-oracle anchoring. Aggregate read/traversal budgets remain routed to #162; Git executable/HEAD/profile authority remains #166.
