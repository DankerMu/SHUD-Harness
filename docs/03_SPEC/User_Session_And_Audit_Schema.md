# User、Session 与 Audit Schema

**状态：** v0.8.1 P1 补充规范  
**适用范围：** Auth_Permission_Design、PI gate、WebSocket session、audit log、small_team 部署。  
**目标：** 把权限文档中的角色和审计原则落实为可编码 schema。

## 1. User

```ts
interface User {
  user_id: string;
  display_name: string;
  email?: string;
  roles: Array<"pi" | "engineer" | "reviewer" | "viewer">;
  status: "active" | "disabled";
  created_at: string;
  last_login_at?: string;
}
```

## 2. Session

```ts
interface Session {
  session_id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  last_active_at: string;
  auth_mode: "local_single_user" | "small_team";
  csrf_token_ref?: string;
  websocket_allowed: boolean;
}
```

## 3. PermissionDecision

每个敏感操作应记录权限判定，至少在 debug/audit 中可查。

```ts
interface PermissionDecision {
  decision_id: string;
  actor_type: "user" | "agent" | "system";
  actor_id: string;
  action: string;
  target_id?: string;
  allowed: boolean;
  reason: string;
  evaluated_at: string;
}
```

## 4. AuditEvent

```ts
interface AuditEvent {
  audit_id: string;
  actor_type: "user" | "agent" | "system";
  actor_id: string;
  action:
    | "login"
    | "create_task"
    | "submit_job"
    | "collect_job"
    | "generate_report"
    | "export_report"
    | "decide_pi_gate"
    | "apply_patch"
    | "delete_artifact"
    | "change_config";
  target_type?: string;
  target_id?: string;
  result: "success" | "failure" | "blocked";
  permission_decision_id?: string;
  evidence_refs: string[];
  created_at: string;
}
```

## 5. Agent identity

Agent 不是普通 user。Agent 可有 `agent_id`，但不得拥有 `pi` role。

```ts
interface AgentIdentity {
  agent_id: string;
  role: "coordinator" | "execution_worker" | "analysis_worker" | "coder" | "reviewer" | "memory_curator";
  task_id: string;
  delegated_by_user_id?: string;
  allowed_tools: string[];
  denied_actions: string[];
}
```

## 6. 验收标准

- [ ] WebSocket 建连绑定有效 Session。
- [ ] PI gate decision 写 AuditEvent。
- [ ] Agent 身份没有 `pi` role。
- [ ] 权限失败写 PermissionDecision 和 AuditEvent。
- [ ] AuditEvent 不包含 secrets。
