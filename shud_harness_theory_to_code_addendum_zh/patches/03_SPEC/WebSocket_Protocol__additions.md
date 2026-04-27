# Patch: docs/03_SPEC/WebSocket_Protocol.md

## 目标文档

`docs/03_SPEC/WebSocket_Protocol.md`

## 补充目的

新增 Theory-to-Code 相关事件，让前端能展示 bundle、verification 和 scientific gate 状态。

## 补充理由

SHUD 的关键风险在理论、公式、数值离散和代码语义映射，不应只依赖运行结果或参数搜索。

## 建议插入位置

事件类型枚举后。

## 建议新增内容


```text
theory_bundle.status_updated
equation.dimension_check_updated
implementation_mapping.updated
verification_case.status_updated
verification_case.run_started
verification_case.result_recorded
scientific_gate.required
scientific_gate.decision_recorded
search_preflight.completed
```

所有事件沿用现有 envelope、seq、event_id、dedupe 规则。


## 验收标准补充

- [ ] 合并后不破坏现有 8 核心对象原则。
- [ ] 高风险科学变更不能绕过 PI gate。
- [ ] Search/calibration 仍保持后置。
