# M1 Acceptance Record

Date: 2026-07-10

Issue: [#38](https://github.com/DankerMu/SHUD-Harness/issues/38)

## Conclusion

M1 acceptance passes. Every applicable item in task 9.1 is green, each M1
exception is recorded below, and the policy-gate spike has a final five-item
green verdict. The acceptance run used `main` base
`741a15df2f6e5d7924c87d21bd53f75455c03c1d`; the resulting acceptance and ADR
accounting diff is subject to the same OpenSpec, docs-link, and repository checks
before merge.

## Product Walkthrough

| Check | Evidence | Result |
| --- | --- | --- |
| Dashboard opens and creates a TaskCard | Browser submitted the existing Dashboard form against the real Hono API and created `TASK-79edd031-8e9c-4f03-a7d7-703b83a5557f` with title `M1 浏览器验收任务`; implementation and regression coverage: [`Dashboard.ts`](../../../packages/frontend/src/pages/Dashboard.ts), [`dashboard.test.ts`](../../../packages/frontend/src/pages/dashboard.test.ts) | Pass |
| Refresh and service restart restore the snapshot | The task remained visible after browser reload and after restarting the acceptance server against the same workspace; API returned one task with status `created`; backend recovery coverage: [`index.test.ts`](../../../packages/backend/src/routes/index.test.ts) | Pass |
| Four-column Workbench opens | Browser rendered Task, Agent Activity, Experiment, and Results columns with the task header/status placeholders; coverage: [`Workbench.ts`](../../../packages/frontend/src/pages/Workbench.ts), [`workbench.test.ts`](../../../packages/frontend/src/pages/workbench.test.ts), [`task-context-components.test.ts`](../../../packages/frontend/src/components/task-context-components.test.ts) | Pass |

The browser harness and screenshots are local `.workplans/issue-38/` evidence and
are intentionally not repository artifacts. The authoritative evidence is the
committed implementation/tests plus this recorded walkthrough.

## Required Gates

| Gate | Command / evidence | Result |
| --- | --- | --- |
| W0-GIT / W0-READY-001 | [`check_readiness.sh`](../../../scripts/readiness/check_readiness.sh) on a clean tracked worktree: `decision: pass`; all four gitlinks match clean submodule HEADs | Pass |
| W0-DOC | [`self_test.sh`](../../../scripts/docs/self_test.sh) and [`check_links.sh`](../../../scripts/docs/check_links.sh): 339 Markdown files scanned | Pass |
| W0-SPEC / W0-CANON | Readiness checks report canonical index, core/support schemas, API registry, idempotency, artifact, lock, and recovery contracts green | Pass |
| OpenSpec / generated schema | `openspec validate m1-foundation --strict --no-interactive` and `bun run schema:check` | Pass |
| W1 unit/integration/UI | `bun run check`: policy gate, registry, backend API/WS, frontend, schemas, core services, and GLM provider suites all pass with zero failures | Pass |
| Registration lint negative | [`policy-gate-registry.test.ts`](../../../packages/core/src/tools/policy-gate-registry.test.ts) covers the 21st tool, incomplete descriptions, invalid Zod carriers, and unwrapped assembly rejection | Pass |
| OBS-HEALTH-001/002 | Live returned 200 with status/version/uptime/timestamp; ready returned 200 with directory tree, snapshot readability, and workspace writability all `ok`; route coverage is in [`index.test.ts`](../../../packages/backend/src/routes/index.test.ts) | Pass |
| OBS-LOG-001/002 | Actual browser/API run emitted eight-field NDJSON request rows; redaction tests cover fake secrets, while provider evidence records only `env:GLM_API_KEY`; coverage: [`routes/index.test.ts`](../../../packages/backend/src/routes/index.test.ts) and [`middleware/index.ts`](../../../packages/backend/src/middleware/index.ts) | Pass |
| PERF-API-001 | `bun run test:perf:api`: 100-task fixture; list P95 `0.06ms`, detail P95 `0.01ms`, ready P95 `5.09ms`, all below `300ms` | Pass |
| SHUD make / rSHUD | [`check_shud_rshud.sh`](../../../scripts/readiness/check_shud_rshud.sh): `make shud` exit 0, SUNDIALS 6.0.0 selected, rSHUD 2.5.0 meets minimum, cleanup complete | Pass |
| Policy-gate spike | [Final five-item verdict](policy-gate-spike-final-verdict.md) | Pass |
| Zero pin and source diff | `zero` HEAD is `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`; `git -C zero diff --quiet` exits 0 | Pass |

## GLM Connectivity

The real local smoke mapped the existing `DMXAPI_KEY` into the canonical
`GLM_API_KEY` process variable and completed one nonempty response. It hit exactly
`https://www.dmxapi.cn/v1/chat/completions` with carrier
`deepseek-v4-pro-guan`; the configured target remains `glm-5.2` and
`model_admission=false`.

Before consuming the canonical readiness JSON, acceptance performed `lstat`-style
metadata checks: the path was not a symlink, was a regular file, and had
`nlink=1`. The canonical schema then reported `status=passed`,
`evidence_scope=canonical`, exact endpoint/response URL,
`secret_ref=env:GLM_API_KEY`, nonempty completion, and one attempt. A direct byte
comparison confirmed that the API key value was absent, and `workspace/` remained
untracked.

## M1 Exceptions

| Item | M1 disposition | Completion milestone |
| --- | --- | --- |
| OBS-HEALTH-003: disk critical and job-submit 409 | N/A in M1; job submission does not exist yet | M3 operational skeleton |
| OBS-HEALTH-004: authenticated deep health | N/A in M1; authentication context is not active | M3+ after authentication context exists |
| Dashboard to Workbench task-context navigation | N/A in M1; the four-column shell is accepted independently | M2 data wiring |
| SideNav displays real task data | N/A in M1; SideNav is a shell placeholder | M2 data wiring |

No M1 acceptance-blocking failure remains. The two nonblocking frozen-spec ledger
items recorded in [`proposal.md`](proposal.md) remain outside #38: the
Roles_and_Boundaries coordinator/bash correction note and the canonical
idempotency applicability-list additions for `POST /api/tasks`.
