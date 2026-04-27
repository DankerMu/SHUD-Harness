# Patch: docs/02_ARCHITECTURE/Roles_and_Boundaries.md

## 目标文档

`docs/02_ARCHITECTURE/Roles_and_Boundaries.md`

## 补充目的

补充 Reviewer 的 Derivation/Implementation 审查职责，以及 Agent 禁止行为。

## 补充理由

SHUD 的关键风险在理论、公式、数值离散和代码语义映射，不应只依赖运行结果或参数搜索。

## 建议插入位置

Reviewer 和 PI 角色职责段落后。

## 建议新增内容


```markdown
### Derivation Reviewer responsibility

Reviewer 可检查：
- symbol/unit/dimension 是否完整；
- derivation steps 是否跳步；
- numerical scheme 是否列出 conservation/stability expectation；
- implementation mapping 是否覆盖 equation_id 和 code target；
- verification cases 是否覆盖关键风险。

Reviewer 不替代 PI 判断科学假设是否成立。

### Agent restrictions

Agent 不得：
- 将自己生成的 TheoryToCodeBundle 标记为 accepted；
- 将 calibration improvement 写成 theory validation；
- 修改 physical equation 后绕过 PI gate；
- 删除失败 verification 证据。
```


## 验收标准补充

- [ ] 合并后不破坏现有 8 核心对象原则。
- [ ] 高风险科学变更不能绕过 PI gate。
- [ ] Search/calibration 仍保持后置。
