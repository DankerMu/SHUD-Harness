# D-01 Research Object Model

## 模块状态标签
- **独立实现**：必须支持
- **ZeRo 参考实现**：无直接对象层
- **[R] 已实现可复用**：无
- **[M] 需修改后复用**：少量可复用的 shared schema 工具
- **[N] 必须新增**：完整科研对象图谱

## 1. 为什么必须单独建对象层
没有对象层，系统最终会退化成“会跑 shell 的聊天机器人”。  
对象层的作用是把问题、实验、运行、证据、变更、验证、审批串成可追溯图谱。

## 2. 一级对象
- ResearchChangeSet
- ExperimentSpec
- JobSpec
- RunManifest
- EvidencePacket
- ChangeSpec
- ValidationReport

## 3. ResearchChangeSet（RCS）
RCS 是系统主对象，代表一个明确研究问题及其过程状态。

推荐字段：
- rcs_id
- title
- status
- research_intent
- hypotheses
- linked_stacklock
- linked_datasets
- linked_observations
- linked_experiments
- linked_evidence
- linked_changes

## 4. ExperimentSpec
ExperimentSpec 表达一个实验计划，而不是一次运行结果。

推荐字段：
- linked_rcs
- purpose
- datasets / observations / preprocess
- basins
- events
- treatments
- metrics
- decision rules
- holdout policy
- optional calibration spec

## 5. JobSpec
JobSpec 表达执行合同，而不是实验本身：
- backend
- mode
- command
- resources
- retry
- expected artifacts
- collection policy

## 6. RunManifest
RunManifest 表达一次具体运行结果：
- linked experiment / job / stacklock
- inputs
- outputs
- numerical health
- resources
- status

## 7. EvidencePacket
EvidencePacket 不等于报告全文。  
它是可机器引用的证据对象：
- main findings
- supporting artifacts
- provenance completeness
- claim strength
- limitations
- recommended next actions

## 8. ChangeSpec
ChangeSpec 描述一个工程改动的意图与影响：
- linked evidence
- scope by repo
- interface impact
- validation required
- compatibility suite
- human gate triggers

## 9. ValidationReport
ValidationReport 是对一次 change / run / benchmark 的正式评价：
- software layer
- model layer
- scientific layer
- required next actions
- pass / needs_revision / blocked

## 10. 对象之间的关系
```text
RCS
  ├── ExperimentSpec
  │     ├── JobSpec
  │     └── RunManifest
  ├── EvidencePacket
  ├── ChangeSpec
  └── ValidationReport
```

## 11. V1 最低要求
- 这些对象至少有 YAML schema + TypeScript/Python type
- Web / CLI / API 都能按对象 ID 查询
- 各对象之间关系可追溯
- 不能只在 message log 里存在，不落对象文件
