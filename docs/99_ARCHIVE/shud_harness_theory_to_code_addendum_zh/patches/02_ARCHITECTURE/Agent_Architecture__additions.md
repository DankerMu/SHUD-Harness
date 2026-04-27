# Patch: docs/02_ARCHITECTURE/Agent_Architecture.md

## 目标文档

`docs/02_ARCHITECTURE/Agent_Architecture.md`

## 补充目的

让 Coordinator 在高风险科学变更时先创建 TheoryToCodeBundle，而不是直接进入代码/搜索。

## 补充理由

SHUD 的关键风险在理论、公式、数值离散和代码语义映射，不应只依赖运行结果或参数搜索。

## 建议插入位置

Coordinator decision tree 或 task planning 阶段。

## 建议新增内容


```markdown
### Scientific change routing

If task/change semantic_level is `physical_equation`, `model_assumption`, `numerical_implementation`, `parameter_default`, or `output_semantics`:

1. Coordinator creates or requests TheoryToCodeBundle.
2. Coder may only modify code after implementation_mapping is drafted.
3. Worker may run verification cases, not calibration/search, until bundle reaches accepted_for_search.
4. Reviewer checks theory-to-code lineage.
5. PI gate controls accepted/accepted_for_search.
```


## 验收标准补充

- [ ] 合并后不破坏现有 8 核心对象原则。
- [ ] 高风险科学变更不能绕过 PI gate。
- [ ] Search/calibration 仍保持后置。
