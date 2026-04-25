# v0.6 Changelog

## 关键修订

### 1. 从“科研 Agent Runtime 平台”收敛为“PI 主导的科研工程助手”

v0.5 中 Commander 被赋予科研主控职责。v0.6 明确：

- PI 提出问题、设定实验方向、判断证据；
- Agent 负责执行协调、脚本生成、运行、日志解析、报告草拟；
- Reviewer/Critic 只做工程一致性检查和证据完整性提醒，不替代 PI 做科学判断。

### 2. 对象模型大幅压缩

v0.5 的对象包括 StackLock、EnvLock、DatasetManifest、ObservationManifest、PreprocessRecipe、CalibrationSpec、HoldoutPolicy、JobSpec、RunManifest、EvidencePacket、ChangeSpec、OutputContract、CompatibilitySuite、BenchmarkPolicy、ValidationReport、HumanGate、ReleaseGate、ArtifactManifest 等。

v0.6 压缩为 8 个核心对象：

1. TaskCard
2. StackLock
3. DataProvenance
4. RunJob
5. RunRecord
6. AnalysisPlan
7. EvidenceReport
8. ChangeRequest

其他治理关切改成字段、标签或 checklist。

### 3. Memory/Skill 治理降级

普通经验不再走多轮审批。v0.6 采用：

```text
普通经验：draft note → 人工可见 → 可检索
高价值结论：evidence note → PI review → accepted/rejected
Skill：draft → active → retired
```

不再默认使用 Critic + Commander + Human 的四级审批。

### 4. 明确 ZeRo 路线

MVP **不 fork ZeRo**。

理由：

- 团队规模小，维护 fork 成本高；
- SHUD 的核心痛点是数据、长任务、报告和版本，而不是 agent 平台能力；
- ZeRo 可作为参考实现，但不应成为第一阶段依赖。

### 5. 补齐科学计算特有问题

新增或强化：

- 长任务 Park/Resume；
- 数据存储策略；
- 失败恢复；
- 增量运行；
- 参数敏感性分析；
- LLM inference budget；
- 多用户轻量锁；
- Harness 自身版本锁。
