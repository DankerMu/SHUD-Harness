# CONTEXT.md — SHUD-Harness

> 项目身份、bounded contexts、不变量、禁止逻辑与开放术语问题。领域术语的定义只在 `openspec/glossary.md`，本文件只引用不定义。操作规则在 `AGENTS.md`，阈值在 `constraints.yaml`。eng-init 2026-10-20。

## Identity

SHUD-Harness 是 **PI 主导的科研工程助手**：用 DeepSeek Harness（dsh）内核加 `dsh-shud-*` 插件，编排 SHUD / rSHUD / AutoSHUD，把重复劳动时间还给 PI 与工程师，并提升科研效率、拓展研究员能力边界。成功标准是时间节省，不是自治程度。Agent 是执行协调员，PI 做科学判断（[ADR-0004](docs/adr/implemented/0004-dsh-kernel.md)）。

## Bounded Contexts

| Context | 职责 | 代码/文档位置 | 对外契约 |
|---|---|---|---|
| Governance（策略门） | `tools/pre-execute` 瀑布决策 allow/deny/cancel/ask；角色—工具映射；保留规则 id | `packages/dsh-shud-core/src/governance/` | 决策表为测试常量；`ask` 走 `ctx.approval` |
| Core objects（8 对象） | TaskCard · StackLock · DataProvenance · RunJob · RunRecord · AnalysisPlan · EvidenceReport · ChangeRequest 的 Zod 权威源与生成投影 | `packages/dsh-shud-core/src/schemas/`，`docs/generated/`，`docs/03_SPEC/Minimal_Schemas.md` | 字段真相 = Zod；Markdown/JSON Schema 只生成不手编 |
| Jobs / Park-Resume（M2） | 长作业经 `ctx.jobs` 提交、agent 空闲、完成唤醒；durable JobRegistry 跨重启对账 | 规划中的 `dsh-shud-jobs` 包，`docs/03_SPEC/Park_Resume_Design.md` | `job/settled` 持久化；SIGTERM/SIGKILL 均可恢复 |
| Host profile（dsh seam） | 模型路由、出站通道、插件挂载；dsh 只读宿主 | `profile/shud/`，`../deepseek-harness`（钉 `dsh-v0.2.1-rc.2`） | 只用文档化 seam；`--dump-config` 可枚举 |
| Scientific runtime | SHUD 编译/运行、rSHUD 读输出与水量平衡、ccw fixture | `scripts/runtime/`，`SHUD/ rSHUD/ AutoSHUD/`，`docs/01_CODEBASE/SHUD_IO_Facts.md` | submodule 只读；运行在 scratch workspace |
| Docs / Spec / Decisions | 规范、里程碑、决策四区、生成指令 | `docs/04_IMPLEMENTATION/Phased_Plan.md`，`docs/adr/`，`instructions/agents/` | 一事一家；生成物由 CI 比对 |

## Invariants

每条在代码里应有伴生断言或测试（`AGENTS.md` ## Architecture Discipline）；尚未有的在 `constraints.yaml` review_only 列出触发点。

1. **K2 Seam-only**：插件只触碰 `tools/pre-execute`、`ctx.approval`、`ctx.jobs`、`ctx.sandbox`、`ctx.storage`、agent preset；缺 seam 是报告偏差，不是 fork，不改 loop。
2. **K4 StackLock.llm** = `base_url` + `request_alias` + `response_model`；response_model 只记录，永不自动失效锁（代码在 M3 前仍带旧字段，记录于 `docs/04_IMPLEMENTATION/Port_List.md`）。
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

## Forbidden Logic

- Agent 陈述科学结论；"单流域指标提升 = 模型改进"；"校准结果 = 结构验证"；"模型机制已验证"；"普遍改进"。
- 把 RepoContextBrief 或 calibration 结果当作模型结论依据。
- Worker/Reviewer 自动批准 PI gate；agent 身份持 pi 角色。
- 直接改 baseline / 默认参数而不经 ChangeRequest + `ask`。
- 用未记录的终端输出作为证据；隐藏失败的 verification。
- 放宽闸（阈值、覆盖率、lint 级别、测试夹具、normalizer）以让自己的改动通过。
- 在 `../deepseek-harness`、`SHUD/`、`rSHUD/`、`AutoSHUD/`、`data/raw`、`docs/adr/archived/`、`docs/generated/`、`AGENTS.md`、`CLAUDE.md` 上手工写入。

## Open Terminology Questions

- `Minimal_Schemas.md` 对 StackLock.llm 三字段的命名（`request_alias` vs 代码旧字段）在 M3 前双态并存，grep 前查 `openspec/glossary.md` 的两态关键词。
- "fixture" 在本仓库同时指 SHUD 输入夹具（ccw tiny）与测试夹具（OpenSpec fixture）；文内首次出现需限定。
- `Spec_Gaps_Register.md` 中 GAP-01..10 的"实现选择"列在 M3 前为空，不是遗漏。
