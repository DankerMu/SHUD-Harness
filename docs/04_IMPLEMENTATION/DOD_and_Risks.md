# Definition of Done 与风险控制

## 1. MVP DoD

系统达到 MVP 可用，需要满足：

```text
1. Web 界面能创建 task、绑定 stack/data、运行 job、生成 report。
2. 每个 run 有 RunRecord、logs、metrics 和 artifacts。
3. tiny benchmark 可重复运行。
4. rSHUD roundtrip 可运行。
5. sensitivity analysis 可生成 table 和图表。
6. patch bundle 可生成并可回滚。
7. 长任务可 park/collect/resume。
8. 每个 task 显示 LLM cost 和 compute cost。
9. PI 在浏览器中对话 + 看报告 + 点审批即可做下一步决策。
```

## 2. 删除/降级清单

v0.6 明确删除或降级：

```text
- 20+ 顶级对象；
- Commander 科研主控定位（已改为 Coordinator）；
- Critic 科学判断角色；
- memory 四级审批；
- skill 六级生命周期；
- 双路径 fork/no-fork 摇摆（已决定基于 Zero 扩展）；
- Harness Optimizer MVP。
```

## 3. 高风险动作

必须 PI approval：

```text
- 修改物理方程；
- 修改默认参数；
- 更新 benchmark baseline；
- 破坏性 I/O 改动；
- 删除 raw data；
- 宣称科学结论 accepted。
```

## 4. 失败标准

出现以下情况，任务必须 block：

```text
- 超过 max retries；
- 没有 baseline 却生成比较结论；
- 没有 StackLock/DataProvenance 却要进入报告验证区；
- Worker 修改了允许范围之外的文件；
- Job 无进展超过阈值。
```

注意：超过 inference budget advisory 值**不会**自动 block 任务。
状态栏标黄提醒，由 PI 在 Web Dashboard 自行决定是否中止（见 `03_SPEC/Cost_Inference_Budget.md`）。

## 5. v0.8.2 新增 DoD

开发阶段 DoD 增加：

- [ ] 新功能关联至少一个 `FR-*` 或 `NFR-*`。
- [ ] P0/P1 requirement 有测试 ID。
- [ ] 新 endpoint 有 latency expectation 或明确豁免。
- [ ] 新长任务行为有 structured log 和 ErrorRecord。
- [ ] 新 artifact 类型进入 Artifact registry。
- [ ] 新运维风险进入 Runbook 或 AlertRule。
- [ ] 新依赖进入 DependencyLock 或说明无需锁定。

## 6. v0.8.2 新增风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 无 health endpoint | 部署后无法判断服务是否可接收任务 | W1 实现 live/ready |
| 性能目标缺失 | UI/API 在开发后期才发现不可用 | W1 建 perf smoke |
| 运维手册缺失 | 真实长任务失败后恢复混乱 | W3 前合并 Operations_Runbook |
| lockfile 漂移 | schema/runtime 行为不稳定 | frozen install + dependency check |
| 需求无编号 | 测试和 release gate 无法追踪 | Requirements_Catalog + Traceability |

## Theory-to-Code DOD additions

Release blocker:
- high-risk scientific ChangeRequest accepted without TheoryToCodeBundle;
- calibration/search report claims theory validation;
- failed VerificationCase hidden from EvidenceReport;
- output semantics changed without PI gate.

Done means:
- high-risk changes have bundle, mapping, verification evidence and PI decision;
- search is only run downstream of accepted_for_search or low-risk baseline analysis.

### Theory-to-Code DOD 验收标准

- [ ] 合并后不破坏现有 8 核心对象原则。
- [ ] 高风险科学变更不能绕过 PI gate。
- [ ] Search/calibration 仍保持后置。

## 7. 成功不是自治，而是节省 PI 和工程师时间

评价指标：

```text
- tiny run 从手动到自动节省多少时间；
- 失败日志定位是否更快；
- sensitivity 表和图是否自动生成；
- patch 是否更容易 review；
- old-output compatibility 是否更早发现；
- 报告是否让 PI 更快做决策。
```
