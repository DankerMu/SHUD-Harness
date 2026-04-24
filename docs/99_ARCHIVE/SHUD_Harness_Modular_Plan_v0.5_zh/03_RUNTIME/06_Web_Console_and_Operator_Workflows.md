# R-06 Web Console 与 Operator Workflows

## 模块状态标签
- **独立实现**：必须支持
- **ZeRo 参考实现**：强参考
- **[R] 已实现可复用**：web server、SPA control plane、WebSocket 实时桥
- **[M] 需修改后复用**：导航结构、对象页、session 页面语义
- **[N] 必须新增**：research-object-first IA、gate/memory review/job monitor 页面

## 1. 设计原则
Web Console 不是普通聊天界面，而是 **operator-first scientific console**。

## 2. 顶层导航建议
```text
1. RCS
2. Experiments
3. Runs
4. Evidence
5. Validation
6. Changes
7. Skills
8. Memory Review
9. Episode Trace
10. Jobs
```

## 3. 核心页面
### 3.1 Commander Dashboard
- active RCS
- current state briefing
- pending decisions
- pending gates
- budget

### 3.2 RCS Detail
- hypotheses
- linked experiments
- linked evidence
- linked changes
- claim status

### 3.3 Experiment / Run Explorer
- stacklock
- datasets / observations / preprocess
- treatments
- run statuses
- metrics snapshots

### 3.4 Validation Dashboard
- latest reports
- failed checks
- benchmark deltas
- holdout status

### 3.5 Change Review
- patch summary
- output contract impact
- compatibility suite
- release gate

### 3.6 Skill Registry
- candidate / tested / promoted / canonical / deprecated

### 3.7 Memory Review
- proposals
- critic review
- promote / reject

### 3.8 Episode Trace Viewer
- bash commands
- job events
- file diffs
- artifacts
- observations

### 3.9 Job Monitor
- queue
- running
- resource usage
- retries
- collected artifacts

## 4. ZeRo 映射
### [R] 可借
- Web control plane 技术栈
- WebSocket 实时更新
- control plane backend

### [M] 必须改
- chat/session 导航不能再是主导航
- 页面必须从 runtime events 转到 research objects
- traces 不能只作为消息流，而要关联 run / validation / artifacts

### [N] 必须新增
- RCS pages
- Experiment / Run / Evidence / Validation / Change pages
- Memory review
- Skill promotion review
- Job monitor
- gate review

## 5. V1 最低要求
- 能浏览 RCS / Runs / Validation / Jobs
- 能 review memory proposals
- 能 review change + compatibility + gate 状态
- 能看 bash / job / artifact 追溯链
