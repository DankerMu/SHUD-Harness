# UI 实现规格

**状态：** P1 设计规范
**适用范围：** React 前端、四栏工作台、组件库、设计系统
**目标：** 基于效果图，固定设计 tokens、组件规格、状态定义、响应式策略和可访问性要求，使前端开发可并行推进。

**效果图参考：** `docs/99_ARCHIVE/images/ChatGPT Image Apr 19, 2026, 10_53_22 PM.png`

---

## 1. 技术栈

| 层级 | 选择 | 理由 |
|------|------|------|
| 框架 | React 19 + TypeScript | 基于 Zero 扩展，与后端共享 Zod 类型 |
| 构建 | Bun + Vite | monorepo 统一 runtime |
| CSS | Tailwind CSS 4 | 效果图的简洁风格适合 utility-first |
| 组件基础 | shadcn/ui (Radix primitives) | 无样式 headless + 可定制主题，a11y 内建 |
| 图表 | Recharts 或 visx | 轻量、React-native、支持 SVG 导出 |
| 终端 | xterm.js | RuntimeTerminal 深色终端模拟 |
| 图标 | Lucide Icons | shadcn/ui 默认搭配 |
| 状态 | Zustand | 5 store 分层（见 Frontend_State_Design.md） |

---

## 2. 设计 Tokens

### 2.1 颜色

基于效果图提取的色板：

```text
# 主色
--color-primary-50:   #EFF6FF    # 浅蓝背景 (SideNav hover)
--color-primary-100:  #DBEAFE    # 选中态背景
--color-primary-500:  #3B82F6    # 主按钮、链接、Coordinator 头像
--color-primary-600:  #2563EB    # 主按钮 hover
--color-primary-700:  #1D4ED8    # 主按钮 active

# 灰度
--color-gray-50:      #F9FAFB    # 页面底色
--color-gray-100:     #F3F4F6    # 卡片边框、分隔线
--color-gray-200:     #E5E7EB    # 输入框边框
--color-gray-300:     #D1D5DB    # 禁用态文字
--color-gray-500:     #6B7280    # 次要文字
--color-gray-700:     #374151    # 正文
--color-gray-900:     #111827    # 标题

# 语义色
--color-success:      #10B981    # succeeded、pass、Worker 头像
--color-warning:      #F59E0B    # warn、budget 接近
--color-error:        #EF4444    # failed、critical、reject
--color-info:         #3B82F6    # 与 primary 一致

# Agent 角色色
--color-agent-coordinator: #3B82F6   # 蓝
--color-agent-explorer:    #14B8A6   # 青绿
--color-agent-worker:      #10B981   # 绿
--color-agent-coder:       #8B5CF6   # 紫
--color-agent-reviewer:    #F97316   # 橙

# 特殊表面
--color-terminal-bg:   #1E1E2E   # 终端深色背景
--color-terminal-text: #E2E8F0   # 终端文字
--color-statusbar-bg:  #1F2937   # 底部状态栏
--color-statusbar-text:#D1D5DB   # 状态栏文字

# 热力图渐变
--color-heatmap-low:   #10B981   # 不敏感 / 优
--color-heatmap-mid:   #F59E0B   # 中等
--color-heatmap-high:  #EF4444   # 敏感 / 差
```

限制：整体 UI 最多 2 个强调色（primary blue + 语义色按需）。

### 2.2 字体

```text
--font-sans:   "Inter", system-ui, -apple-system, sans-serif
--font-mono:   "JetBrains Mono", "Fira Code", "Consolas", monospace

# 字号层级 (px / rem)
--text-xs:     12px / 0.75rem    # 时间戳、badge、状态栏
--text-sm:     14px / 0.875rem   # 次要文字、表格内容、SideNav 项
--text-base:   16px / 1rem       # 正文、消息、输入框
--text-lg:     18px / 1.125rem   # 区域标题 (Results Overview)
--text-xl:     20px / 1.25rem    # 面板标题 (EXP-2024-001-A)
--text-2xl:    24px / 1.5rem     # 指标数字 (NSE -0.62)
--text-3xl:    30px / 1.875rem   # 页面标题 (仅 Dashboard)

# 字重
--font-normal: 400
--font-medium: 500               # 标签、SideNav 项
--font-semibold: 600             # 面板标题、指标值
--font-bold:   700               # 页面标题
```

### 2.3 间距

以 4px 为基准单位：

```text
--space-1:   4px     # 内联元素间隙
--space-2:   8px     # badge padding、图标与文字间距
--space-3:   12px    # 列表项 padding
--space-4:   16px    # 卡片内 padding、栏间 gap
--space-5:   20px    # section 间距
--space-6:   24px    # 面板内 padding
--space-8:   32px    # 面板间 gap
```

### 2.4 圆角

```text
--radius-sm:   4px    # badge、小按钮
--radius-md:   8px    # 卡片、输入框、按钮
--radius-lg:   12px   # 面板、模态框
--radius-full: 9999px # 头像、pill badge
```

### 2.5 阴影

```text
--shadow-sm:   0 1px 2px rgba(0,0,0,0.05)        # 卡片
--shadow-md:   0 4px 6px -1px rgba(0,0,0,0.1)    # 悬浮卡片、dropdown
--shadow-lg:   0 10px 15px -3px rgba(0,0,0,0.1)  # modal
```

### 2.6 栏宽

基于效果图四栏比例：

```text
SideNav (A):             240px  固定宽度，可折叠为 56px 图标栏
AgentActivityFeed (B):   minmax(320px, 1fr)
ExperimentDashboard (C): minmax(400px, 1.5fr)
ResultsPanel (D):        minmax(280px, 1fr)
StatusBar:               100% 固定底部，高度 36px
```

---

## 3. 布局系统

### 3.1 顶层 Grid

```css
.workbench {
  display: grid;
  grid-template-columns: 240px minmax(320px, 1fr) minmax(400px, 1.5fr) minmax(280px, 1fr);
  grid-template-rows: 1fr 36px;
  height: 100vh;
  overflow: hidden;
}
```

### 3.2 面板内部

每个面板内部使用 `flex-col` 布局，溢出部分独立滚动：

```text
Panel
├── PanelHeader (sticky top, 48px)
├── PanelBody (flex-1, overflow-y: auto)
└── PanelFooter (sticky bottom, 可选)
```

---

## 4. 组件规格

### 4.1 SideNav

```ts
interface SideNavProps {
  collapsed: boolean;
  onToggle: () => void;
  sessions: SessionSummary[];
  activeSessionId: string;
  researchContext: {
    stackLock: StackLockSummary | null;
    dataProvenance: DataProvenanceSummary | null;
    notes: MemoryNote[];
    activeSkills: string[];
  };
  costMonitor: CostSummary;
}
```

| 子组件 | 行为 |
|--------|------|
| Logo | `SHUD-Harness` 蓝色图标 + 文字；collapsed 时只显示图标 |
| NewConversation | 蓝色主按钮，`radius-md`，full width |
| SessionList | 按时间倒序；当前 session 高亮 `primary-100` 背景；状态 icon 前缀 |
| ResearchContext | 折叠组，标题 `font-medium text-sm text-gray-500`；内容 `text-sm` |
| CostMonitor | 底部固定；预算接近时 `warning` 色；超出时 `error` 色 |

### 4.2 AgentActivityFeed

```ts
interface AgentActivityFeedProps {
  events: ActivityEvent[];
  isStreaming: boolean;
  onSendMessage: (text: string) => void;
  onAction: (action: ClientAction) => void;
}

interface ActivityEvent {
  eventId: string;
  type: "agent.message" | "tool.started" | "tool.completed" | "tool.failed"
      | "job.submitted" | "job.status" | "runrecord.created" | "pi_gate.required"
      | "report.draft_created" | "repo_context.created" | "pi_gate.decision_recorded";
  source: "coordinator" | "repo_explorer" | "worker" | "coder" | "reviewer" | "client";
  visibility: "user_visible" | "internal";
  timestamp: string;
  payload: unknown;
}
```

| 子组件 | 行为 |
|--------|------|
| AgentMessage | 左侧圆形头像 (32px, 角色色背景 + 白色首字母)；右侧消息体；时间戳 `text-xs text-gray-500` 右对齐 |
| MessageDetail | 可折叠展开区域，浅灰背景 `gray-50`，包含日志/diff/RunRecord 摘要 |
| PIInputBar | 底部固定，输入框 + 发送按钮；placeholder "输入消息或指令..." |
| StreamingIndicator | 三点跳动动画，打字机效果逐字渲染 |
| PIGateCard | 黄色左边框，Approve/Revision/Reject 三按钮 + comment textarea |

消息头像颜色映射：

```text
coordinator → primary-500 蓝
repo_explorer → #14B8A6 青绿
worker      → success 绿
coder       → #8B5CF6 紫
reviewer    → #F97316 橙
client (PI) → gray-700 深灰，右对齐
```

`repo_context.created` 卡片应展示 RepoContextBrief 摘要、涉及仓库、inspected refs 数量和 unknowns 数量；默认折叠文件清单，避免 ActivityFeed 被长路径列表淹没。

### 4.3 ExperimentDashboard

```ts
interface ExperimentDashboardProps {
  task: TaskCard;
  stackLock: StackLock;
  activeRun?: RunRecord;
  analysisProgress?: AnalysisProgressPayload;
  chartState: ChartState;
}
```

| 子组件 | 规格 |
|--------|------|
| ExperimentHeader | 白底卡片；标题 `text-xl font-semibold`；basin/event/status 行 `text-sm text-gray-500`；StackLock pill badge |
| HydrographChart | Recharts LineChart；可交互缩放和 tooltip；多 series 叠加；y 轴标注单位；SVG 可导出 |
| RuntimeTerminal | xterm.js 嵌入；背景 `terminal-bg`；文字 `terminal-text`；stderr 红色、warning 黄色；可收起至 1 行摘要 |
| ParameterSetTable | 带表头排序的 shadcn/ui DataTable；最优行高亮 `success/10%` 背景；失败行 `error/10%` 背景 + `failed` badge |
| BatchProgressGrid | v0.8.1 新增；表格或网格视图可切换；cell 颜色按状态映射 |

RuntimeTerminal 高度：

```text
展开: 200px (可拖拽调节)
收起: 36px (只显示最后一行 + 展开按钮)
```

### 4.4 ResultsPanel

```ts
interface ResultsPanelProps {
  metrics: MetricsCard[];
  comparison?: HydrographComparisonData;
  heatmap?: SensitivityHeatmapData;
  suggestedActions: SuggestedAction[];
  report?: EvidenceReport;
}
```

| 子组件 | 规格 |
|--------|------|
| ResultsOverview | 水平排列 4 个指标卡 (卡片 white bg, `shadow-sm`)；数值 `text-2xl font-semibold`；变化箭头 `▲` green / `▼` red；标签 `text-xs text-gray-500` |
| HydrographComparison | 紧凑折线叠加图；差异带 (fill-between) 半透明蓝色 |
| SensitivityHeatmap | 参数 × 指标 矩阵；cell 颜色用 heatmap 渐变；cell 内显示数值 `text-xs`；失败 cell 显示 `✕` + `gray-300` 背景 |
| NextSuggestedAction | 白底卡片；编号列表；每项可选 radio；底部三按钮 `选择并执行` (primary) / `修改方案` (outline) / `终止任务` (ghost error) |
| ReportExportButton | v0.8.1；report 面板右上角；下拉菜单 `Export HTML` / `Export Markdown`；draft 状态旁显示 `⚠ 含 draft 水印` |
| PIDecisionPanel | v0.8.1；审批卡片，黄色左边框 4px |

### 4.5 StatusBar

```ts
interface StatusBarProps {
  task: { id: string; status: string } | null;
  stack: { shudCommit: string } | null;
  data: { basin: string; event: string } | null;
  budget: CostSummary;
  jobProgress: { done: number; total: number };
  wsStatus: "connected" | "reconnecting" | "disconnected";
}
```

深色背景条（`statusbar-bg`），全宽 36px，内容 `text-xs text-statusbar-text`：

```text
⚙ TASK-0002 running │ Stack: SHUD@9b55b0c │ Data: ccw/storm_2008_02
│ Budget: $0.72/1.00 │ Jobs: 4/6 done │ WS: connected (绿点) / reconnecting (黄闪) / disconnected (红点)
```

---

## 5. 组件状态矩阵

### 5.1 Loading 态

| 场景 | 表现 |
|------|------|
| 初始加载 workspace | 四栏骨架屏 (skeleton shimmer)：SideNav 5 行、Feed 3 条消息占位、Dashboard 图表区灰框、Results 4 卡片占位 |
| 加载单个图表 | 图表区域内 spinner + `text-sm text-gray-500` "加载数据..." |
| 加载 RunRecord 列表 | 表格区域 skeleton 行（4 行 shimmer） |
| WebSocket 重连中 | StatusBar WS 状态变黄 + 闪烁；Feed 底部 banner "正在重连..." |
| 提交 job 等待 | 按钮 disabled + spinner 替换文字 |

骨架屏规则：

```text
skeleton 元素使用 gray-200 背景 + shimmer 动画
形状匹配目标内容（文字行 = 圆角矩形 h-4, 头像 = 圆形 w-8 h-8）
动画: linear-gradient 从左到右扫过, 1.5s 循环
```

### 5.2 Empty 态

| 场景 | 表现 |
|------|------|
| 无 session 历史 | SideNav 中央：插图 (简笔画水滴) + "开始第一个任务" + NewConversation 按钮 |
| 无 ActivityFeed 消息 | Feed 中央：`text-sm text-gray-400` "输入消息开始..." |
| 无 RunRecord | Dashboard 图表区：虚线框 + "尚无运行结果" |
| 无 metrics | Results Overview 4 卡片显示 `--` 和 `text-gray-300` |
| 无 heatmap | Heatmap 区域："需要先完成敏感性分析" |
| 无 report | Report 区域不渲染 |

### 5.3 Error 态

| 场景 | 组件 | 表现 |
|------|------|------|
| transient (WebSocket 断线) | StatusBar + Feed banner | 黄色背景 toast "连接中断，正在重连..."，3 次失败后变红 |
| task-level (RunJob 失败) | ExperimentHeader + Feed | Header 显示红色 banner "SHUD 运行失败 (exit code 1)"；Feed 中 Worker 消息红色左边框 |
| critical (workspace 损坏) | Blocking modal | 半透明遮罩 + 居中白底 modal `shadow-lg`；标题红色；描述 + 建议操作 + "联系管理员" |
| chart 加载失败 | 图表区域 | 替换为错误卡片：红色图标 + "图表加载失败" + retry 链接 |
| notification 发送失败 | StatusBar 小徽标 | 黄色 `!` badge 在通知图标上；不阻塞主流程 |

### 5.4 按钮状态

所有交互按钮遵循 5 态：

```text
default   → 正常色
hover     → 加深一级 (primary-600)
active    → 加深两级 (primary-700)
disabled  → gray-300 背景 + gray-500 文字 + cursor-not-allowed
loading   → spinner 替换 icon/文字 + disabled
```

---

## 6. 响应式策略

### 6.1 断点

```text
--bp-sm:   640px     # 手机 (非目标，仅防崩溃)
--bp-md:   768px     # 平板竖屏
--bp-lg:   1024px    # 平板横屏 / 小笔记本
--bp-xl:   1280px    # 标准笔记本 (主要适配)
--bp-2xl:  1536px    # 大显示器 (效果图目标)
```

### 6.2 折叠策略

SHUD-Harness 是桌面科研工具，不追求完整移动端适配。

| 断点 | 布局 |
|------|------|
| ≥1536px | 四栏完整展示（效果图） |
| 1280–1535px | 四栏，SideNav 折叠为 56px 图标栏 |
| 1024–1279px | 三栏：SideNav 折叠 + Feed + Dashboard/Results 合并为 tab 切换 |
| 768–1023px | 两栏：SideNav overlay + Feed/Dashboard/Results tab 切换 |
| <768px | 单栏全屏：顶部 tab 导航 (Feed / Dashboard / Results)；显示提示 "推荐使用桌面浏览器" |

### 6.3 面板 resize

C 面板 (ExperimentDashboard) 与 D 面板 (ResultsPanel) 之间支持拖拽分隔条：

```text
分隔条: 4px 宽, gray-200, hover 时 primary-500
拖拽范围: C 最小 400px, D 最小 240px
双击分隔条: 重置为默认比例
```

RuntimeTerminal 高度也支持上下拖拽：最小 36px (1行)，最大 50vh。

---

## 7. 可访问性 (a11y)

### 7.1 WCAG 2.1 AA 目标

| 要求 | 实现方式 |
|------|---------|
| 颜色对比度 ≥ 4.5:1 (正文) | 正文 `gray-700` on `white` = 9.1:1 ✓；次要 `gray-500` on `white` = 4.6:1 ✓ |
| 颜色对比度 ≥ 3:1 (大字/UI) | 主按钮 `white` on `primary-500` = 4.5:1 ✓ |
| 不仅靠颜色传达信息 | 所有状态同时显示文字标签或图标；heatmap cell 内含数值 |
| 键盘导航 | 所有交互元素可 Tab 聚焦；focus ring `primary-500` 2px outline offset 2px |
| 屏幕阅读器 | shadcn/ui (Radix) 内建 aria 支持；自定义组件加 aria-label |

### 7.2 Keyboard shortcuts

| 快捷键 | 动作 |
|--------|------|
| `Ctrl+K` / `⌘K` | 聚焦 PI 输入框 |
| `Ctrl+\` / `⌘\` | 折叠/展开 SideNav |
| `Ctrl+T` / `⌘T` | 折叠/展开 RuntimeTerminal |
| `Escape` | 关闭 modal / dropdown |
| `Tab` / `Shift+Tab` | 顺序导航 |
| `Enter` | 激活聚焦元素 |

### 7.3 Focus 管理

```text
Modal 打开 → focus trap 在 modal 内
Modal 关闭 → focus 回到触发元素
PI gate card 出现 → auto focus 到第一个 decision button
页面加载 → focus 到 PI 输入框
```

### 7.4 图表可访问性

```text
每个图表有 role="img" + aria-label 摘要
图表下方提供 sr-only 数据表格 (summary table)
热力图每个 cell 有 aria-label: "参数 ksath +20%, 指标 NSE, 值 0.67"
```

---

## 8. 动画与过渡

原则：科研工具优先清晰和性能，动画只用于减少认知负担，不用于装饰。

| 场景 | 动画 |
|------|------|
| 面板展开/折叠 | `transition: width 200ms ease-out` |
| 消息出现 | `opacity 0→1 + translateY(8px→0), 150ms` |
| LLM streaming | 逐字渲染，无额外动画 |
| 骨架屏 | shimmer gradient, `1.5s linear infinite` |
| 状态切换 (badge) | `transition: background-color 150ms` |
| Modal | `opacity 0→1, 150ms` + 遮罩 `opacity 0→0.5, 200ms` |
| Toast | 右上角滑入 `translateX(100%→0), 200ms`；3s 后自动消失 |

禁止：bounce、overshoot、parallax、3D transform、页面转场动画。

`prefers-reduced-motion: reduce` 时所有 transition duration 设为 0。

---

## 9. 暗色模式

MVP 不实现暗色模式。RuntimeTerminal 始终深色，其余始终浅色。

后续实现时，所有颜色 token 通过 CSS custom properties 切换，不硬编码 hex 值。

---

## 10. 图表导出

所有 Recharts 图表支持：

- 右键菜单 "导出 PNG" / "导出 SVG"
- 导出时图表标题、轴标签、图例完整
- 导出分辨率 2x (retina)
- 导出文件名: `{RUN_ID}_{variable}_{timestamp}.png`

---

## 11. 组件清单与来源

| 组件 | 来源 | 自定义程度 |
|------|------|-----------|
| Button, Input, Textarea | shadcn/ui | 仅改色 |
| Select, Dropdown, Dialog, Sheet | shadcn/ui | 仅改色 |
| DataTable | shadcn/ui + TanStack Table | 加排序、高亮行 |
| Tabs | shadcn/ui | 仅改色 |
| Toast | shadcn/ui (sonner) | 仅改色 |
| Tooltip | shadcn/ui | 仅改色 |
| Badge | shadcn/ui | 加状态变体色 |
| Skeleton | shadcn/ui | 直接使用 |
| AgentMessage | 自定义 | 头像 + 消息体 + 折叠详情 |
| HydrographChart | 自定义 (Recharts) | 完整自定义 |
| HydrographComparison | 自定义 (Recharts) | 完整自定义 |
| SensitivityHeatmap | 自定义 (SVG/Recharts) | 完整自定义 |
| MetricsCard | 自定义 | 数值 + 箭头 + 标签 |
| RuntimeTerminal | 自定义 (xterm.js) | 深色嵌入终端 |
| BatchProgressGrid | 自定义 | 状态矩阵 + cell detail |
| PIDecisionPanel | 自定义 | 按钮组 + textarea + refs |
| StatusBar | 自定义 | 暗底信息条 |
| CostMonitor | 自定义 | 数值 + 进度条 + 阈值色 |

---

## 12. 验收标准

- [ ] 效果图四栏布局可在 ≥1280px 浏览器完整展示。
- [ ] ≤1024px 时面板可折叠/tab 切换，不出现水平溢出。
- [ ] 所有颜色 token 使用 CSS custom properties，不硬编码。
- [ ] 正文 contrast ratio ≥ 4.5:1。
- [ ] 所有交互元素可 Tab 键导航。
- [ ] BatchProgressGrid 状态不仅靠颜色传达（同时显示文字/图标）。
- [ ] 骨架屏在 workspace 初始加载时展示。
- [ ] `prefers-reduced-motion: reduce` 时动画关闭。
- [ ] RuntimeTerminal 可收起至 1 行。
- [ ] 图表可导出 PNG/SVG。
