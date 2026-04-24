# D-04 Benchmark、Validation 与 Release

## 模块状态标签
- **独立实现**：必须支持
- **ZeRo 参考实现**：部分参考 benchmarks 目录与 scheduler
- **[R] 已实现可复用**：benchmarks 目录组织、scheduler 触发能力
- **[M] 需修改后复用**：benchmark reports、web pages、trigger semantics
- **[N] 必须新增**：BenchmarkPolicy、BenchmarkReport、ValidationReport scientific layer、baseline governance、ReleaseGate flow

## 1. BenchmarkPolicy
BenchmarkPolicy 用于把 benchmark 从“团队共识”变成“可审计制度”。

建议字段：
- tiers
- cases
- thresholds
- baseline reference
- overwrite rules
- required metadata
- human gate conditions

## 2. 三层 benchmark
### 2.1 Smoke
用于快速回归：
- build
- tiny run
- schema sanity
- basic reader roundtrip

### 2.2 Regression
用于工程回归：
- old-output compatibility
- solver health delta
- runtime / memory delta
- fixed-case metric delta

### 2.3 Scientific
用于科学判断：
- cross-basin robustness
- cross-event robustness
- holdout behavior
- uncertainty-aware interpretation

## 3. ValidationReport
ValidationReport 必须分三层：
- software
- model
- scientific

其中 scientific 层至少包含：
- claim strength
- holdout status
- overfitting risk
- alternative explanation status

## 4. Baseline Governance
以下动作必须人工审批：
- overwrite baseline
- relax thresholds
- promote a scientific-tier benchmark to release gate reference

## 5. BenchmarkReport 最小绑定
一份有效 BenchmarkReport 应同时绑定：
- before stacklock
- after stacklock
- dataset / preprocess
- output contract version
- compatibility suite result
- validation report

## 6. ReleaseGate
ReleaseGate 是 benchmark / validation / gate 的交汇点。  
只有满足：
- validation pass
- compatibility pass
- no critical regression
- human gate satisfied
才允许进入 release / baseline promotion。

## 7. 与 ZeRo 的关系
ZeRo 可提供：
- 定时运行
- benchmarks 目录组织
- 工具调用与 Web 展示基础

但 SHUD-Harness 必须新增：
- benchmark object model
- policy tiers
- scientific interpretation layer
- baseline governance
- release gate

## 8. V1 最低要求
- 至少有 1 个 active BenchmarkPolicy
- 包含 smoke + regression 两层
- 至少有 1 份 BenchmarkReport 同时绑定 stacklock / dataset / preprocess / output contract
- baseline overwrite 能触发 gate
