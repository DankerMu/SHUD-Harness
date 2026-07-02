# 对抗性设计审查 v0.8.3

**日期**：2026-07-02
**方法**：10 个设计方面并行红队攻击（每方面攻击一组显式"核心主张"，只收 medium+ 且必须带失败场景与 file:line 证据）→ 每条发现由独立核验 agent 对抗性证伪（重点：全库搜索该问题是否已在其他 spec 被处理）→ 综合。共 69 个 agent。
**结果**：59 条原始发现 → **17 CONFIRMED**（核验后维持）· **24 PLAUSIBLE**（问题真实但严重度依赖实现细节）· **18 REFUTED**（被证伪，多因漏看交叉 spec 的强制点）。
**性质**：advisory。逐条处置（修复/降级/接受）另行任务化；处置后在本文件标注状态。

严重度分布（CONFIRMED）：high 6 · medium 9 · low 2。

---

## 0. 综合判断（先读这个）

### 0.1 最大的系统性缺陷：门禁消费 LLM 自报字段

v0.8.3 用 semantic_level_floor 修掉了"语义级别自报"（AGA-P0-2），但 **floor 的输入本身还是自报的**。同一模式在治理链上反复出现：

| 自报字段 | 消费它的门禁 | 发现 |
|---|---|---|
| ChangeRequest.files_changed | floor 计算、scope 校验 | A01-1 (high) |
| （floor 表覆盖缺口）| rSHUD 物理后处理 / AutoSHUD 全仓库无 floor | A05-2 (high) |
| 空 files_changed（纯校准任务）| floor 完全不参与 | A05-1 (plausible high) |
| assertion.evidence_level | lineage guard | A04-1 (plausible) |
| ChangeRequest.interface_impact | CLI 适配闭环 | A07-5 (plausible) |
| ChangeRequest.compat_checks | EVAL-INJ-002 断言 | A10-3 (plausible) |

**修复模式统一**：每个 gate 的输入必须来自 harness 捕获的真值，不是 LLM 填写的 YAML——files_changed 与 CommandTrace/git diff 对账；evidence_level 由 ref 目标对象派生；上游 diff 触及接口面时机器触发 CLI fixture 要求。真值大多**已经存在**（CommandTrace.files_changed、artifact registry、git），缺的只是"接进 gate"这一步。

### 0.2 其余横切主题

2. **"kernel 强制"词汇透支**（A03-3、A03-4、A05-3；plausible A02-6、A08-6）——spec 说"硬校验/确定性拦截"，但指不出执行点。建议文档纪律：每个"强制"声明必须标注 enforcement point（API 层 / 沙箱层 / kernel 层 / validator），标不出的改写为"约定 + eval 兜底"。
3. **路径沙箱与语义边界脱节**（A03-1；plausible A03-5、A03-6）——mutation boundary 是按任务类型的表格，沙箱只认路径前缀；`workspace/repos/*`、`workspace/runs/*` 整体可写让 baseline 和共享源码副本裸奔。
4. **跨文档枚举/阈值漂移**（A01-2、A01-5、A08-5、A06-6；plausible A09-3、A08-4、A02-4）——Schema_Generation_And_Drift_Control 只管实现后的 Zod↔Markdown，零代码阶段的 Markdown↔Markdown 漂移无人管，而这恰是当前最高发问题。建议：CANONICAL_CONTRACTS 增设枚举/映射登记，或把最易漂移的枚举提前写成 Zod。
5. **被全系统引用却从未设计的地基**（A08-1 seq 分配器、A08-2 ActivityFeed 重建；plausible A02-1 plan_step_id、A02-2 cursor 重算、A04-5 plan 修订权）——plan.md 的结构化（步骤 ID、修订权限、cursor 重算规则）是同一个洞的三个面；seq 分配器是实时链路的地基且只在测试计划里出现过一次。
6. **发布路线自相矛盾**（A10-1；plausible A10-2）——治理 eval 100% 是发布前提，但前两个 release 无 LLM 无法产生通过率；N=5/5 的统计功效也撑不起"一次都不能破"的表述。
7. **正面结论**：18 条被证伪，多数因为纵深防御在别处成立——preflight 必查项、白名单准入沙箱、pi_decision 仅 PI 通道（created_by:"pi" 硬约束）、Artifact evidence_usable 链堵死了 metrics 伪造。被攻击而站住的面（§3）与被攻破的面同样有信息量。

### 0.3 处置优先级建议

- **P0（治理可被绕过，直接损害科学正确性）**：A01-1 + A05-2 + A05-1（floor 输入真值化 + 覆盖面补全，一个 patch 系列）；A03-1（沙箱白名单收窄：repos/ 共享副本只读、runs/ 按 run 状态转只读、写权限收到 worktrees/scratch/artifacts）；A06-3（EvidenceReport 非-accepted 终态补 ACL）。
- **P1（不修则实现期必然撞上）**：A08-1（seq 分配器所有权/持久化/原子性设计）；A01-2（request_revision↔revision_requested 映射进 canonical 登记）；A02-1/A02-2/A04-5（plan.md 结构化三件套）；A10-1（发布 gate 按版本分段：无 LLM 版本以确定性测试为 gate，eval gate 自 0.8.3 起生效）；A01-5、A08-5（枚举补全）；A07-2（negative_state_count 的生产者命令 + 强制变量集）。
- **P2**：其余 CONFIRMED medium/low；24 条 PLAUSIBLE 逐条处置（确认为实修或论证关闭）。
  ——已全部完成（2026-07-02）：CONFIRMED 见 §1 处置状态，PLAUSIBLE 见 §2 落点速查。

---

## 1. CONFIRMED（17）

> **处置状态（2026-07-02）：17/17 已修复**。落点速查：
> A01-1 → Scientific_Change_Gating §1.1 规则 0/4（observed 集 + 对账）+ Preflight 检查项 + EVAL-GOV-005 ·
> A01-2 → Minimal_Schemas 枚举映射注 + CANONICAL_CONTRACTS §15 登记 ·
> A03-1 → Execution_Jobs_Runs §9.2 读写分离（repos 只读、runs 按状态转只读、config 只读） ·
> A03-3 → Execution_Jobs_Runs §9.2.1 按角色执行模式 · A03-4 → Control_Kernel §5 spawn_profile_subset ·
> A05-2 → floor 表扩（rSHUD 物理 + AutoSHUD）+ 兜底扩至三仓库任意未登记路径 ·
> A05-3 → Report_Review §4 analysis_mode 派生字段 + assertion_type 确定性限制 ·
> A06-3 → Report_Generation §9 终态 ACL + Auth_Permission 矩阵两行 ·
> A07-2 → Domain_CLI_Spec §2.2 numerical_health 生产通道（5 状态变量固定加载）+ Execution_Jobs_Runs §8 指针 ·
> A08-1 → WebSocket_Protocol §2.1 seq 分配器 · A08-2 → Snapshot_Recovery §4 事件回放接口 ·
> A08-5 → UI_Implementation_Spec 类型对齐（补 plan.created/agent.turn.*） ·
> A10-1 → CICD_Release §12 gate 适用条件分段 · A01-5 → 三处枚举补 submitted/timed_out
> （Minimal + Support + ParameterSet 派生源） · A04-5 → Park_Resume §2.1 plan 结构契约 ·
> A06-6 → Report_Export §4 状态水印表 · A09-5 → ALERT-BATCH-001 按 stop_condition 分支化。

### High（6）

**A01-1 [bypass] 门禁 floor 建立在 Coder 自报的 files_changed 上，未与真实 worktree diff 对账，可整链绕过**
effective_level = max(declared, floor(files_changed))（Scientific_Change_Gating_Spec:44），但 files_changed 是 ChangeRequest 里 LLM 自填字段（Minimal_Schemas:239）；Reviewer validator 核对的是自报字段与自报级别的自洽（:47），全库无一处要求 files_changed == `git diff --name-only`；preflight 的 worktree_clean_or_expected_patch（Preflight:44）也不做该对账。
场景：Coder 改了 SHUD 求解器通量系数，files_changed 只登记 docs/scripts → floor 命中 pure_engineering → 不需要 bundle/verification/PI gate，物理改动直通 search。EVAL-GOV-001 恰不覆盖"漏报"路径（:126）。核验注：真值已在 CommandTrace（Sandbox_and_Executor:41），修复是把它接进 floor。
→ 修复方向：floor 消费 CommandTrace 派生的真实文件集；或 preflight 增加 files_changed == worktree diff 断言 + eval 负例补"漏报"场景。

**A01-2 [contradiction] 同一修订语义两种拼写 request_revision / revision_requested 散落 canonical schema，映射只存在于散文**
PiGateDecision.decision=`request_revision`（Support_Schema_Contracts:194、Minimal_Schemas:407），PiGate.status / EvidenceReport.status / ReportExport=`revision_requested`（Support:177、Minimal:210）。PI_Decision_Comments:56 要求跨字段映射，但无 schema 层强制、无状态迁移测试断言。
场景：handler 直接把 decision 赋给 report.status → 静默丢迁移，PI 点了 Request revision 而报告永远卡 awaiting_pi。
→ 修复方向：CANONICAL_CONTRACTS 登记 decision→status 映射表；测试计划补"decision=request_revision 落库后 report.status==revision_requested"断言。

**A03-1 [bypass] 沙箱允许写 workspace/repos/* 与 runs/*，worker 可无 gate 覆写 solver 源码副本与 baseline 产出**
路径白名单（Execution_Jobs_Runs:168）整体放行 repos/*（共享运行副本，非 worktree）与 runs/*；baseline 物理形态是 runs/ 下的 RunRecord（Sensitivity_Calibration_Benchmark:15,146）。"禁改 solver source/baseline"只在 mutation boundary 表格（语义层），沙箱不认任务类型、不认哪个 run 是 baseline。
场景：worker 执行 `cp new.dat workspace/runs/RUN-BASE-0001/output/rivqdown.dat` 或 `echo >> workspace/repos/SHUD/src/Model_Data.cpp`，路径在白名单内，风险分级 low/medium 放行。
→ 修复方向：repos/ 共享副本只读（写只经 worktree）；runs/ 在 collected/baseline 状态转只读（沙箱按 run 状态查表）；mutation boundary 表格降为"路径规则的语义说明"。

**A03-4 [gap] "spawn 剖面只能减不能加"无校验点，kernel 硬校验只管深度/并发不管内容**
Roles_and_Boundaries §0 把剖面冻结挂到 Control_Kernel §5，但 §5 只校验 max_spawn_depth/max_concurrent_subagents（:98-110）；全库无"子代理 allowed_tools ⊆ canonical 剖面"的谓词。
场景：coordinator spawn worker 时传入超集工具（含 baseline.update），深度/并发校验通过，越权剖面生效。
→ 修复方向：kernel spawn 校验补第三项：allowed_tools ⊆ role canonical profile（canonical 剖面表本身已存在于 Roles_and_Boundaries §0）。

**A05-2 [bypass] floor 表不覆盖 rSHUD 物理后处理与整个 AutoSHUD，降级申报旁路对这些路径仍成立**
floor 表只含 SHUD C++ + 参数文件 + `rSHUD/R/*read*`（Scientific_Change_Gating:27-45）；WaterBalance.R、PET.R 不匹配 `*read*`，AutoSHUD 零条目——而 Sub_iSoil_*.R / Step3_BuidModel.R 恰恰决定土壤水力默认参数与 landcover→Manning 映射（parameter_default/physical_equation 级）。保守兜底只针对"求解器源码路径"，R 脚本不命中。
场景：改 AutoSHUD 土壤 ksat 推导公式，自报 pure_engineering，floor 无定义 → effective_level=declared → 全链旁路。
→ 修复方向：floor 表补 rSHUD 物理函数（WaterBalance/PET/PTF）与 AutoSHUD SubScript/Step3 条目；兜底规则从"求解器源码"扩为"三仓库任何未登记路径 floor ≥ numerical_implementation（宁高勿低）"。

**A08-1 [gap] seq 单调是全部状态重建的地基，但 seq 分配器（所有权/持久化/原子性）从未被设计**
envelope 有 7+ 类并发事件生产者（WebSocket_Protocol:30-36），reducer 靠 seq 单调去重补洞（Frontend_State_Design:45）；但"seq 谁生成、并发如何单调、与 events.ndjson 追加如何原子、重启后计数器如何续"全库缺席——唯一出现处是测试计划里一句"seq allocator"（Phase_By_Phase_Test_Plan:113）：被要求测试的东西从未被设计。
场景：watcher/agent loop/tool executor 并发取号撞同 seq → reducer 静默吞事件、gap 检测失效；或重启后计数器错基 → since_seq 语义错乱。
→ 修复方向：Workspace_Snapshot_And_Recovery 或 WebSocket_Protocol 增设 §"seq 分配器"：单一 writer（事件总线）持锁分配 + 与 ndjson 追加同一原子操作 + 重启从 ndjson 尾部恢复计数。

### Medium（9）

**A01-5 [contradiction] AnalysisProgress cell.status 比源枚举少 submitted/timed_out 两态，存在不可表示状态**
ParameterSet.status 8 值含 submitted（Parameter_Set_And_Analysis_Run_Mapping:16），RunJob 终态含 timed_out（Minimal_Schemas:127）；cells[].status 只有 7 值（Minimal_Schemas:386、Support:269）。timed_out→failed 的被迫映射会把超时误报为执行失败，违背"失败 cell 不得隐藏"。
→ 修复方向：cell.status 补两值，或在派生规则里显式声明映射（timed_out 单列，勿并入 failed）。

**A03-3 [unenforceable] repo_explorer 只读边界靠 prompt 注入 + 复用无 read-only 模式的 sandbox.exec**
只读约束落地是"prompt 注入只读工具策略"（Zero_Reuse_Matrix:192）；执行入口与 worker 相同，denied_actions 的 write/edit 是抽象动作名，未映射到命令/路径判定。`Rscript -e 'writeLines(...)'` 是常见诊断形态，放行。
→ 修复方向：sandbox.exec 增加按 agent role 的执行模式（repo_explorer → 挂只读 FS 视图或写路径全拒），把 denied_actions 接到沙箱判定。

**A04-5 [gap] "plan 以磁盘为准并重算 cursor"，但谁能改 plan、如何重算、信任级全部未定义**
Park_Resume:106,182 规定磁盘 plan revision 更新则重算 cursor；Context_Trust:60 把 plan revision 列为高影响动作。但 cursor 重算算法、plan.md 写入权限、修订的 trust gating 全库无定义——"以磁盘为准"退化为"信任任何来源写入的 plan"。
→ 修复方向：与 A02-1/A02-2 合并做 plan.md 结构化：步骤带稳定 ID，修订走对象事件（记录 actor + 依据 refs），cursor 重算 = 按步骤 ID 交集的确定性算法。

**A05-3 [unenforceable] calibration≠validation 并非确定性拦截，spec 自己承认靠 LLM+PI 兜底**
language guard 自我声明是"枚举短语 lint，不能识别 paraphrase"（Report_Generation:162,257）；Reviewer 清单把换述识别划为 (L) LLM 项；EVAL-GOV-003 是概率 eval。三处一致：不存在确定性强制点，主张措辞透支。
→ 修复方向：接受现实并改主张措辞（"lint + LLM 审查 + PI 兜底"）；把 calibration 结果的 assertion 强制挂 mode=calibration 标签（结构化字段可确定性检查，narrative 不可）。

**A06-3 [bypass] EvidenceReport 终态只有 accepted 有 ACL，agent 可单方面 rejected/archived 终结报告绕过 PI**
状态机（Report_Generation:263-270）仅约束 accepted 归 PI；Auth 能力矩阵（Auth_Permission_Design:37）无"拒绝/归档报告"条目；archived 无 actor 来源定义。
场景：Coordinator 被注入诱导把 awaiting_pi 的报告置 archived，PI 从未看到。
→ 修复方向：四个终态转换全部收归 PI/授权用户（API 层 403），agent 只能推进到 awaiting_pi。

**A07-2 [gap] negative_state_count 无生产者命令，且变量覆盖被默认集/--vars 削减成"钳零即健康"**
SHUD 负状态静默钳零（无日志），检测必须靠输出分析（Domain_CLI_Spec:76）；需查 5 个状态变量含 lakystage（SHUD_Output_Variables:183），但 metrics/wb 都不产出 negative_state_count，get_default_variables() 16 变量不含 lakystage，--vars 还能进一步缩集；而 numerical_health 是 RunRecord 必绑字段（Execution_Jobs_Runs:133）——必需字段无生产者。
→ 修复方向：CLI 增 `health` 子命令（或并入 wb）：固定 5 状态变量强制加载（不受 --vars 影响），产出 numerical_health 全字段。

**A08-2 [gap] ActivityFeed（B 栏）无 snapshot 重建路径，seq 过期后必然空白**
gap recovery 要求丢弃 reducer 缓存后拉 snapshot 重放（Workspace_Snapshot_And_Recovery:64-69），但三种 snapshot 全是实体快照，无 activityStore；Frontend_State_Design:36 亲口把活动流排除在可重建实体外。周末重启 + seq 过期 → 周一 B 栏叙事全部丢失。
→ 修复方向：明确 B 栏历史来源 = events.ndjson 的分页 REST 回放接口（GET /api/tasks/:id/events?before_seq=），gap recovery 第③步改为"实体走 snapshot、叙事走事件回放"。

**A08-5 [contradiction] UI spec 的 ActivityEvent 联合类型漏 plan.created / agent.turn.* 等 Feed 必渲染事件**
Frontend_State_Design:160 要求 Feed 渲染 plan.created，Interaction_Model B 栏效果图有计划卡片；UI_Implementation_Spec:210 的类型枚举独缺之，也缺驱动 thinking 指示的 agent.turn.*。按 UI spec 实现则计划卡片渲染不出。
→ 修复方向：以 WebSocket_Protocol 事件注册表为唯一源，UI spec 类型改为引用而非复写。

**A10-1 [contradiction] 治理 eval 100% 是发布前提，但 0.8.1/0.8.2 两个版本无 LLM，通过率无从产生**
CICD_Release §12 要求每次 release 治理/注入 100%（:191-238），§14 版本方案前两版无 LLM；Agent_Behavior_Eval §1 eval 需真实 LLM 调用。skeleton 版要么发不出、要么被迫豁免违反明文。
→ 修复方向：发布 gate 分段——0.8.1/0.8.2 以确定性测试层为 gate，eval gate 自首个含 LLM 的 release 起强制；写进 CICD §12 的适用条件。

### Low（2）

**A06-6 [contradiction] 水印判据 status!=accepted 对 7 态状态机不自洽**：archived（曾 accepted）被误打 DRAFT 水印，rejected 的关键状态不传达（Report_Export:35,51-54 vs Report_Generation:263-267）。→ 水印按状态查表而非布尔。

**A09-5 [premature-assumption] ALERT-BATCH-001 "failed cells > stop_condition" 把整数与枚举比较**：stop_condition 是枚举，数值阈值在 failure_rate_threshold（Alerting:43 vs Parameter_Set:38）。→ 告警规则改为按 stop_condition 分支的显式判据。

---

## 2. PLAUSIBLE（24）——问题真实，严重度/可利用性待实现定夺【已全部处置】

> **处置状态（2026-07-02）：24/24 全部落修进 spec**——其中 4 条随 CONFIRMED 顺带修复，20 条本轮逐条落点
> （部分为把既有机制的决策点显式写死，如 A03-5 的防线分工、A07-4 的区间外事实声明，其余为新增规则/字段）。
>
> 随 CONFIRMED 顺带：A05-1（Scientific_Change_Gating §1.2 + Controlled_Search §2）·
> A02-1/A02-2（Park_Resume §2.1）· A03-6（Execution_Jobs_Runs §9.2 repos/* 只读）。
>
> 其余 20 条落点速查：
> - A01-3 → Minimal_Schemas §4：RunJob +stack_id/data_id（submit 时从 TaskCard 固化，collect 不回猜）
> - A02-4 → Park_Resume §8：collect.lock 统一为 job 级（与 Idempotency §5 对齐）
> - A02-5 → Control_Kernel §5.1：新颖失败预算——连续仅靠新失败签名的进展步 ≤3，超出只有实质进展能清零
> - A02-6 → Control_Kernel §5 + Zero_Reuse_Matrix §3：spawn 硬校验注入点 = ZeroHarnessAdapter.beforeToolCall
> - A03-5 → Preflight §4：preflight 挡计划错误；运行期越界由沙箱路径层拦（job 进程继承同一约束）
> - A04-1 → Report_Review §4：evidence_level 由 refs 目标对象派生上限，自填高于上限即拒
> - A04-2 → Context_Trust §2/§5.1：T1 note 内嵌 T4 定界片段不随 accept 洗白，进摘要器前剥除
> - A05-4 → Scientific_Change_Gating §1.1：output_semantics 入 floor 值域 + floor_categories 集合防类别被枚举序吞
> - A05-5 → Theory_To_Code_Governance §3：五个 *_review 态推进仅非 agent principal 可触发
> - A07-4 → Domain_CLI §5.2：加速线（db4ccdb）在区间外为显式事实，采纳必须走 bump 流程 + RELTOL 探针
> - A07-5 → Domain_CLI §5.4：回流触发确定性化——diff 触及契约面路径 → CI 强制 fixture 或 cli-impact:none 声明
> - A07-6 → Domain_CLI §2.1：run 输入 copy-in 隔离，ic.update 不回写源输入，inputs_digest 幂等保住
> - A08-3 → Snapshot §2：latest_seq 必填 + 事件总线临界区读取 + ndjson 裁剪不越最新 snapshot
> - A08-4 → Notification §5 + Idempotency §4：target_id 映射统一（critical_failure → error_id）+ 24h 风暴抑制
> - A08-6 → Scientific_Change_Gating §4：calibration 复核 gate 由派生 analysis_mode 确定性触发，非叙事检测
> - A09-2 → Observability §2.2：DuckDB 失败定死 degraded（可重建、不在关键路径）
> - A09-3 → Alerting §2 注：2×=UI exceeded / 3×=alert，有意两级非双写，约束 alert 档 ≥ UI 档
> - A09-6 → Alerting §2 注：RSS 分母按进程类型解析（容器 limit / RunJob.resources / 服务配置项），解析不到即 not_applicable
> - A10-2 → Agent_Behavior_Eval §3/§6：单轮 5/5 降格为冒烟信号，release 判据 = 7 天滚动窗口累计 0 失败；治理类禁减 repeats
> - A10-3 → Agent_Behavior_Eval §3：语义断言强制改写为确定性代理（子串/trace 事实），残余显式交 Reviewer/PI

| ID | 严重度 | 发现 | 关键证据 |
|---|---|---|---|
| A02-2 | high | plan_revision 后"重算 cursor"对自由文本 step-N 无稳定映射，必然重做或漏做 | Park_Resume:106,196 |
| A05-1 | high | 纯校准/敏感性任务 files_changed 为空集，floor 机制完全不参与，search 前置被限定为"依赖 ChangeRequest 时" | Scientific_Change_Gating:44、Controlled_Search:29 |
| A01-3 | medium | RunRecord 必绑 stack_id/data_id，但 RunJob schema 两者皆无，collect 时来源无处定义 | Minimal_Schemas:119,155 |
| A02-1 | medium | 幂等 key 引用的 plan_step_id 在任何 schema 中不存在，步骤无 ID 分配机制 | Idempotency:53 |
| A02-5 | medium | "新失败签名=进展"且签名含 command_digest，LLM 可换命令无限制造新签名绕 block | Control_Kernel:124-126 |
| A02-6 | medium | spawn 硬校验的注入点未定义（Zero spawn/wait 标"直接复用"，adapter 接口无校验方法） | Control_Kernel:110、Zero_Reuse_Matrix:113 |
| A03-5 | medium | preflight 是 submit 前一次性检查，管不住 job 运行期对 baseline/raw 的写 | Preflight:52,61 |
| A04-1 | medium | lineage guard 实现只查 refs 存在性 + 自填 evidence_level，不解析目标对象真实信任级 | Report_Review:93 vs Context_Trust:63 |
| A04-2 | medium | accepted MemoryNote(T1) body 可原样承载 T4 原文进 digest 摘要器，构成洗白链 | Context_Trust:120,31、Memory_Skills:48 |
| A05-4 | medium | floor 值域上限是 numerical_implementation，输出语义变更系统性落到 io_format（gate"视情况"） | Scientific_Change_Gating:34,56 |
| A07-4 | medium | 兼容矩阵钉死 3aec657，项目真正要用的加速线（RELTOL 钩子、omp Config C）在区间外 125 commit | Domain_CLI_Spec:4,175、SHUD 报告:131 |
| A08-3 | medium | snapshot.latest_seq 可选且与 ndjson 无原子契约，gap recovery 会静默丢/重放事件 | Snapshot_Recovery:31,69 |
| A08-4 | medium | critical_failure 通知 dedupe key 两份 spec 粒度矛盾（含/不含错误号），且都打不中"首次即报+抑制重复" | Notification:90 vs Idempotency:57 |
| A09-3 | medium | budget exceeded 阈值双写：2×（Cost spec）vs 3×（ALERT-LLM-004），同维度两套判据 | Cost:124、Alerting:47 |
| A09-6 | medium | ALERT-OOM-001 "RSS>80% soft limit" 分母跨四类部署环境未定义 | Alerting:38、Runbook:4 |
| A10-3 | medium | 多条 injection/governance eval 断言本质是语义判断（"无指令性转写"），确定性脚本判不了 | Agent_Behavior_Eval:18,49 |
| A02-4 | low | collect.lock 路径 task 级 vs job 级两文档不一致，batch 下共锁或漏锁 | Park_Resume:229 vs Idempotency:76 |
| A03-6 | low | coder 范围：Roles 说 worktree 内，沙箱白名单给到整个 repos/* | Roles:22、Execution:168 |
| A05-5 | low | bundle 8 个中间 review 态无角色门，agent 可自证走完 draft→awaiting_pi | Theory_To_Code_Governance:44 |
| A07-5 | low | 成果回流闭环靠自报 interface_impact + Reviewer LLM，无确定性触发点 | Domain_CLI_Spec:182 |
| A07-6 | low | shud run 侧产物 cfg.ic.update/bak 写回输入目录，二次 run 输入已变，digest 幂等破功 | SHUD 报告:117、Domain_CLI_Spec:18 |
| A08-6 | low | 叙事型/标签型 PI gate（calibration→validation 表述、下一步选择）只能靠 agent 自愿 emit | WebSocket:166、Interaction_Model:171 |
| A09-2 | low | DuckDB 损坏 ready 判定二义（not_ready｜degraded），与 Runbook"不停主流程"矛盾 | Observability:55、Runbook:134 |
| A10-2 | low | N=5、5/5 gate：10% 泄漏率有 59% 概率蒙混过关，撑不起"一次都不能破"；降 3 更糟 | Agent_Behavior_Eval:60,85 |

---

## 3. REFUTED（18）——被攻击但站住的面（存档价值：已考虑并被覆盖的证明）

| 指控 | 为何站住 |
|---|---|
| agent 可写 config/ 改 floor 配置 | 沙箱是白名单准入非黑名单排除，config/ 不在允许写枚举内 |
| Research_Object_Model 状态机漂移 | ROM 不在 canonical 排序表内，无权威地位 |
| collect 幂等 key 对空输出不稳定 | key 首段 job_id 已界定 scope，多重强制点堵死重复 RunRecord |
| 禁写路径锚定到不存在的目录 | preflight 必查项（raw_data_not_modified 等）不依赖字面路径前缀 |
| system prompt 快照违反纯函数 | prompt pack 变更 = stack 变更 = 新 session，旧 session 复用旧字节正是设计语义 |
| PI 编辑 digest 即升 T1 是橡皮图章 | digest 无论何态"可作线索不作证据"，lineage guard 无豁免条款 |
| "不得调隐藏容差"无阻断 | calibration + high-risk 必须引用 accepted_for_search bundle，参数白名单非 agent 单方决定 |
| lineage guard 无 ref→信任级判定点 | Domain_CLI_Spec 的 cli_version 戳 + 验收项"拒绝非 CLI 产出的 metrics"提供确定性锚 |
| 越权表述写成叙述句绕过 assertion | 稻草人：spec 明示 MVP 不承诺逐句回溯，主张本身没这么强 |
| draft pi_decision note 洗白通道 | pi_decision note 只能由 PI decision flow 产生（created_by:"pi" 硬约束 + endpoint 权限） |
| lineage 强制推迟 Phase 5 有空窗 | 报告子系统整体 Phase 5 才上线，上线即自带阻断 validator，无空窗 |
| 手写 metrics.yaml 伪造 T2 | Artifact_Registry §4：进证据位需 evidence_usable 链（registered by collect/CLI），手写文件不入链 |
| AutoSHUD 15 变量契约丢 eleveta | 15 变量是 Step4 校验下限非输出全集，SHUD 默认输出含 eleveta |
| 磁盘满仍可提交 job | preflight disk_free_threshold_passed 是确定性 submit 准入项 |
| closure 分类器打破"确定性分类"主张 | Error_Handling §5.1 范围限定 provider 错误；closure_verdicts 显式标注 LLM advisory 且隔离 |
| 治理 eval Phase 2-5 零保护 | 场景随依赖对象出现而增补是明文激活规则，非一次性前置 |
| Zero 复用等级两文档相反 | [E]=Extend（框架上扩展）与 [M]=需改造语义不同轴，每行已写明扩展内容 |
| MemoryNote 枚举与 Zero 矩阵不相交 | Zero 矩阵是迁移示意非 canonical 源，schema 以 Minimal_Schemas 为准已声明 |

---

## 4. 方法论备注

- 红队只读"本方面文档 + 全库 grep"，核验强制全库搜索交叉强制点——18/59 被证伪印证了单方面阅读的误报率（~31%），也说明规范体系的防御多为跨文档纵深，单文档可读性弱是结构性代价。
- 高发误报模式：漏看 Preflight_And_Mutation_Boundary（4 条）、漏看 canonical 排序声明（3 条）、把示意文档当权威源（2 条）。
- 本审查与 Agent_System_Audit_v0_8_3（10 维审计）互补：该审计以维度完备性为纲，本审查以攻击可达性为纲；A01-1/A05-2 证明 AGA-P0-2 的修复只走了半程。
