# 国际化与本地化

**状态：** P2 设计规范  
**适用范围：** Web UI、EvidenceReport、变量名、单位、错误提示、PI gate  
**目标：** 支持中文科研团队使用，同时保留英文文件名、schema 字段和代码接口。

## 1. 基本策略

- 代码、schema 字段、文件名、API endpoint 使用英文；
- UI 文本、报告正文、用户提示可中英文切换；
- 变量注册表同时提供中文显示名和英文显示名；
- 单位不翻译，但可解释；
- 报告中的专业术语保持一致。

## 2. Locale

建议支持：

```text
zh-CN
en-US
```

用户偏好记录在 profile 或 local settings 中。

## 3. 术语表

| 英文 | 中文建议 |
|---|---|
| EvidenceReport | 证据报告 |
| RunRecord | 运行记录 |
| StackLock | 技术栈锁定 |
| DataProvenance | 数据溯源 |
| PI gate | PI 审批门 |
| numerical health | 数值健康度 |
| water balance residual | 水量平衡残差 |
| hydrograph | 水文过程线 |
| sensitivity | 敏感性分析 |
| calibration | 校准 |
| benchmark | 基准比较 |

## 4. 报告语言

中文报告也必须遵守科研治理语言约束。禁止把“指标改善”写成“机制验证”。推荐模板：

```text
在当前流域、事件窗口和 StackLock 下，候选运行相对 baseline 在指定指标上改善。
该结果不构成对模型结构的普遍验证，仍需 PI 结合水文背景判断。
```

## 5. 文件名策略

为避免中文路径或下载链接在部分环境失效，建议：

- ZIP 文件名使用英文；
- Markdown 文件名使用英文；
- artifact 文件名使用 ID 和英文变量名；
- 报告标题和正文可以中文。

## 6. 单位展示

单位保持原始英文/符号形式，例如 `m3/day`、`m`、`m2`。UI tooltip 可以解释：

```text
m3/day：每天立方米，常用于 SHUD 河道流量输出。
```

## 7. 验收标准

- [ ] UI 可切换中英文核心文本。
- [ ] schema 字段不因 locale 改变。
- [ ] 变量有中文和英文显示名。
- [ ] 报告文件路径不使用中文。
- [ ] 中文报告仍包含 limitations 和 PI questions。
