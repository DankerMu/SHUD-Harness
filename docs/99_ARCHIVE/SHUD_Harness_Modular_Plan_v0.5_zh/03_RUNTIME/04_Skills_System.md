# R-04 Skills System

## 模块状态标签
- **独立实现**：必须支持
- **ZeRo 参考实现**：强参考
- **[R] 已实现可复用**：`.zero/skills/` 目录约定、`SKILL.md` + frontmatter loader
- **[M] 需修改后复用**：validator、lifecycle、promotion、tests、governance
- **[N] 必须新增**：candidate/tested/promoted/canonical/deprecated 生命周期与科研 skill contract

## 1. Skill 的定义
Skill 不是普通 prompt，而是可复用的**程序化能力单元**。  
它必须说明：
- 何时使用
- 何时不要使用
- 需要什么输入
- 产出什么输出
- 怎样验证成功
- 常见失败模式

## 2. 目录约定
```text
skills-src/<skill-name>/
  SKILL.md
  contract.yaml
  scripts/
  references/
  examples/
  tests/
  changelog.md
```

## 3. `SKILL.md` 最小 frontmatter
```yaml
---
name: diagnose-shud-run-failure
description: Use when a SHUD run fails, stalls, produces solver anomalies, or emits nonphysical diagnostic signals. Do not use for normal benchmark comparison.
---
```

可选字段可放扩展文件，不建议污染 canonical frontmatter。

## 4. 正文固定结构
- Purpose
- When to use
- When not to use
- Required inputs
- Procedure
- Expected outputs
- Validation
- Common failure modes

## 5. Skill Contract
每个 canonical skill 都应有 `contract.yaml`，至少写清：
- required inputs
- optional inputs
- required outputs
- success criteria
- risk level
- human gate triggers

## 6. 生命周期
```text
scaffold
→ candidate
→ tested
→ promoted
→ canonical
→ deprecated
```

## 7. 首批 canonical skills
1. run-shud-tiny-case
2. diagnose-shud-run-failure
3. rshud-roundtrip-test
4. add-shud-output-diagnostics
5. benchmark-before-after
6. build-provenance-complete-run

## 8. ZeRo 映射
### [R] 可借
- `.zero/skills/` 目录
- `SKILL.md` + YAML frontmatter loader
- `name/description/allowed-tools` 解析

### [M] 必须补
- 强 validator
- tests / smoke checks
- lifecycle state
- success rate tracking
- proposal workflow

### [N] 必须新增
- scaffold → skill promotion
- scientific risk tags
- skill governance dashboard

## 9. 独立实现要求
即使不使用 ZeRo，也要有：
- skill registry
- loader
- validator
- install / retrieve / promote / deprecate
- usage analytics

## 10. V1 最低要求
- 所有 promoted skill 都通过 validator
- 所有 canonical skill 都有 smoke test
- Worker 产生的高价值 scaffold 能提交 proposal
- Critic 能审查 promotion
