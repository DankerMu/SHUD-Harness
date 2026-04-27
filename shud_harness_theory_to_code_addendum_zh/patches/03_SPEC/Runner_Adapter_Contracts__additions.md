# Patch: docs/03_SPEC/Runner_Adapter_Contracts.md

## 目标文档

`docs/03_SPEC/Runner_Adapter_Contracts.md`

## 补充目的

在 Runner submit 前加入 preflight guard，确保任务路径、bundle、baseline、checksum 和 eval script hash 已记录。

## 补充理由

SHUD 的关键风险在理论、公式、数值离散和代码语义映射，不应只依赖运行结果或参数搜索。

## 建议插入位置

Submit request 前或 submit flow 后。

## 建议新增内容

并入 `Preflight_And_Mutation_Boundary_Spec.md` 的 PreflightGuardResult 和必须检查项。

## 验收标准补充


- [ ] Runner submit 前执行 preflight。
- [ ] preflight fail 返回 ErrorRecord，不创建 running job。
- [ ] preflight artifact 进入 RunRecord lineage。
