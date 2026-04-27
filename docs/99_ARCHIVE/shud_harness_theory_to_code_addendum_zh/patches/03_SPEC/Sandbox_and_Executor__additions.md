# Patch: docs/03_SPEC/Sandbox_and_Executor.md

## 目标文档

`docs/03_SPEC/Sandbox_and_Executor.md`

## 补充目的

补充 mutation boundary，防止 Agent 在搜索或代码改动中修改 raw data、baseline、eval script 或未授权公式。

## 补充理由

SHUD 的关键风险在理论、公式、数值离散和代码语义映射，不应只依赖运行结果或参数搜索。

## 建议插入位置

Diff policy 后。

## 建议新增内容

并入 `Preflight_And_Mutation_Boundary_Spec.md` 的 mutation boundary 表。

## 验收标准补充


- [ ] search/calibration 不能修改 solver source。
- [ ] code_change 只能改 worktree 中 ChangeRequest 指定范围。
- [ ] raw data/baseline 修改需要 PI gate。
