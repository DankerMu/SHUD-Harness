# REST API、WebSocket 与 Schemas

## 1. API 端点 (Hono 后端)

```text
# 工作区
POST   /api/workspace/init              # 初始化工作区

# 任务
POST   /api/tasks                       # 创建任务
GET    /api/tasks                       # 任务列表
GET    /api/tasks/:id                    # 任务详情
POST   /api/tasks/:id/plan               # 生成执行计划
DELETE /api/tasks/:id/artifacts          # 清理临时文件

# 版本与数据
POST   /api/stacks/lock                  # 锁版本
POST   /api/data/register                # 注册数据源

# 执行
POST   /api/tasks/:id/run-tiny           # 运行 tiny benchmark
POST   /api/jobs                         # 提交长任务
GET    /api/jobs/:id                      # 查询 job 状态
POST   /api/jobs/:id/collect              # 收集结果

# 分析
POST   /api/analysis/sensitivity         # 敏感性分析
POST   /api/analysis/calibration         # 校准

# 报告与变更
POST   /api/tasks/:id/report              # 生成报告
GET    /api/patches/:id/diff              # 查看 patch diff
POST   /api/patches/:id/bundle            # 打包 patch

# 笔记
POST   /api/notes                        # 添加笔记
GET    /api/notes                        # 笔记列表
```

## 2. WebSocket 端点

```text
WS     /ws/chat                          # LLM 对话流 (streaming)
WS     /ws/logs/:jobId                   # Job 日志实时流
WS     /ws/events                        # 全局事件推送 (job 完成/审批请求/成本告警)
```

## 3. 任务创建示例 (Web 界面)

PI 在对话框输入: "添加 event_flux 诊断输出，不能破坏旧 rSHUD reader"

→ Coordinator 解析后调用:
```json
POST /api/tasks
{
  "type": "engineering",
  "title": "Add optional event diagnostics",
  "question_or_goal": "Add event_flux output without breaking old rSHUD readers",
  "inference_budget": { "mode": "normal" }
}
```

## 4. Sensitivity 分析示例 (Web 界面)

PI 在对话中说: "对 ccw 暴雨做 ksat 和 roughness 的敏感性分析"

→ Coordinator 调用:
```json
POST /api/analysis/sensitivity
{
  "task_id": "TASK-0002",
  "parameters": {
    "ksat_multiplier": [0.5, 1.0, 2.0],
    "mannings_n_multiplier": [0.7, 1.0, 1.3]
  },
  "metrics": ["peak_flow_error", "water_balance_residual"]
}
```

## 5. Schema Validation (Zod)

每个 YAML/JSON 对象读写时用 Zod 验证，前后端共享 schema 定义：

```text
TaskCard        → packages/core/src/domain/schemas/task.ts
StackLock       → packages/core/src/domain/schemas/stacklock.ts
DataProvenance  → packages/core/src/domain/schemas/provenance.ts
RunJob          → packages/core/src/domain/schemas/job.ts
RunRecord       → packages/core/src/domain/schemas/run-record.ts
AnalysisPlan    → packages/core/src/domain/schemas/analysis.ts
EvidenceReport  → packages/core/src/domain/schemas/report.ts
ChangeRequest   → packages/core/src/domain/schemas/change.ts
MemoryNote      → packages/core/src/domain/schemas/note.ts
```

## 6. Report Generation

Report 由确定性模板 + 可选 LLM polish 组成：

```text
metrics summary:    脚本生成 → 前端图表组件渲染
logs summary:       脚本生成 → 前端 LogViewer 展示
interpretive text:  LLM 草拟，标记为 draft
PI decision:        前端 ApprovalButtons → POST /api/tasks/:id/approve
```
