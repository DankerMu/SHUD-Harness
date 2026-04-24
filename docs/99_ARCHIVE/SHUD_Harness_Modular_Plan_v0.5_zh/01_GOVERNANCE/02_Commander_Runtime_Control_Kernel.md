# G-02 Commander Runtime Control Kernel

## 模块状态标签
- **独立实现**：必须支持
- **ZeRo 参考实现**：强参考
- **[R] 已实现可复用**：通用 while-loop、tool loop、continuation / closure control、spawn/wait agent
- **[M] 需修改后复用**：state briefing、domain hooks、tool-result integration、research-aware interruption
- **[N] 必须新增**：Wait / Monitor / Resume 的 job-aware 语义、proposal side effects、scientific graph binding

## 1. 这份文档要解决的问题
上一轮讨论里最关键的问题是：

> 主 Agent 是否需要固定流程？

结论是：

> **需要固定控制内核，不需要固定科研主流程。**

也就是说，主 Agent 必须有一个受控、可 trace、可停止、可预算、可审批的 runtime kernel；  
但不能把科研活动硬编码成线性流程。

## 2. 为什么旧八步法不够好
旧表达：

```text
Observe
→ Decide
→ Act
→ Observe Result
→ Evaluate
→ Reflect
→ Update Memory / Skills
→ Decide Next
```

问题不在于它错，而在于它容易被误读成“科研工作流本体”。  
真正的问题有三类：

### 2.1 它过于同步
现实里很多科研执行是异步的：
- submit batch run
- wait logs
- monitor job
- collect artifacts
- resume decision

### 2.2 它把高治理动作写成每轮必跑
`Reflect` 和 `Update Memory / Skills` 并不应该在每轮 read / grep / bash 后都发生。  
它们应该是**条件触发 side effect**。

### 2.3 它没有把 gate / stop / pause 写成一等公民
主 Agent 必须能：
- pause
- block
- escalate
- finish
- request human gate
- defer until job completes

## 3. 推荐的固定控制内核
```text
Refresh State
→ Observe
→ Decide
→ Act | Spawn | Wait
→ Integrate Result
→ Evaluate / Gate
→ Continue | Pause | Finish | Block | Escalate

[conditional]
→ Reflect
→ Propose Memory Update
→ Propose Skill Update
```

## 4. 每个状态的定义
### 4.1 Refresh State
刷新以下内容：
- active RCS
- latest experiments / runs / validations
- pending jobs
- pending human gates
- active budgets
- current StackLock / EnvLock
- unresolved critic issues
- queued user instructions

### 4.2 Observe
读取当前必要证据，不做长期承诺：
- 文件
- run status
- validation deltas
- compatibility results
- logs
- metrics summaries

### 4.3 Decide
在政策、预算、上下文和证据范围内选择下一步：
- bash direct action
- spawn worker
- ask critic
- submit job
- wait / resume later
- request human gate
- finish

### 4.4 Act | Spawn | Wait
- **Act**：短动作，直接 bash / read / edit
- **Spawn**：派发 Worker / Critic
- **Wait**：对长任务或外部条件进入等待态

### 4.5 Integrate Result
把不同来源的结果整合进当前 state：
- tool result
- worker report
- critic report
- job events
- artifact manifests
- validation results

### 4.6 Evaluate / Gate
判断：
- 是否达到 success criteria
- 是否需要补 benchmark
- 是否需要补 holdout
- 是否触发 human gate
- 是否需要 release gate
- 是否应进入 blocked / paused

### 4.7 Continue | Pause | Finish | Block | Escalate
这是主控必须能明确产出的终态：
- **Continue**：继续推进
- **Pause**：等待条件满足
- **Finish**：任务完成
- **Block**：缺少用户信息/权限/依赖
- **Escalate**：必须提交人工审批

### 4.8 Conditional side effects
只有在证据和治理条件满足时才触发：
- reflect
- memory proposal
- skill proposal

## 5. Scientific Work Graph：可变科研图谱
固定的不是实验路径；真正要允许自由跳转的是下图：

```text
RCS
↔ StackLock
↔ DatasetManifest / ObservationManifest / PreprocessRecipe
↔ ExperimentSpec
↔ CalibrationSpec / HoldoutPolicy
↔ JobSpec / RunManifest
↔ EvidencePacket
↔ ChangeSpec
↔ OutputContract / CompatibilitySuite
↔ ValidationReport
↔ BenchmarkPolicy
↔ Human Gate / ReleaseGate
```

Commander 的职责是沿着这个图谱做最有价值的下一步，不是执行一条先验线性脚本。

## 6. ZeRo 参考实现如何映射
### [R] ZeRo 已有的控制内核骨架
当前 ZeRo 的 `AgentLoop` 已经是一个有最大迭代数的循环，支持：
- buildRequestUserContent
- onEndTurn
- processToolResults
- afterToolResults
- shouldInterrupt
- onEmptyResponse  
并在非 `tool_use` 时通过 `onEndTurn` 判定 break / continue；在工具调用后执行 `processToolResults`、`afterToolResults`，并可通过 `shouldInterrupt` 提前收束。  
这说明 ZeRo 已具备“**固定 loop kernel + hooks**”的结构基础。  
参考：`packages/core/src/agent/agent-loop.ts`

### [R] ZeRo 已有的 task closure control
ZeRo 还提供 `finish / continue / block` 的 task closure 判定逻辑，并对研究/分析类任务额外要求“不能只给第一轮总结就 finish”。  
这个设计非常适合作为 SHUD-Harness 的**Finish/Continue/Block 基础语义**。  
参考：`packages/core/src/agent/task-closure.ts`

### [R] ZeRo 已有的 sub-agent orchestration
ZeRo 已导出：
- `SpawnAgentTool`
- `WaitAgentTool`
- `CloseAgentTool`
- `SendInputTool`  
可直接作为 Commander 派发 Worker / Critic 的基础。  
参考：`packages/core/src/index.ts`

### [M] SHUD-Harness 需要改造的部分
ZeRo 的 loop 仍是**通用对话/任务 loop**，还不是科研控制环。必须补以下改造：
1. State briefing 必须改成研究对象驱动
2. Wait 要能处理 `JobSpec / Executor`，不是只等 sub-agent
3. onEndTurn / shouldInterrupt 需要接入 validation / gate / evidence completeness
4. tool-result integration 要引入 artifact / run / validation / job event 归一化
5. memory/skill proposal 不能成为每轮都默认发生的动作

### [N] SHUD-Harness 必须新增的部分
- job-aware state machine
- scientific work graph binding
- proposal promotion workflow
- evidence completeness gate
- benchmark-aware stop / continue decision

## 7. 推荐伪代码
```python
while kernel.has_budget() and not terminal:
    state = refresh_state(rcs, jobs, validations, human_gates)
    observation = observe(state)
    decision = commander.decide(state, observation, memory, skills, policy)

    if decision.kind == "wait":
        kernel.pause_until(decision.resume_condition)
        continue

    result = execute(decision)   # bash / worker / critic / job submit
    integrated = integrate_result(state, result)
    gate = evaluate_and_gate(integrated)

    if gate.requires_human:
        request_human_gate(gate)
        terminal = gate.blocking
        continue

    if gate.finish:
        terminal = True
    elif gate.pause:
        pause(gate.reason)
    elif gate.block:
        block(gate.reason)

    if should_reflect(integrated, gate):
        propose_memory_updates(integrated)
        propose_skill_updates(integrated)
```

## 8. V1 必须做到的控制纪律
- 主循环可 replay
- 每轮 decision 有 trace
- 每轮 result 可追溯到 artifacts / logs / job events
- 有 stop conditions
- 有 pause / block / escalate
- Wait / Monitor / Resume 可用
- reflect 与 proposal 为**条件触发**

## 9. 与 ZeRo 结合时的实现建议
### 快速路线
- 保留 ZeRo `AgentLoop`
- 把 SHUD state builder 接到 hooks
- 把 task closure classifier 改成科研特化 prompt
- 复用 spawn/wait agent
- 新增 job wait 与 validation gate

### 独立路线
- 直接实现同等抽象：
  - LoopContext
  - LoopHooks
  - TaskClosurePolicy
  - AgentControl
  - SubAgentRegistry
  - JobWatchRegistry

## 10. 本文的最终要求
以后文档中若再写“主 Agent 固定流程”，应统一改成：

> **主 Agent 固定的是 runtime control kernel；科研路径由 Commander 在 scientific work graph 上动态决定。**
