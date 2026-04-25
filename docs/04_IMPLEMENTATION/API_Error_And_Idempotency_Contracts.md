# API Error 与 Idempotency Contracts

**状态：** v0.8.1 P1 实施补充  
**适用范围：** Hono REST API、frontend API client、retry、error UI、audit。  
**目标：** 固定错误响应格式和幂等请求规则，避免前端和后端实现漂移。

## 1. Error response envelope

所有非 2xx API 响应使用：

```ts
interface ApiErrorResponse {
  error: {
    error_id: string;
    category: string;
    severity: "info" | "warn" | "error" | "critical";
    message: string;
    user_message: string;
    evidence_refs: string[];
    retryable: boolean;
    recommended_next_actions: string[];
  };
}
```

## 2. HTTP status mapping

| 场景 | HTTP |
|---|---:|
| schema_error | 400 |
| auth missing | 401 |
| permission_error | 403 |
| not found | 404 |
| conflict / lock held | 409 |
| idempotency key mismatch | 422 |
| transient server error | 503 |

## 3. Idempotency header

对写操作推荐使用：

```http
Idempotency-Key: task:TASK-001:report:REPORT-001:v1
```

适用 API：

```text
POST /api/jobs
POST /api/jobs/:id/collect
POST /api/tasks/:id/report
POST /api/reports/:id/export
POST /api/pi-gates/:id/decision
```

## 4. Retry policy

前端只能自动 retry：

- 幂等 GET；
- 带 Idempotency-Key 且服务端声明 retryable 的 POST；
- WebSocket reconnect。

不得自动 retry：

- PI gate decision；
- high-risk patch apply；
- raw data delete；
- benchmark baseline overwrite。

## 5. 验收标准

- [ ] 所有 API 错误返回统一 envelope。
- [ ] 前端错误 UI 使用 `user_message`，不是 raw exception。
- [ ] 缺少 required comment 的 PI decision 返回 400。
- [ ] lock conflict 返回 409。
- [ ] idempotency mismatch 返回 422。
