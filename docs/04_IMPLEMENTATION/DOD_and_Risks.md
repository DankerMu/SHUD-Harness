# Definition of Done 与风险控制

## 1. MVP DoD

系统达到 MVP 可用，需要满足：

```text
1. CLI 能创建 task、绑定 stack/data、运行 job、生成 report。
2. 每个 run 有 RunRecord、logs、metrics 和 artifacts。
3. tiny benchmark 可重复运行。
4. rSHUD roundtrip 可运行。
5. sensitivity analysis 可生成 table 和图表。
6. patch bundle 可生成并可回滚。
7. 长任务可 park/collect/resume。
8. 每个 task 显示 LLM cost 和 compute cost。
9. PI 可以从 Markdown report 做下一步决策。
```

## 2. 删除/降级清单

v0.6 明确删除或降级：

```text
- 20+ 顶级对象；
- Commander 科研主控定位（已改为 Coordinator）；
- Critic 科学判断角色；
- memory 四级审批；
- skill 六级生命周期；
- 10 页 Web Console；
- 双路径 fork/no-fork 摇摆；
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
- 超过 inference budget；
- 超过 max retries；
- 没有 baseline 却生成比较结论；
- 没有 StackLock/DataProvenance 却要进入报告验证区；
- Worker 修改了允许范围之外的文件；
- Job 无进展超过阈值。
```

## 5. 成功不是自治，而是节省 PI 和工程师时间

评价指标：

```text
- tiny run 从手动到自动节省多少时间；
- 失败日志定位是否更快；
- sensitivity 表和图是否自动生成；
- patch 是否更容易 review；
- old-output compatibility 是否更早发现；
- 报告是否让 PI 更快做决策。
```
