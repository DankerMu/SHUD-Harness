# Patch: docs/04_IMPLEMENTATION/DOD_and_Risks.md

## 目标文档

`docs/04_IMPLEMENTATION/DOD_and_Risks.md`

## 补充目的

将“高风险科学变更无 theory-to-code evidence”列为 release blocker。

## 补充理由

SHUD 的关键风险在理论、公式、数值离散和代码语义映射，不应只依赖运行结果或参数搜索。

## 建议插入位置

风险清单和完成定义部分。

## 建议新增内容


```markdown
## Theory-to-Code DOD additions

Release blocker:
- high-risk scientific ChangeRequest accepted without TheoryToCodeBundle;
- calibration/search report claims theory validation;
- failed VerificationCase hidden from EvidenceReport;
- output semantics changed without PI gate.

Done means:
- high-risk changes have bundle, mapping, verification evidence and PI decision;
- search is only run downstream of accepted_for_search or low-risk baseline analysis.
```


## 验收标准补充

- [ ] 合并后不破坏现有 8 核心对象原则。
- [ ] 高风险科学变更不能绕过 PI gate。
- [ ] Search/calibration 仍保持后置。
