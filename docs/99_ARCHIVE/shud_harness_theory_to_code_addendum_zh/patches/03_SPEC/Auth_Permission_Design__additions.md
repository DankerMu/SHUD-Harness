# Patch: docs/03_SPEC/Auth_Permission_Design.md

## 目标文档

`docs/03_SPEC/Auth_Permission_Design.md`

## 补充目的

补充 scientific gate 权限和 comment 必填规则。

## 补充理由

SHUD 的关键风险在理论、公式、数值离散和代码语义映射，不应只依赖运行结果或参数搜索。

## 建议插入位置

PI gate / approval section 后。

## 建议新增内容

并入 `Scientific_Change_Gating_Spec.md` 中的 gate matrix、自动 gate 规则和 comment required rules。

## 验收标准补充


- [ ] Agent 不能 approve scientific gate。
- [ ] high-risk approve/comment required 规则生效。
- [ ] waived verification 必须 PI comment。
