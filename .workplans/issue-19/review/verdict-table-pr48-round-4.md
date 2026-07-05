# PR #48 round 4 verifier verdict table

Reviewed head SHA: `1c18247d9acaac53d751186526ee5f35fb9907b6`

| Candidate | Originating concern | Verdict | Blocking input |
| --- | --- | --- | --- |
| cand-19-r4-01 | Masked dynamic raw writes using `:`, `exit 0`, or alternate stderr ordering can return `success=true` / audit `allowed`. | CONFIRMED | Yes |
| cand-19-r4-02 | Interpreter payloads can dynamically construct `data/raw` and swallow sandbox exceptions internally, returning exit 0 with no denial evidence. | CONFIRMED | Yes |
| cand-19-r4-03 | `createShudRuntimeToolRegistry` returns tools that bypass the central policy-gate wrapper. | CONFIRMED | Yes |
| cand-19-r4-04 | SHUD registry factory drops caller-provided `protectedEvidencePaths`. | CONFIRMED | Yes |
| cand-19-r4-05 | Stale or sabotaged audit state can make a raw-write denial return without a durable audit row. | CONFIRMED | Yes |
| cand-19-r4-06 | Legal raw read to workspace plus denial-like stdout can be falsely converted to `raw_data_write_denied`. | CONFIRMED | Yes |
| cand-19-r4-07 | Exported `appendPolicyGateAuditRow` can write under raw when `protectedRawPaths` is omitted. | CONFIRMED | Yes |
| cand-19-r4-08 | New hardlink creation from raw source to workspace is not proven denied. | REFUTED | No |
| cand-19-r4-09 | Wrapper observability and `outputSummary` expose wrapped command / double lifecycle. | CONFIRMED | P2 |
| cand-19-r4-10 | Allowed-call profile identity and WS remediation triplet are under-asserted in tests. | CONFIRMED | P2 |

Dropped findings:

- cand-19-r4-08 -> REFUTED: the seatbelt profile's raw `file-write*` deny blocks `ln data/raw/input.csv workspace/raw-alias.csv`; verifier probe left raw unchanged and created no same-inode alias. A dedicated regression is useful but the claimed mutation scenario is not constructible at this head.

Confirmed failure classes:

- Denial classification / false success / false denial: cand-19-r4-01, cand-19-r4-02, cand-19-r4-06.
- Audit/evidence path durability and raw-safe public helper contract: cand-19-r4-05, cand-19-r4-07.
- Runtime registry / central policy-gate integration: cand-19-r4-03, cand-19-r4-04.
- Wrapper observability and evidence assertion hardening: cand-19-r4-09, cand-19-r4-10.
