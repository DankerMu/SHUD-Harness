# R-05 Memory System

## 模块状态标签
- **独立实现**：必须支持
- **ZeRo 参考实现**：中强参考
- **[R] 已实现可复用**：memory store、memory search、memory read
- **[M] 需修改后复用**：create/update 语义、status lifecycle、retrieval policy
- **[N] 必须新增**：proposal-only scientific memory、epistemic claim model、review workflow

## 1. Memory 的角色
Memory 不是聊天记录，也不是任意 note。  
它是 Commander 的长期科研认知结构。

## 2. 推荐分层
### Working
当前 episode 的短期上下文

### Episodic
历史执行、失败、修复路径

### Procedural
skills 和高价值 scaffolds

### Epistemic
claim / evidence / counter-evidence / uncertainty / decision

### Semantic（轻量）
概念、变量、代码地图

### Meta（轻量）
harness 自我改进经验

## 3. 为什么必须 proposal-only
如果允许 Agent 直接写 verified memory，就会出现：
- 一次局部现象被写成长期知识
- 错误判断污染系统
- scientific claim 与普通 note 混在一起

因此长期 memory 必须走：

```text
propose
→ critic review
→ commander approve
→ optional human promote
→ canonical
```

## 4. Proposal 示例
```yaml
memory_proposal_id: MP-2026-00031
memory_type: episodic
status: proposed
claim: old-output compatibility failed after adding diagnostics reader
evidence:
  - validation_report_00042
critic_review:
  status: pending
```

## 5. Epistemic Memory 规则
### 5.1 claim 不能离开 evidence 独立存在
claim 必须绑定：
- supporting evidence
- weakened_by / counter evidence
- uncertainty context
- decision status

### 5.2 只有通过 holdout / policy 的 claim 才能升级
例如：
- promising
- validated
- rejected

### 5.3 不允许把 calibration 结果直接当成 structure truth
CalibrationSpec 的结果只能进入受限 epistemic memory，不得直接升级成“机制成立”。

## 6. ZeRo 映射
### [R] 可借
- memory store
- memory search
- memory read
- vector index（若后续需要）

### [M] 必须改
- `create` 默认 verified/confidence=0.85 的行为必须删除
- memory type 要支持 SHUD 分类
- retrieval 应按 state briefing / RCS / object graph 做过滤

### [N] 必须新增
- proposal workflow
- critic review of memory
- epistemic object schema
- promotion / deprecation lifecycle

## 7. 独立实现要求
- proposal repository
- promoted memory store
- retrieval API
- review actions
- status lifecycle

## 8. V1 最低要求
- Agent 不能直接 create verified scientific memory
- 至少支持 episodic / validated-evidence / procedural 三条长期主线
- memory review 有人工或 Commander 审批能力
