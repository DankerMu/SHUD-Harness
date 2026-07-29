# Round 4 verifier table

Reviewed head: `64f548385c9cf3bd6cd7fff3bf244641827a4d61`

| Candidate | Verdict | Disposition |
|---|---|---|
| `r4-data-01` incomplete final generation/set closure | CONFIRMED | FIX_NOW |
| `r4-contract-01` Git executable-bit mode mapping | CONFIRMED | FIX_NOW |
| `r4-contract-02` frozen scope gate excludes required workflow evidence | CONFIRMED | FIX_NOW |
| `r4-contract-03` stale metrics/state and unsuperseded clean history | CONFIRMED | FIX_NOW |
| `r4-evidence-01` schema-invalid exact depth/item evidence | CONFIRMED | FIX_NOW |
| `r4-evidence-02` red proofs lack immutable test-tree/tool/overlay binding | CONFIRMED | FIX_NOW |

All candidates passed T1 reachability, T2 observable impact and T3 project-oracle
anchoring. Aggregate traversal/read budgets remain #162; Git executable/HEAD/
profile authority remains #166; network is excluded.
