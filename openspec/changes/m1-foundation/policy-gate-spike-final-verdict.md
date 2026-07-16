# M1 Policy Gate Spike Final Verdict

Date: 2026-07-10

Issues: [#21](https://github.com/DankerMu/SHUD-Harness/issues/21),
[#38](https://github.com/DankerMu/SHUD-Harness/issues/38)

## Verdict

All five policy-gate spike items are green after item 2 was replaced by the
executor-level item 2' boundary adjudicated in ADR-0001. The Zero runtime basis is
promoted from Trial to Adopt at the pinned commit
`13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

This final verdict supersedes the operational conclusion of the immutable
[first-round verdict](policy-gate-spike-verdict.md), but does not erase its failure
evidence or the 2026-07-04 revisit record.

## Evidence Matrix

| Spike item | Final evidence | Status |
| --- | --- | --- |
| 1. Cross-cutting tool-registration gate | [#17](https://github.com/DankerMu/SHUD-Harness/issues/17) / merged [PR #43](https://github.com/DankerMu/SHUD-Harness/pull/43); registry tests prove bash, edit, and spawn are wrapped and bypass assembly fails | Green |
| 2'. Executor-level `data/raw/**` byte authority | [#19](https://github.com/DankerMu/SHUD-Harness/issues/19) / merged [PR #48](https://github.com/DankerMu/SHUD-Harness/pull/48); macOS seatbelt tests cover six escape classes, raw reads, workspace writes, hardlink detection, advisory remediation, WebSocket failure, and audit rows | Green |
| 3. Spawn profile superset denial | [#20](https://github.com/DankerMu/SHUD-Harness/issues/20) / merged [PR #50](https://github.com/DankerMu/SHUD-Harness/pull/50); excess `allowed_tools` is denied with `remediation.next_action=adjust_scope` | Green |
| 4. Pure policy evaluator and independent tests | [#18](https://github.com/DankerMu/SHUD-Harness/issues/18) / merged [PR #45](https://github.com/DankerMu/SHUD-Harness/pull/45); deterministic allow/deny and remediation tests pass | Green |
| 5. Zero source remains pinned and unchanged | 2026-07-10 acceptance run: `git -C zero diff --quiet` exits 0 and `git -C zero rev-parse HEAD` equals the ADR pin | Green |

## Preserved Boundaries

- Byte authority for bash raw-data protection remains at the OS sandbox layer;
  static pre-execution checks remain advisory.
- Hidden sandbox denials swallowed by child processes and arbitrary detached
  process ownership are not claimed as M1 telemetry guarantees.
- A pre-existing hardlink alias remains a producer/readiness concern, bounded by
  `nlink>1` rejection and the later DataProvenance checksum cross-check.
- The current implementation is macOS seatbelt-specific. A future platform move
  must preserve the same authority semantics with an equivalent executor sandbox.

These are explicit architecture boundaries, not failed spike items. No fallback
runtime evaluation remains open for ADR-0001 trigger 1.
