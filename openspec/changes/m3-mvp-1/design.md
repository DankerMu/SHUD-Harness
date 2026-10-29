# Design

## Issue #424 implementation boundary

Change surface: `schemas/run-identifiers.ts`, `schemas/task.ts`, schema exports, tests and generated TaskCard projections; `scripts/schema/registry.ts` TaskCard example overrides; `scripts/schema/self-test.ts` TaskCard fixture; `Minimal_Schemas.md` §1.
Must preserve: `generateRunIdentifiers(now?)` signature, UTC-second formatting and shared JOB/RUN suffix; TaskCard type/status enums, reviewer and optional theory bundles.
Governing invariant: TaskCard identifiers and references accept only their matching branded format, while a newly created card has explicit null stack/data references.
Sibling surfaces: public core exports, TaskCard validators, schema registry/example generation, generated JSON Schema/Markdown, existing schema and collection consumers.
Seams under test: exported identifier generation and schema parsing; generated TaskCard contract. No dsh seam.
Required evidence: all five new prefixes accept valid lowercase ids and reject legacy/wrong-prefix/uppercase ids; empty-reference card parses, malformed links and missing required references fail; existing JOB/RUN tests remain green.
Non-goals: aligning StackLock/DataProvenance/EvidenceReport objects, filesystem collision handling, tools, governance, jobs and profile changes.
Review focus: one generation implementation, JOB/RUN pairing, required nullable references, unchanged unrelated schemas, generated projections and public exports.
Scope correction approved by PI during issue execution: both `core-schemas.test.ts` `validTaskCard()` and `scripts/schema/self-test.ts` `assertTaskCardUnknownKeyParity()` use `TASK-0001` and omit both references, contradicting the new schema. Migrate only those fixtures to a valid branded task id and explicit null references; preserve all assertions, including root/nested unknown-key stripping, and every JOB/RUN test. `shud-collect.test.ts` remains unchanged. The existing schema registry's TaskCard entry needs valid `exampleOverrides` for branded ids/links; this is the issue's required schema-registration work, not a new generator convention.

## Issue #425 implementation boundary

Change surface: tools strict-tool registration and one TaskCard file module; core caller-preset reader; jobs index export of existing `writeJsonSync`.
Must preserve: shud_run/shud_collect behavior and strict-tool validation, shared atomic writer, schema from #424, unknown role value as a nonempty original string or `unknown`.
Governing invariant: valid task_create publishes one schema-valid planned card only in the calling session workspace; invalid input or unsafe paths never write through a link or alter an existing card.
Sibling surfaces: tool schema/runtime validation, caller identity, workspace directory and target validation, shared writer, public registrations and tests.
PI scope decision: missing agent/session cwd rejects before file IO; present cwd with missing preset succeeds with unknown attribution. No implicit launch-directory fallback. This corrects the former no-agent success scenario, since ToolExecution has no independent session/cwd field.
Required evidence: science_assist success with exact deterministic fields and valid id; missing/non-science type, empty fields, wrong root and unknown keys reject without files; absent workspace rejects; absent preset returns unknown; unsafe tasks directory/allocated directory/target rejects without outside mutation; generated-id collision preserves original bytes and retries; no leftover atomic temporary file.
Reuse existing strict-tool and jobs writeJsonSync; one synchronous allocation/validation/write boundary prevents in-process interleaving. Existing genuine task directory collisions regenerate ids; links/special files fail closed rather than being treated as reusable directories.
No new retry timer/configuration, second atomic writer, schema changes, records package, report tool or job mutation. File module and writer migrate once to records in #437.
Review focus: model-visible closed arguments; validation-before-IO; caller workspace/identity separation; lstat on managed descendants and target; existing-card preservation.

## Issue #430 implementation boundary

Change surface: core `schemas/stack-lock.ts`, `stack-lock/repository-revision.ts`, `stack-lock/fingerprint.ts` and their tests; generated StackLock projections, Minimal_Schemas §2, CONTEXT K4 lines and glossary StackLock entry.
Must change: reuse StackIdSchema; strict three-field llm, minimal runtime/harness; repo dirty_paths and truncation invariant; porcelain -z parser; exclude only llm.response_model in addition to the existing fingerprint exclusions.
Must preserve: exactly four git subprocess commands, argument-array execution, fsmonitor disabled, optional locks disabled, inherited repository locator removal, physical-root equality, detached/invalid HEAD semantics, ignored-file semantics, no index mutation, existing overflow/error distinction and original errors.
Governing invariant: a schema-valid revision describes the same status observation used for dirty; only complete NUL records contribute paths, sorted/deduplicated independently of locale, with dirty=true on nonempty-stdout overflow.
Parser boundaries: R/C records use destination only and are complete only after both destination and source terminators; spaces, tabs, newlines and Unicode filenames remain verbatim. Code-point ordering must cover astral versus BMP characters, not merely ASCII or locale collation.
Review correction (PR #462): Linux reproduction confirmed malformed UTF-8 names collapse under replacement decoding. Read only status stdout as bytes, delimit complete records first, decode retained paths strictly with literal U+FFFD/BOM preserved; fail closed on invalid complete paths and ignore incomplete overflow tails. No byte-escape representation, extra git call or buffer-limit change.
Schema boundaries: required dirty_paths/truncation, nonempty relative POSIX path entries in canonical unique order, dirty equals nonempty paths unless truncated; truncated requires dirty=true and may have no complete paths.
Sibling surfaces: existing core-schemas StackLock cases and typed fingerprint fixtures migrate to the new contract without weakening unrelated schemas; tests move/consolidate rather than leaving obsolete R-package-lock expectations. Public exports/signatures remain, only StackLock/RepositoryRevision field types intentionally cut over.
PI-approved exception: `scripts/schema/registry.ts` StackLock exampleOverrides migrates to a schema-valid example; no other registry entries, render/generator logic or checks change. Generated examples must parse with the new schema.
PI-approved documentation companions: update only the stale StackLock current-state notes in `openspec/project-profile.md` and `docs/04_IMPLEMENTATION/Port_List.md`; record schema/fingerprint alignment without claiming captureStackLock or submission integration is delivered.
Required evidence: new tests run red before implementation; positive/negative schema cases, genuine git dirty/rename/special-character/index-byte checks, overflow partial-record and R/C parser boundaries, preserved failures, fingerprint response-model invariance and dirty-path sensitivity, independent `shasum -a 256` fixed vector.
Compile-time evidence additionally binds `StackLockSchema.parse(...).stack_id` to StackId in the existing compiler-owned fixture, with plain-string rejection and a regex-preserving brand-removal negative control. Real Linux Git/Buffer filename reproduction and valid replacement/BOM controls prove the path-fidelity correction.
Smoke: direct Node invocation against a disposable git repository yields a schema-valid lock and paths; changing response_model leaves the fingerprint equal while changing paths changes it. Do not mutate the real repo/submodules as test input.
Non-goals: captureStackLock, records package, installer/jobs configuration, other object schema alignment, buffer-limit changes, extra git calls, dependencies or compatibility shims.
Review focus: NUL/R/C completeness, code-point order, strict nested shapes, read-only guarantees, overflow classification, canonical serialization/exclusion precision and generated-example validity.

## Issue #431 implementation boundary

Change surface: DataProvenance schema and dedicated tests, corresponding old core-schemas cases, schema self-test, generated DataProvenance projections, Minimal_Schemas §3; approved registry example and existing compiler fixture.
Must change: reuse DataIdSchema; strict sources `{ input_root, files: [{ path, sha256, size_bytes }] }`; required nullable event_window endpoints; required literal-null preprocess/uncertainty_notes; remove old terrain/mesh/forcing/observations/preprocess-params shapes.
Schema/producer distinction: D3 and issue #431 require event_window endpoints to accept nonempty string or null; M3 generation in D6 emits both null because the producer is undefined until M5. Do not narrow the schema to literal null or invent timestamp parsing.
Scalar contracts: basin and sha256 stay nonempty strings; size_bytes is a nonnegative integer, including zero. input_root is absolute using existing path-validation conventions; files[].path is a nonempty relative POSIX path, with parent traversal/NUL rejected and legal filename characters preserved. No filesystem reads, new digest syntax, minimum file count or array-order/uniqueness constraint in this schema slice; deterministic inventory ordering belongs to generation.
Reuse existing primitives. A minimal extraction of StackLock's relative-POSIX scalar inside schemas may serve both schemas; preserve StackLock behavior and generated output exactly. Do not copy the predicate or change RunRecord's distinct cross-platform artifact-path policy.
Must preserve: every unrelated schema/generator assertion, TaskCard unknown-key stripping, strict registry example round-trip, closed object traversal through arrays and nullable/union branches, all existing StackLock contracts.
Open-record removal: delete intentionalOpenRecordBoundary and its bypass/helper/import; replace obsolete observations.station/params-empty assertions with the new file-array/null shape. Self-test must reject open records even at the former DataProvenance.preprocess.params identity/path, not merely stop exercising it.
PI-approved cleanup boundary: removing the old params-rendering self-test leaves yamlLines used only inside scripts/schema/render.ts. Remove only that declaration's export keyword; preserve its implementation and generated output. This one-line boundary extension removes the dead export rather than adding an incidental test consumer or weakening knip.
Public type evidence: parsed DataProvenance.data_id assigns to DataId; a plain string cannot assign to DataProvenance["data_id"], checked in the existing compiler-owned fixture, not runtime expectTypeOf.
Required evidence: minimal branded/null record red before implementation; required/strict/legacy/nullable/path/size positive and negative cases; legacy UUID rejected; generated example parses; open-record bypass regression red then green; full default check and direct Node parse/rejection smoke.
Non-goals: generateProvenance, input inventory/hash computation, persistence/submission/configuration, semantic source classification/window calculation, other schema field migrations, dependencies and compatibility shims.
Review focus: strict nested fields and nullability, public brand, path-scalar reuse without sibling drift, removal rather than weakening of the open-record exception, valid generated examples and no false producer claims.

## Issue #432 implementation boundary

Change surface: new schemas/evidence-report.ts and dedicated tests, schemas/index.ts public exports, scripts/schema/registry.ts registration/examples, generated projections, Minimal_Schemas §7 and existing PiGateDecision projection, canonical Support_Schema_Contracts §6. Approved compiler fixture additions and replacement of the optional decision_history extension declaration are narrowly scoped (6470602398).
Report shape: strict required fields report_id (ReportId), task_id (TaskId), seven-status enum, nonempty summary, observations/limitations/pi_questions arrays of nonempty strings, nonempty linked_runs (RunId), nonempty unique stack_ids (StackId), data_ids (DataId), llm_response_models (nonempty strings), decision_history (PiGateDecision array), created_at and updated_at.
Follow the exact spec distinctions: text arrays and decision_history may be empty; uniqueness is required for stack_ids/data_ids/llm_response_models, not invented for linked_runs. Preserve caller order; reject duplicates rather than silently normalizing them. No trim/coercion/defaults. Report created_at/updated_at follow existing TaskCard nonempty-string metadata convention; decided_at alone has the explicit ISO 8601 UTC contract and reuses z.iso.datetime().
Decision shape: strict required decision_id (DecisionId), report_id (ReportId), approval_ref (nonempty exec.callId string), outcome accepted/rejected/revision_requested, comment, decided_at. accepted requires comment exactly null; the other outcomes require nonempty string and errors locate comment. No prior rejected-card field, approval-id parser, log subscriber or actor/gate/idempotency compatibility fields.
Schema validation is not authority: schema does not execute approvals, derive lineage from RunRecords, enforce report status transitions, compare timestamps or require decision_history entries to match a state machine. Those belong to later records/tools slices. Do not claim a parsed callId proves approval.
Reuse core branded schemas and established Zod primitives. Export the two schemas/types through the existing schemas barrel. Register both as strict input with legitimate fixed examples that pass the unchanged real-schema round-trip; no generator relaxation or ignored-object exception.
Generator integration: registry discovery and validation require ZodObject roots. Keep both schemas strict objects with existing refinement conventions; do not replace the generator, introduce union-root exceptions, or weaken its closure/coverage checks.
Must preserve: all existing schemas and compiler assertions; TaskCard stripping and strict-object generator recursion; DataProvenance/StackLock projections; existing JOB/RUN behavior. Public field tests cover report/task/run/stack/data identities and decision/report identities, not only the standalone id schemas.
Documentation: update Support_Schema_Contracts §6 first, then existing Minimal_Schemas PiGateDecision projection in place; retain its projection notice, remove A01-2 mapping. Replace only the duplicate optional decision_history extension with a reference to required §7; future ReportExport stays unchanged.
Required evidence: multi-run/multi-lock positive; every status; empty/duplicate/null/wrong-brand reference failures; empty text-element rejection and empty narrative arrays accepted; required/unknown-field cases at report and nested decision boundaries; all outcome/comment combinations including missing/undefined; legacy fields and UTC timestamp failures; field brand compiler checks; generated examples parse with no drift; direct built API smoke and full check.
Non-goals: wording constants, report renderer/validator/state transitions, filesystem IO/capture, approval and report tools, timestamp chronology, history cross-record consistency, new dependencies.

## Issue #433 implementation boundary

Change surface: governance/wording.ts and its tests, existing core root barrel, constraints.yaml wording row, instructions/agents/shared.md Enforcement Index wording row and rendered outputs, CONTEXT.md invariant companion. No other instruction rewrites.
Canonical literals: ten phrases from Report_Generation_Spec §5/§5.1 and evidence-reports「Forbidden report phrases」, four GOVERNANCE_INVARIANTS verbatim, and REPORT_SECRET_PATTERN exactly /\bsk-[A-Za-z0-9_-]{8,}/ (no stateful flags). Constants have no profile/config override.
Public scanner: scanForbiddenPhrases(fields) accepts only the model-authored shape {summary: string, observations: readonly string[], limitations: readonly string[], pi_questions: readonly string[]}; return {field, phrase} hits with field one of those four names. Fixed field order summary/observations/limitations/pi_questions, phrase order canonical list; one hit per field/phrase regardless of repeated occurrences. Do not join array elements: a phrase split across entries is not a substring of either entry.
Use plain literal substring checks, report overlapping short/long phrases separately, preserve caller data and do not echo full source text. No trimming, case normalization, paraphrase detection, regex-generated phrase matching or configurable lists. Inputs are typed report text, not a new untrusted JSON parser.
The invariant exclusion is ownership, not a text whitelist: template-added governance sentences are not scanner inputs. Do not silently exempt a model-authored sentence merely because it equals an invariant that contains a forbidden substring. The explicit spec no-hit example 校准结果不等于结构验证 contains no forbidden phrase.
Must preserve: all existing governance rule ids/decisions and schemas; source/generated instruction synchronization; quality thresholds and default check. No new approval authority, report status transition, secret logging or profile setting. Scanner hits are phrase+field, not raw payload.
Control plane: remove only scientific-wording review_only row, add verification row using pnpm run test, change only the canonical Enforcement Index wording row to block while stating enumerated-lint/PI-semantic boundary, render instructions normally. Add CONTEXT invariant pointing to wording.test.ts. These edits register constants/scanner tests, not a claim that report_validate already exists.
Required evidence: ten literal phrase cases; overlapping pair; each of four fields with array-later-entry; repeated phrase dedup and cross-entry split control; recommended wording/no-hit and empty inputs; fixed governance constants not used as scan phrases; model-authored forbidden substring still rejected; exact regex length/word-boundary/character/case and repeated-call positives/negatives. Public built-package smoke exercises multi-field/overlap plus secret-shape check without printing candidate contents.
Non-goals: report rendering/validator/tools/preset drift tests, semantic compliance, configurable vocabulary, new JSON validation, runtime approvals, new dependencies. Existing schema/fingerprint/job surfaces remain untouched.

## Issue #434 implementation boundary

Mode: behavior-preserving Equivalence. Reference revision 4685297a06f135e94de6cd12d469e3991ebd8bc1; policy source blob 5dd4e9f612e8a67511f2cc3ebfd7e6b0c88180d7, test blob 17b43a8be811e1a8cb84d321bfe6d72b3c8ff098. The reference is accepted for this slice; no semantic correction is authorized.
What exists: one 1448-line evaluator/spawn source and its large decision-table test, role-tool-map's type import, root public exports, two size/type baseline exemptions and the duplicate-export alias baseline. There is no live policy plugin consumer yet.
Change surface: split production into governance/policy-gate/{types,parameter-schema,evaluate,spawn-rules}.ts and split existing tests by their existing rule-family blocks; update root barrel and role-tool-map's type import only as needed. Remove replaced source/test files; no compatibility shim or duplicate implementation.
Preserve the public runtime export inventory and every existing public type name/signature. Internal helpers exported between split modules must not leak through the root barrel; use explicit root exports if needed. Keep one error class identity, alias identity, shared schema identity and default rule-array ordering.
Governing invariant: every reference input retains the same allow/deny result, rule id, guard class, remediation, normalization, exception name/message and hostile getter/proxy non-execution behavior after the move.
Must preserve: first-deny ordering; upfront context metadata validation; reserved-id downgrade/prefix protection; snake/camel alias rules; data-descriptor snapshots; spawn profile limits/sanitized diagnostics; absent versus invalid trusted counts; model-controlled counts ignored; frozen default context. All existing decision-table expectations remain unchanged.
Only non-move code changes are the four recorded type-aware findings: two no-unsafe-assignment and two no-unsafe-return. Narrow unknown values or annotate returns without reading extra properties, invoking accessors, coercing values or changing any decision/expected value. Record exact fixes for review.
Configuration: remove FROZEN_OVERSIZED_FILES and both unsafe-rule overrides, remove both large-file exclusions and their obsolete rationale, remove the corresponding max_file_lines/eslint_type_safety baseline entries. Keep MAX_FILE_LINES=1000 and all other gates unchanged. Retain the duplicate-export alias and knip warn policy; update only its baseline path to its new owner.
Documentation: PI-approved shared.md file-size Enforcement row and Port_List policy row must describe the removed exemptions; normal instructions:render owns AGENTS/CLAUDE. Do not rewrite naming examples, unrelated rows or historical source references.
Sibling surfaces: role-tool-map type cycle, root exports, schema generator imports, downstream core consumers and package build, same hostile-input and authority tests, enforcement scripts. LSP references are unavailable (no server); scoped import/reference searches identified the root barrel and role-tool-map type import.
Plan: (1) freeze reference evidence and fixture; (2) one implementer moves the complete rule families and tests, fixes only type boundaries and updates approved controls; (3) parent compares unchanged assertions/test inventory, runs built API parity and strengthened gates; (4) three-seat white-box review, CI, merge. No stacked #435 implementation.
Required evidence: reference evaluator+role-tool tests 71 passed; parent public API oracle records 97 runtime exports and 18 observations, rejects a first-deny→allow mutant, then restoration passes. Reference JSON sha256 d59202d4fc2de3d1d96908f1b8574ec7f547c097f4af138b990f6d5378e4b021; probe sha256 ccddaf7bf691ee3a160144e2f7ff107a9d46c1f192d14cd4be230fa0f342e7df. Candidate runs the same probe without rewriting oracle bytes; tests retain expected assertions and no cases disappear.
Acceptance: every source/test ≤1000 lines, no size/type exemptions, git diff -M reviewed for move structure, compiler/lint/default check and 169-case guardrail suite pass, commit hook accepts touched split files, direct built API results match reference exactly. Tests and CI are parent-owned; worker may not alter oracle/threshold/discovery scripts.
Non-goals: remove spawn rules/alias, add role-tool-surface, change role tool maps semantically, change schemas or parameters, new dependency/API behavior, test expectation rewrites, new gate exemptions. Rollback is whole-PR revert to the accepted reference, never a runtime fallback or retained old production copy.

## Issue #435 implementation boundary

Change surface: delete policy-gate/spawn-rules.ts, its profile/limit tests and orphaned test helper; remove corresponding root exports, spawn-only PolicyGateInputNormalization type and PolicyGateToolCall spawnDepth/activeSubagentCount fields; remove the obsolete default spawn context rather than retain an empty placeholder. Update evaluator reserved ids/imports and remove its spawn-specific downgrade test, retaining all non-spawn expectations.
Intermediate slice: RESERVED_AUTHORITY_POLICY_RULE_IDS is exactly raw-data-write plus tool-parameter-schema-validation. role-tool-surface and a new substantive DEFAULT_SHUD_POLICY_GATE_CONTEXT belong to #436; do not predeclare its id or introduce an empty alias merely to preserve the old name. No current runtime consumer requires the old spawn context.
Delete isReservedAuthorityPolicyEvidenceId only; retain isReservedAuthorityPolicyErrorId and its exact semantics. Remove the final knip_duplicates baseline, make knip rules.duplicates error, and introduce no duplicate suppression or widened ignore.
Governing invariant: removing obsolete duplicate host policies cannot weaken the remaining evaluator's first-deny, metadata, authority-downgrade/prefix, remediation, descriptor-snapshot or error behavior. Existing raw-data-write and tool-parameter-schema-validation protection stays unchanged.
PI-approved jobs integration is exactly two declarations: registry.ts retains the named ShudJobRegistry class export but drops its duplicate default declaration; public index.ts re-exports that same binding as both default and ShudJobRegistry. Named direct-module consumers and package public API keep identity and behavior; no registry, jobs, config, lifecycle or index implementation changes.
Documentation: update only the shared.md knip Enforcement row and Port_List policy row, followed by normal instruction rendering. State duplicates=error and removed spawn/default/alias, with role rule still deferred. Historical source descriptions and OpenSpec removal requirements may name deleted symbols; the no-reference audit targets active implementations/imports/exports/current gate configuration. The two retained spawn-profile-subset-extra false-result assertions are non-spawn identity-helper negative controls, not live rule references, and must remain unchanged.
Verification plan: preserve exactly 26 evaluator test titles and 65 expect assertions against the parent-owned .workplans/issue-435/retained-assertions-reference.json, deleting only the test titled guard_class lint rejects spawn profile authority downgrades. Keep the tool-parameter-schema-validation downgrade rejection unchanged. Run retained tests plus full check; exercise direct built authority/first-deny/error paths and prove removed runtime exports absent. Verify default===named ShudJobRegistry and actual pinned-host profile smoke after build; this proves plugin import/mount, not a solver run.
Duplicate-gate qualification: use a disposable verification snapshot with the delivered package scripts and knip configuration; plain tree must pass pnpm run deadcode, a temporary duplicate export must fail specifically with a Duplicate exports diagnostic, and restoration must pass. Do not seed faults into user production files, weaken the rule or count an unrelated unused-file failure as the negative control.
Must preserve: all other core exports/schemas/wording, role-tool-map semantics, 1000-line and all quality thresholds, jobs class identity and actual host import, original retained test expectations. No new test of source text/grep wiring; removal and control-plane checks are parent verification artifacts.
Non-goals: role-tool-surface, inherited/local role-map migration, policy plugin, host configuration, retries, compatibility shims, jobs behavior, new dependencies. Rollback is the whole PR; no runtime fallback. Remaining raw/schema evaluator tests and package CI are required alongside the finite smoke.

## Context

动机见 proposal.md「Why」。约束均已在钉版 `dsh-v0.2.1-rc.2` 的 npm 包/文档核查（#420 证明 rc.4 对这些 seam 逐字节无变化）：

- `tools/pre-execute` 是 waterfall，决策 `allow|deny|cancel|ask`；`ask` 由宿主 `serviceAsk` 走 `ctx.approval`，无 approval 服务、无 agent 或结果非 `allowed-once` 一律 deny（`packages/core/tools/src/index.ts:1737-1773`）。插件不直接调 `ctx.approval`。参数不可改写。
- `approval/asked {id, toolName, callId?, reason?}` 与 `approval/decided {id, outcome}` 是 log-only 审计事件，`displayReason` 不落日志，**无 comment 字段**（`packages/interaction/user-approval/src/types.ts:44-60`）。
- 响应体 model 在 rc.2 不可得（`llm-deepseek` 丢弃 `message_start.message.model`）；M2 D10 定为记 configured 别名 + `response_model_source: configured`。
- agent preset = `@deepseek-ai/dsh-agent-preset` 行，`config.plugins` 在 preset 作用域装配。O3 实测：preset apply 时 shud 全局工具尚未注册；Agent 作用域的 `restrict` 会过滤继承的 `job_*`，不能沿用只含 shud 全局工具的 allow。`tool-subagent` 后续把 `subagent` 注册为 Agent 自有工具，不受继承过滤。采用 D11 的 inherited/local 两集合与全局生命周期插件；子代理注册表/provider 仍在宿主平面，maxDepth 默认 1。
- preset 当前身份通过公开 `agent.ctx` 的 `sessionProjections.stateOf(session, "agentPreset")` 读取；header 只记录创建 preset。O6 空白会话切换实测 header 不变，`tools/change` 早于投影提交；`agent-preset/selected` 会话事件后投影与实际组合一致。D10 的唯一读取函数改用投影，不以旧 header 回退。
- 现有 `packages/dsh-shud-raw-guard/src/index.ts` 是 pre-execute 挂载范式（apply → 规范化配置 → `ctx.on("tools/pre-execute")` → duck-type exec → 纯决策 → 返回 decision）。`policy-gate-core` 的 `evaluatePolicyGate(call, context)` 只产 `allow|deny`，输入 `{toolId, role, input, workDir?, spawnDepth?, activeSubagentCount?}`，零消费者。
- M2 事实：`shud_run` 在注册表同步提交，RunJob/RunRecord 落 `<cwd>/runs/<run_id>/`；唤醒投递到 `owner_session`；shud 作业无 owner 登记。`collectRepositoryRevision`/`computeStackFingerprint` 已在 core。`run-identifiers.ts` 生成 `JOB-/RUN-<UTC>-xxxx`。
- 代码现状：`stack-lock.ts` llm 为旧五字段；`task.ts` id 裸 string、`stack_id/data_id` optional；`data-provenance.ts` 为 `DATA-<UUID>`；无 EvidenceReport/PiGateDecision schema；无 `wording.ts`；profile 无 preset/subagent 行。

Stage 1 grill 结论（`.workplans/m3-mvp-1/grill-gate.json`，22 分支 + 4 开放项，含 Stage 3 的 PI 裁定）是本 design 的输入，逐条落在 Decisions 与 Open Questions。

首个子 issue 是限时 K13 spike（1.1），验证 O1/O2/O3/O5/O6，并以首任务的一个用户可见步骤收尾：Web 内 coordinator 建卡并派 worker 跑 ccw。为此 spike 依赖的最小可合入切片先行：3.1a（`TaskId` + TaskCard schema + `Minimal_Schemas.md` §1）与最小 `task_create`（6.1a，只建卡、不做链接回写——回写属 6.1b）；spike 中 worker 调用不带 `task_id` 的 `shud_run`（回写尚未交付）。

## Goals / Non-Goals

**Goals:**
- 在 `dsh --profile shud` 的 Web 里：coordinator 建 TaskCard → 派 worker 用 `shud_run` 跑 ccw → worker 等待并成功收集后返回 → coordinator 生成 EvidenceReport（Markdown，含 StackLock 三字段与响应 model、水印）→ `report_submit` 弹出 PI 审批卡 → accepted 落盘、TaskCard done。
- 四个对象零 LLM 参与自动采集/校验；报告措辞由测试常量守住；终态只由审批结果写入。
- 所有新行为在钉版 rc.2 seam 上，无 dsh 升级、无第三方新依赖。

**Non-Goals:**
- ChangeRequest / VerificationCase / `semantic_level` 触发的 ask（M4）；AnalysisPlan 与 calibration 复核项（M5）。
- metrics / 水量平衡 / rSHUD 指标生产者与 `numerical_health` 计算（#422，M5）；报告"指标与图表"节在 M3 只引用 RunRecord 事实并把缺失写进 limitations。
- Reviewer preset 与 (L) 三项语义判断（M4）；repo_explorer / coder preset。
- `reports/` 文件的 bash 写保护（单用户工作台边界，与 M2 对 `runs/` 的处理一致）。
- `timed_out`、`max_wall_minutes`、`cost_budget` 超时终止（GAP-02）；TaskCard `parked`/`blocked` 的自动产生者（状态保留在枚举，M3 无转换进入）。
- RunJob/RunRecord 的 `task_id/stack_id/data_id` 由提交时解析写入；schema 保持 nullable（M2 记录仍可读），必填由 closure 谓词裁决。
- `ctx.storage` 持久化、stateDir 索引、`completed.json` 清理策略。
- PI comment 的行级批注；多用户。

## Decisions

### D1 三个新包与职责边界

- `@shud-harness/dsh-shud-records`（运行时无 Cordis 依赖的文件层）：四对象的工作区文件读写、原子写入、品牌 id 分配、StackLock/DataProvenance 确定性采集、EvidenceReport 模板填充/水印/validator/状态机、TaskCard 状态机与 closure 谓词的持久化绑定。只依赖 `dsh-shud-core` 与 Node 内置模块。
- `@shud-harness/dsh-shud-policy-gate`（Cordis 插件）：第二个 `tools/pre-execute` 监听。
- `@shud-harness/dsh-shud-presets`（Cordis 插件 + bundle patch 片段）：两个 preset 行与全局 `shud-role-restrict` 生命周期插件。
- 模型工具（`task_create`、`report_generate`、`report_validate`、`report_submit`、`report_decide`）放在现有 `dsh-shud-tools`，复用其 strict-tool 适配；`dsh-shud-jobs` 在提交时经 records 解析/采集 lock 与 provenance。依赖方向：core ← records ← jobs ← tools；policy-gate、presets 只依赖 core（+ records 读报告状态）。

备选：把对象持久化并入 jobs（jobs 已 >10K 行且是 Critical Path #4，混入报告逻辑扩大白盒审查面）；并入 tools（tools 是工具契约层，records 要被 jobs 消费会倒置依赖）。均否决。

### D2 工作区文件落点与原子写

```
<session cwd>/
  tasks/<task_id>/task.json
  stacks/<stack_id>.json
  provenance/<data_id>.json
  reports/<report_id>.json          # EvidenceReport 对象（含 decision_history）
  reports/<report_id>.md            # 由 .json 确定性渲染；每次状态变化重渲染
  runs/<run_id>/…                   # M2 不变
```

原子写 = 同目录临时文件 + `rename`，复用 `dsh-shud-jobs/src/state-files.ts` 的实现：该实现**移入 records** 并由 jobs 改为 import（Canonicality，原地重构）。唯一例外是 StackLock 文件：以 `wx`（排他创建）写入，`EEXIST` 时重新生成 `stack_id`，至多 3 次，仍冲突则报错（lock 只新建、从不改写，排他创建即是其原子性）。读取经 core schema 校验，损坏文件 fail-closed 报错、不改写。不建索引：查找按 id 直接定位文件；"当前 lock" 由 D5 定义，不需要"最新"查询。

路径安全（规范要求落在 `specs/task-cards` 的 "TaskCard workspace file"，其余对象 spec 以一句引用）：

- id 在任何路径拼接之前先经品牌 schema 校验；工具与 policy-gate 插件从不由原始字符串构造路径，只由品牌 id 构造。
- `<cwd>/tasks`、`stacks`、`provenance`、`reports` 不存在时 `mkdir -p` 创建；已存在时先 `lstat`，凡不是真实目录（符号链接、普通文件等）一律 fail-closed。
- 目标文件在读写前 `lstat`，符号链接与特殊文件 fail-closed；写入为同目录临时文件 + `rename`（StackLock 按上文 `wx`）。

备选 `ctx.storage`（PI 不可直接读，且 M2 D2 已否决）；stateDir 索引（M3 无并发/跨工作区查找需求，YAGNI）。

### D3 品牌 id 与 schema 对齐（Critical Path #7）

- `run-identifiers.ts` 的生成器泛化为 `createBrandedId(prefix)`，格式 `<PREFIX>-YYYYMMDDTHHMMSS-xxxx`（UTC 秒，4 位小写 hex），新增 `TaskId`、`StackId`、`DataId`、`ReportId`、`DecisionId`（`DEC-`）品牌类型；schema 拒绝旧格式（`TASK-0001`、`DATA-<UUID>`）。同一 TaskCard 创建的对象不共享随机段（与 JOB/RUN 配对规则不同，那是同一作业的两个视角）。冲突（同秒同随机段已有文件）重新生成。
- `TaskCardSchema`：`task_id: TaskId`；`stack_id`/`data_id` 为 `StackId | null` / `DataId | null`（M3 由 `shud_run` 回填，建卡时 null）；`linked_jobs: JobRecordId[]`、`linked_reports: ReportId[]`；`reviewer` 保留；`theory_bundle_ids` 保留 optional。`type` 枚举不变。
- `StackLockSchema`：`llm` 收窄为 `{ base_url, request_alias, response_model }` 三个非空字符串；`repos.<name>` 增加 `dirty_paths: string[]`（排序后的 POSIX 相对路径，来自 `git status --porcelain` 第二列，`dirty === dirty_paths.length > 0`，但溢出判 dirty 时 `dirty_paths` 可能不完整——记录 `dirty_paths_truncated: boolean`）；`runtime` 改为 `{ os: string, sundials_version: string | null, host_version: string }`（`host_version` 为钉版 dsh 版本，来自 `shud-jobs` 行配置 `hostVersion`），删除 `r_version/r_packages_lock/python_version/gcc_version/gdal_version`（nullable 也不保留：无采集者的字段是假数据）；`harness` 改为 `{ version: string }`（本仓库 `package.json` version），删除 `cli_version/prompt_pack/skills_version`。`computeStackFingerprint` 排除集加入 `llm.response_model`（K4）。
- `DataProvenanceSchema`：`data_id: DataId`；`sources` 改为 `{ input_root: string, files: [{ path, sha256, size_bytes }] }`（排序 POSIX 相对路径，覆盖输入目录副本全部普通文件）；`basin: string`（= project）；`event_window: { start: string | null, end: string | null }`（M3 为 null，见 Not yet specified）；`preprocess`、`uncertainty_notes` 为 `null`。原 `terrain/mesh/forcing/observations` 分类删除（无采集者）。
- 新增 `EvidenceReportSchema`：`report_id`、`task_id`、`status`（7 态）、`summary`、`observations[]`、`limitations[]`、`pi_questions[]`（非空字符串数组）、`linked_runs: RunId[]`（非空）、`stack_ids: StackId[]`、`data_ids: DataId[]`（非空、去重，生成时从每个 linked RunRecord 解析；多运行可含多个 lock）、`llm_response_models: string[]`（来自 linked RunRecord，去重非空）、`decision_history: PiGateDecision[]`、`created_at`、`updated_at`。
- 新增严格 PiGateDecisionSchema，字段恰为 decision_id（DecisionId）、report_id、approval_ref（本次工具调用的 callId，非空；经日志 approval/asked.callId 关联审批 id）、outcome（accepted/rejected/revision_requested）、comment（accepted 仅 null，其余非空）、decided_at。O5 实测工具上下文没有 approval id；不新增日志订阅取 id 的第二路径，不记录先前被拒 submit 卡引用。
- `Minimal_Schemas.md` 对应段按本 D3 逐项写处置，其中既有 `PiGateDecision` 段（原字段 `decision_id, gate_id, task_id, actor_user_id, actor_role, decision, comment?, comment_required, next_action?, evidence_refs, created_at` 与 A01-2 映射）被**改写**为本条 M3 schema，不另增一段：只保留 `decision_id`，`decision`→`outcome`、`created_at`→`decided_at`、`comment?`→必填且仅 `accepted` 为 null，其余字段删除；权威源 `Support_Schema_Contracts.md` §6 同刀改写（连同 `idempotency_key`），投影声明不变；`pnpm run schema:generate` 刷新投影；`CONTEXT.md` 第 2 条"代码在 M3 前仍带旧字段"解除。

备选：保留 StackLock 全量 runtime/harness 字段设 nullable——否决（没有采集者的字段是假数据，违反"无 placeholder"；PI 于 2026-10-27 Stage 3 确认删除）。备选：PiGateDecision 记录被拒 `report_submit` 卡的引用并由 `report_decide` 参数传入——否决（PI 2026-10-27：审批 id 仅 log 可见，模型无来源）。

### D4 TaskCard 状态机与 closure 谓词

转换表（records 纯函数 `transitionTask(card, event)`，非法转换抛错，不改文件）：

| 事件（来源） | 前态 | 后态 | runtime_phase |
|---|---|---|---|
| `task_create` | — | `planned` | null |
| `shud_run(task_id)` 提交成功 | `planned`/`running` | `running` | `submitted_job` |
| reconcile 发现非终态的链接作业 | `planned` | `running` | `submitted_job` |
| `report_generate` 且 closure 谓词成立 | `running`/`planned`/`reporting` | `reporting` | null |
| `report_submit` 获 `allowed-once` 执行 | `reporting` | `done` | null |
| `report_decide(revision_requested)` 获 `allowed-once` 执行 | `reporting` | `planned` | null |
| `report_decide(rejected)` 获 `allowed-once` 执行 | `reporting` | `cancelled` | null |

非法转换示例：`planned` 且 `linked_jobs: []` 时 `report_generate` → closure 错误（无作业），文件不变；`done` 时 `report_decide` → 错误，文件不变。

报告重新生成：每次 `report_generate` 分配新 `report_id`，写新的 `reports/<report_id>.{json,md}` 并追加到 `linked_reports`；先前报告文件原样保留（字节与 mtime 不变）。`report_validate` 失败的 `draft` 报告保持 `draft`，coordinator 修正输入后再调 `report_generate`（新 id），或就此搁置；`report_validate`/`report_submit` 只作用于传入的 `report_id`，只有 `reviewed` 报告可提交。`revision_requested → planned` 之后：PI 要求重跑则 `shud_run(task_id)`（`planned → running`）；不要求重跑则直接从 `planned` 调 `report_generate`（既有已收集运行仍满足 closure 谓词）。新旧报告的延续关系见 Not yet specified。

`awaiting_pi`（TaskCard 与 EvidenceReport 的枚举值均保留）在 M3 是审批卡挂起期间的瞬时态：dsh 的 `ask` 在工具执行**之前**决定结果，放行即执行、拒绝即不执行，没有可落盘的中间时刻，因此 M3 不写入 `awaiting_pi`，TaskCard 停在 `reporting`、报告停在 `reviewed` 直到某张卡放行。

`created` 只在建卡原子写入前的内存态；`parked`/`blocked` 在 M3 无进入转换（Non-Goal）。`updated_at` 每次转换刷新；`linked_jobs` 在 `shud_run` 提交时追加，`linked_reports` 在 `report_generate` 时追加。

`shud_run(task_id)` 的回写顺序：(1) 读取 TaskCard → reconcile（见下）→ 校验（`planned|running`，品牌 id）→ (2) M2 提交（durable；RunJob 携带 `task_id`、`stack_id`、`data_id`）→ (3) TaskCard 读取—校验—转换—`writeJsonSync`，读与写之间不 await（沿 M2 RunJob 同步边界规则）。第 3 步失败返回工具错误，指明 `run_id` 与"运行已 durable、任务卡回写失败"；运行不回滚。

TaskCard reconcile（唯一一条卡↔作业对账规则，`specs/task-cards`，records 4.3 拥有）：`reconcileTaskCard(card, runJobsForTask)` 令 `linked_jobs := union(card.linked_jobs, task_id === card.task_id 的 RunJob)` 并按码点升序排序；以其中最新 RunJob（`submitted_at` 最大，相同时取 `job_id` 码点序最大者）填补为 null 的 `stack_id`/`data_id`，从不覆写已非 null 的值；卡为 `planned` 且任一链接作业未终态时按转换表置 `status: running`（`runtime_phase: submitted_job`）；没有任何变化时不写文件。它在 `shud_run(task_id)` 与 `report_generate` 开头调用。注册表查询 `listRunJobsByTask(task_id)`（活动 + 完成索引，按 `job_id` 码点升序）由独立切片 5.2 拥有（只读 API，不依赖 5.1 的提交事务）：任一已索引条目的路径/身份校验失败、`run-job.json` 不可读或未通过 schema 时以指出该 `run_id` 的错误 fail-closed 拒绝，不跳过该条目；与 `collectShud` 相同，就绪之前与关闭准入之后拒绝。并发：单进程、同步边界，不会交错。

closure 谓词（`science_assist`）在 `report_generate` 内、reconcile 之后求值，全部成立才通过：`linked_jobs` 非空；所有 `linked_jobs` 的 RunJob 处于 `collected`（有 RunRecord）；每个 RunRecord 的 `stack_id`/`data_id` 非 null；待写入的报告 `observations/limitations/pi_questions` 各 ≥1；每个 metric_fact 有 evidence_refs——M3 报告没有 metric_fact（Non-Goal），该子句恒真并在报告 limitations 自动追加一条"无指标 artifact"。链接的 RunJob 处于 `failed`/`cancelled`（已收集者即 RunRecord `status: failed`，含取消/丢失的 `exit_class`），或收集已耗尽（存在 `collect-error.json` 且 `attempts ≥ MAX_COLLECT_ATTEMPTS`）时，closure 不成立，错误子句点名该作业；卡保持 `running`——M3 没有 TaskCard 取消工具，PI 可对仍在运行的作业 `job_kill` 或保留该卡。谓词不满足时工具返回错误、不写报告、不改状态。LLM closure 分类器不实现（advisory，M3 无消费者）。`engineering`/`ops` 的建卡在 M3 被 `task_create` 拒绝（schema 枚举保留，工具参数 `type` 必填且只接受 `science_assist`），避免产生永不可关闭的卡。`task_create` 其余字段确定性填充：`created_by` 与 `current_owner` = 调用 agent 的 preset id（`coordinator`，读取路径见 D10，可读性由 O6 核实），`reviewer` = 常量 `pi`，`inference_budget` = `{ mode: "normal" }`，`linked_jobs/linked_reports` 空数组，`stack_id/data_id` null（由 `shud_run` 回填）。closure 谓词在 `linked_jobs` 为空时不成立；"limitations ≥1" 按模型传入的条目计数，自动追加的"无指标 artifact"一条不计入。

### D5 StackLock 采集与"当前 lock"

`shud_run` 提交时（输入复制完成、RunJob 写入前）由注册表调用 records 的 `captureStackLock(config, llm)`：

- 采集配置全部挂在既有 `shud-jobs` 行（records 包不是 Cordis 插件，没有自己的行）：`Config` 并集扩展为 `LocalJobRegistry.Config ∪ {stateDir, shudBin, stackRepos.{SHUD,rSHUD,AutoSHUD}, sundialsRoot?, hostVersion, llm.base_url, llm.request_alias}`，缺失即 apply 失败（fail-loud）。`profile:install` 与写 `shudBin` 同一机制写入这些键：`stackRepos` 从本仓库根派生绝对路径（三目录须存在），`hostVersion` 取 bundle 钉版 `@deepseek-ai/dsh` 版本，`llm.*` 取 bundle patch `llm-deepseek` 行的 `baseURL` 与 `agent-default-model` 的 `model`；`sundialsRoot` 取环境变量 `SUNDIALS_ROOT`（设置时须为存在目录），未设置则不写该键（采集为 null）。安装器整体拥有该 patch 项，重装以当次环境为准。
- `repos`：对 `stackRepos.*` 调用 `collectRepositoryRevision` 并扩展返回 `dirty_paths`：既有 `git status --porcelain` 调用改为 `--porcelain -z`（NUL 分隔、无引号转义，`core.quotePath` 不影响），每条记录取路径字段，重命名/复制条目（`R`/`C`）只记新路径，去重后按码点升序排序；溢出判 dirty 时 `dirty_paths_truncated: true`。不新增 git 调用。
- `runtime.os` = `os.type() + " " + os.release()`；`runtime.sundials_version` = 读 `sundialsRoot`（可选）下 `include/sundials/sundials_config.h` 的 `SUNDIALS_VERSION`，无配置或文件缺失为 `null`；`runtime.host_version` = `hostVersion`。
- `harness.version` = 本仓库根 `package.json` version（构建期常量）。
- `llm.base_url`、`llm.request_alias` = `shud-jobs` 行的 `llm.*`（`profile:smoke` 断言与 `llm-deepseek` 行及 `agent-default-model` 一致）；`llm.response_model` = 本次 `shud_run` 的 configured 别名（与 RunJob 同源，`response_model_source` 不进 StackLock——它在 RunRecord）。
- 指纹按 D3 排除集计算。**当前 lock** = `stacks/` 下指纹相等的已有文件（多份时取 `stack_id` 码点序最小者，不改写）；没有则以 `wx` 写新文件（D2，`EEXIST` 重新生成 id，至多 3 次）。因此同一环境反复提交不产生新 lock，环境一变自然换 lock，无需"最新"概念。两个提交并发首次写出指纹相同的两份 lock 是允许的重复（两份都有效，后续复用取最小者）；提交回滚不删除任何 lock 文件（新写的 lock 可能已被并发提交复用，且它只是环境记录），只删除本次 provenance。
- 采集失败（任一 repo 不是仓库、配置缺失）→ `shud_run` 返回工具错误、不提交。

备选：独立 `stack_lock` 工具先调再跑（多一次模型调用，错漏面大）；报告时补采（与运行时状态脱节）。均否决（grill Q17）。

### D6 DataProvenance 生成

同样在提交时由注册表生成：对运行目录内 `input/<project>/` 副本（M2 已完整复制且已拒绝链接/特殊文件）遍历普通文件，计算 sha256 与大小，排序写 `provenance/<data_id>.json`；`basin = project`，`event_window` 两端 `null`，`input_root` 为原始 `input_dir` 绝对路径。每次提交一份新 provenance（输入副本是本次运行的事实；去重按内容指纹不在 M3 范围）；provenance 先于 `run-job.json` 原子写入，提交回滚时删除（lock 不删，见 D5）。RunJob 的 `data_id`、`stack_id`、`task_id`（来自工具参数，可缺省为 null）在同一次原子写入 `run-job.json` 时落盘；RunRecord 继承。raw 下的输入仍由 raw-guard 弹读审批卡（M2 D8 不变）。

### D7 EvidenceReport 生成、模板与水印

`report_generate(task_id, summary, observations[], limitations[], pi_questions[])`：

1. 读 TaskCard，执行 D4 reconcile 后求 closure 谓词；读每个 linked job 的 RunRecord（经 `collectShud` 同一后端 API，已 collected 则原样返回）。
2. 引用存在性校验：参数文本中每个品牌 id 令牌（`TASK-/STACK-/DATA-/RUN-/JOB-/REPORT-`）必须解析到工作区已有文件或索引条目，否则工具错误（`llm_output_error`，不写 draft，不重试——重试由 coordinator 决定，上限由 preset 指令说明）。
3. 事实表由对象确定性生成：StackLock 三仓库 commit/branch/dirty（dirty 时列 `dirty_paths`）、llm 三字段、每个 RunRecord 的 `exit_code/exit_class/status/wall_seconds/response_model(+source)`、产物清单条数与总字节、stdout/stderr 路径（只记路径）。
4. 渲染 10 节模板（`packages/dsh-shud-records/templates/evidence_report.md`，构建产物随包；`Repository_Layout` 的根 `templates/` 规划改指向此处）：§5"指标与图表"固定写"本里程碑无指标 artifact，见 limitations"；§7 列出 `status != succeeded` 的运行（closure 已排除失败/取消运行，M3 中该节渲染为空列表，渲染器与 validator 仍覆盖）；§10 附 argv、日志路径、产物清单；limitations/治理节逐字渲染 `GOVERNANCE_INVARIANTS` 四句（D8）。
5. closure 谓词通过后才写 `reports/<id>.json`（`status: draft`）；随后 TaskCard → `reporting`、`linked_reports` 追加；最后渲染 `.md`。多运行时事实表逐 run 列出各自的 `stack_id`/`data_id`/`response_model`，不定义比较规则（Not yet specified）。

报告工具的提交点（`report_generate`/`report_validate`/`report_submit`/`report_decide` 共用）：报告 `.json`（提交点：`status`/`decision_history`）→ TaskCard 转换（同步边界）→ `.md` 渲染。提交点之后的失败返回工具错误，指明失败步骤与 `report_id`，不回滚任何已写内容。修复只有两种，且只在下一次针对该 `report_id` 的报告工具调用（四者任一）开头进行：(a) 卡尚未取得报告状态所蕴含的转换则先补做该转换——"尚未取得"定义为该 `report_id` 不在 `linked_reports` 中，或它是 `linked_reports` 的最后一项且卡状态与报告状态不符；较早的报告从不改变卡；(b) `.md` 过期定义为标题下的水印行与报告状态不符（`draft` 与 `reviewed` 共用同一水印），此时重渲染。这是报告工具仅有的对账行为；卡↔作业对账属 D4 reconcile。

`.md` 的渲染输入 = 报告 `.json` + 其引用的 StackLock、DataProvenance、RunRecord 文件；每次重渲染重新读取它们；任一引用文件缺失 → 渲染错误，报告 `.json` 不变。

报告状态在 M3 的实际落盘序列：`draft` →（`report_validate`）`reviewed` →（`report_submit` 放行）`accepted`，或（`report_decide` 放行）`rejected`/`revision_requested`；`awaiting_pi` 不落盘（见 D4）。水印 `accepted` 首部行为 `Accepted by PI · <decided_at> · <decision_id>`（`Report_Generation_Spec` 的 `decision_at` 在 2.1 对齐为 `decided_at`）。

水印按 7 态表（`Report_Generation_Spec` §7.1）渲染为标题下第一行与文末最后一行；`accepted` 为首部 `Accepted by PI · <decided_at> · <decision_id>`；`archived` 继承归档前终态另加 `ARCHIVED`（M3 无归档转换，但渲染器与测试覆盖 7 态）。`.md` 不内联日志/产物内容、不含密钥（事实表只取 RunRecord 已脱敏字段）。

备选：插件内再调 LLM 写叙事——无 seam，且与"coordinator 即叙事作者"重复。否决。

### D8 语言护栏与确定性 validator

- `core/governance/wording.ts`：导出 `FORBIDDEN_REPORT_PHRASES`（§5 五条 + §5.1 五条，中文原文，共 10 条）、`GOVERNANCE_INVARIANTS`（四句固定文案常量：①单流域/单事件指标提升不等于模型改进；②校准结果不等于结构验证；③不得宣称模型机制已验证；④不得宣称普遍改进）与密钥形态正则常量 `REPORT_SECRET_PATTERN = /\bsk-[A-Za-z0-9_-]{8,}/`，测试钉正反例；报告模板在 limitations/治理节逐字渲染四句不变式；`constraints.yaml` review_only 的"措辞规则"条目转为 matrix（`pnpm run test`）。无 profile 覆写（放宽需 ADR）。
- `report_validate(report_id)`：draft → reviewed 的唯一入口，逐项执行 13 项 (D)：(1) `stack_ids` 各解析到 StackLock 文件且 `stack_id` 一致；(2) `data_ids` 各解析到 DataProvenance 文件；(3) 每个 `linked_runs` 有 RunRecord；(4) 指标来自确定性 artifact；(5) limitations 非空；(6) pi_questions 非空；(7) 禁止用语扫描模型撰写的 `summary/observations/limitations/pi_questions`（子串匹配，命中列出短语与字段）；(8) 失败运行已在 §7 列出；(9) 每个 dirty 仓库在 `.md` 有标注行；(10) 关键指标有 source_ref；(11) 图表观察有 artifact ref；(12) `GOVERNANCE_INVARIANTS` 四句在渲染后的 `.md` 中逐字出现（缺任一句即失败）；(13) 渲染后的整份 `.md` 不匹配 `REPORT_SECRET_PATTERN`（失败时只指出所在节、不回显匹配内容）。(4)、(10)、(11) 在 M3 以"无指标、无图表"恒真并在结果中标注；不变式门禁的"无禁止用语"即第 (7) 项。不做 `tmp` 路径检查（工作区与运行目录可以位于 `$TMPDIR` 下，报告中的这类路径引用是合法事实）。任一失败：状态不变、返回逐项结果。通过：`status: reviewed`，按 D7 提交点顺序写 `.json` 后重渲染 `.md`。
- guard 的边界按 §5.2：只是枚举短语 lint，报告与文档不得把它说成合规充分条件；preset 指令里对 coordinator 写明。门禁措辞"措辞过四条不变式"的机器判据 = 第 (12) 项（四句逐字出现）与第 (7) 项（模型撰写节无禁止用语）；语义层面的合规不做机器检查，仍由 PI 审阅。

### D9 审批接线：`report_submit`、`report_decide` 与 PiGateDecision（Critical Path #3）

- report_submit(report_id) 前态 reviewed。policy-gate 在角色 deny 之后无条件 ask；reason 为固定前缀+report_id（落日志），displayReason 给摘要/路径（不落日志）。allowed-once 后工具先写 accepted 与 decision_history（approval_ref = 本次 exec.callId，comment null），再 TaskCard done、重渲染；其它 outcome 不执行、不改文件。O5 已通过真实 Web 卡证明：审批 id 仅在 asked/decided 事件，执行上下文只提供 callId。
- 拒绝后按候选(a)：coordinator 向 PI 索要非空 comment 与明确 rejected/revision_requested；不默认处置。report_decide 的二次卡回显两者，allowed-once 才记录 outcome、comment 与本次 exec.callId 并推进状态。两卡由日志中 report_id/callId 与审批 id 关联，模型可见即记录；不伪称 callId 本身是审批 id。
- 被拒 submit 卡的审计关联只经 session log：`approval/asked{toolName: "report_submit"}`（其 `reason` 携带该 `report_id`）之后紧随 `approval/decided{outcome ≠ allowed-once}`；同一 `report_id` 的 `report_decide` 卡 `reason` 也携带 `report_id`，两者由此在日志中关联。PiGateDecision 不记录被拒卡的引用。
- `accepted` 之后的 `report_decide` 拒绝（终态不可覆盖）；`archived` 无 M3 入口。
- 因此终态只在 `allowed-once` 分支写入；agent 无任何不经审批卡写终态的路径（grill Q12）。单用户工作台下 PI 自己用 bash 改文件不在保护范围（Non-Goal）。

备选 (b) 等 form seam（#420 否定）、(c) PI 专用工具无入口（K7）。

### D10 policy-gate 插件与 policy-gate-core 的去留（Critical Path #1）

- 插件挂全局行 `shud-policy-gate`（与 raw-guard 并列，不进 preset）。监听逻辑按固定顺序：先构造 `PolicyGateToolCall{ toolId, role, input, workDir }`（`spawnDepth`/`activeSubagentCount` 随 spawn 规则删除）调 `evaluatePolicyGate`，`deny` → `{kind: "deny", reason}`；求值器抛错 → fail-closed `deny`（受控 reason，不转发原始异常）；未被 deny 且工具为 `report_submit`/`report_decide` → `ask`（D9）；其余 → `next()`。角色 deny 先于报告工具 ask，因此 worker 调 `report_submit` 被直接拒绝，而不是弹卡问 PI。
- `role` = map(`readCallerPresetId(exec.agent)`) → coordinator/worker/unknown。唯一读取函数经公开 sessionProjections 服务读当前 agentPreset 投影；缺 Agent/会话/服务/有效值为 unknown。#425 的 header-only reader 在 #444 原地迁移，task_create 与 policy/restrict 共用，不另造读取路径；头部创建事实不能覆盖已切换身份。
- `DEFAULT_SHUD_POLICY_GATE_CONTEXT` 的三条 spawn 规则移除后，只加入 authority 规则 `role-tool-surface`：已知角色调用不在 `inherited ∪ local` 的工具即 deny（reason 仅角色/工具名），unknown 不适用。保留 id 恰为 raw-data-write、tool-parameter-schema-validation、role-tool-surface；前两者框架不新增实现。role-tool-map 是唯一两集合数据源：restrict 消费 inherited，执行门消费并集。模型可见性与执行授权分别验证。
- `policy-gate-core` 按规则族拆分为 `governance/policy-gate/{types,role-tool-surface,parameter-schema,evaluate}.ts`（每文件 ≤1000 行，测试同步拆）；删除 `spawn-depth-limit`/`spawn-concurrency-limit`/`spawn-profile-subset` 三条规则及其常量（dsh 原生 `maxDepth`、`maxActiveSubagents`、preset 子集语义取代——Canonicality），`RESERVED_AUTHORITY_POLICY_RULE_IDS` 中对应 id 一并移除并在 spec 写 Reason/Migration；删除 `isReservedAuthorityPolicyEvidenceId` 别名；`constraints.yaml` 的三条 baseline 与 `.large-file-guard.json` 排除项移除；knip `rules.duplicates` 转 error。
- 日志：每条 deny/ask 经 `ctx.logger("shud-policy-gate")` 一行（同 raw-guard 约定，#378 的可见性边界不变）。

### D11 preset 与角色工具面

- bundle patch 插入两行 `@deepseek-ai/dsh-agent-preset`：`preset-coordinator`（`order: 1`，`agent-preset-registry.default = coordinator`）与 `preset-worker`。两者的 `plugins` 子树逐行显式列出，不沿用 stock `standard` 骨架：
  - coordinator 子树：persona、agent-instructions（maxBytes: 65536）、time-context、tool-jobs、tool-subagent（provider spawn、toolName: subagent、agentPreset: worker、modelSelectionSettings: false）。指定 worker，不能默认继承 coordinator。
  - worker 子树：persona、agent-instructions（maxBytes: 65536）、time-context、tool-jobs。无委派行。
  - 两个子树均无 shud-role-restrict、tool-fs/fs-search、tool-bash、tool-skill/skill-filesystem、tool-subagent-control、tool-ask-user、tool-todo、tool-web、tool-schedule、plan-mode、compaction、present、tool-goal。PI 在 Web 文件面板读报告，不给模型 read/write/edit 工具。
  - subagent 注册表与 `subagent-spawn-in-process` provider 行保持 stock web bundle 的宿主平面全局行位置（`packages/bundle/web-app/cordis.patch.yml` 注释 "The subagent registry and its backends STAY in the host plane"），由 profile bundle patch 保持启用并只出现一次，`profile:smoke` 断言其存在；coordinator preset 只添加 `tool-subagent` 这一工具行。`maxDepth` 用 dsh 设置默认 1。
- role-tool-map 每个角色恰有 `{ inherited, local }` 两集合，按 Agent 的实际作用域而非插件行位置分类：
  - coordinator inherited = task_create、report_generate、report_validate、report_submit、report_decide、shud_collect、job_output、job_list、job_kill；local = subagent。
  - worker inherited = shud_run、shud_collect、job_output、job_list、job_kill；local 为空。
  - repo_explorer/coder/reviewer 既有 id 全部放 inherited，local 为空；注明 M4 契约，无 M3 preset 消费。
  - getRoleToolIds 返回两集合，isRoleToolIdAllowed 检查并集，ROLE_TOOL_IDS 为所有并集；移除 Zero 时代 coordinator/worker 名称。原 global/preset 分类被原地替换，不留别名。
  - shud-role-restrict 是无 role 配置的全局插件；agent/created 与 committed agent-preset/selected 后按当前投影经 agent.ctx 绑定 inherited allow。先成功安装新限制，再同步释放旧限制；unknown 释放本插件旧限制，重复同角色不叠加；Agent/插件释放撤销自身限制。禁止用 tools/change 的未提交身份重绑。空/未知 inherited 名明确失败，不删掉失败项继续。local 不传 restrict；policy-gate 检查并集。
- headless profile（`shud-probe`）：web 与 headless 共用同一 bundle，但 headless 模板没有 `agent-preset-registry`，因此当 `PROFILE_TEMPLATE=headless` 时安装器（`scripts/runtime/profile-patch.ts`）沿写 `shud-jobs` 行的同一路径，在用户 patch 中为 `preset-coordinator` 与 `preset-worker` 写入 `disabled: true`；`shud-probe` 的 `profile:smoke` 断言这两行已禁用。其会话角色为 `unknown`、不受角色限制；`shud-policy-gate` 仍挂载，报告工具的 ask 照常生效。
- persona/agent-instructions 的 system prompt 段放 `packages/dsh-shud-presets/prompts/{coordinator,worker}.md`：coordinator 指令含首任务流程、comment 索要规则、禁止科学结论措辞、"guard 通过≠合规"。prompt 中出现的 wording 文案由漂移测试与 `governance/wording.ts` 常量逐字比对；对 LLM 行为的要求写成 prompt 内容要求（"coordinator.md 含……文本"），实际行为序列以首任务脚本在 session log 中的证据为准。
- 首任务：coordinator 建卡并显式派 worker；worker shud_run(task_id)，用 dsh_job_id 调 job_output 等待、用持久 run_id/job_id 调 shud_collect 确认收集后返回。O1 本次真实 worker 作业 notify unreachable，恢复失败根因未诊断；轮询成功，原生 subagent-settled 携带结果回 coordinator。不把该通知冒充 shud-jobs wake，不改 M2 jobs；coordinator 未得已收集结果时保留自行 collect 的兜底。
- O3 原方案与原备选实测均失败，已按 #426 停止条件报告；PI 明确授权重开。真实 Web inherited allow 方案保留 job_* 与 coordinator 自有 subagent，隐藏 off-role shud 工具；O6 的 committed event 重绑避免旧限制残留。详细命令、会话与限制见 Migration_Plan_dsh 的 M3 spike 记录。

备选"coordinator 直调 shud_run"（worker preset 零使用，grill Q18 否决）。

### D12 验收门与 PI 验收

- 工程门：`pnpm run check` + `profile:smoke`（web profile：两 preset 行启用与默认 preset；`shud-probe`：两 preset 行 `disabled: true`；宿主平面 subagent 注册表与 `subagent-spawn-in-process` 行、policy-gate 行、`shud-jobs` 行的采集配置键齐全且 llm 与 `llm-deepseek`/`agent-default-model` 一致）；新增本机 `pnpm run shud:first-task`：headless 不可用（无审批卡），故用 Web 模板 + HTTP 接口（M2 `shud-restart.sh` 的会话恢复机制）驱动一次首任务；脚本以显式参数接收 scratch 工作区路径（不检查、不拒绝 `$TMPDIR` 下的路径），判据取 session log 的 `approval/asked|decided` 与工作区文件（task.json `done`、report.md 含 `Accepted by PI`、StackLock llm 三字段（base_url/request_alias/response_model）与三 submodule 修订出现在 md、四句不变式逐字出现）。
- 门禁措辞：Phased_Plan §3 的"StackLock 三字段"按"StackLock llm 三字段（base_url/request_alias/response_model）与三 submodule 修订"对齐；"措辞过四条不变式"= 四句不变式逐字出现且模型撰写节无禁止用语，语义合规不做机器检查、仍由 PI 审阅（D8）。
- PI 验收：Epic 收口时在 Web 亲自完成一次首任务（含至少一次 Allow once 与一次 reject + comment + `report_decide`），证据记 `Migration_Plan_dsh.md`；决策记录 `docs/adr/proposed/0010-m3-epic-acceptance.md`（沿 0007）；PI comment 对话承载为 `docs/adr/proposed/0011-pi-comment-conversation-carrier.md`。

### D13 Spec 对齐任务组（实现组之前）

一次 docs-only 任务组修正：`Task_Playbooks.md:16/21/36`（ctx.storage、工具名、coordinator 直调）；`Workspace_Conventions.md` §4/§9.1（目录表改 D2、删 HTML、`runs/` 结构改 M2）；`Minimal_Schemas.md` §1/§2/§3/§7（按 D3）与既有 `PiGateDecision` 段的改写（`gate_id`、`decision: approved|rejected|request_revision`、A01-2 映射替换为 M3 字段，不另增一段）；`Report_Generation_Spec.md`（`format: html`、API 403、`ResultsPanel`，§5.2"禁止用语清单应作为配置维护"改为 `governance/wording.ts` 常量、无 profile 覆写（D8），§7.1 落点统一 `reports/<id>.md`、§7.1 `export_manifest.yaml` 标注为 M4、不在 M3 范围，水印表 `decision_at` 改 `decided_at`，§8 (D) 项标注 M3 恒真项并去掉 tmp 路径项）；`Report_Review_And_Evidence_Lineage_Spec.md` HTML 导出段；`Scientific_Change_Gating_Spec.md:172-176` API 422/403 → 工具错误/审批 outcome；`PI_Decision_Comments_Spec.md` §7 开放项改为 D9；`Port_List.md:11` RunRecord 已存在；`Repository_Layout.md` 新包与模板落点；`Spec_Gaps_Register.md` GAP-01（revision_requested 回 planned；每次 report_generate 分配新 report_id；新旧报告的延续关系未定义）/GAP-04（id 已定）/GAP-05（已由 M2 解决）；`role-tool-map` 的文字引用；`Testing_Strategy.md:30` 与 `Test_Fixtures_And_Command_Matrix.md` §报告 fixture 改为本 change 的 fixture 定义；`docs/02_ARCHITECTURE/Roles_and_Boundaries.md` 对 tool-registry-governance 的失效引用改指 `role-tool-map`。`docs:check` 全绿。

### Sketch seams under test

- `tools/pre-execute` 监听（policy-gate 插件）以真实 Cordis `Context` + `@deepseek-ai/dsh-tools` 注册的假工具行使：ask/deny/next 三路与 fail-closed（无 approval 服务）——最高的已有 seam，M1 raw-guard 测试范式直接复用。
- `ShudJobRegistry.submitShud()`（已有）：提交时写入 `task_id/stack_id/data_id` 与 StackLock/DataProvenance 文件——不新开 seam，沿 M2 的 submit 集成测试扩展。
- records 包的文件层公共函数（`captureStackLock`、`generateProvenance`、`renderReport`、`validateReport`、`transitionTask`、`reconcileTaskCard`、`applyDecision`）：纯函数 + 临时目录，覆盖 7 态水印、四句不变式逐字渲染、禁语与密钥正则正反例、closure 谓词正反例、路径安全（符号链接/非目录 fail-closed）、原子写失败与提交点后的修复。
- 模型工具经 `dsh-shud-tools` 现有 `strict-tool` 测试装配（闭合 schema、未知键拒绝）；`report_submit`/`report_decide` 的终态写入以真实 ToolRuntime + policy-gate 集成测试证明（allowed-once / rejected / cancelled / 无 approval 服务，宿主 deny 时工具不执行）。
- preset 行与 restrict：`--dump-config` 投影断言（profile:smoke）+ spike 的真实 Web 会话 session log（O1/O2/O3/O5/O6）；不在单测里模拟 preset 作用域。

## Risks / Trade-offs

- [O3 原 preset apply 与原 global-only allow 备选失败] → 已记录停止与 PI 重开；采用真实 Web 验证的 agent.ctx inherited allow，job_* 保留、local subagent 不传 restrict，角色执行面不变。
- [本次子代理 SHUD wake 未投递、原因未诊断] → 已实测 worker job_output/shud_collect 路径取得 succeeded RunRecord；prompt 必须等待收集再返回，coordinator 可兜底 collect。保留 M2 通知状态/预算，不因 M3 另造通知通道，不推广为所有子代理均不可唤醒。
- [creation header 在 preset 切换后过期] → O6 已观测 header 不变，committed agentPreset 投影为当前身份；唯一 reader 原地迁移，限制在 selected 事件后同步重绑，测试覆盖双向空白会话切换与未知角色释放。
- [审批 id 不在执行上下文] → O5 已答：approval_ref 固定为 exec.callId；以 session log 的 asked.callId → asked.id → decided.id 审计，不新增推测或日志抓取订阅者。
- [候选 (a) 的 comment 由 coordinator 转述] → `report_decide` 二次审批卡回显全文，PI 不确认即不落盘。
- [语言护栏只是子串 lint] → 文档与 preset 指令明示边界，PI 审阅是最终防线（§5.2）。
- [StackLock 采集需要三 submodule 为 git 仓库] → `profile:install` 校验路径；未初始化 submodule 时 `shud_run` 明确失败（不降级为 null）。
- [`dsh-shud-jobs` 增加对 records 的依赖与提交路径改动（Critical Path #4）] → 只在输入复制之后、RunJob 首次原子写之前插入采集步骤，失败走既有回滚；集成测试覆盖采集失败不留运行目录。
- [两个 pre-execute 监听的顺序] → O2 实测 raw-guard 先于第二监听器，产品保持该顺序。next 委托后续监听，deny/ask 会短路；未挂载的 auto-review/hooks 顺序与优先级不在证据内。
- [M2 记录 `task_id` 等为 null] → schema 保持 nullable，报告生成对 null `stack_id` 的运行拒绝（closure 谓词），不回猜。

## Migration Plan

合入顺序：

1. spike 最小切片：3.1a（`TaskId` + TaskCard schema + `Minimal_Schemas.md` §1）→ 6.1a（最小 `task_create`，只建卡、无链接回写）→ 1.1 spike（O1/O2/O3/O5/O6，以 Web 内 coordinator 建卡并派 worker 跑 ccw 收尾；`shud_run` 不带 `task_id`）。
2. 文档对齐 2.1a → 2.1b → 2.1c。
3. core schema/id/wording/policy-gate 拆分（3 组其余切片）。
4. records 包与原子写迁移（4 组切片）。
5. 5.1：jobs 提交时采集 + `shud-jobs` 配置并集 + `profile-patch.ts` 写入新键 + smoke 断言 + Runtime Lifecycle 文档同一 PR；`size-exempt` 理由：未知键拒绝与必填键迫使这些改动同时落地，否则中间提交下每次真实安装都 apply 失败。5.2：只读 API `listRunJobsByTask(task_id)` 独立切片（只依赖 3.1a，可与 5.1 并行；6.1b 依赖它）。
6. 7.1：policy-gate 插件 + bundle 行 `shud-policy-gate` + smoke 断言；角色 `unknown` → 不 deny；ask 分支以假 `report_submit`/`report_decide` 工具测试——先于真实报告工具落地，保证报告工具从不在无 ask 的窗口内挂载。
7. 6.1b（`shud_run(task_id)` 回写与 reconcile 调用点；`task_create` 已在 6.1a 完整交付）→ 6.2 → 6.3（`report_submit`/`report_decide`，真实 ToolRuntime + policy-gate 集成：allowed-once / rejected / cancelled / 无 approval 服务）。
8. 8.1a presets 包 → 8.1b bundle preset 行 + `profile-patch.ts` 在 `PROFILE_TEMPLATE=headless` 时写两行 `disabled: true` + smoke（web 断言两行启用与 default，`shud-probe` 断言两行禁用）+ 文档。
9. 9.1 首任务脚本 → 9.2 控制面登记。
10. 10.1 Epic 收口验收。

每步 `pnpm run check` 绿；5.1 起 `profile:smoke` 绿；9.1 后 `shud:first-task` 绿。回滚：每个包独立 PR，profile 行可 `disabled: true` 关闭新插件而不影响 M2 主链。

## Not yet specified

- SHUD 输入文件到 `terrain/mesh/forcing/observations` 语义分类与 `event_window` 的来源（`cfg.para` 的 START/END 是分钟/天混合单位，CONTEXT 不变量 10）：M3 只记文件级 sha256；分类与窗口待 M5 批量运行需要可比性时界定。
- 同一 TaskCard 多次 `shud_run`（多 run 报告）的报告结构与 StackLock 不一致呈现（"可比性由 PI 看报告判断"）：M3 事实表逐 run 列出，不定义比较规则。
- 重新生成报告的 `report_id` 延续与 decision_history 继承：每次 `report_generate` 分配新 `report_id`（D4）；新旧报告的延续关系未定义。
- `archived` 的进入路径与 `completed.json`/`reports/` 的清理策略。

## Open Questions

- O1（已答）：owner_session 是 worker 子会话；本机 ccw30 RunJob 最终 collected、notify unreachable/3，worker 已取得 succeeded/exit0 RunRecord。原生 subagent-settled 回主会话，不是 SHUD wake。采用 worker 等待/轮询，保留 coordinator collect 兜底。
- O2（已答）：实测 raw-guard 先进入并 next 到 policy-shaped 第二监听；ask 沿链返回，再由宿主产生审批事件。auto-review/hooks 未挂载，只记录该边界，不声称验证不存在监听的相对顺序；两者都 next 的调用仍完整到达工具。
- O3（已答）：原 preset apply 时 shud 工具未注册，原 agent.ctx/global-only 备选隐藏 job_*。已停止并获 PI 重开授权；真实 Web 证据确定 inherited/local 两集合、agent.ctx 生命周期绑定与 committed preset 事件重绑，详 D11。
- O5（已答）：真实 Web harmless approval probe 的执行键没有 approval id；asked/decided 有独立 id 且 asked.callId 匹配执行 callId。approval_ref 固定用 exec.callId。
- O6（已答）：真实主/worker 子会话分别有 coordinator/worker header；header 是创建事实，空白会话切换不改写。当前投影在 committed selected 事件更新，双向重绑工具面通过；唯一 reader 在 #444 迁移到公开当前投影。
- O4：metrics 生产者归属（#422，M5），不影响本 change。
