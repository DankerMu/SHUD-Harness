---
status: frozen
---

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
│   ├ Session Digest (对话摘要, PI 可编辑; 语义见 Context_Trust §5.1)
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
│ [填入输入框]  [终止任务]     ← 建议即草稿：点击填入 PIInputBar，PI 确认发送才生效
│                              （UI_Implementation_Spec §4.4，无隐式执行）
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

**轻量应答分流（对标 xagent 吸收）**：不是每句输入都值得立卡。Coordinator 收到 PI 消息先做三分类：

| 类型 | 判据 | 处理 |
|---|---|---|
| 轻量问答 | 答案可从已有对象（TaskCard/RunRecord/报告/note）直接给出，无需执行 | 直接回答，不建 TaskCard、不产生对象 |
| 追问/修订 | 指向当前活动任务 | 走 §7.1 append/interrupt 语义 |
| 新工作 | 需要运行、改码、分析或产出报告 | 建 TaskCard，走完整闭环 |

规则：轻量问答**不得触发工具执行与对象写入**——要执行就必须有卡，审计链不留裸执行；
分类保守（拿不准就立卡），分错的代价是一次澄清而不是治理漏洞；回答引用对象时照常带 ID。

交互定位是 **workbench-first 双通道**（2026-07-02 裁决，对齐效果图实态）：结构化操作
（审批、建议动作确认、导出、Pause/Park）走面板控件，每次点击生成等价审计事件；
自然语言输入框负责表达意图、澄清与发起新工作。"对话驱动"指任务由对话**发起与修订**，
不指一切操作都要打字。典型闭环：

```text
PI: "ccw 洪峰偏低，做敏感性分析"
→ Activity Feed: Coordinator 创建任务 → Worker 编译运行 → 参数扫描
→ Experiment Dashboard: 实时更新水文过程线 + 参数表
→ Results Panel: 指标卡片 + 热力图 + 下一步建议
→ PI 在 Next Action 面板点击选择

PI: "选方案 1, 补 holdout 验证"
→ Coordinator 自动创建子任务 → 执行 → 报告
```

### 7.1 PI 介入语义（运行中任务）

Agent 执行期间 PI 的输入不是"发出去就没了"，按三级语义处理（协议细节见 [WebSocket_Protocol](../03_SPEC/WebSocket_Protocol.md) §10.1）：

| PI 行为 | 语义 | 前端呈现 |
|---|---|---|
| 直接输入消息 | 默认 `append`：入队，下一轮推理前注入 | 消息旁显示"已排队，将在当前步骤后生效" |
| 点击"打断并调整" | `interrupt`：当前工具调用完成后重新规划 | Feed 显示"正在中断当前步骤…"直至 ack |
| 点击"终止任务" | `abort`：任务取消，运行中 job 一并 cancel | 二次确认后执行 |

关键区别必须让 PI 看得见：**agent 在思考（LLM 推理中）、job 在跑（模型计算中）、任务已挂起（parked）是三种不同状态**，输入框旁的状态提示随 `agent.turn.*` / `job.status` / `task.updated` 事件切换。parked 期间的输入会被保存并在 resume 时注入，前端明确提示这一点。

## 8. Markdown 报告

每个任务仍生成 `reports/TASK-*_report.md`，在 `/reports/:taskId` 路由全屏渲染。
报告内容与工作台面板数据一致，但以线性文档形式呈现，适合存档和离线阅读。
