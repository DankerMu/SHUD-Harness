# Task Playbooks

## 1. 工程任务：添加输出诊断

```text
PI/Engineer 输入：添加 event_flux 诊断，但不能破坏旧 rSHUD reader。

步骤：
1. create TaskCard(type=engineering)
2. lock StackLock
3. run tiny baseline
4. Worker 修改 SHUD output
5. Worker 修改 rSHUD reader
6. run tiny + rSHUD roundtrip + old-output fixture
7. build ChangeRequest
8. generate report
9. PI/Engineer review patch
```

## 2. 科学辅助任务：洪峰偏低敏感性分析

```text
PI 输入：对 Cache Creek storm，检查 ksat 和 hillslope roughness 对洪峰误差的敏感性。

步骤：
1. create TaskCard(type=science_assist)
2. register DataProvenance
3. create AnalysisPlan(mode=sensitivity)
4. run baseline
5. run parameter sweep
6. summarize metrics + plots
7. generate report with limitations
8. PI 判断是否继续校准或补 holdout
```

Agent 不得写："H2 is validated"。

Agent 可以写："Within this event, peak timing is more sensitive to hillslope roughness multiplier than ksat multiplier."

## 3. 运维任务：记录失败经验

```text
输入：rSHUD roundtrip failed due to missing optional event_flux.csv.

步骤：
1. create note(type=compatibility_note)
2. link failed RunRecord/report
3. add tag rshud, output-compatibility
4. next similar task retrieves note
```

不需要 Critic，不需要 Commander approval。

## 4. Patch review playbook

```text
1. Ensure patch only touches allowed worktree files.
2. Ensure tiny benchmark was run if executable code changed.
3. Ensure old-output check was run if output/reader changed.
4. Ensure report lists StackLock and DataProvenance.
5. If interface breaking, mark needs_pi_approval.
```
