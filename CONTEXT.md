# CONTEXT.md — SHUD-Harness

> 项目身份、bounded contexts、不变量、禁止逻辑与开放术语问题。领域术语的定义只在 `openspec/glossary.md`，本文件只引用不定义。操作规则在 `AGENTS.md`，阈值在 `constraints.yaml`。eng-init 2026-10-20。

## Identity

SHUD-Harness 是 **PI 主导的科研工程助手**：用 DeepSeek Harness（dsh）内核加 `dsh-shud-*` 插件，编排 SHUD / rSHUD / AutoSHUD，把重复劳动时间还给 PI 与工程师，并提升科研效率、拓展研究员能力边界。成功标准是时间节省，不是自治程度。Agent 是执行协调员，PI 做科学判断（[ADR-0004](docs/adr/implemented/0004-dsh-kernel.md)）。

## Bounded Contexts

| Context | 职责 | 代码/文档位置 | 对外契约 |
|---|---|---|---|
| Governance（策略门） | `tools/pre-execute` 瀑布决策 allow/deny/cancel/ask；角色—工具映射；保留规则 id | `packages/dsh-shud-core/src/governance/` | 决策表为测试常量；`ask` 走 `ctx.approval` |
| Core objects（8 对象） | TaskCard · StackLock · DataProvenance · RunJob · RunRecord · AnalysisPlan · EvidenceReport · ChangeRequest 的 Zod 权威源与生成投影 | `packages/dsh-shud-core/src/schemas/`，`docs/generated/`，`docs/03_SPEC/Minimal_Schemas.md` | 字段真相 = Zod；Markdown/JSON Schema 只生成不手编 |
| Jobs / Park-Resume（M2） | 长作业经 `ctx.jobs` 提交、agent 空闲、完成唤醒；durable JobRegistry 跨重启对账 | `packages/dsh-shud-jobs/`，`docs/03_SPEC/Park_Resume_Design.md` | shud 无 owner 登记，以运行目录、索引与 `shud-jobs` 消息满足下列五条可恢复性断言；非 shud 作业保持宿主行为 |
| Host profile（dsh seam） | 模型路由、出站通道、插件挂载；dsh 只读宿主 | `profile/shud/`，`../deepseek-harness`（钉 `dsh-v0.2.1-rc.2`） | 只用文档化 seam；`--dump-config` 可枚举 |
| Scientific runtime | SHUD 编译/运行、rSHUD 读输出与水量平衡、ccw fixture | `scripts/runtime/`，`SHUD/ rSHUD/ AutoSHUD/`，`docs/01_CODEBASE/SHUD_IO_Facts.md` | submodule 只读；运行在 scratch workspace |
| Docs / Spec / Decisions | 规范、里程碑、决策四区、生成指令 | `docs/04_IMPLEMENTATION/Phased_Plan.md`，`docs/adr/`，`instructions/agents/` | 一事一家；生成物由 CI 比对 |

## Invariants

每条在代码里应有伴生断言或测试（`AGENTS.md` ## Architecture Discipline）；尚未有的在 `constraints.yaml` review_only 列出触发点。

1. **K2 Seam-only**：插件只触碰 `tools/pre-execute`、`ctx.approval`、`ctx.jobs`、`ctx.sandbox`、`ctx.storage`、agent preset；缺 seam 是报告偏差，不是 fork，不改 loop。
2. **K4 StackLock.llm** = `base_url` + `request_alias` + `response_model`，Zod 严格限定三字段；response_model 只记录、排除出指纹，永不自动失效锁。repo 路径及截断标记参与指纹，StackId 统一为品牌时间戳格式。
3. **K9 出站**：只有 `session-log-deepseek` 关闭，其余 dsh 默认；每次 dsh 升级重审新增出站行。
4. **K12 治理**：物理方程 / 默认参数 / benchmark baseline 改动需 PI `ask`；原始数据删除禁止或 PI 审批；`data/raw` 在 workspace root 之外且只读。
5. **K13 作用域**：任何 spike 不以首任务（ccw 运行 → RunRecord → EvidenceReport）的一个用户可见步骤收尾就不准开。
6. **Fail-closed 审批**：`ctx.approval` 结果只有 `allowed-once | rejected | cancelled | unavailable`；非 allowed 一律视为拒绝。
7. **Model-visible ⟺ logged**：模型看到的工具结果/审批/作业事件必在 session log；证据只来自结构化输出（RunRecord、metrics、artifact manifest、patch bundle）。
8. **Schema 单源**：Zod 是字段最高事实源；`docs/generated/` 零漂移（`pnpm run schema:check`）。
9. **密钥**：`DMXAPI_KEY` 只经 `apiKeyEnv`；不进 RunRecord、报告、session log fixture、git。
10. **时间单位**：SHUD 内部时间为分钟；forcing ×1440、KsatV ÷1440；`ccw.cfg.para` 的 `END` 为天；每个时间值标注单位，不确定标 `[UNCERTAIN]`。
11. **Closure 代码化**：TaskCard 进入 reporting/done 由确定性谓词裁决，LLM 分类器只是 advisory（`docs/02_ARCHITECTURE/Agent_Architecture.md` §7）。
12. **Canonicality**：同一逻辑一个实现；禁止 `_v2`/`_new` 等并行版本（naming guard）。
13. **shud 作业可恢复（M2）**：对 SIGTERM/SIGKILL 前已经返回 `job_id` 的 shud 作业，重启后满足 [Recoverability invariant](openspec/specs/shud-run-jobs/spec.md)：
    1. `run-job.json` 存在，状态只沿 RunJob 状态机前进。
    2. 最终存在 `run-record.json` 或 `collect-error.json`。
    3. 同一运行目录在任一时刻至多一个 SHUD 进程；不同运行目录可并行。
    4. 挂载 `session-controller` 时，`notify.status` 最终为 `delivered`（发起会话 session log 有 `source.kind: shud-jobs` 且含该 `run_id` 的消息）或带原因的 `unreachable`。
    5. 同一前提下，作业最终在 `completed.json` 且不在 `active.json`。无 owner 作业不以 `job/settled` 判定。

    伴生验证已登记进 Verification Matrix / Enforcement Index：既有集成测试由 `pnpm run test:coverage`（默认 `pnpm run check` 的组成部分，本机 + CI）执行；真实 ccw 的 `pnpm run shud:restart` 是需本机 SHUD 与 `DMXAPI_KEY` 的独立阻断闸，不在默认 `check` 或 CI 中运行。该受控脚本的 SIGTERM / SIGKILL 两用例要求五条断言成立，且第 4 条必须为 `delivered`（`unreachable` 判 FAIL），RunRecord 含退出码与非空产物清单；不收窄一般恢复允许 delivered 或带原因 unreachable 的契约。以下是 M2 第 6–11 组的代表性集成测试，不是完整文件清单：

    - 第 6 组，提交 / 脱离执行 / 轮询：`packages/dsh-shud-jobs/src/submit-shud.test.ts`、`packages/dsh-shud-jobs/src/detached-shud.test.ts`、`packages/dsh-shud-jobs/src/poll-shud.test.ts`。
    - 第 7 组，收集与失败重试记账（`collect-error.json`）：`packages/dsh-shud-jobs/src/collect-shud.test.ts`、`packages/dsh-shud-jobs/src/collect-shud-retry.test.ts`。
    - 第 8 组，状态锁 / 持久索引：`packages/dsh-shud-jobs/src/state-lock.test.ts`、`packages/dsh-shud-jobs/src/state-indexes.test.ts`。
    - 第 9 组，取消 / 宿主释放与执行存活：`packages/dsh-shud-jobs/src/kill-shud.test.ts`、`packages/dsh-shud-jobs/src/teardown-shud.test.ts`。
    - 第 10 组，启动对账 / 原执行接管：`packages/dsh-shud-jobs/src/reconcile-shud.test.ts`、`packages/dsh-shud-jobs/src/takeover-shud.test.ts`。
    - 第 11 组，唤醒 / 确认 flush / 重试耗尽 unreachable：`packages/dsh-shud-jobs/src/wake-shud.test.ts`、`packages/dsh-shud-jobs/src/wake-shud-retry.test.ts`。

    上述工程验证不等于 PI 功能验收；PI 已于2026-10-27明确通过 #318 的 Web 重启与唤醒验收，真实日志与 RunRecord 见 [M2 手工验收记录](docs/Migration_Plan_dsh.md#m2-手工-web-重启唤醒验收2026-10-27318)。[ADR-0007](docs/adr/implemented/0007-m2-epic-acceptance.md) 的独立 PI gate 不变，合并子 PR 本身仍不代表验收通过。

14. **科学措辞枚举护栏**：core 导出的十条 `FORBIDDEN_REPORT_PHRASES`、四句 `GOVERNANCE_INVARIANTS` 与无状态 `REPORT_SECRET_PATTERN` 由 `packages/dsh-shud-core/src/governance/wording.test.ts` 钉住，无 profile 覆写，纳入默认测试闸。`scanForbiddenPhrases` 只扫描模型撰写的 `summary/observations/limitations/pi_questions`，按字段和清单顺序返回命中短语，不拼接数组条目、不回显原文；模板拥有的四句不变式不作为扫描输入，也不构成模型文本白名单。完整报告校验器另行交付；枚举 lint 通过 ≠ 语义合规，PI 审阅仍是最终防线。

15. **报告终态只在审批卡 `allowed-once` 分支写入**：已安装的 raw→policy→host 链先保护确切报告/TaskCard 目标、判定当前角色，再由宿主审批准入；`report_submit`/`report_decide` 不自行审批。拒绝、取消、不可用、缺服务/Agent 均不得执行终态写入；`approval_ref` 精确取本次 `exec.callId`，被拒 submit 卡不产生领域决定。报告 JSON 是权威提交点，卡片/Markdown 后续失败保留已提交决定，下一次调用修复但不重复决定；四个报告工具共用物理 cwd/report_id 的单进程发布顺序，不能让迟到 DRAFT 覆盖终态水印。伴生断言：`packages/dsh-shud-tools/src/report-decisions.test.ts`（真实 ToolRuntime + policy + approval 边界 double）、`report-decision-contract.test.ts`、`report-decision-publication.test.ts`、`report-decision-ordering.test.ts`、`report-decision-raw.test.ts`；对话转述与二次确认选择见 [ADR-0011（proposed）](docs/adr/proposed/0011-pi-comment-conversation-carrier.md)。这些工程测试不等于真实 Web/session-log 持久化证据或 PI 功能验收。

## Forbidden Logic

- Agent 陈述科学结论；"单流域指标提升 = 模型改进"；"校准结果 = 结构验证"；"模型机制已验证"；"普遍改进"。
- 把 RepoContextBrief 或 calibration 结果当作模型结论依据。
- Worker/Reviewer 自动批准 PI gate；agent 身份持 pi 角色。
- 直接改 baseline / 默认参数而不经 ChangeRequest + `ask`。
- 用未记录的终端输出作为证据；隐藏失败的 verification。
- 放宽闸（阈值、覆盖率、lint 级别、测试夹具、normalizer）以让自己的改动通过。
- 在 `../deepseek-harness`、`SHUD/`、`rSHUD/`、`AutoSHUD/`、`data/raw`、`docs/adr/archived/`、`docs/generated/`、`AGENTS.md`、`CLAUDE.md` 上手工写入。

## Open Terminology Questions

- "fixture" 在本仓库同时指 SHUD 输入夹具（ccw tiny）与测试夹具（OpenSpec fixture）；文内首次出现需限定。
- `Spec_Gaps_Register.md` 中 GAP-01..10 的"实现选择"列在 M3 前为空，不是遗漏。
