# 交互模型：Web-first，对话驱动，报告产出

## 1. 日常入口

Web 是用户唯一的交互渠道。PI 在浏览器中完成所有操作：

- **实时对话**: 与 Coordinator Agent 自然语言交互
- **日志流**: 实时查看 SHUD 编译/运行输出
- **审批按钮**: 高风险变更的 PI gate
- **报告阅读**: 在浏览器中阅读和批注 Markdown 报告
- **Dashboard**: 任务列表、Job 状态、成本监控

## 2. Web 交互流程

```text
PI 打开浏览器 → 登录 → Dashboard (任务概览)
  ├── 对话框: "帮我诊断 ccw 暴雨洪峰偏低"
  │   → Coordinator 自动创建 TaskCard + 规划 + 执行
  │   → 前端实时展示日志流 (WebSocket)
  │   → 完成后弹出报告 + 审批选项
  ├── 任务列表: 查看所有 task 状态
  │   → 点击进入详情 (RunRecord, artifacts, logs)
  ├── 审批区: 待 PI 判断的任务
  │   → 查看 EvidenceReport → 点击 Accept / Revise / Reject
  └── 成本面板: 实时 LLM + compute 消耗
```

## 3. API 端点 (Hono 后端)

```text
# 任务管理
POST   /api/tasks                    # 创建任务
GET    /api/tasks                    # 任务列表
GET    /api/tasks/:id                # 任务详情
POST   /api/tasks/:id/plan           # 生成执行计划
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

# 报告与变更
POST   /api/tasks/:id/report          # 生成报告
GET    /api/patches/:id/diff          # 查看 patch diff
POST   /api/patches/:id/bundle        # 打包 patch

# 笔记
POST   /api/notes                    # 添加笔记
GET    /api/notes                    # 笔记列表

# 实时通信
WS     /ws/chat                      # 对话流 (LLM streaming)
WS     /ws/logs/:jobId               # Job 日志流
WS     /ws/events                    # 全局事件推送 (job 完成/审批请求)
```

## 4. PI 交互界面

PI 不需要理解技术细节。Web 界面为 PI 展示：

```text
┌─────────────────────────────────────────────────┐
│  SHUD-Harness    [Tasks] [Reports] [Cost]       │
├─────────────────────────────────────────────────┤
│  💬 对话区                           审批区 📋   │
│  ┌─────────────────────────┐  ┌──────────────┐  │
│  │ PI: ccw 洪峰偏低原因？  │  │ TASK-0002    │  │
│  │                         │  │ 状态: 等待审批│  │
│  │ Agent: 已创建敏感性分析 │  │ [接受] [修改] │  │
│  │ 任务，正在运行 baseline │  │ [拒绝]       │  │
│  │ ...                     │  │              │  │
│  │ ▌                       │  │ TASK-0003    │  │
│  └─────────────────────────┘  │ 状态: 运行中 │  │
│  [输入消息...]                 │ 进度: 4/6    │  │
│                                └──────────────┘  │
├─────────────────────────────────────────────────┤
│  📊 实时日志 (TASK-0002 / JOB-0005)             │
│  [2026-04-25 10:12:03] Compiling SHUD...        │
│  [2026-04-25 10:12:15] Running ccw 30-day...    │
│  [2026-04-25 10:14:22] Water balance: 0.0008 ✓  │
└─────────────────────────────────────────────────┘
```

## 5. Markdown 报告仍是核心产出

每个任务生成 `reports/TASK-*_report.md`，在浏览器中渲染展示。报告内容：

```text
- 任务目标
- 代码/环境版本 (StackLock)
- 数据来源 (DataProvenance)
- 运行清单 (RunRecord 列表)
- 指标摘要 (确定性脚本生成)
- 图表 (嵌入或链接)
- 失败和不确定性
- patch 摘要
- 下一步选项 (PI 点击选择)
```

## 6. 对话是主工作流

PI 通过自然语言对话驱动所有操作：

```text
PI: "给 SHUD 添加 event flux 诊断输出"
→ Coordinator 自动: 创建 task → lock stack → run baseline → 等待 PI 确认方案

PI: "ccw 洪峰偏低，做敏感性分析"
→ Coordinator 自动: 创建 task → register data → 创建 AnalysisPlan → run sweep → 生成报告

PI: "解释上次报告里 old-output compatibility 为什么失败"
→ Coordinator: 检索 note + RunRecord → 生成解释
```
