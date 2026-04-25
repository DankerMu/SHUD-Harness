# UX 设计规格

**状态：** P1 设计规范
**适用范围：** PI/工程师在 Web 工作台中的完整交互体验
**目标：** 从用户视角定义交互模式、信息层级、反馈机制、注意力管理和决策支持，使 PI 能高效地驱动科研任务而不被系统复杂性淹没。

**效果图参考：** `docs/99_ARCHIVE/images/ChatGPT Image Apr 19, 2026, 10_53_22 PM.png`
**关联文档：** `Interaction_Model.md`（布局架构）、`UI_Implementation_Spec.md`（视觉实现）、`Frontend_State_Design.md`（状态管理）

---

## 1. 核心 UX 原则

| 原则 | 含义 | 反例 |
|------|------|------|
| **PI 在方向盘上** | PI 做科学判断，系统做执行 | 系统自动应用 calibration 参数为默认值 |
| **对话驱动，面板联动** | PI 说话 → 四栏同步更新 | PI 需要手动切页面查看结果 |
| **渐进呈现** | 先给结论，再给细节 | 一次性展开 50 个参数集的完整日志 |
| **不打扰，但不丢事** | 长任务静默执行，完成时恰当通知 | 每个 RunJob 弹一个 modal |
| **失败可见，不可伪装** | 失败项不从表中消失，不标为成功 | heatmap 悄悄跳过 failed cell |
| **可复盘** | 任何结论都能追溯到 RunRecord + artifact | 报告引用已删除的临时文件 |

---

## 2. 用户角色与心智模型

### 2.1 PI（主要用户）

```text
目标: 用自然语言提问 → 看到可信证据 → 做科学判断
心智模型: "我在和一个能跑模型的助手对话"
关注点: 结论是否可信、证据是否充分、下一步怎么做
不关注: Agent 内部协调、Zod schema、WebSocket seq
```

### 2.2 工程师（次要用户）

```text
目标: 调试运行、检查日志、修改代码、监控系统
心智模型: "我在一个集成了 IDE + terminal + dashboard 的工作台"
关注点: 日志细节、exit code、diff、构建产物
```

### 2.3 角色对 UI 的影响

| 功能区 | PI 视角 | 工程师视角 |
|--------|---------|-----------|
| AgentFeed | 读 Coordinator 摘要，跳过工具调用细节 | 展开每条看完整日志 |
| RuntimeTerminal | 收起，只在失败时展开 | 常开，实时跟踪 |
| ResultsPanel | 重点看指标卡和 NextAction | 重点看 heatmap 和参数表 |
| StatusBar | 看任务状态和预算 | 看 WS 连接和 job 进度 |

默认视图按 PI 需求优化；工程师通过展开/展开终端/debug 模式获取细节。

---

## 3. 用户旅程

### 3.1 首次使用

```text
PI 打开浏览器 → 进入 Dashboard (/)
  ↓
看到空态: 简洁插图 + "开始第一个科研任务"
  ↓
点击 "New Conversation" 或直接在输入框打字
  ↓
系统自动初始化 workspace（后台，PI 无感）
  ↓
PI 输入: "ccw 洪峰偏低，做敏感性分析"
  ↓
四栏开始联动: Feed 显示 Agent 消息 → Dashboard 出现实验头部 → Results 显示骨架屏
  ↓
等待 → 结果 → 审批 → 下一步
```

首次使用不需要配置向导。系统对 PI 的唯一前置要求是 workspace 中存在 SHUD/rSHUD 子模块和至少一个数据集。缺失时在 Feed 中用人类语言提示，不用错误码。

### 3.2 日常科研会话

```text
PI 打开工作台 → 自动恢复上次 session
  ↓
SideNav 显示历史任务列表 + Research Context
  ↓
PI 在输入框提问 → Coordinator 解析 → 执行 → 报告
  ↓
PI 审批 / 选下一步 / 切换到其他任务
  ↓
关闭浏览器 → 长任务继续运行 → 完成后邮件通知
  ↓
PI 重新打开 → 从 parked 状态恢复 → 查看结果
```

### 3.3 长任务等待

```text
PI 提交 sensitivity batch (9 组参数) → 预计 2 小时
  ↓
Feed: "已提交 9 组参数扫描，预计需要较长时间。您可以关闭浏览器，完成后会通知您。"
  ↓
Dashboard: BatchProgressGrid 出现，9 cell 全部 queued
  ↓
PI 选择:
  a) 留在页面 → 实时看 cell 状态变化
  b) 切换到其他任务 → SideNav 旧任务显示 ⏸ parked 图标
  c) 关闭浏览器 → 邮件通知
  ↓
重新打开 → Feed 顶部恢复摘要:
  "任务 TASK-003 的 sensitivity 分析已完成 (8 succeeded, 1 failed)，报告待审阅。"
```

### 3.4 审批决策

```text
Report 生成 → Feed 中出现 PI gate card
  ↓
PI 阅读 ResultsPanel 中的指标和图表
  ↓
PI 点击 "查看完整报告" → 右侧 Sheet 打开 report 全文
  或
PI 直接在 PIDecisionPanel 做决策:
  ↓
  approve (简单) → 可选 comment → 完成
  approve (高风险) → 必填 comment → 完成
  request_revision → 必填 comment，说明修改要求 → Coordinator 重新执行
  reject → 必填 comment → 任务结束
  ↓
决策记录进入 audit log + MemoryNote + report decision_history
```

---

## 4. 信息层级与渐进呈现

### 4.1 三层信息架构

```text
Layer 1 — 结论 (一眼看到)
  指标卡片 (NSE, Peak Error)、任务状态、审批按钮

Layer 2 — 证据 (一次点击)
  水文过程线、热力图、参数表、报告摘要

Layer 3 — 细节 (两次点击)
  完整日志、RunRecord YAML、diff、artifact manifest
```

### 4.2 各面板的信息层级

**AgentActivityFeed:**
```text
Layer 1: Agent 角色 + 一句话摘要 + 时间
Layer 2: [展开] → 工具调用结果、RunRecord 摘要、diff 预览
Layer 3: [查看完整日志] → 跳转到 artifact 或分页 API
```

内部事件 (`visibility: internal`) 默认隐藏。Feed 底部提供 toggle: "显示内部事件"。

**ExperimentDashboard:**
```text
Layer 1: 实验头部 (basin/event/status) + 水文过程线
Layer 2: RuntimeTerminal (默认收起) + 参数表 + BatchProgressGrid
Layer 3: cell detail panel (点击 cell) → 日志 tail、failure reason
```

**ResultsPanel:**
```text
Layer 1: 指标卡片 (4 个数字) + NextSuggestedAction
Layer 2: 对比图 + 热力图
Layer 3: 点击指标卡 → 展开来源 artifact ref + 历史趋势
```

### 4.3 空间优先级

屏幕空间有限时（小屏或面板被压缩），按优先级保留：

```text
1. PI 输入框 (始终可见)
2. 任务状态 + 审批按钮
3. 指标卡片
4. Agent 最新消息
5. 水文过程线
6. 参数表 / 热力图
7. RuntimeTerminal
8. 历史消息
```

---

## 5. 反馈模式

### 5.1 实时反馈矩阵

| 用户动作 | 即时反馈 (< 100ms) | 过程反馈 | 完成反馈 |
|----------|-------------------|---------|---------|
| 发送消息 | 消息出现在 Feed + 输入框清空 | Coordinator 消息 "正在分析..." | 任务创建确认消息 |
| 提交 RunJob | 按钮 loading 态 | Feed: "编译中..." → Terminal 日志流 | Feed: "运行完成" + Dashboard 图表更新 |
| 提交 batch | 按钮 loading 态 | BatchProgressGrid cell 状态实时变化 | 全部完成 → 通知 + report draft |
| PI approve | 按钮 loading → success 色 | — | Feed: "已批准" + 报告状态变更 |
| 导出报告 | 按钮 loading | — | 浏览器开始下载 + toast "导出成功" |

### 5.2 进度指示

| 场景 | 指示方式 |
|------|---------|
| 短操作 (< 3s) | 按钮 spinner |
| 中等操作 (3-30s) | Feed 消息 + StatusBar 状态更新 |
| 长操作 (> 30s) | BatchProgressGrid / Terminal 实时日志 + StatusBar job 计数 |
| 超长操作 (> 5min) | Park 提示 + 邮件通知选项 |

### 5.3 成功反馈

```text
短: toast (右上角, 3s 自动消失)
中: Feed 消息 (绿色左边框) + 指标卡片更新
长: Feed 摘要 + 全部图表更新 + PI gate card (若需审批)
```

### 5.4 失败反馈

```text
可恢复: Feed 消息 (红色左边框) + 推荐操作 ("查看日志" / "重试")
不可恢复: Feed 消息 + ExperimentHeader 红色 banner + 推荐 "联系工程师" 或 "调整参数"
critical: blocking modal (仅 workspace 损坏等极端情况)
```

失败消息必须用人类语言，不用错误码开头：
```text
✗ "SHUD 运行失败，可能是输入文件路径不正确。查看日志 →"
✓ 而非 "ERR-001: runtime_error: SHUD exited with code 1"
```

---

## 6. 注意力管理

### 6.1 打扰等级

```text
Level 0 — 静默: 写入日志，不推送到前端
  例: 内部 tool 调用成功、heartbeat

Level 1 — 被动可见: 更新 UI 但不抢焦点
  例: job status 变化更新 BatchProgressGrid cell、cost 更新

Level 2 — 主动可见: Feed 新消息 + 面板更新
  例: RunRecord 创建、report draft 完成、Agent 摘要

Level 3 — 需要注意: 视觉强调 + 可选声音
  例: PI gate required、critical failure、budget exceeded

Level 4 — 必须行动: 前端卡片 + out-of-band 通知
  例: PI approve needed (report ready)、critical failure (浏览器关闭时)
```

### 6.2 通知渠道与场景

| 场景 | 浏览器打开 | 浏览器关闭 |
|------|-----------|-----------|
| job 状态变化 | L1 被动更新 | 不通知 |
| batch 单项完成 | L1 BatchProgressGrid 更新 | 不通知 |
| 全部 batch 完成 | L2 Feed 消息 | L4 邮件 |
| report draft 完成 | L2 Feed 消息 + PI gate card | L4 邮件 |
| critical failure | L3 Feed 红色消息 + Header banner | L4 邮件 |
| budget 接近 | L1 CostMonitor 变黄 | 不通知 |
| budget 超出 | L2 Feed 提示 + CostMonitor 变红 | 不通知 |

### 6.3 batch 通知合并

sensitivity 9 组参数不产生 9 条 "PSET-00X succeeded" 消息。合并为：

```text
Feed 实时: BatchProgressGrid 静默更新 cell 颜色
Feed 里程碑: "已完成 5/9 组参数..." (可选, 仅 50% 和 100% 时)
Feed 完成: "Sensitivity 分析完成: 8 succeeded, 1 failed。报告草稿已生成。"
```

---

## 7. 对话交互模式

### 7.1 输入方式

PI 输入框支持三种输入：

```text
1. 自然语言: "ccw 洪峰偏低，做敏感性分析"
2. 结构化指令: "/run-tiny ccw" (可选, MVP 不强制)
3. 选择动作: 点击 NextSuggestedAction 按钮
```

输入框行为：

```text
Enter: 发送 (单行)
Shift+Enter: 换行 (多行)
上箭头: 回溯上一条消息 (编辑重发)
Ctrl+K / ⌘K: 全局聚焦到输入框
```

### 7.2 Agent 消息可操作性

Agent 消息不应只是文字。关键消息应内嵌可操作元素：

| 消息类型 | 可操作元素 |
|----------|-----------|
| plan.created | "查看计划详情" 展开链接 |
| runrecord.created | "查看 RunRecord" 链接 → Dashboard 滚动到对应图表 |
| report.draft_created | "阅读报告" 按钮 → 打开 report Sheet |
| pi_gate.required | 内嵌 approve/revision/reject 按钮 + comment 框 |
| tool.failed | "查看日志" 链接 → Terminal 展开并滚动到错误行 |

### 7.3 上下文连续性

PI 不需要每条消息都重复上下文。Coordinator 维护对话上下文：

```text
PI: "ccw 洪峰偏低，做敏感性分析"
→ Coordinator 创建任务, 执行, 报告

PI: "用 heihe 也跑一下"  ← 不需要重复 "敏感性分析"
→ Coordinator 理解为: 对 heihe 做同样的敏感性分析

PI: "把 roughness 范围扩大到 ±30%"  ← 引用当前分析上下文
→ Coordinator 修改 AnalysisPlan, 重新执行
```

中断恢复时，Coordinator resume prompt 应在 Feed 顶部显示恢复摘要，让 PI 知道上下文已衔接。

---

## 8. 多任务管理

### 8.1 Dashboard 页面 (/)

任务列表按状态分组：

```text
需要您的注意 (awaiting_pi)
  └ TASK-003: sensitivity 完成, 报告待审阅  [查看]

正在运行 (running / parked)
  └ TASK-004: ccw calibration 运行中 (3/9 done)  [查看]

最近完成 (done, 7 天内)
  └ TASK-001: event_flux 诊断  ✓ accepted  [查看报告]
  └ TASK-002: ccw baseline  ✓ accepted  [查看报告]
```

### 8.2 任务切换

SideNav 会话列表支持：

```text
点击 → 切换到对应 session, 四栏全部更新
当前任务高亮 (primary-100 背景)
parked 任务显示 ⏸ 图标
awaiting_pi 任务显示 🔴 红点 (需要注意)
failed 任务显示 ✕ 图标
```

切换任务时：
- Feed 清空并加载目标任务的事件流
- Dashboard 加载目标任务的实验数据
- Results 加载目标任务的结果
- 不需要页面跳转，四栏原地更新

### 8.3 并行任务感知

PI 可能同时有多个任务在跑。SideNav 需要告知哪些任务需要关注：

```text
Badge 规则:
  红点 — 需要 PI 操作 (awaiting_pi, pi_gate.required)
  黄点 — 有警告 (failed job, budget exceeded)
  无点 — 正常运行或已完成
```

StatusBar 只显示当前 session 的任务状态，不聚合所有任务。

---

## 9. 决策支持

### 9.1 NextSuggestedAction 设计

Coordinator 生成 2-4 个建议，按推荐度排序。每个建议包含：

```text
标题: 一句话描述动作
理由: 为什么推荐 (可展开, 不默认显示)
预计成本/时间: 可选
风险标注: 若涉及 PI gate
```

示例：

```text
1. ● 补 holdout 验证 (storm_2008_11)
     理由: 当前只在训练窗口验证, holdout 可检查过拟合。
     预计: ~15 min, normal budget

2. ○ 修改 hillslope roughness 后重跑
     理由: roughness 是最敏感参数, 当前值可能偏高。
     预计: ~10 min, cheap budget

3. ○ 扩展到 heihe 流域验证
     理由: 跨流域可检查参数迁移性。
     预计: ~2 hr, deep budget, 需 PI 审批

4. ○ 暂缓，当前证据不足以做进一步判断
```

PI 可以：
- 点击选择一个 → 执行
- 修改方案 → 输入框编辑后发送
- 全部不选 → 自己在输入框写新指令
- 终止任务 → 确认后 task done

### 9.2 指标卡片的决策辅助

指标卡不只显示数字。通过视觉线索辅助判断：

```text
颜色: 绿 (达标) / 黄 (边界) / 红 (不达标)
箭头: ▲ 改善 / ▼ 恶化 (相对 baseline)
阈值: 来自 Visualization_Data_Spec 中的 pass/warn 定义
tooltip: 展示阈值定义、计算方法、来源 artifact
```

### 9.3 报告阅读辅助

EvidenceReport 在 UI 中以结构化方式展示，不是一大段 Markdown：

```text
Report Sheet 布局:
  左侧: 目录导航 (摘要 / 运行记录 / 指标 / 限制 / PI 问题 / 建议)
  右侧: 报告正文 (Markdown 渲染)
  底部: 审批栏 (Approve / Revision / Reject + comment)
```

PI 问题 section 用蓝色背景高亮，提示 PI 这些需要回答。

---

## 10. 长任务体验

### 10.1 时间感知

系统应让 PI 对等待时间有预期：

```text
提交时: "预计运行时间 ~15 分钟" (基于 tiny case 外推或历史记录)
运行中: StatusBar "已运行 3:42 / ~15:00"
即将完成: BatchProgressGrid "8/9 完成, 最后 1 组运行中"
超时: Feed 警告 "运行已超过预计时间, 可能是参数异常导致"
```

### 10.2 Park/Resume 的用户感知

PI 不需要知道 "Park" 和 "Resume" 的技术概念。前端表述：

```text
Park 时:
  Feed: "任务已进入后台运行，完成后会通知您。"
  SideNav: 任务显示 ⏸ 图标 + "后台运行中"
  StatusBar: "等待 SHUD 运行完成"

Resume 时:
  Feed 顶部: "任务恢复 — SHUD 运行已完成 (8 succeeded, 1 failed)，正在汇总结果..."
  Feed 不重复显示中间日志，只显示恢复摘要
```

### 10.3 浏览器关闭后的恢复

```text
PI 重新打开浏览器 → 自动恢复上次 session
  ↓
若有 parked task 已完成:
  Dashboard 顶部蓝色 banner: "TASK-003 的 sensitivity 分析已完成, 点击查看结果"
  Feed: 恢复摘要 (不是完整事件回放)
  ↓
若有 parked task 仍在运行:
  Dashboard 显示 BatchProgressGrid 当前状态
  ↓
若有 awaiting_pi:
  SideNav 红点 + Dashboard 审批卡片
```

---

## 11. 错误恢复

### 11.1 用户操作错误

| 场景 | 恢复方式 |
|------|---------|
| 发错消息 | 无法撤回，但可发新消息修正意图 |
| 误 approve | 无法撤回 approve，但可创建新 ChangeRequest 回滚 |
| 误 reject | reject 不可逆，需要 PI 手动创建新任务 |
| 选错 NextAction | Coordinator 开始执行后，PI 可发 "取消" 或 "停" |
| 误关浏览器 | 无影响，session 持久化，长任务继续 |

### 11.2 系统错误恢复

```text
WebSocket 断线:
  自动重连 (3 次, 指数退避)
  UI 不清空状态
  重连后通过 since_seq 补齐事件
  StatusBar 显示 "reconnecting..."

API 请求失败:
  toast 提示 + retry 按钮
  不自动重试 mutate 操作 (POST/PUT/DELETE)
  自动重试 GET 操作 (最多 2 次)

RunJob 失败:
  Feed 消息 + 日志链接
  Terminal 自动滚动到错误行
  NextSuggestedAction 包含 "调整参数后重试" 或 "查看日志诊断"
```

---

## 12. 数据密度管理

### 12.1 多 run 场景

当 sensitivity batch 有 20+ parameter sets 时：

```text
BatchProgressGrid:
  显示网格视图 (紧凑)，不是表格视图
  聚合摘要: "12 succeeded, 3 running, 5 queued"
  点击单个 cell → 展开详情

ParameterSetTable:
  默认显示前 10 行 + "显示全部 (25)" 链接
  可按指标排序
  可按状态过滤 (只看 failed)

SensitivityHeatmap:
  超过 2 参数维度时 → 分面 (faceted) 展示
  每个面最多 10×10 cell
```

### 12.2 多 session 场景

SideNav 会话列表超过 20 条时：

```text
搜索框: 按任务标题/basin/日期搜索
分组: "本周" / "上周" / "更早"
归档: done > 30 天的任务自动折叠到 "已归档" 组
```

### 12.3 长 Feed 场景

AgentActivityFeed 消息超过 50 条时：

```text
虚拟滚动 (只渲染可视区域 + buffer)
时间分隔线: "---- 今天 10:00 ----"
"跳到最新" 按钮 (当 PI 向上滚动时出现)
折叠连续工具调用: "Worker 执行了 5 个工具调用 [展开]"
```

---

## 13. 首次使用 (Onboarding)

不做弹窗教程。使用渐进式发现：

```text
首次打开:
  Dashboard 空态 + "开始第一个任务" 引导文字
  输入框 placeholder: "试试输入 '运行 ccw tiny benchmark'"

首次创建任务:
  SideNav Research Context 出现 StackLock 和 Data，
  带一次性 tooltip: "这里显示当前实验的版本和数据信息"

首次 PI gate:
  PIDecisionPanel 首次出现时,
  带一次性 tooltip: "请审阅结果后做出决策"

首次长任务:
  Park 提示带一次性 tooltip: "长时间运行会在后台继续，完成后通知您"
```

一次性 tooltip 用 localStorage 记录已展示状态，不再重复。

---

## 14. Report 阅读与分享

### 14.1 报告阅读体验

```text
在工作台内:
  ResultsPanel 底部 "查看完整报告" → 右侧 Sheet (宽度 60vw)
  Sheet 内: 左侧目录 + 右侧正文 + 底部审批栏
  PI 可边看报告边看 Dashboard 图表 (Sheet 不遮挡 Dashboard)

全屏阅读:
  /reports/:taskId 路由
  专注阅读模式, 无四栏布局
  适合长报告和打印
```

### 14.2 报告分享

```text
Export HTML:
  点击 "导出 HTML" → 下载 standalone .html
  draft 状态有可见 watermark
  PI 可通过邮件发给合作者

Export Markdown:
  点击 "导出 Markdown" → 下载 .md
  适合粘贴到论文草稿

打印 PDF:
  HTML 报告用浏览器 Ctrl+P 打印
  打印样式: 隐藏导航、固定分页、A4 优化
```

---

## 15. 验收标准

- [ ] PI 可以用一句自然语言发起 engineering / science_assist / ops 三种任务。
- [ ] 四栏在 PI 发送消息后 2 秒内开始联动更新。
- [ ] 长任务 park 时，PI 看到人类语言提示而非技术状态。
- [ ] 浏览器关闭后重新打开，parked 任务状态正确恢复。
- [ ] PI gate card 出现时自动获得焦点。
- [ ] 失败 RunJob 在 Feed、Dashboard、Results 三处均可见。
- [ ] BatchProgressGrid 不对每个 job completion 产生独立 Feed 消息。
- [ ] NextSuggestedAction 提供 2-4 个可选方案。
- [ ] 首次使用无需配置向导，空态引导足够启动。
- [ ] 报告在 Sheet 内可边阅读边查看 Dashboard 图表。
- [ ] 所有失败消息用人类语言描述，不以错误码开头。
- [ ] Feed 超过 50 条消息时 UI 不卡顿。
