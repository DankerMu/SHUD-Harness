# Patch: Auth_Permission_Design.md additions

**目标文档：** `docs/03_SPEC/Auth_Permission_Design.md`  
**目的：** 补充 PI comment 必填规则、通知收件人和通知 secret 管理。  
**合并方式：** 在 PI gate、API key 管理、审计日志、验收标准中追加。

## 插入位置 1

在 `## 4. PI gate` 审批记录之后追加：

```markdown
### PI decision comment rules

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
```

## 插入位置 2

在 `## 6. API key 管理` 后追加：

```markdown
### Notification secret policy

SMTP / SendGrid / notification provider 凭据只允许来自：

```text
.env.local
workspace/secrets/
system keyring
```

不得写入 RunRecord、EvidenceReport、artifact manifest、NotificationRecord body 或 git。
```

## 插入位置 3

新增 notification recipient 规则：

```markdown
## Notification recipient resolution

MVP email notification 的收件人解析顺序：

```text
task.notification_recipients[]
→ task.pi_owner_email
→ task.reviewer_email
→ HARNESS_DEFAULT_NOTIFY_EMAIL
```

无可用收件人时，系统写入 `NotificationRecord(status=skipped)`，不得中断 RunRecord、AnalysisPlan summary 或 EvidenceReport 生成。
```

## 插入位置 4

在 `## 8. 审计日志` 中补充：

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

## 插入位置 5

在验收标准追加：

```markdown
- [ ] reject/request_revision 缺少 comment 时服务端拒绝。
- [ ] high-risk approve 缺少 comment 时服务端拒绝。
- [ ] Agent 不能调用 PI decision endpoint 成功通过权限检查。
- [ ] Notification provider secrets 不进入任何 report、RunRecord 或 artifact。
- [ ] 无 notification recipient 时写 skipped，不中断主流程。
```
