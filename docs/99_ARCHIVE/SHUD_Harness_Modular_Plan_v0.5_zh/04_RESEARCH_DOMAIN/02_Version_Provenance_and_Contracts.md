# D-02 Version、Provenance 与 Contract 治理对象

## 模块状态标签
- **独立实现**：必须支持
- **ZeRo 参考实现**：无直接对应
- **[R] 已实现可复用**：无
- **[M] 需修改后复用**：observe / store / schema utilities 可借
- **[N] 必须新增**：StackLock、EnvLock、DatasetManifest、ObservationManifest、PreprocessRecipe、OutputContract、CompatibilitySuite、ReleaseGate

## 1. 这层为什么是硬底座
没有这一层，系统无法区分：
- 代码改进
- 环境漂移
- 数据版本变化
- 预处理变化
- 输出契约变化

## 2. StackLock
作用：
- 锁 repo commits
- 锁 runtime image
- 锁 compiler / R / Python / deps
- 作为 benchmark delta 的前置条件

最小字段：
- repos
- runtime
- dependencies
- fingerprint
- status

## 3. EnvLock
作用：
- 锁 mounts
- 锁 env vars
- 锁 resource limits
- 锁 network policy

它是 StackLock 的运行扩展层。

## 4. DatasetManifest
作用：
- 说明输入数据是什么
- 文件路径与 hash
- spatial/temporal metadata
- quality / QC
- lineage

## 5. ObservationManifest
作用：
- 说明观测真值来源
- 站点、时间范围、单位、质量
- 不确定性与说明

## 6. PreprocessRecipe
作用：
- 记录从 raw 到 model-ready 输入的处理链
- 防止“预处理变了”被误读成“模型变好了”

## 7. OutputContract
作用：
- 显式描述 SHUD 输出对 rSHUD / AutoSHUD 的消费契约
- 强制 additive-only 优先
- breaking change 必须升版本并 gate

## 8. CompatibilitySuite
作用：
- 固化 old-output fixtures
- 用制度而不是口头保证向后兼容

## 9. ReleaseGate
作用：
- 把“是否可进入 release / baseline promotion”显式对象化
- 绑定 validation / compatibility / human approval

## 10. 关键治理规则
### 10.1 没有 StackLock 的结果不能进 benchmark baseline
### 10.2 没有 Dataset / Observation / Preprocess 三件套的结果不能升级为 validated evidence
### 10.3 OutputContract 变更必须先跑 CompatibilitySuite
### 10.4 ReleaseGate 不能绕过 Human Gate

## 11. V1 最低要求
- 至少 1 个 StackLock 可 snapshot / verify / diff
- 至少 2 个 DatasetManifest 可 register / verify
- Evidence 入库前检查 provenance completeness
- ChangeSpec 能引用 OutputContract / CompatibilitySuite
