---
status: accepted
---

# ADR-0001: Agent 运行时基座与拓扑（Zero + 单 Coordinator 星型）

**状态**: accepted（2026-07-02） · **执行状态**: Trial，M1 spike 触发 revisit → 边界重划已裁决（2026-07-04），条 2' 绿后复判转正
· **决策人**: PI + 工程师 · **方法**: future-aware-architecture 分析
**事实基线**: zero@13e25c1（development 分支）· SHUD-Harness v0.8.3（97 篇 spec，零代码）

## 背景

三个约束的交集决定架构：**任务时间尺度倒挂**（LLM 秒级回合 vs SHUD 小时/天级运行）、
**科学正确性不可妥协**（错误结论比无结论更糟）、**1.5 人维护带宽**。
决策分类：complicated 而非 complex——领域工作流（建模→运行→分析→报告）结构已知，
不需要涌现式多 agent 协商；除运行时基座外，各项选择均为双向门。

## 决策

1. **拓扑**：单 Coordinator + spawn 深度 1 星型。治理、审计、成本三个单点收敛到一个 kernel。
2. **kernel**：任务驱动 + park/resume，弃长自主循环——状态归 harness，不归模型。
   （2026 年中 durable execution/HITL 成为主流框架一等公民，验证了该方向。）
3. **基座**：基于 Zero 扩展，评级 **Trial** 而非 Adopt——Week 1-2 spike 验证后转正。
4. **期权结构**：领域治理层（8 对象 + gate matrix + Domain CLI + T0-T4 信任分级）设计上
   运行时无关，是可平移资产——这使基座赌注保持双向门。

## 替代方案与否决理由

| 方案 | 否决理由 |
|---|---|
| 多 agent mesh / pipeline 编排 | "谁批准了什么"变成分布式问题；真实瓶颈是 PI 决策节奏与模型运行时长，不是 agent 间通信带宽 |
| Claude Agent SDK (TS) | 成熟、通用化（2026-06 起 SDK 用量单独计费）；否决理由=自有 Web UI 是产品本体而非附件 + 结构强制治理需 kernel 完全自控。**保留为回退目标** |
| LangGraph | durable execution / HITL 最成熟，但 Python 分栈违反 TS 单语言约束（1.5 人一套工具链） |
| 全自研 runtime | 带宽不允许；Zero 已有 ~7.6 万行可复用基础设施 |

## 实测事实（zero@13e25c1，2026-07-02 取证）

- 9 packages + 3 apps，核心模块实存（agent-loop / spawn-agent / session / memory / channel / observe）。
  上游活跃：本次同步吸收 117 commits（memory 治理重写 R2-R12 对抗加固、core 模块合并重构、
  后台工具完成事件、context 分段预算、DingTalk/Feishu 通道、secrets vault）。
- **上游正向本项目需求收敛**：memory 原生 `draft|verified|archived|conflict` 状态机 +
  governance/lifecycle 端点；`BackgroundToolTaskSink` + `background_tool_completed` 消息
  （park/resume 的天然接缝）；`ContextBudget` 分段预算 + session `context_compression`
  快照（与 session digest 对象同形）。
- **关键缝隙确认**：`AgentLoopHooks.onToolCallStart` 为 void 观测钩子，**不可否决**；
  可阻断缝 = `ToolBase.beforeExecute`（throw 即拒，逐工具模板方法）。中央策略门
  （`ZeroHarnessAdapter.beforeToolCall`）必须在工具注册层自建横切包装；`bash.ts` 无内置
  safety 逻辑，沙箱约束全部为 SHUD 侧扩展。

## 后果

- 正面：治理单点可审计；成本封顶（并发/深度硬限制）；领域层可平移。
- 负面（接受的债）：确定性映射表（semantic floor / 契约面路径集）随上游漂移的维护面；
  阶段重投影丢 warm context 的效果损耗（待实现期实测）；Zero 追 development 分支、
  无稳定 tag，只能以 commit 钉版本。

## Revisit 触发器

1. **Week 1-2 spike**（首项任务）：工具注册层中央策略门 + 一条治理规则端到端穿透。
   工作量超预期 → 启动 Claude Agent SDK (TS) 迁移评估。
2. Zero 上游停更或破坏性重构导致复用矩阵行失效超 1/3 → 同上。
3. submodule bump 频率 > 1 次/季 → 兼容矩阵与契约面探针自动化。
4. 多 PI 需求出现 → ACL 泛化（principal 化设计已留门）。
5. 模型层注入防护实质突破 → T4 处理可放宽（在此之前不放）。
6. `StackLock.llm` 升级且行为 eval 全量达标 → 触发能力护栏减重审查
   （[Control_Kernel §5.2](../02_ARCHITECTURE/Control_Kernel.md)，harness 评审 G5）——
   capability 类护栏逐项评估退役，authority 类不参与；护栏只增不减是另一种熵。

> **修订（2026-07-02，[ADR-0002](0002-mvp-reality-anchoring.md) D9）**：运行时模型定为 GLM 5.2
> （第三方 OpenAI 兼容端点）后，触发器 1/2 命中时"Claude Agent SDK (TS) 迁移"作为首选备胎的前提
> （Anthropic 生态运行时）不再成立。备选评估顺序改为：① **自建薄工具注册层**（provider 无关，
> 保留 Zero 其余复用面）；② Claude Agent SDK 迁移（仅当运行时模型回到 Anthropic 生态时才是候选）。

## Revisit 记录

### 2026-07-04: 触发器 1 命中（M1 policy-gate spike）

判定：Zero 基座不转正，保持 Trial；M1 后续策略门任务暂停到 enforcement boundary 重审完成。

证据：
- spike 条 1（工具注册层横切包装）已由 issue [#17](https://github.com/DankerMu/SHUD-Harness/issues/17)
  / PR [#43](https://github.com/DankerMu/SHUD-Harness/pull/43) 验证通过。
- spike 条 4（策略门纯函数核心）已由 issue [#18](https://github.com/DankerMu/SHUD-Harness/issues/18)
  / PR [#45](https://github.com/DankerMu/SHUD-Harness/pull/45) 验证通过。
- spike 条 2（`data/raw/**` 写禁区）在 issue [#19](https://github.com/DankerMu/SHUD-Harness/issues/19)
  / PR [#46](https://github.com/DankerMu/SHUD-Harness/pull/46) 中产生实现证据，但最终 comprehensive review
  + independent verifier gate 确认仍有 merge-blocking 问题。失败类别覆盖 executable payload writes、
  pipeline/stdin dataflow、dynamic write target、shell dynamic state、pre-existing filesystem alias，以及 raw-read
  compatibility false positives。
- spike 条 3（spawn 剖面超集拒绝，issue [#20](https://github.com/DankerMu/SHUD-Harness/issues/20)）未作为失败源执行；
  因条 2 已触发不绿分支而停止。
- spike 条 5 的确定性检查仍成立：`zero/` 无源码 diff，HEAD 保持 `13e25c1`；但五条全绿条件不满足。

结论：当前纯 pre-exec static scanner 不能同时满足"任意 bash 写入 `data/raw/**` 前置拒绝"、
"合法 raw 读取兼容"和"不实现 full shell parser"三项约束。#19 的当前 PR 仅作为 spike 证据保留，
不得按 authority implementation 合并。

下一步按 2026-07-02 修订注顺序评估：① 自建薄工具注册/执行边界，保留 Zero 可复用面，但把 raw-data
写保护放到可观测真实目标路径的执行层或 OS sandbox/read-only mount；② Claude Agent SDK 迁移仅在运行时模型
回到 Anthropic 生态时重新成为候选。

### 2026-07-04 裁决：边界重划，基座不换

按上节顺序完成评估，同日结案：

1. **根因是层错位，不是基座缺陷**。冻结 spec 早已分工——preflight 挡提交前可判定的计划性错误，
   运行期写入由沙箱路径策略拦截（[Preflight_And_Mutation_Boundary_Spec](../03_SPEC/Preflight_And_Mutation_Boundary_Spec.md)
   "preflight 是 submit 前的门，不是运行期防线"A03-5；[Sandbox_and_Executor §1](../03_SPEC/Sandbox_and_Executor.md)）。
   #19 将写禁区 authority 误置于 pre-exec 扫描层，是实施记录相对 spec 的漂移。"写哪些文件"是程序语义属性，
   对图灵完备的 shell 不可静态判定——该墙对两个备胎同样存在（任何 pre-exec 字符串门都撞；Claude Code 自身
   在 macOS 亦以 seatbelt 实现 bash 沙箱），故备胎评估关闭：不换基座。
2. **新 enforcement boundary（guard_class 两分落位）**：authority 类结构化校验（role→tool、spawn 剖面、
   结构化路径参数）留 pre-exec 策略核心（spike 条 1/4 成果继续有效）；bash 的 capability 约束下沉执行层——
   bash 工具 spawn 命令时施加 OS 沙箱 profile（macOS `sandbox-exec`/seatbelt：`(deny file-write*
   (subpath data/raw))`，子进程继承；包装在 SHUD 侧工具实现内，zero diff 仍 = 0）。pre-exec 静态检查
   降级 advisory（UX/remediation/audit 提示，fail-open），不再作为唯一 authority。
3. **实测证据（2026-07-04 本机 14 用例 probe）**：六类 blocker（解释器 payload、pipeline/stdin、动态目标、
   shell 状态与子/孙进程、symlink 与 `../` 别名、rename/unlink）全部 syscall 层 DENY，新建 hardlink DENY；
   合法 raw 读与 workspace 写 ALLOW（fail-closed 读误拒消失）。唯一原理性残留 = enforcement 生效前已存在的
   hardlink 别名——兜底 = ingest/readiness `nlink>1` 扫描 + DataProvenance 校验和交叉验证。
4. **执行状态**：Zero 维持 Trial；spike 条 2 重定为条 2'（执行层穿透，issue #19 已重定标；PR #46 按
   verdict 留作 spike 证据关闭不合并）；条 3（#20）与该墙无依赖，与其余 3.x/5.x 一并解冻按原依赖图恢复；
   条 2' 绿后基于五条重出判定再议转正。落账：Phased_Plan M1 条 2 行同步修订（账本例外批次 5）。
5. **迁移出口**：`sandbox-exec` deprecated-but-universal（Chromium/Bazel/Nix/Claude Code 在用）；
   若离开 macOS 单机形态，等价物 = Linux landlock/bwrap/ro-bind，authority 语义不变。

### 2026-07-04 裁决补充 / 2026-07-05 gate 收窄：可信可观测边界（PR #48）

条 2' 首个实现（PR [#48](https://github.com/DankerMu/SHUD-Harness/pull/48)）经六路 comprehensive review +
independent verifier 确认 4 条 merge-blocking finding，但它们是同一堵墙换位复发：wrapper 想从"命令文本 +
事后进程采样"反推**运行期真相**（seatbelt 拒没拒、后代跑没跑掉）——与被裁决否决的"从命令串反推写目标"同类，
同样不可静态判定。四条**无一击穿 raw 字节完整性**，据此把条 2' 的保证分层收窄：

1. **byte authority 不变（六类全守）**：raw 字节由 seatbelt 在 syscall 层拒写——穿 symlink（按真实路径拒）、
   超预算命令、继承 profile 的子/孙进程一律锁死。`cand-01`（symlink 假成功）、`cand-03`（超预算假成功）的
   字节均**未泄漏**，失败点只是 audit 标签记成 `allowed`；`cand-02` 的残留写只落 **workspace**（raw 仍锁），
   属生命周期问题非完整性问题。
2. **denial telemetry 收窄为可信可观测**：wrapper 仅对可信 raw-denial 证据源产 `tool.failed` + remediation +
   audit denial 行。当前 M1 可信源为 advisory/static 层提前捕获的同根 raw 写意图；`denied_by_sandbox` 预留给
   后续不可伪造的 OS 事件源。post-exec stdout/stderr/退出码可由被测命令伪造，因此只记录普通 lifecycle
   `failed` 事实，不得据此声明 `raw_data_write_denied` 或 `denied_by_sandbox`。子进程**吞掉** EPERM、抑制
   stderr、exit 0 的隐藏拒绝，当前 M1 wrapper 原语不能可靠观测 → 移出 #19。audit 行只记可观测事实（施加的
   seatbelt profile、退出状态、advisory 决策），不得声称已检出每一次被拒尝试。
3. **进程树生命周期所有权 deferred**：双 fork/setsid/会话分裂后代经 PPID 采样不可靠捕获——M1 不承诺阻止一切
   invocation-owned 后代在终态后写 workspace（raw 仍由继承 profile 守住）。为抓 cand-02 而收紧的
   process-creation preflight 误杀合法 **waited 前台子进程**（`cand-04`）须收窄，合法 workspace 写保持放行。
   完整所有权 = 需进程 supervisor / cgroup 等价 containment，归后续 executor/runtime。
4. **M1 验收核 = raw 字节完整性不变量**：任何 bash 调用及其后代不能改写 `data/raw/**` 字节——seatbelt 守住，
   四条 finding 未破。隐藏拒绝遥测与任意进程树所有权是**执行器/审计后端**能力，非 M1 wrapper 原语可诚实兑现，
   显式移出条 2'；四条 finding 按 acceptance-boundary 修正处置（非实现漏项，cand-04 随 preflight 收窄修复）。
   落账：Phased_Plan M1 条 2 行与 policy-gate-spike spec 同步（账本例外批次 5 延伸）。PR #48 基于更新后的
   boundary 重做实现并继续 gate。

## 参照

[Zero_Reuse_Matrix](../02_ARCHITECTURE/Zero_Reuse_Matrix.md) ·
[Control_Kernel §5](../02_ARCHITECTURE/Control_Kernel.md) ·
[Adversarial_Design_Review_v0_8_3](../00_INDEX/Adversarial_Design_Review_v0_8_3.md) ·
[Context_Trust §5.1](../03_SPEC/Context_Trust_And_Injection_Spec.md) ·
外部 2026 框架综述：morphllm / qubittool / developersdigest / alicelabs（检索于 2026-07-02）
