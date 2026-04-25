# EvidenceReport 生成规范

**状态：** P1 设计规范  
**适用范围：** EvidenceReport、ResultsPanel、report artifact、Reviewer  
**目标：** 将 deterministic evidence 与 LLM 叙述分离，避免 Agent 过度解释模型结果。

## 1. 报告定位

EvidenceReport 是给 PI 阅读和决策的证据包，不是论文结论，也不是自动科学验证。报告应回答：

- 做了什么；
- 使用了什么 stack 和数据；
- 得到了哪些可复盘结果；
- 指标和图表显示什么；
- 哪些限制影响解释；
- 需要 PI 判断什么；
- 下一步建议是什么。

## 2. 输入依赖

生成报告前必须具备：

```text
TaskCard
StackLock
DataProvenance
RunRecord 或 AnalysisPlan result
metrics artifact
artifact manifest
log summary
```

缺少 RunRecord 的结果只能进入“待验证/未复盘信息”部分，不能进入 evidence section。

## 3. 生成流程

```text
collect deterministic artifacts
→ build report facts table
→ run report language guard
→ LLM draft narrative
→ deterministic citation/reference insertion
→ Reviewer check
→ PI review
```

LLM 不应自行计算指标；指标由脚本或 rSHUD pipeline 生成。

## 4. 报告模板

```markdown
# EvidenceReport: <title>

## 1. 摘要

## 2. 任务与问题

## 3. StackLock 与数据来源

## 4. 运行记录

## 5. 指标与图表

## 6. 观测与解释限制

## 7. 风险和失败项

## 8. 需要 PI 判断的问题

## 9. 建议下一步

## 10. 附录：命令、日志、artifact manifest
```

## 5. 语言约束

禁止用语：

- “模型机制已验证”；
- “普遍改进”；
- “校准证明结构正确”；
- “该参数就是真实物理原因”；
- “无需 PI 审查”。

推荐用语：

- “在该 basin/event/window 下”；
- “该指标改善/下降”；
- “该结果支持进一步检查”；
- “该解释需要 PI 结合水文背景判断”；
- “当前证据不足以支持普遍结论”。

## 6. 证据等级

| 等级 | 含义 |
|---|---|
| `deterministic` | 由脚本、RunRecord、metrics、图表 artifact 直接生成 |
| `llm_summary` | LLM 对 deterministic evidence 的摘要 |
| `pi_confirmed` | PI 明确接受或确认 |
| `hypothesis` | 待验证假设或下一步建议 |
| `unsupported` | 缺少证据，不应作为结论 |

报告正文中的关键陈述应标注证据等级。

## 7. Artifact 引用

报告引用 artifact 时使用相对路径或 artifact id：

```markdown
见 `artifacts/metrics/RUN-001.yaml#numerical_health.water_balance_residual`。
```

图表可引用：

```markdown
![Hydrograph](../artifacts/figures/RUN-001_rivqdown.png)
```

但图表生成参数必须在 manifest 中记录。

## 8. Reviewer 检查清单

Reviewer 应检查：

- [ ] 是否有 StackLock；
- [ ] 是否有 DataProvenance；
- [ ] 所有结果是否绑定 RunRecord；
- [ ] 指标是否来自 deterministic artifact；
- [ ] 是否列出 limitations；
- [ ] 是否列出 PI questions；
- [ ] 是否存在禁止用语；
- [ ] 是否把 calibration 结果误写成验证；
- [ ] 是否包含失败运行；
- [ ] 是否清楚标注 dirty stack。

## 9. 报告状态

```text
draft
→ reviewed
→ awaiting_pi
→ accepted | revision_requested | rejected | archived
```

`accepted` 只能由 PI 或授权用户设置。

## 10. 报告元数据

```yaml
report:
  report_id: REPORT-001
  task_id: TASK-001
  status: draft
  created_at: ...
  generated_by: coordinator
  reviewed_by: reviewer_01
  accepted_by: null
  run_records:
    - RUN-001
  evidence_level: deterministic_plus_llm_summary
  limitations_count: 3
  pi_questions_count: 2
```

## 11. 验收标准

- [ ] 报告不能在缺少 RunRecord 时标为 reviewed。
- [ ] LLM narrative 不负责计算指标。
- [ ] Reviewer 能检测禁止用语。
- [ ] PI questions 必须非空，除非任务类型为纯 ops。
- [ ] accepted 状态需要权限。
- [ ] 报告引用的 artifact 均存在。
