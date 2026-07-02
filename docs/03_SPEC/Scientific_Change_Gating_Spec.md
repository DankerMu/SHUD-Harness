# Scientific Change Gating Spec

**状态**：v0.8.3 P0 补充规范  
**目标**：根据科学语义风险对 ChangeRequest 分级，并决定是否需要 Theory-to-Code Bundle、VerificationCase 和 PI approval。

## 1. Semantic level

```ts
type ChangeSemanticLevel =
  | "pure_engineering"
  | "io_format"
  | "output_semantics"
  | "numerical_implementation"
  | "parameter_default"
  | "physical_equation"
  | "model_assumption";
```

## 1.1 分类的确定性下限（semantic level floor）

**问题（AGA-P0-2）**：semantic_level 由 Coder（LLM）自填。若无制衡，agent 把物理语义改动标为 `pure_engineering` 即可旁路整条治理链。分类是治理链最弱环节，必须有机器强制的下限。

**机制**：维护确定性的 path → 最低 semantic_level 映射表（配置文件，非硬编码）：

```yaml
# config/semantic_level_floor.yaml（示例初值，随 ImplementationMapping 积累细化）
floors:
  - pattern: "SHUD/src/ModelData/**"        # 求解器物理/数值核心
    floor: numerical_implementation
  - pattern: "SHUD/src/classes/**"
    floor: numerical_implementation
  - pattern: "SHUD/input/**/*.para*"        # 默认参数文件
    floor: parameter_default
  - pattern: "SHUD/src/**/IO*"              # 输出格式
    floor: io_format
  - pattern: "rSHUD/R/*read*"               # reader 语义
    floor: io_format
  - pattern: "docs/**, scripts/**, templates/**"
    floor: pure_engineering
```

**强制规则**（harness 代码执行，不是 prompt）：

1. `effective_level = max(declared_level, max(floor(f) for f in files_changed))`。gate matrix 一律按 effective_level 求值。
2. files_changed 命中未登记 pattern 的求解器源码路径 → effective_level 至少 `numerical_implementation`，并要求 Reviewer 确认分类（保守默认）。
3. **降级需 PI**：agent 声明的级别低于 floor 时不报错，直接按 floor 执行；如确属误报（如纯注释修改），由 PI/工程师在 gate 上豁免并记录理由——agent 无降级权。
4. Reviewer validator（确定性）交叉核对 files_changed 与 effective_level，不一致即拒绝进入 reviewed。
5. ImplementationMapping 存在时，floor 表应从 mapping 的 code_targets 自动增补（equation 映射过的文件自动获得对应 floor）。

## 2. Gate matrix

| semantic_level | 需要 bundle | 需要 verification | 需要 PI gate | 能否进入 search |
|---|---:|---:|---:|---:|
| pure_engineering | 否 | 视情况 | 通常否 | 不相关 |
| io_format | 视情况 | 是，若影响 reader | 视情况 | 可以 |
| output_semantics | 是 | 是 | 是 | accepted_for_search 后 |
| numerical_implementation | 是 | 是 | 是 | accepted_for_search 后 |
| parameter_default | 是 | 是 | 是 | accepted_for_search 后 |
| physical_equation | 是 | 是 | 是 | accepted_for_search 后 |
| model_assumption | 是 | 是 | 是 | accepted_for_search 后 |

## 3. ChangeRequest additions

```ts
interface ChangeRequestScientificAdditions {
  semantic_level: ChangeSemanticLevel;
  theory_bundle_id?: string;
  verification_case_ids?: string[];
  implementation_mapping_id?: string;
  search_allowed_after?: "accepted_for_search" | "accepted";
  pi_gate_required: boolean;
  scientific_risk_summary?: string;
}
```

## 4. 自动 gate 规则

系统应自动生成 PiGate：

- semantic_level in `output_semantics | numerical_implementation | parameter_default | physical_equation | model_assumption`；
- benchmark baseline replacement；
- SHUD output variable unit/meaning change；
- rSHUD reader semantics change；
- VerificationCase waived；
- failed verification 仍想进入 search；
- Agent narrative 想把 calibration 写成 validation。

## 5. Comment required rules

PI decision comment 必填：

| 情况 | comment |
|---|---:|
| rejected | 必填 |
| revision_requested | 必填 |
| approve high-risk semantic change | 必填 |
| waive verification | 必填 |
| accepted_for_search despite inconclusive verification | 必填 |
| accepted report only | 可选 |

## 6. 禁止路径

```text
physical_equation ChangeRequest
→ no bundle
→ direct patch
→ sensitivity search
```

必须被拒绝。

```text
calibration improved
→ report says theory validated
```

必须被 language/lineage guard 拒绝。

## 7. 验收标准

- [ ] semantic_level 高风险但缺 bundle 时 API 返回 422。
- [ ] high-risk approve 无 comment 返回 400。
- [ ] Agent 角色不能 approve scientific gate。
- [ ] PI decision 写入 AuditEvent、MemoryNote、report decision history。
- [ ] search/calibration 前置检查 bundle status。
- [ ] 负例：files_changed 触及 floor=numerical_implementation 的路径而声明 pure_engineering → effective_level 按 floor 生效，gate 照常触发（EVAL-GOV-001）。
- [ ] agent 无法修改 semantic_level_floor 配置（路径在沙箱写禁区）。
