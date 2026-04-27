# Patch: docs/04_IMPLEMENTATION/Task_Playbooks.md

## 目标文档

`docs/04_IMPLEMENTATION/Task_Playbooks.md`

## 补充目的

增加科学语义变更 playbook，防止 Claude 直接从问题跳到 patch/search。

## 补充理由

SHUD 的关键风险在理论、公式、数值离散和代码语义映射，不应只依赖运行结果或参数搜索。

## 建议插入位置

现有 3 个 Task Playbook 后。

## 建议新增内容

并入 `Scientific_Change_Playbooks.md`。

## 验收标准补充


- [ ] physical equation playbook 包含 TheoryNote/Equation/Derivation/Scheme/Mapping/Verification/PI gate。
- [ ] calibration playbook 强制 baseline 和 accepted_for_search。
