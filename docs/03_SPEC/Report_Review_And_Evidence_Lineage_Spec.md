# Report Review 与 Evidence Lineage 规范

**状态：** v0.8.1 P1 补充规范  
**适用范围：** EvidenceReport、Reviewer、PI gate、ReportExport、language guard。  
**目标：** 将报告中的关键陈述追溯到 RunRecord、metrics、figure、artifact 或 PI comment，避免 LLM narrative 脱离证据。

## 1. 报告陈述分层

报告正文中的陈述分为：

| 类型 | 示例 | 允许证据来源 |
|---|---|---|
| `run_fact` | “RUN-001 completed with exit_code=0” | RunRecord / RunJob |
| `metric_fact` | “water_balance_residual=0.0008” | metrics artifact |
| `visual_observation` | “hydrograph peak appears later” | figure + timeseries artifact |
| `limitation` | “only ccw 30-day window” | DataProvenance / TaskCard |
| `pi_decision` | “PI accepted this as tiny benchmark” | PiGateDecision / MemoryNote |
| `hypothesis` | “forcing interpolation may explain timing error” | PI comment 或明确 hypothesis |
| `unsupported` | 缺少证据 | 不得作为结论 |

## 2. Report assertion schema

```ts
interface ReportAssertion {
  assertion_id: string;
  report_id: string;
  section: string;
  text: string;
  assertion_type:
    | "run_fact"
    | "metric_fact"
    | "visual_observation"
    | "limitation"
    | "pi_decision"
    | "hypothesis"
    | "unsupported";
  evidence_level: "deterministic" | "llm_summary" | "pi_confirmed" | "hypothesis" | "unsupported";
  evidence_refs: string[];
  generated_by: "template" | "deterministic_script" | "llm" | "pi" | "reviewer";
}
```

MVP 不要求每句话都建 assertion，但报告中的关键指标、限制、PI 问题和建议必须有 evidence refs。

## 3. Reviewer lineage checklist

Reviewer 在将 report 从 `draft` 推到 `reviewed` 前必须检查：

- [ ] 每个 `metric_fact` 有 metrics artifact ref。
- [ ] 每个 `visual_observation` 有 figure/timeseries artifact ref。
- [ ] 每个 `pi_decision` 有 PiGateDecision 或 MemoryNote ref。
- [ ] `hypothesis` 没有被写成事实。
- [ ] `unsupported` 不出现在 summary 或 conclusion 中。
- [ ] report 中没有引用 `tmp/` 路径。
- [ ] report 中没有 secret、token 或敏感绝对路径。

## 4. Language guard 与 lineage guard

Language guard 只检查禁止用语是不够的。还应有 lineage guard：

```text
for each key claim:
  require evidence_refs
  require evidence_level != unsupported
  if evidence_level == llm_summary:
    require deterministic source underneath
```

## 5. Report export

Standalone HTML export 必须保留：

- report status；
- watermark；
- decision history；
- artifact manifest 摘要；
- key assertion evidence refs；
- generated/exported timestamp。

导出文件可以简化 assertion 展示，但不能丢掉 report status 和 draft watermark。

## 6. 验收标准

- [ ] Report reviewed 前执行 lineage guard。
- [ ] 关键指标没有 source_ref 时 report 不能进入 reviewed。
- [ ] PI comment 不自动进入 observations，除非标记为 `pi_decision` 或 `hypothesis`。
- [ ] HTML export 保留 evidence refs 或 manifest 摘要。
- [ ] language guard 和 lineage guard 均有负例测试。
