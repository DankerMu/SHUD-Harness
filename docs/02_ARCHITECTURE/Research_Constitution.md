# 科研宪法与治理规则

> 权威规格见 `SPEC_v0.7_Final.md` Section 3。本文件提供补充说明。

## 1. 核心原则

### 1.1 研究问题优先
- 不允许没有问题意识的代码修改
- 不允许"先改再找理由"

### 1.2 证据优先
- 没有 baseline，不允许宣称改进
- 没有 water balance / solver health，不允许宣称模型更好
- 单一 basin / single event 提升，不允许外推为普遍改进

### 1.3 数据与版本优先
- 没有 StackLock 的结果不能进 validated benchmark
- 没有 DataProvenance 的结论不能升级为 validated claim

### 1.4 兼容性优先
- 影响 SHUD 输出消费路径的修改，必须先看 ChangeRequest.interface_impact
- additive change 优先
- breaking change 必须升版本并触发 PI 审批

### 1.5 人工责任边界
以下动作必须 PI 审批，Agent 不可自主执行：
- 修改物理过程实现
- 修改默认参数
- 覆盖 benchmark baseline
- 修改输出格式 (breaking)
- 删除原始数据

## 2. 风险分级

| 级别 | 动作 |
|------|------|
| **Low** | 读文件、写临时脚本、运行 tiny case、解析日志、生成报告草稿 |
| **Medium** | 修改 worktree 代码、增加 optional 输出、新增 regression case |
| **High** | 修改默认参数、修改物理方程、修改 output contract、baseline overwrite |

High-risk 动作一律需要 PI 审批。

## 3. 治理实现方式

v0.7 不再使用独立的 HumanGateRequest / ReleaseGate 对象。治理能力通过以下方式实现：

- **ChangeRequest.gates.needs_pi_approval** — 标记是否需要 PI 审批
- **ChangeRequest.risk** — low/medium/high 风险标记
- **EvidenceReport.pi_questions** — 明确需要 PI 判断的问题
- **TaskCard.status = awaiting_pi** — 任务状态机中的 PI 决策点

治理不靠对象数量，而靠关键字段必须存在、报告必须回答关键问题、高风险动作必须 PI approve。
