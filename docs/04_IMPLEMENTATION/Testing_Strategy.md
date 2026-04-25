# 测试策略

**状态：** P2 实施规范  
**适用范围：** schema、API、WebSocket、executor、SHUD fixture、report、UI  
**目标：** 用分层测试保证 v0.8 端到端闭环可复盘。

## 1. 测试分层

| 层级 | 测试对象 |
|---|---|
| unit | Zod schema、reducers、path policy、metric functions |
| integration | API + filesystem、WebSocket、Sandbox Executor |
| fixture | ccw tiny 或 dummy SHUD run |
| report | EvidenceReport 生成和 language guard |
| e2e | Web UI 创建 task、运行 job、生成 report |

## 2. Schema 测试

必须测试：

- TaskCard；
- StackLock；
- DataProvenance；
- RunJob；
- RunRecord；
- AnalysisPlan；
- EvidenceReport；
- ChangeRequest；
- WebSocket event envelope。

## 3. WebSocket 测试

测试场景：

- seq 单调递增；
- event 去重；
- reconnect with `since_seq`；
- snapshot fallback；
- job.log streaming；
- PI gate action 权限失败。

## 4. Sandbox 测试

测试：

- workspace 内命令成功；
- workspace 外写入被拒绝；
- timeout；
- stdout/stderr 分片；
- high risk command 被 gate；
- env secrets redaction。

## 5. Fixture 测试

MVP 推荐两个 fixture：

| fixture | 作用 |
|---|---|
| dummy runner | 快速测试 job/collect/report，不依赖 SHUD |
| ccw tiny | 测试真实 SHUD/rSHUD 闭环 |

ccw tiny 验收：

- SHUD 编译成功；
- 30 天运行 exit_code=0；
- 生成 RunRecord；
- water_balance_residual 达阈值；
- HydrographChart 可加载 `rivqdown`。

## 6. Report 测试

应包含 language guard：

- 禁止“模型机制已验证”；
- 禁止“普遍改进”；
- 必须包含 limitations；
- 必须包含 PI questions；
- artifact 引用存在。

## 7. UI 测试

E2E 流程：

```text
打开 workspace
→ 创建 task
→ 提交 dummy job
→ 查看日志流
→ collect RunRecord
→ 打开 ResultsPanel
→ 生成 report
→ PI approve/revision
```

## 8. 验收标准

- [ ] CI 跑 schema/unit/integration 测试。
- [ ] 本地可手动跑 ccw tiny fixture。
- [ ] WebSocket reconnect 有自动测试。
- [ ] 报告 language guard 有负例测试。
- [ ] Sandbox path policy 有越界测试。
