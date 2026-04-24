# D-03 Experiments、Calibration 与 Holdout

## 模块状态标签
- **独立实现**：必须支持
- **ZeRo 参考实现**：无直接对应
- **[R] 已实现可复用**：无
- **[M] 需修改后复用**：无关键对应
- **[N] 必须新增**：CalibrationSpec、HoldoutPolicy、anti-leakage rules、promotion rules

## 1. 这一层为什么必须单独写
如果不把实验设计、参数校准和结构诊断分开，Agent 很容易：
- 用调参掩盖结构缺陷
- 用单事件过拟合制造“改进”
- 把 calibration 结果误写成 scientific truth

## 2. ExperimentSpec 的三类模式
### 2.1 Diagnostic Experiment
目标：诊断结构问题  
限制：不允许大范围自由调参

### 2.2 Calibration Experiment
目标：在受控参数空间内搜索  
要求：必须绑定 HoldoutPolicy

### 2.3 Engineering Validation
目标：验证跨仓库实现、输出契约、性能回归  
重点：兼容性、runtime、old-output、schema

## 3. CalibrationSpec
必须显式规定：
- allowed parameters
- forbidden parameters
- search space
- objective functions
- anti-leakage rules
- acceptance rules

## 4. HoldoutPolicy
必须显式规定：
- calibration basins/events
- holdout basins/events
- promotion rules
- 何时只能称“promising”
- 何时可称“validated”

## 5. 不允许的常见误用
- 用 hidden debug tolerances 参与 calibration
- calibration_set 与 holdout_set 重叠
- 单事件最优参数直接当默认参数
- training improvement 直接外推为 scientific improvement

## 6. 推荐的 promotion 词汇
- observed
- promising
- limited-support
- validated
- rejected

而不要一上来就写“proved / confirmed”。

## 7. 与 EvidencePacket 的关系
CalibrationSpec 的输出进入 EvidencePacket 时，必须附带：
- holdout status
- uncertainty note
- anti-leakage compliance

## 8. V1 最低要求
- 至少有 1 个 CalibrationSpec
- 该 spec 绑定 1 个 HoldoutPolicy
- validation report 能显示 holdout 是否运行
- claim promotion 规则显式依赖 holdout
