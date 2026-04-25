# 认证与权限设计

**状态：** P1 设计规范  
**适用范围：** 本地 MVP、小团队部署、PI gate、API key、session  
**目标：** 在不引入过重企业权限系统的前提下，保证科研治理动作不能被误触发或被 Agent 绕过。

## 1. MVP 模式

建议支持两种模式：

| 模式 | 场景 | 特点 |
|---|---|---|
| local_single_user | PI 本机或可信开发机 | 简单登录或本地 token；默认具备 PI 权限 |
| small_team | 小组服务器 | 用户、角色、session、审批记录、API key vault |

即使是单用户，也应显式记录 PI gate 审批事件，便于复盘。

## 2. 角色

| 角色 | 权限概述 |
|---|---|
| `pi` | 可以批准科学治理动作、接受报告、确认 memory、覆盖 benchmark 决策 |
| `engineer` | 可以创建任务、运行 job、收集结果、提交 ChangeRequest |
| `reviewer` | 可以审查报告和 patch，但不能批准科学结论 |
| `viewer` | 只读查看任务、报告和 artifact |
| `agent` | 系统内部身份，只能执行被授权的工具调用 |

## 3. 权限矩阵

| 动作 | pi | engineer | reviewer | viewer | agent |
|---|---:|---:|---:|---:|---:|
| 创建 TaskCard | ✓ | ✓ | ✓ |  |  |
| 提交 RunJob | ✓ | ✓ |  |  | 受 Coordinator 委托 |
| collect RunJob | ✓ | ✓ |  |  | 受 Coordinator 委托 |
| 生成 EvidenceReport 草稿 | ✓ | ✓ | ✓ |  | 受 Coordinator 委托 |
| 接受 EvidenceReport | ✓ |  |  |  |  |
| 批准物理方程修改 | ✓ |  |  |  |  |
| 批准默认参数修改 | ✓ |  |  |  |  |
| 批准 benchmark baseline 覆盖 | ✓ |  |  |  |  |
| 创建 patch | ✓ | ✓ |  |  | 受 Coder 委托 |
| 应用 patch 到 baseline | ✓ |  |  |  |  |
| 删除 raw data | ✓ |  |  |  |  |

## 4. PI gate

需要 gate 的动作包括：

- 修改 SHUD 物理方程；
- 修改默认参数；
- 接受 breaking output format；
- 覆盖 benchmark baseline；
- 将 calibration 结果标记为 validated；
- 删除或覆盖 raw data；
- 将 memory candidate 标记为 PI-confirmed evidence；
- 应用影响论文结论的 patch。

审批记录：

```yaml
pi_approval:
  gate_id: GATE-001
  task_id: TASK-001
  requested_by: coordinator
  approved_by: user_pi
  decision: approved | rejected | request_revision
  comment: "同意仅用于 ccw tiny benchmark，不作为科学验证。"
  timestamp: ...
  evidence_refs:
    - reports/REPORT-001.md
```

### 4.1 PI decision comment rules

PI gate decision 支持 `comment`。必填规则：

| 场景 | comment 是否必填 |
|---|---|
| 普通 approve report | 可选 |
| reject | 必填 |
| request_revision | 必填 |
| approve scientific interpretation | 必填 |
| 将 calibration 结果标记为 validated | 必填 |
| 覆盖 benchmark baseline | 必填 |
| 修改默认参数 | 必填 |
| 应用影响论文结论的 patch | 必填 |

Canonical endpoint：

```http
POST /api/pi-gates/:gateId/decision
```

`POST /api/tasks/:id/approve` 可作为 convenience endpoint，但内部应委托到 PI gate decision handler。

## 5. Session 与登录

MVP 可以采用本地密码或一次性 setup token。小团队部署建议：

- HttpOnly session cookie；
- CSRF token；
- session 过期时间；
- 登录失败限速；
- WebSocket 建连时校验 session；
- server-side permission check。

## 6. API key 管理

LLM API key、远程服务器凭据和数据库凭据不应进入 Git 或 RunRecord。

建议：

```text
.env.local             # 本地开发，不提交
workspace/secrets/     # 加密或权限限制目录
system keyring         # 可选
```

### 6.1 Notification secret policy

SMTP / SendGrid / notification provider 凭据只允许来自：

```text
.env.local
workspace/secrets/
system keyring
```

不得写入 RunRecord、EvidenceReport、artifact manifest、NotificationRecord body 或 git。

EvidenceReport 中只记录使用的 provider/model，不记录 key。

```yaml
llm_usage:
  provider: openai
  model: gpt-5.5-pro
  api_key_ref: local_env:OPENAI_API_KEY
```

## 7. Agent 权限

Agent 不是普通用户。Agent 工具调用必须由当前用户 session 或系统策略授权：

```yaml
agent_authorization:
  task_id: TASK-001
  user_id: user_pi
  allowed_tools:
    - sandbox.exec
    - shud.run
  denied_actions:
    - delete_raw_data
    - approve_pi_gate
```

Agent 永远不能自行批准 PI gate。

## 7.1 Notification recipient resolution

MVP email notification 的收件人解析顺序：

```text
task.notification_recipients[]
→ task.pi_owner_email
→ task.reviewer_email
→ HARNESS_DEFAULT_NOTIFY_EMAIL
```

无可用收件人时，系统写入 `NotificationRecord(status=skipped)`，不得中断 RunRecord、AnalysisPlan summary 或 EvidenceReport 生成。

## 8. 审计日志

所有权限敏感动作写入 audit log：

```yaml
audit_event:
  id: AUDIT-001
  actor_type: user | agent | system
  actor_id: user_pi
  action: approve_pi_gate
  target_id: GATE-001
  timestamp: ...
  result: success
```

PI gate decision 审计示例：

```yaml
audit_event:
  id: AUDIT-002
  actor_type: user
  actor_id: user_pi
  action: decide_pi_gate
  target_id: GATE-001
  decision_id: DECISION-001
  result: success
  timestamp: ...
```

## 9. 验收标准

- [ ] WebSocket 建连需要有效 session。
- [ ] 前端按钮隐藏不作为权限依据，服务端重新校验。
- [ ] Agent 不能调用 approve/reject PI gate。
- [ ] LLM API key 不进入 RunRecord、report、artifact manifest。
- [ ] 审批记录包含 actor、decision、comment、evidence_refs。
- [ ] 删除 raw data 等高风险动作默认禁止。
- [ ] reject/request_revision 缺少 comment 时服务端拒绝。
- [ ] high-risk approve 缺少 comment 时服务端拒绝。
- [ ] Agent 不能调用 PI decision endpoint 成功通过权限检查。
- [ ] Notification provider secrets 不进入任何 report、RunRecord 或 artifact。
- [ ] 无 notification recipient 时写 skipped，不中断主流程。
