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
  - pattern: "SHUD/src/Equations/**"        # Van Genuchten / Manning 等物理方程实现
    floor: physical_equation
  - pattern: "SHUD/src/Model/**"            # 主求解循环 / 残差函数
    floor: numerical_implementation
  - pattern: "SHUD/input/**/*.para*"        # 默认参数文件
    floor: parameter_default
  - pattern: "SHUD/src/**/IO*"              # 输出格式
    floor: io_format
  - pattern: "SHUD/src/classes/Model_Control.*, SHUD/src/Equations/print.hpp"
    floor: output_semantics                 # 输出变量注册/Print 控制——改动即输出语义（对抗审查 A05-4）
  - pattern: "rSHUD/R/*read*"               # reader 语义
    floor: io_format
  - pattern: "rSHUD/R/WaterBalance.R, rSHUD/R/PET.R, rSHUD/R/Func_PTF.R"
    floor: numerical_implementation         # 物理后处理/参数转换——直接决定证据数值（对抗审查 A05-2）
  - pattern: "AutoSHUD/SubScript/Sub_iSoil*.R, AutoSHUD/SubScript/Sub2.1_*.R, AutoSHUD/SubScript/Sub2.2_*.R"
    floor: parameter_default                # 土壤水力/地表覆盖参数推导（ksat、Manning n 映射）
  - pattern: "AutoSHUD/Step3_BuidModel.R, AutoSHUD/Rfunction/Step3*.R"
    floor: parameter_default                # SHUD 输入生成——参数物理意义的落点
  - pattern: "docs/**, scripts/**, templates/**"
    floor: pure_engineering
```

**强制规则**（harness 代码执行，不是 prompt）：

0. **floor 的输入是观测集，不是自报字段**（对抗审查 A01-1）：
   `observed_files_changed = git diff --name-only`（ChangeRequest 对应 worktree，含 untracked），
   由 harness 在 preflight 与 Reviewer validator 运行时现场采集，CommandTrace.files_changed 作辅助对账源。
   下述规则的 floor 遍历一律在 observed_files_changed 上求值；`ChangeRequest.files_changed` 是申报字段，
   仅供人读与对账——Coder 漏报文件不改变 floor 结果。
1. `effective_level = max(declared_level, max(floor(f) for f in observed_files_changed))`。gate matrix 一律按 effective_level 求值。
2. observed_files_changed 命中三仓库（SHUD/rSHUD/AutoSHUD）任何未登记 pattern 的路径 → effective_level 至少
   `numerical_implementation`，并要求 Reviewer 确认分类（宁高勿低）。原"求解器源码路径"限定废除——
   R 脚本同样承载物理语义（对抗审查 A05-2）。
3. **降级需 PI**：agent 声明的级别低于 floor 时不报错，直接按 floor 执行；如确属误报（如纯注释修改），由 PI/工程师在 gate 上豁免并记录理由——agent 无降级权。
4. Reviewer validator（确定性）两步：① 对账 `ChangeRequest.files_changed == observed_files_changed`（集合相等；
   不等 → 拒绝进入 reviewed 并记录差集）；② 交叉核对 observed 集求得的 effective_level 与 gate 求值所用级别一致。
5. ImplementationMapping 存在时，floor 表应从 mapping 的 code_targets 自动增补（equation 映射过的文件自动获得对应 floor）。
6. floor 值域是 §1 全枚举（含 output_semantics）。max() 按枚举序取 effective_level 定 gate 强度；
   同时产出 `floor_categories`（命中的全部 floor 值集合）记入 ChangeRequest 并显示在 gate 卡片——
   命中 output_semantics 时即使 effective_level 被更高 floor 覆盖，bundle 仍须含 output registry
   patch 项（Preflight §1 output_semantics 行）。类别不因枚举序被吞（对抗审查 A05-4）。

## 1.2 参数语义下限（无 ChangeRequest 的 search 任务）

纯 sensitivity/calibration 任务不改代码，files_changed 为空集，§1.1 的 floor 完全不参与——对抗审查 A05-1
指出的旁路。补充机制：semantic_level_floor.yaml 增设 `parameters` 段，对校准参数键分级：

```yaml
parameters:
  registered_calib_keys:                     # SHUD .cfg.calib 的 38 因子（GEOL/SOIL/LC/TS/ET/RIV/IC/AQ）
    floor: none                              # 常规校准面：无需 bundle，越界由 search_scope 校验拦（Controlled_Search §2.1）
  solver_numeric_keys:                       # 求解器容差/步长类（MAX_SOLVER_STEP、CVODE 容差映射键等）
    floor: numerical_implementation          # 触及数值实现语义 → 需 bundle accepted_for_search + PI gate
  unregistered:                              # 未登记参数键
    action: block                            # 不得进入 search；先登记分级再跑（隐藏旋钮即注入面）
```

规则：AnalysisPlan preflight 对 `parameters` / `parameter_sets` 的全部键求
`parameter_effective_level = max(floor(p))`，高风险时按 §2 与 Controlled_Search §2 要求 bundle；
该求值与 files_changed floor 相互独立、取并集生效。"hidden numerical tolerance 需 PI gate"
（Preflight §1 mutation boundary）由此获得确定性执行点。

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
- 报告关联 `mode=calibration` 的 AnalysisPlan——gate 原因自动含 calibration≠validation 复核项。
  触发条件是派生字段 `analysis_mode`（Report_Review §2，非 LLM 自填），不依赖叙事检测或 agent
  自愿 emit（对抗审查 A08-6）；narrative 级换述仍由 Reviewer (L) + PI 审阅兜底。

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
- [ ] 负例：worktree 实际改动 solver 路径但 files_changed 漏报 → observed 集仍触发 floor，且对账失败拒绝进入 reviewed（EVAL-GOV-005，对抗审查 A01-1）。
- [ ] 负例：AnalysisPlan.parameters 含 solver 容差键且无 accepted_for_search bundle → preflight 拒绝（对抗审查 A05-1）；含未登记键 → 直接 block。
- [ ] agent 无法修改 semantic_level_floor 配置（路径在沙箱写禁区）。
