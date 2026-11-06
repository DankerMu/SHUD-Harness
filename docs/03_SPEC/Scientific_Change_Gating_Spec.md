---
status: frozen
canonical_for: [scientific-semantic-levels]
---

# Scientific Change Gating Spec

**状态**：v0.8.3 P0 补充规范  
**目标**：根据科学语义风险对 ChangeRequest 分级，并决定是否需要 Theory-to-Code Bundle、VerificationCase 和 PI approval。

本页 M4 已知答案回放的具体范围以 [policy-gate](../../openspec/specs/policy-gate/spec.md) 与下列 M4 注记为准；相关工具已交付，人工功能验收见 [M4 验收记录](../Migration_Plan_dsh.md#m4-pi-acceptance)。M3 报告终态审批契约保持不变。通用 bundle/search 规则保留为后续范围，不冒充 M4 生产者。

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

**机制**：确定性的 path → 最低 semantic_level 映射落在仓库内受测常量模块，初值由下表约束；不是 profile/运行时可覆写配置。M4 仅观测 `repos/SHUD`，使用表中 SHUD 模式去掉 `SHUD/` 前缀后的相对源仓库根路径，以及 docs/scripts/templates 模式；rSHUD/AutoSHUD 条目不进入 M4 源检出工具。

```yaml
# 规范初值；M4 由 core 的受测常量与生成投影表达，不创建此 YAML 配置文件
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
   patch 项（[Preflight §1](Preflight_And_Mutation_Boundary_Spec.md) output_semantics 行）。类别不因枚举序被吞（对抗审查 A05-4）。

**M4 确定性落地（保留规则 2/6 原文）：** 每个路径取全部匹配条目的最大 floor，不采用首匹配；未匹配路径按规则 2 取 `numerical_implementation`。例如 `src/classes/Model_Control.cpp` 同时命中两档，最大值为 numerical_implementation，而 `floor_categories` 同时保留 output_semantics 与 numerical_implementation，按七档顺序去重排序。`Makefile`、`README.md` 未匹配同样取 numerical_implementation。`files_changed` 由工具观测生成，不接受模型路径列表；观测使用受控 git 的 porcelain `-z`，拒绝未忽略 untracked、删除、重命名，只接受已跟踪修改。申报低于 floor 自动抬升，不提供 M4 降级入口；Mapping 自动增补与 CommandTrace 对账不在本轮实现。floor/categories/风险校验只有一个 core 来源，具体规则见 [Semantic level floor](../../openspec/specs/change-requests/spec.md#requirement-semantic-level-floor)。

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
`parameter_effective_level = max(floor(p))`，高风险时按 §2 与 [Controlled_Search §2](Controlled_Search_Boundary_Spec.md) 要求 bundle；
该求值与 files_changed floor 相互独立、取并集生效。"hidden numerical tolerance 需 PI gate"
（[Preflight §1](Preflight_And_Mutation_Boundary_Spec.md) mutation boundary）由此获得确定性执行点。

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

**M4 bundle 免除（D15(1)）：** 本轮不生产 TheoryToCodeBundle，对 output_semantics 及以上的 bundle 门整体免除，以 `change_submit` 的 PI 审批卡替代 bundle → mapping → accepted_for_search 路由；VerificationCase.bundle_id 恒写 null。不开放 search/calibration，也不以该例外推导可无审批变更科学语义。这是 M4 范围裁剪、非放宽 baseline。

## 3. ChangeRequest additions

本节接口是未激活的 Theory-to-Code 扩展规划；M4 严格对象只接受 [Minimal_Schemas §8](Minimal_Schemas.md#8-changerequest) 字段，尤其不接受 theory_bundle_id、verification_case_ids、pi_gate_required 或其它无生产者扩展。

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
  触发条件是派生字段 `analysis_mode`（[Report_Review §2](Report_Review_And_Evidence_Lineage_Spec.md)，非 LLM 自填），不依赖叙事检测或 agent
  自愿 emit（对抗审查 A08-6）；narrative 级换述仍由 Reviewer (L) + PI 审阅兜底。

**M4 `change_submit`：** role-tool-surface 未 deny 后，策略门先按品牌 id 只读校验 CR 与 patch。两者可读且 patch SHA256 不符即 deny `change-patch-mismatch`，不弹卡；高风险五档返回 ask，displayReason 包含 floor_categories，文件缺失或损坏仍先 ask，执行时再明确失败。pure_engineering/io_format 在证据可读且摘要匹配时 next。工具执行时再次复核 patch，只有宿主放行后才原子写 proposed → approved、approval_ref = 本次 exec.callId。rejected/cancelled/unavailable 均不执行、CR 不变；danger-full-access 仍 ask。`change_create` 本身不 ask，候选 `shud_build` 只接受已批且摘要匹配的 CR。

Delegated coder 的 ask 可达性另由 [Coder 审批与运维边界](../02_ARCHITECTURE/Roles_and_Boundaries.md#61-delegated-coder-审批与运维边界) 的一次性初始化控制；这不改变上述 CR admission/写入规则，不覆盖 parent、显式或 restored never，也不把工程 answerer 的 allowed-once 当作 #549 PI 验收。

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

**M4 comment 偏离（D15(2)）：** 宿主审批卡没有 comment 通道，高风险 ChangeRequest 的 `allowed-once` 即批准，不要求落盘 comment；不是 agent 批准。拒绝时 CR 保持 proposed，PI 理由仅经对话由 coordinator 转述给 coder，不写入 CR/TaskCard/patch 或其它工作区文件，不新增 change_decide。报告 `report_decide(comment)` 的既有契约不变，见 [ADR-0011](../adr/implemented/0011-pi-comment-conversation-carrier.md)。这是 M4 范围裁剪、非放宽 baseline；其它通用 comment 要求不因此解除。

## 6. 禁止路径

```text
physical_equation ChangeRequest
→ no bundle
→ direct patch
→ sensitivity search
```

必须被拒绝。

M4 仅免除上述路径中的 bundle 前置，以 CR 的 PI 卡及确定性 VerificationCase 走已知答案回放；不存在从该例外进入 sensitivity/search 的入口。agent 不得直接把 CR 标为 approved 或改写治理文件。

```text
calibration improved
→ report says theory validated
```

必须被 language/lineage guard 拒绝。

## 7. 验收标准

M4 不以“高风险缺 bundle”或“批准缺 comment”判本轮失败；对应前两项通用验收暂不激活，替代判据是高风险 CR ask/非 allowed-once 不执行、patch 摘要不符 deny、VC 有真实证据且失败不隐藏。其余 scientific governance 边界继续有效（M4 范围裁剪、非放宽 baseline）。

- [ ] semantic_level 高风险但缺 bundle 时，在相应工具/校验前置阶段返回明确错误，不执行变更；不以 REST 422 为契约。
- [ ] high-risk approve 缺必需 comment 时校验拒绝，不关闭领域 gate；不以 REST 400 为契约。
- [ ] Agent 不自行 approve scientific gate；需审批的工具经 tools/pre-execute ask，只有宿主 allowed-once 才执行，其余 outcome/无服务 fail-closed，不以 agent principal 的 API 403 代替审批语义。
- [ ] 决定与批准证据可追溯：M3 为 session log 与 report decision_history，后续 AuditEvent/MemoryNote 不冒充当前已实现。
- [ ] 后续 search/calibration 工具执行前校验 bundle status，失败为工具错误、不启动搜索。
- [ ] 负例：files_changed 触及 floor=numerical_implementation 的路径而声明 pure_engineering → effective_level 按 floor 生效，gate 照常触发（EVAL-GOV-001）。
- [ ] 负例：worktree 实际改动 solver 路径但 files_changed 漏报 → observed 集仍触发 floor，且对账失败拒绝进入 reviewed（EVAL-GOV-005，对抗审查 A01-1）。
- [ ] 负例：AnalysisPlan.parameters 含 solver 容差键且无 accepted_for_search bundle → preflight 拒绝（对抗审查 A05-1）；含未登记键 → 直接 block。
- [ ] agent 无法通过 profile/运行时覆写 semantic level floor；M4 的表为仓库内受测常量，变更须走代码审查与投影漂移闸。
