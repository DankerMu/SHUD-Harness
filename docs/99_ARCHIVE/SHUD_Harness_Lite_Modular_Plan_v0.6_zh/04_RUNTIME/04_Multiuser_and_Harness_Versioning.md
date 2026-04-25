# 多用户与 Harness 自身版本管理

## 1. 多用户假设

MVP 不做复杂 RBAC，但要支持研究组最小协作：

```text
- 多个学生可以创建 task；
- 同一个 task 同一时间只允许一个 writer；
- PI 可以 review reports；
- 数据目录有只读保护。
```

## 2. 轻量锁

```yaml
lock:
  task_id: TASK-0001
  owner: alice
  acquired_at: ...
  expires_at: ...
  mode: write
```

命令：

```bash
shud-harness task lock TASK-0001
shud-harness task unlock TASK-0001
```

## 3. Session ownership

每个 TaskCard 记录：

```yaml
created_by: alice
current_owner: alice
reviewer: pi_name
```

## 4. Harness 自身版本进入 StackLock

StackLock 必须包含：

```yaml
harness:
  runtime_version: 0.6.0
  prompt_pack: promptpack-0003
  skills_version: skills-0004
  policy_version: policy-0002
  report_template_version: reporttpl-0005
```

原因：

```text
同一个 SHUD commit + 数据，如果 prompt/skill/report template 变了，报告和执行行为也可能变。
```

## 5. Prompt / Skill 版本策略

```text
prompts/ 和 skills/ 进入 Git；
每个 task 记录使用的版本；
报告显示 prompt/skill 版本；
更新 prompt/skill 后需要跑 tiny task smoke。
```

## 6. PI 决策记录

PI 的重要判断以 note 形式保存：

```yaml
note_id: NOTE-PI-0001
type: pi_decision
status: accepted
task_id: TASK-0002
decision: "Do not pursue physics change before sensitivity and holdout analysis."
```

这是比 Agent “epistemic memory” 更可信的科学记忆。
