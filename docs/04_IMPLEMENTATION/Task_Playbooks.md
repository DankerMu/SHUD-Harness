# Task Playbooks (Web 交互)

## 1. 工程任务：添加输出诊断

```text
PI 在对话框输入：添加 event_flux 诊断，但不能破坏旧 rSHUD reader。

步骤：
1. Coordinator 自动 → POST /api/tasks (type=engineering)
2. 自动 → POST /api/stacks/lock
3. 自动 → POST /api/tasks/:id/run-tiny (baseline)
   → 前端 LogViewer 实时展示编译/运行日志
4. Worker 修改 SHUD output (在 worktree 中)
5. Worker 修改 rSHUD reader
6. 自动 → run tiny + rSHUD roundtrip + old-output fixture
7. 自动 → 生成 ChangeRequest + patch bundle
8. 自动 → POST /api/tasks/:id/report → 前端展示报告
9. 前端弹出 ApprovalButtons → PI 点击 Accept/Revise/Reject
```

## 2. 科学辅助任务：洪峰偏低敏感性分析

```text
PI 在对话框输入：对 Cache Creek storm，检查 ksat 和 roughness 对洪峰的敏感性。

步骤：
1. Coordinator 自动 → POST /api/tasks (type=science_assist)
2. 自动 → POST /api/data/register
3. 自动 → POST /api/analysis/sensitivity (创建 AnalysisPlan)
4. 自动 → run baseline → 前端实时日志
5. 自动 → run parameter sweep (6 组合)
   → 长任务: park, WebSocket 推送完成通知
6. 自动 → 汇总 metrics + tornado 图 → 前端图表组件渲染
7. 自动 → 生成报告 → 前端展示
8. 前端弹出审批 → PI 选择下一步
```

Agent 不得写："H2 is validated"。
Agent 可以写："Within this event, peak timing is more sensitive to hillslope roughness multiplier than ksat multiplier."

## 3. 运维任务：记录失败经验

```text
Coordinator 自动记录一次兼容性失败：

1. 自动 → POST /api/tasks (type=ops)
2. 后端执行诊断，前端展示日志
3. 自动 → POST /api/notes (type=compatibility_note, tags=["rshud","output-compatibility"])
4. task done → 前端通知
```

不需要 Critic，不需要 Coordinator approval。

## 4. Patch review playbook

```text
1. Ensure patch only touches allowed worktree files.
2. Ensure tiny benchmark was run if executable code changed.
3. Ensure old-output check was run if output/reader changed.
4. Ensure report lists StackLock and DataProvenance.
5. If interface breaking, mark needs_pi_approval → 前端弹出审批按钮.
```
