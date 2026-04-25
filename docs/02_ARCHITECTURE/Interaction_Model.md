# 交互模型：Web 科研工作台

## 1. 设计理念

Web Console 不是"对话框 + 几个按钮"，而是一个**完整的科研工作台**——PI 在一个界面中完成对话、查看多 Agent 活动、监控实验、阅读结果、审批决策。

参考设计：`docs/99_ARCHIVE/images/ChatGPT Image Apr 19, 2026, 10_53_22 PM.png`

## 2. 四栏布局

```text
┌──────────┬─────────────────────┬──────────────────────────────┬──────────────┐
│ A. 导航栏 │ B. Agent 活动流       │ C. 实验详情面板                │ D. 结果面板   │
│          │                     │                              │              │
│ 新会话    │ ● Coordinator Agent │  EXP-2024-001-A              │ Results      │
│          │   "正在分析 peak     │  Basin: Cache Creek           │ Overview     │
│ ─────── │    flow 敏感性..."   │  Event: Storm 2008-02         │ ┌──────────┐│
│ 会话历史  │                     │                              │ │NSE  -0.62││
│ ├ ccw    │ ● Worker Agent      │  ┌─── Hydrograph ──────────┐ │ │Err -12.3%││
│ │ 洪峰   │   "编译 SHUD 完成,  │  │  ~~  baseline            │ │ │Peak 628.4││
│ │ 分析   │    exit_code=0"     │  │ ~~   experiment          │ │ └──────────┘│
│ ├ event  │                     │  │~~                        │ │              │
│ │ flux   │ ● Coder Agent       │  └──────────────────────────┘ │ Hydrograph   │
│ └ ...    │   "修改 MD_f.cpp    │                              │ Comparison   │
│          │    第 142 行..."     │  ┌─── Runtime Terminal ────┐ │ ┌──────────┐│
│ ─────── │                     │  │ $ make shud              │ │ │ ~~~ ~~~  ││
│ Research │ ● Coordinator Agent │  │ $ ./shud ccw             │ │ │~~~  ~~~~ ││
│ Context  │   "6 组参数扫描     │  │ [10:14:22] WB: 0.0008   │ │ └──────────┘│
│ ├ Stack  │    全部完成, 正在   │  └──────────────────────────┘ │              │
│ │ Lock   │    汇总..."        │                              │ Sensitivity  │
│ ├ Data   │                     │  ┌─── Parameter Set ────────┐ │ Heatmap     │
│ │ Prov   │                     │  │ ksat  │ n_mul │ NSE │ PE │ │ ┌──────────┐│
│ └ Notes  │                     │  │ 0.5   │ 0.7   │-0.8 │12%│ │ │▓▒░▒▓    ││
│          │                     │  │ 1.0   │ 1.0   │-0.6 │ 8%│ │ │▒░▒▓▒    ││
│ ─────── │                     │  │ 2.0   │ 1.3   │-0.3 │ 5%│ │ └──────────┘│
│ Cost     │ [PI 输入消息...]     │  └──────────────────────────┘ │              │
│ $0.72    │                     │                              │ Next Action  │
│ 9 calls  │                     │                              │ ┌──────────┐│
│          │                     │                              │ │1. 补 hold-││
│          │                     │                              │ │   out 验证 ││
│          │                     │                              │ │2. 改 rough-││
│          │                     │                              │ │   ness    ││
│          │                     │                              │ │[选择]     ││
│          │                     │                              │ └──────────┘│
├──────────┴─────────────────────┴──────────────────────────────┴──────────────┤
│ ⚙ Status: TASK-0002 running │ StackLock: 9b55b0c │ Budget: $0.72/1.00(adv)  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 3. 四栏详细定义

### A. 左侧导航栏 (SideNav)

```text
┌ New Conversation 按钮
├ 会话历史 (Conversation History)
│   按时间倒序, 显示任务标题和状态图标
│   点击切换到对应 session
├ Research Context (当前任务上下文)
│   ├ StackLock 摘要 (repo commits + runtime versions)
│   ├ DataProvenance 摘要 (basin, event, sources)
│   ├ Related Notes (关联笔记/经验)
│   └ Active Skills (当前可用 skill 列表)
└ Cost Monitor (底部悬浮)
    ├ LLM: $0.72 / 1.00(adv)
    ├ Calls: 9 / 12(adv)
    └ Compute: 12 min
```

### B. Agent 活动流 (Agent Activity Feed)

不是简单的聊天框。每条消息标注**来源 Agent 角色**，带时间戳和折叠详情：

```text
● Coordinator Agent  10:12:01
  "已创建 TASK-0002, 正在规划敏感性分析..."
  └ [展开] TaskCard 详情

● Repo Explorer Agent  10:12:08
  "已定位 SHUD/rSHUD 相关入口和影响面，生成 RepoContextBrief。"
  └ [展开] inspected refs / impact surface / unknowns

● Worker Agent  10:12:15
  "编译 SHUD 完成, exit_code=0, 耗时 12s"
  └ [展开] 编译日志

● Worker Agent  10:14:22
  "ccw 30-day 运行完成, water_balance=0.0008"
  └ [展开] RunRecord 摘要

● Coder Agent  10:15:03
  "修改 MD_f.cpp 第 142 行, 添加 event_flux 输出"
  └ [展开] diff 预览

● Coordinator Agent  10:20:45
  "6 组参数扫描全部完成, 正在汇总指标..."
  └ [展开] 批量 RunRecord

[PI 输入消息...]  ← 底部输入框, 支持自然语言 + 指令
```

关键设计：
- 每个 Agent 有独立颜色标识 (Coordinator=蓝, Repo Explorer=青绿, Worker=绿, Coder=紫, Reviewer=橙)
- 可折叠展开详情 (日志、diff、RunRecord)
- PI 消息和 Agent 消息视觉区分
- 支持 LLM streaming (打字机效果)

### C. 实验详情面板 (Experiment Dashboard)

当前选中实验/任务的核心视图，包含 4 个子区域：

**C1. 实验头部 (Experiment Header)**
```text
EXP-2024-001-A
Basin: Cache Creek  |  Event: Storm 2008-02-14  |  Status: Running
StackLock: SHUD@9b55b0c + rSHUD@d162db3
```

**C2. 水文过程线 (Hydrograph Chart)**
```text
- 交互式时间序列图 (观测 vs baseline vs 实验)
- 支持缩放、tooltips、多系列叠加
- 支持 eleygw, rivqdown 等多个输出变量切换
```

**C3. Runtime 终端 (Runtime Terminal)**
```text
- 嵌入式终端, 实时流式展示 SHUD 编译/运行日志
- 语法高亮 (错误红色, 警告黄色, 成功绿色)
- 可收起/展开
- 关联当前 JobId
```

**C4. 参数集表格 (Parameter Set Table)**
```text
- 敏感性分析的参数组合 + 对应指标结果
- 可排序、高亮最优组合
- 列: 参数值... | NSE | Peak Error | Timing Error | WB Residual
```

### D. 结果面板 (Results Panel)

右侧垂直排列的结果卡片：

**D1. Results Overview (关键指标卡)**
```text
┌────────┬────────┬────────┬────────┐
│  NSE   │Peak Err│ Timing │  Peak  │
│ -0.62  │ -12.3% │ +15min │ 628.4  │
│  ▼0.1  │  ▲2.1% │  ▼5min │ m³/s   │
└────────┴────────┴────────┴────────┘
- 与 baseline 的差异箭头 (▲▼)
- 达标/未达标颜色标注
```

**D2. Hydrograph Comparison (对比图)**
```text
- baseline vs experiment 叠加对比
- 比 C2 更紧凑, 聚焦差异区域
- 差异带 (filled diff band) 高亮
```

**D3. Sensitivity Heatmap (敏感性热力图)**
```text
- 参数 vs 指标 的热力矩阵
- 颜色编码: 敏感(红) → 不敏感(蓝)
- tornado 图的可视化替代
```

**D4. Next Suggested Action (下一步建议)**
```text
┌ Coordinator 建议:
│ 1. ○ 补 holdout 验证 (storm_2008_11)
│ 2. ○ 修改 hillslope roughness 后重跑
│ 3. ○ 扩展到 heihe 流域验证
│ 4. ○ 暂缓, 证据不足
│
│ [选择并执行]  [修改方案]  [终止任务]
└
```

## 4. 底部状态栏 (Status Bar)

```text
⚙ TASK-0002 running  │  Stack: SHUD@9b55b0c  │  Data: ccw/storm_2008_02
│  Budget: $0.72/1.00(adv)  │  Jobs: 4/6 done  │  WS: connected
```

## 5. 页面路由

```text
/                        → Dashboard (所有任务概览 + 最近活动)
/session/:id             → 科研工作台 (四栏布局, 主工作界面)
/reports/:taskId         → 报告全屏阅读 (Markdown 渲染)
/admin/cost              → 成本汇总 (按任务/按天/按 Agent)
```

## 6. API 端点 (Hono 后端)

```text
# 任务管理
POST   /api/tasks                    # 创建任务
GET    /api/tasks                    # 任务列表
GET    /api/tasks/:id                # 任务详情 (含 RunRecords, AnalysisPlan)
POST   /api/tasks/:id/plan           # 生成执行计划
POST   /api/tasks/:id/approve        # PI 审批 (accept/revise/reject)
DELETE /api/tasks/:id/artifacts      # 清理临时文件

# 版本与数据
POST   /api/stacks/lock              # 锁版本
POST   /api/data/register            # 注册数据源

# 执行
POST   /api/tasks/:id/run-tiny       # 运行 tiny benchmark
POST   /api/jobs                     # 提交长任务
GET    /api/jobs/:id                  # 查询 job 状态
POST   /api/jobs/:id/collect          # 收集结果

# 分析
POST   /api/analysis/sensitivity     # 敏感性分析
POST   /api/analysis/calibration     # 校准

# 结果与可视化
GET    /api/runs/:id/metrics         # RunRecord 指标
GET    /api/runs/:id/hydrograph      # 水文过程线数据
GET    /api/analysis/:id/heatmap     # 敏感性热力图数据
GET    /api/analysis/:id/parameters  # 参数集表格数据

# 报告与变更
POST   /api/tasks/:id/report         # 生成报告
GET    /api/reports/:taskId          # 获取报告 (Markdown)
GET    /api/patches/:id/diff         # 查看 patch diff
POST   /api/patches/:id/bundle       # 打包 patch

# 笔记
POST   /api/notes                    # 添加笔记
GET    /api/notes                    # 笔记列表

# 实时通信
WS     /ws/session/:sessionId        # 统一 session 通道 (agent 活动流 + 日志 + 事件)
```

## 7. 对话驱动工作流

PI 通过 Agent 活动流底部输入框驱动所有操作：

```text
PI: "ccw 洪峰偏低，做敏感性分析"
→ Activity Feed: Coordinator 创建任务 → Worker 编译运行 → 参数扫描
→ Experiment Dashboard: 实时更新水文过程线 + 参数表
→ Results Panel: 指标卡片 + 热力图 + 下一步建议
→ PI 在 Next Action 面板点击选择

PI: "选方案 1, 补 holdout 验证"
→ Coordinator 自动创建子任务 → 执行 → 报告
```

## 8. Markdown 报告

每个任务仍生成 `reports/TASK-*_report.md`，在 `/reports/:taskId` 路由全屏渲染。
报告内容与工作台面板数据一致，但以线性文档形式呈现，适合存档和离线阅读。
