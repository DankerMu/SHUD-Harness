---
status: frozen
canonical_for: [language-guard, reviewer-checklist]
---

# EvidenceReport 生成规范

**状态：** P1 设计规范  
**适用范围：** EvidenceReport、Markdown 投影、确定性 validator 与 PI 审阅；Reviewer preset 与完整 evidence lineage 属于后续里程碑。
**目标：** 将 deterministic evidence 与 LLM 叙述分离，避免 Agent 过度解释模型结果。

M3 设计依据见 [m3-mvp-1 design D7/D8](../../openspec/changes/archive/2026-11-01-m3-mvp-1/design.md#d7-evidencereport-生成模板与水印)，当前契约以 [evidence-reports](../../openspec/specs/evidence-reports/spec.md) 为准。`dsh-shud-tools` 已挂载 `report_generate`、`report_validate` 与 PI 终态工具 `report_submit` / `report_decide`；生成与校验不代行终态审批。已挂载工具用法见 [Repository Layout](../04_IMPLEMENTATION/Repository_Layout.md)。

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

M3 没有 metrics/图表/AnalysisPlan 生产者，不把这些作为生成前提；§5“指标与图表”固定说明本里程碑无指标 artifact，缺失写入 limitations。没有 RunRecord 的信息不能冒充已复盘结果。失败运行在渲染器/validator fixture 中保持可见；正常 report_generate 的 closure 已拒绝失败/取消运行。

## 3. 生成流程

```text
coordinator 提供叙述参数
→ 无副作用读取 TaskCard / 状态与 authored 品牌引用校验
→ 查询作业 / 新鲜同步 TaskCard reconcile（变化时独立提交）
→ 只读取已 collected 作业的规范 RunRecord / 保留 ledger 次数
→ 新鲜 TaskCard closure 检查
→ 确定性事实表与模板填充
→ 写 reports/<report_id>.json（draft）
→ TaskCard reporting / linked_reports 回写
→ 渲染同名 .md
→ report_validate 的 13 项确定性检查
→ reviewed
→ report_submit / report_decide 经宿主审批
```

工具不另调 LLM、不自行计算科学指标。引用参数中的 `TASK-/STACK-/DATA-/RUN-/JOB-/REPORT-` 品牌 id 逐一解析；缺失引用返回工具错误，不写 draft、不自动重试，由 coordinator 修正后重新生成。没有额外的 M3 artifact registry/hash 校验或 Reviewer preset 前置门。

报告 JSON 是提交点，其后 TaskCard/Markdown 失败不回滚已提交对象；下一次针对同报告的工具调用按 [写入与修复契约](../../openspec/specs/evidence-reports/spec.md) 修复。重新生成总是新 report_id，保留旧报告字节与决定历史，不把旧终态改回 draft。

`report_generate` 经 `collectShud(id, { readonly: true })` 只读取已 collected 作业的既有规范 RunRecord：缺失、损坏、不安全或身份不符均直接失败，不生成结果、不写失败 ledger、不投影作业状态、不完成登记回执、不通知。普通 `collectShud(id)` 与 `shud_collect` 仍保留原采集行为。保留的收集失败次数另经 `readCollectErrorAttempts(id)` 读取，即使已有成功 RunRecord 也参与 closure；耗尽或损坏 ledger 不会因缓存成功而被绕过。异步证据读取后新出现的作业链接使 closure 拒绝，不重试、不丢弃链接。JSON 提交后的失败明确返回 `report_id` 与 `task_card` / `render` 阶段。

`report_validate` 先执行卡片与 Markdown 首部修复，再检查新鲜报告是否为 draft。修复独立提交，后续前置条件或 validator 失败不撤销修复、也不改报告 JSON。卡片修复只使用既有合法转换，不重开 done/cancelled，不以较早已链接报告移动卡片；未链接终态报告先在内存中完成全部转换，再一次发布最终卡片。正确水印下的正文差异不触发修复。

校验结果为 `{ report_id, status, ok, checks }`，成功与检查失败都完整返回规范 13 项；检查失败保持 draft，而请求、前置条件与 IO 失败仍为工具错误。通过后仅提交 reviewed JSON 并更新 Markdown，不产生 PI 决定。raw-guard 在执行前保护生成的 reports 命名空间与本任务目标，以及校验的确切 JSON/Markdown 对和关联任务修复目标，写保护不提供审批绕过。

规范 `renderReport` / `validateReport` 及工具的入口 Markdown 修复、最终渲染共用无创建副作用的引用读取：报告、StackLock、DataProvenance 的路径安全、schema 与文件内 id 绑定由共享 readonly 工作区读取负责。缺失的 `reports` / `stacks` / `provenance` 目录保持不存在，包括配置为 raw 的引用根；不通过扩大 raw 拒绝范围或工具侧重复解析来掩盖读取副作用。普通三参数 `readWorkspaceRecord` 的既有创建目录行为不变。

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

## 4.1 Theory-to-Code Evidence 章节

本节为 M4 科学变更规划；M3 只有 science_assist 首任务，不引入 Theory-to-Code 生产者或据此增加 closure 前提。

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

高风险任务报告缺 Theory-to-Code Evidence 不能进入 reviewed。

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

下面的 metrics/figure 引用示例是后续分析产物规划；M3 仅列 RunRecord 中的真实产物元数据与日志路径，不创建这些示例文件。后续报告引用 artifact 时使用相对路径或 artifact id：

```markdown
见 `artifacts/metrics/RUN-001.yaml#numerical_health.water_balance_residual`。
```

图表可引用：

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

Markdown 由 JSON 及其引用记录确定性渲染；PI 通过 dsh 对话提供的路径或文件面板阅读。`export_manifest.yaml` 属于 M4 导出规划，不在 M3 生成，也不是 M3 验收前提。

**水印表（canonical，原 Report_Export_Spec §4 并入）**——按报告状态查表，7 态各有标记；布尔判据 `status != accepted` 已废除，它会把 accepted 后归档的报告误标为草稿（对抗审查 A06-6）：

| status | 文件内可见标记 |
|---|---|
| `draft` / `reviewed` / `awaiting_pi` | `DRAFT — not accepted by PI` |
| `accepted` | 无水印；首部一行 `Accepted by PI · <decided_at> · <decision_id>` |
| `revision_requested` | `REVISION REQUESTED — not accepted by PI` |
| `rejected` | `REJECTED — not accepted by PI` |
| `archived` | 按归档前终态显示（accepted → 接受标记；其余 → 对应水印），另加 `ARCHIVED` |

规则：水印是正文的一部分（标题下第一行 + 文末最后一行），不得仅靠样式/注释承载；accepted 例外按表只在首部显示接受标记。后续 artifact registry 的 evidence_usable 与小型图表内联规则不作 M3 前提；任何阶段不得内联完整 stdout/stderr、raw SHUD binary output、大型 timeseries 或 secrets。

M4 的 export manifest 规划记录 included/excluded artifacts；M3 仅引用 RunRecord 中的日志路径与产物清单，不读取/内联日志、raw 或求解器产物内容。`awaiting_pi` 保留水印渲染分支但只在审批卡挂起期间瞬时存在，M3 不将其落盘；`archived` 无 M3 状态转换生产者。

### Evidence Lineage

报告中关键陈述应建立 evidence lineage。ReportAssertion、assertion_type、evidence_level 和 lineage guard 的完整规范见 [Report_Review_And_Evidence_Lineage_Spec.md](Report_Review_And_Evidence_Lineage_Spec.md)。

## 8. Reviewer 检查清单

M3 的 draft → reviewed 唯一入口是 `report_validate`；每次列出全部 13 项结果，任一失败保持原状态，不消耗额外 LLM 调用。确定性 validator（D）：

1. StackLock 引用存在且 id 一致；
2. DataProvenance 引用存在；
3. 每个 linked_run 有 RunRecord；
4. 指标来自确定性 artifact（M3 无指标，恒真并明确标注）；
5. limitations 非空；
6. pi_questions 非空；
7. 模型撰写节无十条禁止用语，命中指出短语与字段；
8. 失败运行在“风险和失败项”列出（渲染/validator fixture 覆盖，正常生成仍受 closure 限制）；
9. 每个 dirty 仓库在 Markdown 有标注；
10. 关键指标有 source_ref（M3 无指标，恒真并明确标注）；
11. 图表观察有 artifact ref（M3 无图表，恒真并明确标注）；
12. 四句 GOVERNANCE_INVARIANTS 在渲染 Markdown 中逐字出现；
13. 整份 Markdown 不匹配 REPORT_SECRET_PATTERN；失败只指出所在节，不回显密钥匹配文本。

不按路径含 tmp 或位于 `$TMPDIR` 拒绝报告：scratch 工作区与运行目录是合法事实来源。语义判断（L）仍由 PI 审阅，M3 无 Reviewer preset：

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
- [ ] M4 export manifest 不作为 M3 验收前提。
- [ ] PI decision comments 在 §10 的六字段历史表中按 JSON literal 展示，与 observations 分离；空历史显示 `No PI decision recorded.`，不增加二级标题。
- [ ] accepted/null、rejected/revision_requested 非空批注、字符串 `"null"` 与 archived 继承展示正确；结构字符单次转义且重复渲染一致，源 JSON/引用记录字节和修改时间不变。
- [ ] comment 不扩大禁止用语检查的四字段边界；其中的密钥形态仍由既有检查诊断为 section10，且不回显值。
