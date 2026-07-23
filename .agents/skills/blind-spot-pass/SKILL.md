---
name: blind-spot-pass
description: >
  开工前对陌生区域做一次盲区侦察：从代码库考古（git 历史、相似实现、隐形约定、危险区、邻接面）
  挖出你没意识到要问的 unknown unknowns，产出带证据的盲区清单、改写后的更好 prompt 和 reference 清单。
  触发词："blind spot pass"、"盲区扫描"、"找盲区"、"我还有哪些 unknown unknowns"、
  "这块有什么我不知道的坑"，或长任务即将进入不熟悉的模块/子系统、动手前想先摊开问题空间。
  不用于压测已有计划（grill-me）、需求澄清（clarify）或仓库健康度审计（repo-entropy-audit）。
invocation_posture: hybrid
version: 0.1.1
---

# Blind Spot Pass

Prompt、skill、context 是 map；真实代码库、真实约束、真实运行环境是 territory。两者的差距就是 unknowns——长程 agent 遇到没写清的空白不会停下来等你，它会替你补全世界。本 skill 在动手前把这个差距摊开：**不是从计划出发问问题（那是 `grill-me`），而是从代码库考古出发，找出你根本没意识到要问的问题**。

## 四类 unknowns（诊断词汇）

| 类别 | 含义 | 谁处理 |
|---|---|---|
| known knowns | 已写进 prompt/计划的 | 不归本 skill |
| known unknowns | 知道没想清、知道该问什么 | `clarify` / `grill-me` |
| unknown knowns | 藏在经验里，看到结果才能判断（偏好、风格） | `grill-me` 的 reference/原型铁律 |
| **unknown unknowns** | 连不知道什么都不知道（历史坑、隐形约定、不能动的模块） | **本 skill** |

## 核心铁律（Non-negotiables）

1. **只侦察，不实现**：结束时不写任何代码、不改任何项目文件；输出全部 inline。持久化走出口路由。
2. **每条盲区带证据**：file:line、commit hash 或命令输出。给不出证据的是猜测，必须标注为"假设，待验证"。
3. **消费基线，不重挖**：`openspec/project-profile.md`、`openspec/glossary.md`、`docs/adr/`、scoped 指令文件里已写明的不算盲区，直接引用。
4. **以"改变行动"为准入**：一个发现只有在会改变你接下来怎么问、怎么计划或怎么下 prompt 时才进清单；不改变行动的背景知识不列。

## 流程

1. **锚定**：确认任务意图（打算做什么）和陌生区域（哪个模块/子系统/目录）。两者缺一就先问一句。
2. **基线**：读项目 profile、glossary、ADR、相关 scoped 指令，列出"已知项"，划掉不用挖的。
3. **考古 sweep**（区域大或调用链深时，委派 `explorer` agent 并行执行；结论按证据抽查后采信）：
   - **历史**：`git log`/`git log --follow` 该区域——高频改动点、revert、fix 密集区、最近一次大改及其动机。
   - **范式**：相似的既有实现（同类 provider/handler/module）。最好的 reference 是源码——找到它，后续 prompt 直接指向它。
   - **约定**：未文档化的命名、结构、状态管理模式，以及代码里默认成立但没人写下来的不变量。
   - **危险区**：反向依赖（谁在用它）、测试覆盖薄弱处、历史事故痕迹（FIXME/HACK/绕过注释、异常分支上的特判）。
   - **邻接面**：契约、调用方、生成物、权限、状态、错误处理——这次改动会自然波及哪里。
4. **清单化**：每条盲区 = 发现 + 证据 + 对本次任务的影响 + 建议动作（问用户 / 继续查证 / 绕开 / 作为前置决策进计划）。
5. **重写 prompt**：基于清单产出一版更好的任务 prompt——补上约束、指向找到的 reference、划清边界。这是本 skill 的第二交付物，不是可选项。

## 输出

- **盲区清单**：按"对任务的影响"排序，每条带证据与建议动作。
- **改写后的 prompt**：可直接用于下一步（计划或实现）的任务描述。
- **reference 清单**：值得指给下游的源码目录/文件/文档。

## 出口路由

- 暴露的**决策点** → `grill-me` 当作分支逐个拷问（本 skill 挖出问题，grill-me 逼出答案）。
- 值得沉淀的**团队隐形约定** → `grill-with-docs`（`openspec/glossary.md` / `docs/adr/`）。
- 范围外撞见的**雷** → `issue-scribe`（已安装时）或 `gh-create-issue`，不顺手修。
- 发现**方向本身没定** → `brainstorming`。

## When Not To Use

- 已有 plan/design 要逐决策压测 → `grill-me`（它假设计划存在；本 skill 在计划之前）。
- 需求含混、缺验收标准 → `clarify`（那是 known unknowns；本 skill 找 unknown unknowns）。
- 全仓健康度/熵审计 → `repo-entropy-audit`（面向仓库体检；本 skill 面向单个任务的开工前侦察）。
- 熟悉区域的小改动：直接做，别加仪式。

## 与本仓库其它 skill 的关系

- `grill-me`：反向箭头——本 skill 从 territory 出发（代码库 → 问题），grill-me 从 map 出发（计划 → 问题）。陌生区域先跑本 skill，产出的决策点作为 grill 分支输入。
- `subagent-workflow`：项目级 territory 基线在 Phase 0.0 的 `openspec/project-profile.md`（一次性）；本 skill 是任务级增量挖掘，消费 profile、只挖 delta。
- `explorer`：考古 sweep 的天然执行器；本 skill 定义角度与输出契约，explorer 负责跑。
