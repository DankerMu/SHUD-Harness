# I-03 分阶段实施计划（支持独立实现，也支持 ZeRo 加速）

## 模块状态标签
- **独立实现**：必须支持
- **ZeRo 参考实现**：可加速
- **[R] 已实现可复用**：runtime startup / agent loop / tool registry / web shell
- **[M] 需修改后复用**：bash / roles / memory / skills / web IA
- **[N] 必须新增**：research domain、versioning、provenance、benchmark governance

## 1. 总路线
分两条视角写：
- **P0 / P1 / P2**：能力闭环路线
- **Week 1–12**：工程实施路线

## 2. P0 / P1 / P2
### P0：tiny run / evidence loop
目标：
- commander → worker → bash
- run manifest
- evidence packet
- critic review
- memory proposal

### P1：cross-repo code change loop
目标：
- ChangeSpec
- SHUD / rSHUD / AutoSHUD worktree
- validation report
- compatibility suite
- benchmark before/after

### P2：harness self-improvement loop
目标：
- optimizer 读取失败 traces
- skill/context/scaffold 改进
- 对照 benchmark 验证优化有效

## 3. 12 周计划
### 第 1–2 周
- baseline freeze
- repo / package layout
- runtime startup
- basic loop + trace

### 第 3–4 周
- Commander / Worker / Critic profiles
- state briefing
- bash sandbox
- human gate 初版

### 第 5–6 周
- RCS / Experiment / Run / Evidence / Validation / Change
- YAML schema + types
- artifact manifests

### 第 7–8 周
- skills validator
- memory proposal workflow
- first canonical skills
- critic review loop

### 第 9–10 周
- StackLock / DatasetManifest / PreprocessRecipe
- local executor + JobSpec
- tiny loop 闭环

### 第 11–12 周
- CompatibilitySuite
- BenchmarkPolicy smoke/regression
- cross-repo change loop
- release / baseline gate 初版

## 4. Greenfield 实施建议
如果不使用 ZeRo：
- Week 1–2 先写 AgentKernel + ToolRegistry + Sandbox 接口
- Week 3–4 写 basic CLI + Web API + trace store
- 其余路线与上面保持一致

## 5. ZeRo 加速建议
如果使用 ZeRo：
- 先 fork baseline
- 保留 `apps/server`, `apps/web`, `apps/supervisor`
- 先新增 `harness-*` / `shud-*` 包
- 不要早期大改 `packages/core`
- 通过 wrapper / hooks 接入 SHUD 语义

## 6. 里程碑验收
### Milestone A
- loop 可跑
- bash 可控
- trace 可看

### Milestone B
- RCS / Run / Evidence / Validation 对象齐
- skills / memory proposal 能跑

### Milestone C
- StackLock / DatasetManifest / JobSpec / BenchmarkPolicy 实际被调用
- 形成一条真实闭环

## 7. 首个 demo 主题建议
仍建议围绕 **event-scale diagnostics** 做第一条闭环。  
理由：
- 覆盖跨仓库
- 不必一开始改物理方程
- 能覆盖 OutputContract / CompatibilitySuite / BenchmarkPolicy

## 8. 本计划的原则
- 先可控，再自治
- 先 tiny，再 batch
- 先 smoke/regression，再 scientific tier
- 先 proposal-only memory，再高级记忆检索
