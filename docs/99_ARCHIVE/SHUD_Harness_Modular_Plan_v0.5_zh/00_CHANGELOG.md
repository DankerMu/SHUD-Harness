# SHUD-Harness 模块化详细方案 v0.5 变更说明

## 相对 v0.4 的变化
1. 从**单主文档**拆分成**主索引 + 子文档**。
2. 把原先 `Observe → Decide → Act → Observe Result → Evaluate → Reflect → Update Memory / Skills → Decide Next`  
   重新定义为**runtime control kernel**，不再误写成固定科研流程。
3. 正式加入 `Wait / Monitor / Resume` 语义，使 `JobSpec / Executor` 成为一等公民。
4. 新增 ZeRo 当前实现基线分析，并将每个模块显式标成 `[R] / [M] / [N]`。
5. 新增“**无 ZeRo 独立实现**”路线，避免文档变成 ZeRo 的附属说明。
6. 把“ZeRo 能提供什么”和“SHUD-Harness 必须拥有的科研语义”严格拆开。
7. 对文档体系加入：
   - 代码仓与 package 落点
   - CLI/API 最小集
   - 切换 / 迁移 / cutover 策略
   - 模块状态矩阵附录

## 本版最重要的三条补充
### 1. 主 Agent 不应绑定固定科研流程
固定的是：
- 状态刷新
- 决策
- 执行 / 派发 / 等待
- 结果整合
- 评价与门控
- 停止条件
- 预算
- trace
- human escalation

不固定的是：
- 先做实验还是先补诊断输出
- 先校准还是先做结构诊断
- 先跑 smoke 还是先做兼容性回归

### 2. ZeRo 是参考实现，不是系统身份
本版明确：
- **不使用 ZeRo** 也应能实现完整 SHUD-Harness
- 使用 ZeRo 可以更快拿到：
  - agent loop
  - tool registry
  - bash
  - spawn/wait agent
  - scheduler
  - supervisor
  - web control plane
  - `.zero/skills` / `.zero/roles` / `.zero/memory`

### 3. 科研治理对象成为一等公民
本版不再只说“要有 evidence / benchmark / version lock”，而是要求这些对象进入代码与目录结构：
- StackLock / EnvLock
- DatasetManifest / ObservationManifest / PreprocessRecipe
- CalibrationSpec / HoldoutPolicy
- JobSpec / RunManifest
- OutputContract / CompatibilitySuite
- BenchmarkPolicy / ValidationReport / ReleaseGate
