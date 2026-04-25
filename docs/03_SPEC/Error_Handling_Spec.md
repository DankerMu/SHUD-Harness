# 错误处理规范

**状态：** P1 设计规范  
**适用范围：** API、WebSocket、Sandbox、RunJob、Collect、Report、AgentLoop  
**目标：** 统一错误分类、严重性、重试策略和用户提示，使失败可复盘、可恢复、不可伪装。

## 1. 错误分类

| 类别 | 示例 | 处理策略 |
|---|---|---|
| `schema_error` | 请求字段缺失、状态非法 | 立即返回 400，前端提示修正 |
| `permission_error` | 无权批准 PI gate | 返回 403，写 audit log |
| `workspace_error` | 路径不存在、manifest 损坏 | 标记 task blocked，要求人工检查 |
| `sandbox_error` | 命令超时、cwd 非法 | 停止工具调用，记录 tool failure |
| `build_error` | SHUD 编译失败 | 生成失败 RunRecord 或 build artifact |
| `runtime_error` | SHUD exit code 非 0 | collect 日志并标记 run failed |
| `numerical_error` | CVODE failures、负状态、water balance fail | run 可完成但 numerical_health failed |
| `parser_error` | rSHUD 读取失败、输出变量缺失 | 生成 parser failure artifact |
| `report_error` | 报告引用缺失 artifact | 阻止 report reviewed |
| `agent_error` | LLM 工具选择错误、上下文不足 | Coordinator 可恢复或要求 PI 输入 |

## 2. 严重性

```text
info      # 不影响流程，例如成本提醒
warn      # 有异常但可继续，例如缺少可选 lake 输出
error     # 当前步骤失败，需要修复或重试
critical  # 可能破坏数据或科研治理，必须停止
```

## 3. 标准错误对象

```yaml
error:
  error_id: ERR-001
  category: runtime_error
  severity: error
  task_id: TASK-001
  run_id: RUN-001
  message: "SHUD exited with code 1"
  evidence_refs:
    - artifacts/logs/RUN-001.stderr
  recommended_next_actions:
    - "检查 input project 文件路径"
    - "查看最后 100 行 stderr"
  retryable: true
  created_at: ...
```

## 4. RunJob 失败规则

RunJob 失败不等于 TaskCard 失败。TaskCard 可以进入：

- `collecting`：仍需收集失败日志；
- `reporting`：生成失败分析报告；
- `awaiting_pi`：需要 PI 决定是否重试或调整；
- `blocked`：缺少必要输入或权限。

失败 RunJob 也应生成最小 RunRecord 或 FailureRecord，包含命令、环境、日志、exit code 和资源使用。

## 5. 重试策略

| 错误 | 自动重试 | 条件 |
|---|---:|---|
| WebSocket 短暂断线 | ✓ | 前端重连 |
| API transient 5xx | ✓ | 幂等 GET 或明确 idempotency key |
| Sandbox timeout |  | 需要用户或 Coordinator 调整 timeout |
| SHUD 编译失败 |  | 不自动修改依赖或源码 |
| rSHUD parser 缺少可选变量 | ✓ | 标记 not_available 后继续 |
| numerical health fail |  | 不自动改参数 |
| LLM 生成报告语言违规 | ✓ | 使用 guard 后重新生成一次 |

## 6. 用户提示

错误提示应包含：

- 发生了什么；
- 影响范围；
- 证据链接；
- 推荐下一步；
- 是否需要 PI/工程师处理。

示例：

```text
SHUD 运行失败，exit code=1。失败日志已保存到 artifacts/logs/RUN-001.stderr。
当前结果不会进入 EvidenceReport 的已验证结果部分。建议先查看 input project 路径和 SUNDIALS 运行信息。
```

## 7. Parser 与变量缺失

输出变量缺失分为：

| 类型 | 处理 |
|---|---|
| required missing | run 或 metrics 失败 |
| optional missing | 标记 `not_available` |
| unknown variable | 标记 `advanced_unknown` |
| corrupted file | parser_error，保留原文件 |

## 8. 报告错误

报告生成失败时，不应删除已有 RunRecord 或 metrics。应生成：

```text
reports/REPORT-001.generation_error.yaml
```

并允许用户重新生成报告。

## 9. WebSocket 错误事件

```json
{
  "type": "error.raised",
  "payload": {
    "error_id": "ERR-001",
    "category": "runtime_error",
    "severity": "error",
    "message": "SHUD exited with code 1",
    "evidence_refs": ["artifacts/logs/RUN-001.stderr"]
  }
}
```

## 10. 验收标准

- [ ] 每个失败 tool/job/report 都有结构化错误对象。
- [ ] 失败 run 不会被误标为 succeeded。
- [ ] numerical health fail 不会被隐藏。
- [ ] parser 缺少可选变量不会导致整个 UI 崩溃。
- [ ] 重试只发生在明确安全和幂等的场景。
- [ ] 用户提示包含 evidence refs。
