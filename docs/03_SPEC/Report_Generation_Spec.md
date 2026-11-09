---
status: frozen
canonical_for: [language-guard, reviewer-checklist]
---

# EvidenceReport 生成规范

**状态：** P1 设计规范  
**适用范围：** EvidenceReport、Markdown 投影、确定性 validator 与 PI 审阅；M4 增 code_change / VerificationCase，完整 evidence lineage 仍属后续里程碑。
**目标：** 将 deterministic evidence 与 LLM 叙述分离，避免 Agent 过度解释模型结果。

M3 设计依据见 [m3-mvp-1 design D7/D8](../../openspec/changes/archive/2026-11-01-m3-mvp-1/design.md#d7-evidencereport-生成模板与水印)，当前契约以 [evidence-reports](../../openspec/specs/evidence-reports/spec.md) 为准。`dsh-shud-tools` 已挂载 `report_generate`、`report_validate` 与 PI 终态工具 `report_submit` / `report_decide`；生成与校验不代行终态审批。已挂载工具用法见 [Repository Layout](../04_IMPLEMENTATION/Repository_Layout.md)。

M4 实现契约为 [evidence-reports](../../openspec/specs/evidence-reports/spec.md)。`report_generate` 已接入规范 code_change closure，`report_validate` 已执行下列 17 项检查；自动工程审批不等于 PI 验收，人工回放与限制见 [M4 验收记录](../Migration_Plan_dsh.md#m4-pi-acceptance)。M3 science_assist 的报告字节、七态水印与审批状态机保持不变。

## 1. 报告定位

EvidenceReport 是给 PI 阅读和决策的证据包，不是论文结论，也不是自动科学验证。报告应回答：

- 做了什么；
- 使用了什么 stack 和数据；
- 得到了哪些可复盘结果；
- 指标和图表显示什么；
- 哪些限制影响解释；
- 需要 PI 判断什么；
- 下一步建议是什么。

## 2. 输入依赖

M3 生成报告前必须通过 TaskCard closure 谓词，并解析其链接的 RunRecord、StackLock、DataProvenance。模型提供 summary、observations、limitations、pi_questions，事实表由记录确定性生成。

M5 的实现基线改为 collect 内生产 `runs/<run_id>/metrics.json` 与 numerical_health；各类型报告读取关联 RunRecord 的 metrics_summary 引用并复核文件 sha256，历史无指标记录仍可按既有任务 closure 渲染为 not_available，不回填。sensitivity 报告只按卡片链接读取唯一 AnalysisPlan，并引用由 report_generate 派生的 `reports/<report_id>.sensitivity.json`；重渲染安全读取引用文件并核对 sha256，不从模型文本重算。图表仍无生产者。没有 RunRecord 的信息不能冒充已复盘结果；sensitivity 的失败有效 run 与被取代失败运行按其专用 closure 保持可见，不套用 science_assist 的全部成功条件。权威见 [M5 report workspace files](../../openspec/changes/m5-oat-sensitivity/specs/evidence-reports/spec.md#requirement-report-workspace-files)。

M4 的 code_change closure 只按卡片链接读取 ChangeRequest、patch、VerificationCase，并复用既有运行与收集次数子句，按 [code_change closure](../02_ARCHITECTURE/Agent_Architecture.md#7-closure-判据) 六子句检查；VC 的 base/candidate BuildRecord 属于后续确定性事实表读取，不新增 build/pin/thread closure 条件。失败 VC 不阻止报告生成，但必须可见；缺失或不安全证据仍拒绝。`change_ids`、`verification_ids` 按首次出现顺序来自 closure 所用同一新鲜 TaskCard，保留 proposed CR 与 failed VC，不由模型提供；science_assist 报告两者为空。

本页 M5 输入与模板描述是实现前的书面契约；§3 整节记录当前 M4 实现（两类生成谓词、九类品牌引用、17 项 validator），不是 M5 的最终工具面。PLAN 引用、安全读取与 sensitivity 生成接线分别随 #656/#667 交付；validator 第 (16)/(17) 项已随 #658 交付，sensitivity 报告的工具生成路径仍待 #667。

## 3. 生成流程

```text
coordinator 提供叙述参数
→ 无副作用读取 TaskCard / 类型、状态与 authored 品牌引用校验
→ 查询作业 / 新鲜同步 TaskCard reconcile（变化时独立提交）
→ 只读取已 collected 作业的规范 RunRecord / 保留 ledger 次数
→ 新鲜 TaskCard closure 检查
→ 从规范 RunRecord / 新鲜卡片提取报告引用
→ 写 reports/<report_id>.json（draft）
→ TaskCard reporting / linked_reports 回写
→ 读取确定性事实表并渲染同名 .md
→ report_validate 的 17 项确定性检查
→ reviewed
→ report_submit / report_decide 经宿主审批
```

工具不另调 LLM、不自行计算科学指标。引用参数中的 `TASK-/STACK-/DATA-/RUN-/JOB-/REPORT-` 及 M4 `CHG-/VC-/BUILD-` 品牌 id 逐一解析；缺失引用返回工具错误，不写 draft、不自动重试，由 coordinator 修正后重新生成。M4 的 VC artifact 哈希复核仅限第 (15) 项，不扩展为通用 artifact registry 或语义审查。

仅 `science_assist` 与 `code_change` 有生成谓词；`engineering` / `ops` 在查询作业或对账前返回含实际类型的错误，允许的状态仍为 planned/running/reporting。九类品牌引用只匹配独立、格式合法的令牌，去重后经规范 readonly 读取校验；嵌入较长标识符的片段、畸形令牌和 DEC 不扩大为引用。缺失的 changes/verifications/builds 根不会因拒绝而创建。

报告 JSON 是提交点，其后 TaskCard/Markdown 失败不回滚已提交对象；下一次针对同报告的工具调用按 [写入与修复契约](../../openspec/specs/evidence-reports/spec.md) 修复。重新生成总是新 report_id，保留旧报告字节与决定历史，不把旧终态改回 draft。

`report_generate` 经 `collectShud(id, { readonly: true })` 只读取已 collected 作业的既有规范 RunRecord：缺失、损坏、不安全或身份不符均直接失败，不生成结果、不写失败 ledger、不投影作业状态、不完成登记回执、不通知。普通 `collectShud(id)` 与 `shud_collect` 仍保留原采集行为。保留的收集失败次数另经 `readCollectErrorAttempts(id)` 读取，即使已有成功 RunRecord 也参与 closure；耗尽或损坏 ledger 不会因缓存成功而被绕过。异步证据读取后新出现的作业链接使 closure 拒绝，不重试、不丢弃链接。JSON 提交后的失败明确返回 `report_id` 与 `task_card` / `render` 阶段。

`report_validate` 先执行卡片与 Markdown 首部修复，再检查新鲜报告是否为 draft。修复独立提交，后续前置条件或 validator 失败不撤销修复、也不改报告 JSON。卡片修复只使用既有合法转换，不重开 done/cancelled，不以较早已链接报告移动卡片；未链接终态报告先在内存中完成全部转换，再一次发布最终卡片。正确水印下的正文差异不触发修复。

M4 校验结果为 `{ report_id, status, ok, checks }`，成功与检查失败都完整返回规范 17 项；检查失败保持 draft，而请求根、前置条件、入口修复或结果发布失败仍为工具错误。VC artifact 的读取、摘要或描述符关闭失败属于第 (15) 项失败，不中断其余检查。通过后仅提交 reviewed JSON 并更新 Markdown，不产生 PI 决定。raw-guard 在执行前保护生成的 reports 命名空间与本任务目标，以及校验的确切 JSON/Markdown 对和关联任务修复目标，写保护不提供审批绕过。

规范 `renderReport` / `validateReport` 及工具的入口 Markdown 修复、最终渲染共用无创建副作用的引用读取：报告、StackLock、DataProvenance 的路径安全、schema 与文件内 id 绑定由共享 readonly 工作区读取负责。缺失的 `reports` / `stacks` / `provenance` 目录保持不存在，包括配置为 raw 的引用根；不通过扩大 raw 拒绝范围或工具侧重复解析来掩盖读取副作用。普通三参数 `readWorkspaceRecord` 的既有创建目录行为不变。

校验依据是当前 JSON/引用记录的规范渲染，不信任已有 Markdown 正文。第 (8)、(14) 项只查看模板拥有的 §7/§5 区间，模型文本中的伪造编号标题不能补齐证据。其它 stack/data/run/change/build 引用或渲染失败时仍返回全部 17 项，并独立检查每个可读 VC 的 artifact；已有成功事实读取可复用，不通过失败的上游投影跳过 artifact 检查。相对于成功入口修复后的基准，检查失败不再写报告、卡片或证据。

## 4. 报告模板

```markdown
# EvidenceReport: <title>

## 1. 摘要

## 2. 任务与问题

## 3. StackLock 与数据来源

## 4. 运行记录

## 5. 指标与图表

## 6. 观测与解释限制

## 7. 风险和失败项

## 8. 需要 PI 判断的问题

## 9. 建议下一步

## 10. 附录：命令、日志、artifact manifest

### PI decision history
```

§10 的展示权威为 [Decision history Markdown projection](../../openspec/specs/evidence-reports/spec.md#requirement-decision-history-markdown-projection)。`### PI decision history` 位于既有各 Run 命令、日志路径及 artifact manifest 块之前，不增加第十一个二级标题。非空历史按持久数组顺序展示 decision_id、report_id、outcome、decided_at、approval_ref、comment 六列，不排序、去重或推断；空历史精确显示 `No PI decision recorded.`，不伪造历史行。既有 Run 块、七态水印和终态历史约束不变。

comment 先表示为 JSON literal，再与其余五列一起经过既有结构化 metadata 单次转义：null 显示为 `null`，字符串 `"null"` 保留引号；原始空白、换行、反斜杠和引号以 JSON 转义保留。HTML、管道、反引号、反斜杠与物理换行不会生成新表格列或物理标题，模板样式文本不递归替换。该路径不是模型撰写的 prose；comment 不进入 §6 observations 或自动提升为科学解释，禁止用语检查仍只扫描原四个模型撰写字段，整份 Markdown 的密钥检查仍覆盖 §10。

M4 在 §3 增加三个确定性事实表段：ChangeRequest（含 floor_categories、patch 路径/摘要、状态与 approval_ref）、VerificationCase（两 run/build 引用、两个 SHA256、判定与 reviewer 字段）、BuildRecord（先 base 后 candidate，含 source_commit、rhs_openmp、make_argv、compiler、patch_sha256、binary_sha256）；StackLock 仅在 build_id 非 null 时展示该行。不内联 patch、编译日志或求解器输出；字段清单遵循 [Deterministic facts table](../../openspec/specs/evidence-reports/spec.md#requirement-deterministic-facts-table)。

M5 的 code_change 报告 §5 第一段逐字渲染更新后的 core 措辞常量（模板文本，不进入禁止短语集；删除旧“无指标”前缀，其余逐字不变）：

> 验证判定见 §3 VerificationCase 表。bitwise 一致只证明候选在 N=1 下与 serial baseline 输出一致，不构成并行正确性、性能或模型改进结论。

所有报告类型的 §5 均追加逐 run 指标表，按 linked_runs 顺序列出 metrics status、三项流量指标、numerical_health 四项与前三项判定，附 `runs/<run_id>/metrics.json` 路径和 sha256。数值原样采用源 JSON 的 JS 最短往返串，不舍入、补零或重新计算；null 单元格固定显示 `null` 并附源文件原因，缺 metrics 引用的 status 为 `not_available`。max_solver_dt 只展示值，不展示判定。sensitivity 另追加 `.sensitivity.json` 的 Δ 汇总表及路径/sha256；code_change 的固定句在逐 run 表之前，science_assist/sensitivity 不显示该固定句。详见 [Deterministic facts table](../../openspec/changes/m5-oat-sensitivity/specs/evidence-reports/spec.md#requirement-deterministic-facts-table)。

汇总只从唯一 plan 与有效 run 的 metrics 派生，按 pset 顺序每项一行。失败 cell 保留退出码/类别，指标与 Δ 为 null；被取代运行另列。Δ 只陈述单流域单窗口相对 baseline 的变化，不计算敏感性指数或排名。派生、null 原因和不可变文件边界见 [Sensitivity summary derivation](../../openspec/changes/m5-oat-sensitivity/specs/evidence-reports/spec.md#requirement-sensitivity-summary-derivation)。

确定性 limitations 在模型条目之后依次追加（[权威模板](../../openspec/changes/m5-oat-sensitivity/specs/evidence-reports/spec.md#requirement-deterministic-report-limitations)）：

1. sensitivity 恰一条覆盖声明，由 plan 的 project/end_days 与按 pset 顺序列出的非 baseline 键×倍率组成，明确未覆盖其它参数、取值与窗口。
2. sensitivity 恰一条“参数范围为 agent 建议值，未经 PI 确认”。
3. 所有类型每报告恰一条 max_solver_dt 在钉版 SHUD 不可观测的固定说明，不逐 run 追加。
4. 按 linked_runs 顺序，对 status: ok 的 metrics 按 residual、cvode、negative 顺序列出 warn/fail/not_available 的值或原因；成功但无 metrics 或 unavailable 的运行各一条原因。
5. sensitivity 按汇总 rows 顺序为每个失败有效 run 追加 pset/run/exit_code/exit_class 及不参与比较的说明。

非 sensitivity 不含第 1、2、5 类；追加条目写入报告 JSON 并在 §6 原样渲染，不凑 closure 的模型 limitation 计数。§7 保留失败运行与 failed VC 的 vc_id/failure_reason；sensitivity 另列被取代运行。M3 无变更引用/无 build 报告仍不增加 CR/VC/Build 段，但 M5 的逐 run 指标与确定性 limitation 会更新其渲染，不再声称全文字节不变。

## 4.1 Theory-to-Code Evidence 章节

本节完整 Theory-to-Code 章节是后续科学变更规划，不在 M4 已知答案回放中激活。M4 不生产 bundle，以 §3 的 CR/VC/Build 三段事实表与 §5 固定句承载证据（design D15(1)，M4 范围裁剪、非放宽 baseline）；M3 science_assist 不增加这些前提。

对以下任务类型（semantic_level），报告必须增加 `Theory-to-Code Evidence` 章节：

- physical_equation
- model_assumption
- numerical_implementation
- parameter_default
- output_semantics

建议模板：

```markdown
## Theory-to-Code Evidence

### Scientific question
...

### Assumptions and limitations
...

### Equation summary
- EQ-001: ...

### Derivation status
- DER-001: reviewed / revision_requested

### Numerical scheme summary
- finite_volume / ODE / boundary conditions / conservation expectations

### Implementation mapping
| equation | symbol | repo/file/function | semantics |

### Verification cases
| case | type | status | evidence |

### Benchmark / validation context
...

### What this report does not prove
- Verification passed does not prove model structure is universally true.
- Calibration improvement does not prove the physical hypothesis.
```

在完整 Theory-to-Code 范围激活后，高风险任务报告缺此章节不能进入 reviewed；M4 采用上面的替代契约，不要求不存在的 bundle 字段。

## 5. 语言约束

禁止用语：

- “模型机制已验证”；
- “普遍改进”；
- “校准证明结构正确”；
- “该参数就是真实物理原因”；
- “无需 PI 审查”。

推荐用语：

- “在该 basin/event/window 下”；
- “该指标改善/下降”；
- “该结果支持进一步检查”；
- “该解释需要 PI 结合水文背景判断”；
- “当前证据不足以支持普遍结论”。

### 5.1 Theory-to-Code 语言约束补充

禁止：

- “校准证明模型结构正确”；
- “verification 通过说明物理机制真实”；
- “该公式已经被模型结果证明”；
- “参数搜索确认了理论假设”；
- “无需 PI 审查即可接受该物理变更”。

允许：

- “该 verification case 支持代码实现满足指定公式/用例”；
- “在该 basin/event/window 下，candidate 指标相对 baseline 改善”；
- “该结果支持进一步检查假设，但不足以构成普遍结论”；
- “该解释需要 PI 结合水文背景判断”。

### 5.2 Language guard 能力边界

Language guard 是**枚举短语的确定性 lint**，必须清楚它能做什么、不能做什么：

- **能**：拦截 §5 / §5.1 枚举的十条禁止用语；在 draft → reviewed 前扫描模型撰写的 summary/observations/limitations/pi_questions，命中即拒绝迁移（负例测试见 TR-003）。不扫描固定治理不变式来误拒报告。
- **不能**：识别换一种说法的越权表述（paraphrase evasion）。LLM 把“已验证”换写成“表现出稳健的普适性改善”时，guard 不会命中。
- **因此**：guard 通过 ≠ 报告表述合规。PI 审阅是最终防线；完整 assertion/lineage guard 是后续里程碑规划，不能当作 M3 已交付的语义保障。

禁止用语的唯一实现来源是 core `governance/wording.ts` 的 `FORBIDDEN_REPORT_PHRASES`，与 `GOVERNANCE_INVARIANTS`、`REPORT_SECRET_PATTERN` 一起随 M3 常量切片交付；无 profile 覆写。新增短语需更新常量与正反例，放宽既有规则需独立 ADR。四句不变式逐字渲染，不能用语言模型判断代替确定性检查。

calibration 的 `analysis_mode` 与 assertion_type 结构化约束见 [后续 lineage 设计](Report_Review_And_Evidence_Lineage_Spec.md#4-language-guard-与-lineage-guard)，不在 M3 science_assist 报告字段中伪造。

## 6. 证据等级

| 等级 | 含义 |
|---|---|
| `deterministic` | 由脚本、RunRecord、metrics、图表 artifact 直接生成 |
| `llm_summary` | LLM 对 deterministic evidence 的摘要 |
| `pi_confirmed` | PI 明确接受或确认 |
| `hypothesis` | 待验证假设或下一步建议 |
| `unsupported` | 缺少证据，不应作为结论 |

报告正文中的关键陈述应标注证据等级。

## 7. Artifact 引用

M5 的逐 run 指标引用使用实际运行目录文件，读取时以 RunRecord.metrics_summary 的 sha256 核验，不构造旧 metrics YAML：

```markdown
见 `runs/<run_id>/metrics.json` 的 numerical_health.water_balance_residual。
```

图表仍是后续规划，不由 M5 创建。后续可引用：

```markdown
![Hydrograph](../artifacts/figures/RUN-001_rivqdown.png)
```

但图表生成参数必须在 manifest 中记录。

## 7.1 Standalone Report Export

M3 的规范对象与唯一阅读格式：

```text
<workspace>/reports/<report_id>.json
<workspace>/reports/<report_id>.md
```

Markdown 由 JSON 及其引用记录确定性渲染；PI 通过 dsh 对话提供的路径或文件面板阅读。`export_manifest.yaml` 属于后续导出规划，不在 M3/M4 生成，也不是回放验收前提。

**水印表（canonical，原 Report_Export_Spec §4 并入）**——按报告状态查表，7 态各有标记；布尔判据 `status != accepted` 已废除，它会把 accepted 后归档的报告误标为草稿（对抗审查 A06-6）：

| status | 文件内可见标记 |
|---|---|
| `draft` / `reviewed` / `awaiting_pi` | `DRAFT — not accepted by PI` |
| `accepted` | 无水印；首部一行 `Accepted by PI · <decided_at> · <decision_id>` |
| `revision_requested` | `REVISION REQUESTED — not accepted by PI` |
| `rejected` | `REJECTED — not accepted by PI` |
| `archived` | 按归档前终态显示（accepted → 接受标记；其余 → 对应水印），另加 `ARCHIVED` |

规则：水印是正文的一部分（标题下第一行 + 文末最后一行），不得仅靠样式/注释承载；accepted 例外按表只在首部显示接受标记。后续 artifact registry 的 evidence_usable 与小型图表内联规则不作 M3 前提；任何阶段不得内联完整 stdout/stderr、raw SHUD binary output、大型 timeseries 或 secrets。

后续 export manifest 规划记录 included/excluded artifacts；M3/M4 报告仅引用日志路径与产物清单，不内联日志、raw 或求解器产物内容，M4 比较器与第 (15) 项只读取目标 artifact 计算摘要。`awaiting_pi` 保留水印渲染分支但只在审批卡挂起期间瞬时存在，不将其落盘；`archived` 无 M3/M4 状态转换生产者。

### Evidence Lineage

报告中关键陈述应建立 evidence lineage。ReportAssertion、assertion_type、evidence_level 和 lineage guard 的完整规范见 [Report_Review_And_Evidence_Lineage_Spec.md](Report_Review_And_Evidence_Lineage_Spec.md)。

## 8. Reviewer 检查清单

`report_validate` 是 draft → reviewed 唯一入口；每次列出全部 17 项结果，任一失败保持 draft，不消耗额外 LLM 调用。确定性 validator（D）：

1. StackLock 引用存在且 id 一致；
2. DataProvenance 引用存在；
3. 每个 linked_run 有 RunRecord；
4. 指标来自确定性 artifact（由构造保证：指标只由事实表从 sha256 锁定的 `metrics.json` 与 `.sensitivity.json` 渲染，恒为通过并标注）；
5. limitations 非空；
6. pi_questions 非空；
7. 模型撰写节无十条禁止用语，命中指出短语与字段；
8. 失败运行与每个 failed VerificationCase 在“风险和失败项”列出；失败运行受生成 closure 限制，失败 VC 不被隐藏；
9. 每个 dirty 仓库在 Markdown 有标注；
10. 关键指标有 source_ref（由构造保证：每行带 source_ref，sha256 不符即渲染失败，恒为通过并标注）；
11. 图表观察有 artifact ref（报告无图表，恒真项并明确标注）；
12. 四句 GOVERNANCE_INVARIANTS 在渲染 Markdown 中逐字出现；
13. 整份 Markdown 不匹配 REPORT_SECRET_PATTERN；失败只指出所在节，不回显密钥匹配文本。
14. `change_ids` 非空时，Markdown §5 逐字含 code_change 固定句；为空时通过并标注不适用；
15. 按工作区文件安全规则读取每个 `verification_ids` 引用的 VC，校验 schema 及文件内 vc_id 与引用相等；其两个 artifact_refs 的每级路径组件与目标经 lstat 验证，不跟随链接，目标必须是会话 cwd 物理位置下的普通文件。按原 POSIX 路径组件遍历，不能把 `file/.` 或 `file/` 规范化为普通文件。使用 no-follow/nonblocking 打开、描述符身份校验及有界缓冲 SHA256；第一、第二项分别等于 observed.base_sha256/candidate_sha256。缺失、不安全、不可读、身份变化、摘要不符或关闭失败均使本项失败；空 verification_ids 时通过并标注不适用。
16. `sensitivity_summary` 非 null 时，渲染 Markdown 逐字含覆盖声明（只由 `.sensitivity.json` 的 `project`、`end_days` 与 `rows` 键和倍率经 core 模板实例化，不读 `analyses/`）与“参数范围为 agent 建议值，未经 PI 确认”；缺任一句失败并以 `sensitivity_statement_missing` 指出 `coverage` 或 `parameter_range`；`.sensitivity.json` 不可用而无法渲染时按渲染不可用失败；为 null 时通过并标注不适用。
17. `sensitivity_summary` 非 null 时，其 `path` 按工作区文件安全规则解析为普通文件 `reports/<report_id>.sensitivity.json` 且字节 sha256 等于引用值；缺失、不安全、不可读或不等时失败，诊断 `sensitivity_summary_invalid` 带该路径与 stage。该文件每次校验只读取一次，结果同时决定本项与第 (16) 项的渲染输入；sha256 相符但 JSON/schema 无效时本项通过、第 (16) 项按渲染不可用失败；为 null 时通过并标注不适用。

第 (15) 项的受控诊断包含 `vc_id`、零起始 `artifact_index`、相对 `path` 与失败 `stage`；路径中所有 `REPORT_SECRET_PATTERN` 命中替换为 `[REDACTED]`，普通相对路径保持原文。不返回解析后的绝对路径、原始系统异常或其 cause；多个路径脱敏后相同时仍由 VC 与下标区分。打开成功的描述符只尝试关闭一次，关闭失败不假定资源已释放、不盲目重试；路径与身份复查不构成针对外部并发写入的原子快照。第 (13) 项继续只指出节号，不回显匹配值。

第 (4)、(10) 项由构造保证、第 (11) 项为恒真项，均恒为通过并在结果中以 `vacuous` 标注，不伪造 artifact。不按路径含 tmp 或位于 `$TMPDIR` 拒绝报告：scratch 工作区与运行目录是合法事实来源。语义判断（L）仍由 PI 审阅，M4 reviewer 只补工程判定字段，不执行下列三项 LLM 语义判断：

- calibration 是否被换述为结构验证；
- PI comment 是否被误当科学事实；
- observations 是否有其它越权表述或因果跳跃。

## 9. 报告状态

```text
draft → reviewed → accepted | revision_requested | rejected
```

终态只由宿主审批结果授权写入：`report_submit` / `report_decide` 的审批为 allowed-once 时工具才执行；rejected/cancelled/无审批服务保持 reviewed，不写决定。模型不能绕开该工具路径直接声明 accepted。`awaiting_pi` 是审批卡挂起的瞬时状态，不落盘；没有 M3 archive endpoint 或归档生产者。

revision_requested 的报告保持该终态，TaskCard 回 planned；下一次 report_generate 分配新 report_id，不覆盖旧报告。新旧报告的延续关系未定义，不虚构父子字段。完整审批/comment 契约由 [M3 policy-gate](../../openspec/specs/policy-gate/spec.md) 定义。

## 10. 报告元数据

M3 EvidenceReport/PiGateDecision 字段以 [evidence-reports schema 契约](../../openspec/specs/evidence-reports/spec.md) 为准，由 core schema 切片同步 Minimal_Schemas 和生成投影。本文不保留另一套 export/actor/gate 元数据示例。

报告用品牌 REPORT id，决定用品牌 DEC id；decision_history 含 report_id、approval_ref、outcome、comment、decided_at。approval_ref 为本次工具执行 callId，经 session log asked.callId → asked.id → decided.id 关联审批；accepted 的 comment 为 null，rejected/revision_requested 必须非空。

报告 JSON 是提交与决定历史的权威源，session log 是实际批准关联的来源；Markdown 仅是这些持久字段的确定性展示，不新增审批 authority。规范渲染只读原有 JSON/引用记录与模板，保留输入字节和修改时间；每次新请求均包含历史，但不扫描或自动重写历史文件，也不增加正文差异的 staleness 判据或改变既有发布/修复流程。

## 11. 验收标准

- [ ] 报告不能在缺少 RunRecord 时标为 reviewed。
- [ ] LLM narrative 不负责计算指标。
- [ ] 确定性 validator 拦截禁止用语，PI 负责未枚举的语义越权。
- [ ] M3 science_assist 报告的 PI questions 必须非空。
- [ ] accepted/rejected/revision_requested 只由 allowed-once 授权的工具执行写入。
- [ ] M3 参数中的品牌 id 引用均存在：生成时逐一解析，虚构引用导致工具错误而非流入 draft（负例测试），不另称已验证任意路径或 artifact registry/hash。
- [ ] 每个 EvidenceReport 落为 standalone Markdown 文件。
- [ ] 七态逐一匹配水印表，包括 archived 的终态继承；awaiting_pi/archived 渲染覆盖不冒充 M3 转换已实现。
- [ ] 报告文件不包含 secrets、完整日志或 raw binary output。
- [ ] 后续 export manifest 不作为 M3/M4 验收前提。
- [ ] PI decision comments 在 §10 的六字段历史表中按 JSON literal 展示，与 observations 分离；空历史显示 `No PI decision recorded.`，不增加二级标题。
- [ ] accepted/null、rejected/revision_requested 非空批注、字符串 `"null"` 与 archived 继承展示正确；结构字符单次转义且重复渲染一致，源 JSON/引用记录字节和修改时间不变。
- [ ] comment 不扩大禁止用语检查的四字段边界；其中的密钥形态仍由既有检查诊断为 section10，且不回显值。
