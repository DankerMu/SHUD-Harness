# M1 Policy Gate Spike Verdict

Date: 2026-07-04

Issue: [#21](https://github.com/DankerMu/SHUD-Harness/issues/21)

## Verdict

The M1 policy-gate spike is not green. ADR-0001 trigger 1 is active, and the Zero runtime basis remains Trial rather than promoted.

Reason: spike item 2, the `data/raw/**` bash write-denial rule, produced useful implementation evidence in PR [#46](https://github.com/DankerMu/SHUD-Harness/pull/46), but the final comprehensive review and independent verifier gate confirmed merge-blocking gaps. The failure class is not an isolated command-pattern miss. A pure pre-execution static scanner cannot satisfy arbitrary bash write denial while preserving required raw-read compatibility and without implementing a full shell interpreter.

Immediate effect:
- PR #46 remains draft and must not merge at head `4074cf423796f35dce3b38f906d707de2a7161f3`.
- Stop policy-gate-dependent 3.x/5.x follow-up work until the enforcement boundary is revisited.
- Treat the current #19 implementation as spike evidence, not as the M1 authority implementation.

Non-policy M1 work may continue only when its dependency path does not rely on the unresolved policy-gate enforcement boundary.

## Spike Evidence Matrix

| Spike item | Issue / PR evidence | Status | Notes |
| --- | --- | --- | --- |
| 1. Tool-registration cross-cutting wrapper | [#17](https://github.com/DankerMu/SHUD-Harness/issues/17), merged PR [#43](https://github.com/DankerMu/SHUD-Harness/pull/43) | Green | Wrapper seam landed; Zero reference shape recorded as root Bun workspace inclusion of `zero/packages/*`; zero source remained clean. |
| 2. `data/raw/**` governance rule E2E | [#19](https://github.com/DankerMu/SHUD-Harness/issues/19), draft PR [#46](https://github.com/DankerMu/SHUD-Harness/pull/46) | Not green | Local tests passed, but final reviewer/verifier gate confirmed F1-F6 merge blockers: executable payload writes, stdin/pipeline dataflow, dynamic write targets, shell dynamic state, filesystem aliases, and read compatibility false positives. |
| 3. Spawn profile superset rejection | [#20](https://github.com/DankerMu/SHUD-Harness/issues/20) | Stopped | Not evaluated as a failure source. It depends on the policy-gate path and should not be implemented while item 2 has already triggered ADR-0001 revisit. |
| 4. Pure policy-gate function + independent tests | [#18](https://github.com/DankerMu/SHUD-Harness/issues/18), merged PR [#45](https://github.com/DankerMu/SHUD-Harness/pull/45) | Green | Pure evaluator and remediation shape landed; concrete governance rules remain separate. |
| 5. Zero source clean and pinned | Local check in #21 branch | Green as a deterministic check | `git -C zero diff --quiet` passes and `git -C zero rev-parse HEAD` remains `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`; overall spike still fails because item 2 is not green. |

## Revisit Memo

The current failure activates the ADR-0001 2026-07-02 fallback order.

Preferred option to evaluate first: keep Zero's reusable packages and Web/runtime surface, but replace the current pure static bash write scanner as the authority boundary. The likely replacement is a thin SHUD-owned tool execution boundary around BashTool that can enforce protected raw-data writes by canonical path/inode checks or OS-level sandbox/read-only mount semantics. Under that shape, static preflight remains useful for early UX, remediation, and audit hints, but it is no longer the sole authority for arbitrary shell writes.

Second option: evaluate Claude Agent SDK migration only if the runtime-model and provider assumptions return to an Anthropic-centered stack. ADR-0002 D9 currently makes this the secondary option rather than the first fallback.

Rejected continuation path: keep adding static command patterns until review stops finding bypasses. The final #19 gate showed the same invariant family across executable payloads, dynamic shell state, pipelines, and filesystem aliases; continuing that loop would violate the "do not carry a not-green spike forward" rule.
