---
status: living
canonical_for: [implementation-plan]
supersedes: Zero 时代 M1–M9 计划（见 tag archive/zero-v0.8.3）
---

# 里程碑计划 v2（dsh 内核）

> 唯一真相源：排期、交付切分、验收门以本文为准。决策依据 [ADR-0004](../adr/implemented/0004-dsh-kernel.md)。
> 弹性里程碑，无日历承诺；上一门全绿才进下一门；issue 按单 agent-PR 尺寸切。
> **作用域规则（ADR-0004 K13）**：任何 spike 不以首任务的一个用户可见步骤收尾就不准开。

## 0. 总览

编号说明：M1–M6 为本次重切编号。`Migration_Plan_dsh.md` 与 `../dsh-spike` 记录中出现的"M3 JobRegistry"沿用旧编号，对应本表 **M2**。

| 里程碑 | 主题 | 用户可见步骤 | 验收门 |
|---|---|---|---|
| M1 | 骨架：profile + bundle + raw-guard 插件（包：`dsh-shud-core` 库 + `dsh-shud-raw-guard`） | 在 `dsh --profile shud` 里对话：写 raw 被拒（无审批路径），bash 读 raw 弹出 PI 审批卡 | `dsh --profile shud` 启动；raw-guard 单测 + 5 探针全绿；CI 通过 |
| M2 | 运行主链：`shud_run` + durable JobRegistry + RunRecord | 一句话跑 ccw，中途重启 dsh，完成后被唤醒并拿到 RunRecord | ccw 全程 4m45s 内 dsh 重启一次，仍产出 RunRecord 且含退出码与产物清单 |
| M3 | **MVP-1**：TaskCard + EvidenceReport + StackLock + 审批接线 | 从任务卡到 Markdown 证据报告，含 PI 审批 | 首任务"ccw 运行 → RunRecord → EvidenceReport"端到端；报告含 StackLock 三字段与响应 model |
| M4 | **MVP-2**：已知答案回放 | 提交 openMP RHS 切片 ChangeRequest，经 VerificationCase 判定 | 正确性门按 serial baseline 一致性判定（ADR-0002 D4） |
| M5 | 最小 OAT 敏感性（3–5 run，AnalysisPlan 对象） | 一次批量运行与汇总表 | 批次内 StackLock 一致；汇总表可复算 |
| M6 | 收口：记忆评估、UI 插件评估、dsh 升级评估、通知评估 | — | 每项一份一页评估，PI 决定是否立项 |

## 1. M1 骨架

**交付计划**（不是完成状态；对应 OpenSpec change [`m1-skeleton`](../../openspec/changes/archive/2026-10-21-m1-skeleton/proposal.md)、Epic #210）
- pnpm workspace：`packages/dsh-shud-core` 库（8 对象 Zod schema、治理常量、policy-gate-core 纯函数移植）、`packages/dsh-shud-raw-guard` 插件（决策核、dsh 适配层、审计与单测）、`profile/shud/` bundle（模型路由、仅关闭 `session-log-deepseek`、以 workspace 包说明符挂载 raw-guard）。
- `profile:install`：识别 checkout/npm 两种 dsh 布局，幂等建立 web 模板的 `shud` 或 headless 模板的 `shud-probe` profile；不覆盖用户 patch。
- 本机 `profile:smoke`：build → 临时 profile 建档 → dump-config/schema 自检，证明 raw-guard 可导入；`raw-guard:probes`：真实 LLM 五探针、session log 判据、负例与离线 judge 夹具自证。
- CI：typecheck + vitest + `profile-smoke` job（npm 版 dsh），结果纳入 `all-checks-passed`；真实 LLM 探针只在本机运行。
- eslint dsh seam 白名单与闸自证；Verification Matrix / Enforcement Index / constraints 同步。
- 手工 Web 验收记录读 raw 的 ask → Allow once → 工具结果，以及写 raw 的 deny 无卡，session log 与 raw md5 证据记入 Migration_Plan。此项证明用户可见步骤，不改上表验收门。
- 用户可见步骤改写依据：grill 分支⑤用户决策（[design D13](../../openspec/changes/archive/2026-10-21-m1-skeleton/design.md)）；写 raw deny 无审批路径，bash 读 raw ask。
- 移植清单执行：[Port_List](Port_List.md)。

**验收门**：上表 M1 行。**前置**：Phase 4 reset 完成（ADR-0004 K15）。

## 2. M2 运行主链

**交付**
- `dsh-shud-jobs`：继承 `LocalJobRegistry`，禁用原 `jobs` 行并插入 `shud-jobs` 行；非 shud 作业保持宿主行为。shud 作业无 owner 登记，包装进程 detach，作业记录与输出落文件；启动按 R1–R12 对账，存活作业接管、已退出作业结算并 collect，统一经 `shud-jobs` 消息唤醒（无 owner 作业不产生 `job/settled`）。
- `dsh-shud-tools`：`shud_run`（kind=shud 作业）+ `shud_collect`（解析产物 → RunRecord）。
- `RunJob`/`RunRecord` 记录位于 `<session cwd>/runs/<run_id>/` 的 `run-job.json`/`run-record.json`；必填 `stateDir` 保存 `active.json`、`completed.json` 与排他 `lock`，不经 `ctx.storage` 域保存运行记录。细节以 [m2-run-chain design D2/D7/D11](../../openspec/changes/archive/2026-10-27-m2-run-chain/design.md) 为准。

**验收门**：上表 M2 行；另加 SIGTERM 与 SIGKILL 各一次重启用例。

**状态（2026-10-27）**：PI 已明确通过 Web 中 ccw 运行中重启、原会话自动唤醒与 RunRecord 验收；真实 session log、工具调用/结果及 RunRecord 路径见 [M2 手工验收记录](../Migration_Plan_dsh.md#m2-手工-web-重启唤醒验收2026-10-27318)。#318 的证据 PR #418 已合并，M2 change 随本次收口归档；不扩展为 M3 EvidenceReport 交付或科学结论。

## 3. M3 MVP-1

**交付**：TaskCard 建卡/状态机；EvidenceReport Markdown 生成（模板 + RunRecord 引用）；StackLock llm 三字段（base_url/request_alias/response_model）与 SHUD/rSHUD/AutoSHUD 三 submodule 修订、dirty 路径；DataProvenance 最小记录；审批接线（治理动作经 `tools/pre-execute` 返回 `ask`）；coordinator/worker 两个 agent preset。
**验收门**：`pnpm run check`、`pnpm run profile:smoke` 与本机阻断闸 `pnpm run shud:first-task <scratch-workspace>`；后者需本机可执行 SHUD（显式 `SHUD_BIN`）与环境变量 `DMXAPI_KEY`，工作区可位于 `$TMPDIR`，CI 不运行。脚本用独立 Web profile，经 HTTP Allow once 验证首任务调用链、同提交审批审计与 done TaskCard/Accepted by PI Markdown；报告含上述 StackLock llm 三字段与三 submodule 修订。“措辞过四条不变式”的机器判据仅为四句 GOVERNANCE_INVARIANTS 逐字出现且模型撰写节无禁止用语；语义合规仍由 PI 审阅。

**状态（2026-11-01）：M3 已完成，PI 已明确通过阶段验收。** TaskCard、采集/记录、报告工具、角色 preset 与首任务脚本的工程主链已合并；[PR #491](https://github.com/DankerMu/SHUD-Harness/pull/491) 记录真实首任务正例、禁策略门缺审批负例及 SIGTERM/SIGKILL 重启回归。PI 在 Web 亲自完成 accepted/done 与拒绝 → 对话 comment → `report_decide` → revision_requested/planned 两条路径，证据见 [M3 PI 验收记录](../Migration_Plan_dsh.md#m3-pi-acceptance)；自动工程 Allow once 不代表 PI 接受报告。[ADR-0010（Accepted，已实施）](../adr/implemented/0010-m3-epic-acceptance.md) 登记仅限 [Epic #423](https://github.com/DankerMu/SHUD-Harness/issues/423) 的统一 PI 功能验收安排；PI 已授权关闭 [验收 issue #452](https://github.com/DankerMu/SHUD-Harness/issues/452) / Epic 并归档 `m3-mvp-1`。两条 worker 作业的 notify 均 unreachable，显式等待/收集完成闭环，不声称自动唤醒成功，也不放宽 `shud:restart` 必须 delivered 的独立判据；科学验证及 [#422](https://github.com/DankerMu/SHUD-Harness/issues/422) 的 M5 指标生产不在本次验收范围。

## 4. M4 MVP-2

**已交付**（[Epic #515](https://github.com/DankerMu/SHUD-Harness/issues/515)，[m4-mvp-2 归档](../../openspec/changes/archive/2026-11-05-m4-mvp-2/proposal.md)）：ChangeRequest、VerificationCase、BuildRecord；code_change TaskCard 与确定性 closure；coder/reviewer preset 与四角色工具面；change_create/change_submit/shud_build/verification_run；构建绑定运行与报告事实表。coder 在 scratch workspace 内 `repos/SHUD` 的独立本地 clone 修改已跟踪文件，不使用 git worktree add、不修改根 submodule（D15(8)，M4 范围裁剪、非放宽 baseline）。

**回放素材**：SHUD 钉定切片前 `9a422e5eb708df7d2f8b4066a3083a031d679a82`；提供 P1e StrictOMP 设计文档与五文件清单，不给上游 diff，由 coder 重导出。base 从干净钉定 commit 构建，candidate 从同一归档加已批 patch 构建。keliya 输入只在副本改 NUM_OPENMP=1 与外部 forcing 路径，窗口保留 12053–12143，不传 end_days。

**工程验收门**：ADR-0002 D4，命令 `pnpm run shud:replay <scratch-workspace>`（由 #547 交付、本机阻断、CI 不运行），必须满足 [Replay acceptance criteria 全部判据](../../openspec/specs/known-answer-replay/spec.md#requirement-replay-acceptance-criteria)：

- TaskCard/CR/两个 BuildRecord 的 base commit 均为上述完整 sha；恰一个 approved CR，文件集限五文件且含 Makefile 与 MD_rhs_core.cpp，numerical_implementation/high。
- 恰两个成功 BuildRecord：base 无 CR/patch、rhs_openmp=false；candidate 绑定已批 CR/patch、rhs_openmp=true，make.stdout.log 有 `-fopenmp` 编译链接证据。
- 两个已 collected、成功的 keliya 运行，threads=1、分别绑定两构建，每份 provenance 的 external_files 恰 32 项；恰一个 passed VC，rivqdown SHA256 bitwise 相等。
- 报告 accepted、卡 done；两份不同 build_id 的 StackLock、CR/VC/Build 事实表、四句不变式与 §5 固定句齐全；四角色 header 与 coordinator 三委派工具有 canonical session log 证据。
- 恰两次自动 Allow once（CR、报告），approval_ref 与对应 asked/decided 关联；clone HEAD/git dir、根 submodule 修订与 git 元数据、ccw 输入及 raw 字节按判据保持不变。

前置为本机 SHUD 工具链、SHUD_BIN、SUNDIALS_ROOT、DMXAPI_KEY 与 keliya 来源；缺项明确失败。VC failed 或任何判据不成立均 exit 1，不降为 INCONCLUSIVE。bitwise 一致只证明 N=1 与 serial baseline 输出一致，不构成并行正确性、性能或模型改进结论；不做性能复现。

**PI 功能验收已通过**：PI 在 Web 亲自操作两次 CR 审批卡（含线程接线修复）与一次报告审批卡，报告 accepted、TaskCard done，随后明确通过并授权 M4 收尾；完整证据、原失败候选与限制见 [M4 PI acceptance](../Migration_Plan_dsh.md#m4-pi-acceptance)，安排登记于 [ADR-0014](../adr/implemented/0014-m4-epic-acceptance.md)。该人工修复流程与上述恰两次自动审批的工程脚本分别记账，不把旧候选重写为通过，也不放宽脚本判据。结论仅限固定 keliya 输入/时间窗的 rivqdown 一致；不是并行正确性、性能或科学有效性证明。#517 的 ADR-0011 确认独立于本次 PI 功能验收。

## 5. 全程不变式

secrets 不进 RunRecord/报告/git；agent 不作科学结论判断；高风险科学变更不绕过 PI gate；`data/raw` 在 workspace root 之外。

## 6. 升级节奏

每个里程碑边界开一条 `chore(dsh-upgrade)` issue：读上游 `docs/upgrade-guide/<tag>/`，评估 seam 影响，升级或记录跳过原因；升级后重跑 spike 五项探针（`../dsh-spike/runs/`）作为回归。

**M4 边界例外（2026-11-02，D15(7)）：** PI 决定保持 dsh `0.2.1-rc.2`，本轮不新开 `chore(dsh-upgrade)` issue；理由是已知答案回放只扩展现有 seam，避免把宿主升级引入回放变量。这是本轮范围裁剪、非放宽 baseline，后续边界仍执行上述升级评估规则。rc.2 同包三条 tool-subagent 的装配由 #543 首条 smoke 断言实测，失败报告 seam 偏差，不修改宿主绕过。
