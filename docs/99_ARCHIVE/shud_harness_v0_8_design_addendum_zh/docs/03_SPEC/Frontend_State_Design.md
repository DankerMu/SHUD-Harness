# 前端状态设计

**状态：** P1 设计规范  
**适用范围：** Web-first Scientific Workbench，React，WebSocket reducer，四栏布局  
**目标：** 让前端状态与 TaskCard、RunJob、RunRecord 和 EvidenceReport 一致，避免聊天 UI 与实验状态脱节。

## 1. 四栏布局状态

v0.8 Web Console 推荐四栏：

```text
SideNav | AgentActivityFeed | ExperimentDashboard | ResultsPanel
```

每栏关注不同状态层：

| 区域 | 主要状态 | 数据来源 |
|---|---|---|
| SideNav | workspace、session、task list、ResearchContext、CostMonitor | REST snapshot + WebSocket events |
| AgentActivityFeed | agent messages、tool events、PI gate、plan | WebSocket event log |
| ExperimentDashboard | active experiment、RunJob、RunRecord、charts、terminal | REST artifact + WebSocket job events |
| ResultsPanel | metrics、comparison、sensitivity、next action、report | RunRecord/EvidenceReport artifact |

## 2. Store 分层

建议将前端状态分为五层：

```text
connectionStore     # WebSocket 连接、seq、重连状态
entityStore         # TaskCard、RunJob、RunRecord、Report、Artifact 等实体缓存
activityStore       # AgentActivityFeed 使用的事件流
uiStore             # 当前选中的 task/run/chart/tab/filter
permissionStore     # 当前用户角色、可执行动作、PI gate 权限
```

实体数据应可通过 REST snapshot 重建；活动流用于展示过程，不应成为唯一事实来源。

## 3. WebSocket reducer

所有 WebSocket 事件先进入统一 reducer：

```ts
function applyWsEvent(state: AppState, event: WsEvent): AppState {
  if (state.seenEventIds.has(event.event_id)) return state;
  state.connection.lastSeq = Math.max(state.connection.lastSeq, event.seq);
  // 根据 event.type 更新 entity/activity/ui 派生状态
  return state;
}
```

原则：

- event 去重；
- seq 单调；
- 不按到达时间排序；
- 失败事件不覆盖已成功 artifact；
- task/run/report 状态以服务端实体为准。

## 4. Entity 模型

前端应缓存以下实体：

```ts
TaskCard
StackLock
DataProvenance
RunJob
RunRecord
AnalysisPlan
EvidenceReport
ChangeRequest
Artifact
PiGate
```

实体 ID 使用后端 canonical schema。前端不应自行生成永久 ID；临时 optimistic ID 必须在服务端确认后替换。

## 5. ActivityFeed 派生规则

AgentActivityFeed 展示用户可理解的事件卡片：

| 事件类型 | Feed 卡片 |
|---|---|
| `agent.message` | Agent 文本消息 |
| `plan.created` | 计划卡片，可展开步骤 |
| `tool.started/completed/failed` | 工具调用卡片 |
| `job.submitted/status` | 运行任务卡片 |
| `runrecord.created` | 结果卡片 |
| `pi_gate.required` | 审批卡片 |
| `report.draft_created` | 报告卡片 |

内部事件默认不展示，但可在 debug 模式查看。

## 6. RuntimeTerminal 状态

RuntimeTerminal 不保存完整日志在 React state 中，避免大日志拖慢 UI。推荐：

- 最新 N 行保存在内存；
- 完整日志通过 artifact 下载；
- 支持按 stream 过滤 stdout/stderr/job；
- job 完成后显示日志文件路径；
- 搜索时从服务端分页读取。

## 7. Chart 数据状态

图表数据不应通过 WebSocket 全量推送。WebSocket 只发送 artifact 生成事件：

```text
artifact.created → 前端 fetch /api/artifacts/:id/data
```

图表状态包含：

```ts
chartState: {
  selectedRunIds: string[];
  selectedVariable: string;
  selectedElementOrRiverId?: string;
  aggregation: "outlet" | "basin_mean" | "basin_sum" | "selected_id";
  timeWindow?: [string, string];
}
```

## 8. 权限驱动 UI

按钮显示由 permissionStore 决定，但服务端仍要校验。

| 动作 | 前端条件 |
|---|---|
| approve PI gate | 当前用户有 `pi.approve` |
| cancel job | 有 task write 权限且 job 可取消 |
| collect job | 有 ops 权限且 job 已完成 |
| apply patch | 有 code approval 权限 |
| mark report accepted | PI 或授权 reviewer |

## 9. Snapshot 加载

页面刷新时：

1. 获取 workspace snapshot；
2. 获取 active session snapshot；
3. 获取当前 task/run/report 实体；
4. 建立 WebSocket，传入 `since_seq`；
5. reducer 补齐事件；
6. 如果 seq 过期，重新拉取 snapshot。

## 10. 错误 UI

前端错误分三类：

| 类型 | 显示方式 |
|---|---|
| transient | toast，例如 WebSocket 正在重连 |
| task-level | TaskCard 顶部 warning/error banner |
| critical | blocking modal，例如权限不足、workspace 损坏 |

不要把模型运行失败简单显示为“系统错误”；应展示 RunJob 失败、日志路径和建议下一步。

## 11. 验收标准

- [ ] 页面刷新后能从 snapshot 恢复当前 task/run 状态。
- [ ] WebSocket 重连不重复显示旧事件。
- [ ] 大日志不会导致 UI 卡顿。
- [ ] 图表通过 artifact API 加载，不通过 WebSocket 全量推送。
- [ ] PI gate 的按钮显示和服务端权限一致。
- [ ] ResultsPanel 不展示缺少 RunRecord 的结果为 confirmed evidence。
