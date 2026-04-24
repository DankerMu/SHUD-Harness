# I-04 DoD、风险与迁移切换

## 模块状态标签
- **独立实现**：必须支持
- **ZeRo 参考实现**：可选
- **[R] 已实现可复用**：通用测试 / startup / supervisor 经验
- **[M] 需修改后复用**：基线测试、UI review flow
- **[N] 必须新增**：科研 DoD、切换策略、科研风险矩阵

## 1. Definition of Done（系统级）
系统达到“可用”的最低标准不是界面齐全，而是满足：

1. Commander 能围绕一个真实 SHUD 问题跨多个 episode 推进
2. Worker 能在 sandbox 中完成一次跨仓库小改动
3. Critic 能审查该改动并给出 revise / accept / reject
4. 至少 1 个 StackLock 被 benchmark 引用
5. 至少 1 个 JobSpec 经 local executor 完成 submit / watch / collect
6. 至少 2 个 DatasetManifest 完成 verify
7. 至少 1 个 CalibrationSpec 绑定 HoldoutPolicy
8. 至少 1 个 BenchmarkPolicy 包含 smoke / regression tiers
9. Evidence 入库显式检查 provenance completeness
10. 高风险动作可触发 Human Gate

## 2. 文档到代码的一致性要求
以下四者必须一致：
- 文档
- schema
- CLI / API
- 目录落点

不允许出现：
- 文档有对象，代码无 schema
- API 有资源，目录无对象存储
- UI 有页面，后端无治理逻辑

## 3. 风险矩阵
### 3.1 过度依赖 ZeRo
风险：系统身份被上游实现绑住  
控制：先定义抽象，再接 ZeRo wrapper

### 3.2 把通用 coding agent 当科研 agent
风险：能改代码但不会守科学边界  
控制：Research Constitution + BenchmarkPolicy + Human Gate

### 3.3 Memory 污染
风险：错误判断被固化  
控制：proposal-only + critic review + evidence link

### 3.4 Calibration 泄漏
风险：参数优化掩盖结构问题  
控制：CalibrationSpec + HoldoutPolicy + anti-leakage rules

### 3.5 Baseline 污染
风险：回归基线被无意覆盖  
控制：baseline overwrite 必须 gate

## 4. Cutover 策略
### 路线 A：Greenfield
- 新仓直接建设
- milestone 到位后逐步导入 SHUD repos / data manifests

### 路线 B：Zero fork
- baseline freeze
- 新增 `harness-*` / `shud-*`
- 逐步把 session-centric workflow 改为 RCS-centric
- `.zero` 与 `.shud-harness` / `shud-workspace` 并存过渡

## 5. 兼容切换建议
- 前期允许 `.zero` 保持 runtime state
- SHUD 领域对象一律进 `shud-workspace/`
- 中后期再决定是否完全移除 `.zero` 语义

## 6. 明确的“不通过条件”
出现以下任一项，都不能宣称系统进入科研 runtime 阶段：
- 结果无法绑定 StackLock
- 数据无法追溯
- calibration 没有 holdout
- benchmark 没有 baseline governance
- memory 仍可直接 verified create
- Human Gate 可被绕过

## 7. 项目管理层一句话判断
> 只有当结果被版本锁住、被数据 manifest 说明、由 JobSpec 可审计地执行、在校准边界内搜索、并受 BenchmarkPolicy 约束时，SHUD-Harness 才算从“智能脚本系统”升级为“科研运行时系统”。
