# Patch: docs/03_SPEC/Frontend_State_Design.md

## 目标文档

`docs/03_SPEC/Frontend_State_Design.md`

## 补充目的

增加最小 Theory-to-Code UI state，让 PI/Reviewer 能看到科学链路状态。

## 补充理由

SHUD 的关键风险在理论、公式、数值离散和代码语义映射，不应只依赖运行结果或参数搜索。

## 建议插入位置

Entity cache / ResultsPanel 或 Report panel 相关章节。

## 建议新增内容


```markdown
## Theory-to-Code UI state

Entity cache 增加：
- theoryBundles
- equationSpecs
- implementationMappings
- verificationCases
- experimentLedgers

MVP 组件：
- TheoryBundleSummaryCard
- EquationSymbolTable
- ImplementationMappingTable
- VerificationCaseTable
- SearchPreflightBanner

Phase 3/4 可先以只读卡片实现，不阻塞 W1/W2 skeleton。
```


## 验收标准补充

- [ ] 合并后不破坏现有 8 核心对象原则。
- [ ] 高风险科学变更不能绕过 PI gate。
- [ ] Search/calibration 仍保持后置。
