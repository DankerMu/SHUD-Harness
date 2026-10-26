---
status: proposed
kind: process
---

# ADR-0009: 本地 agent 证据与交付文件分界

## 背景与授权

[#322](https://github.com/DankerMu/SHUD-Harness/issues/322) 暴露了 issue、PR 与设计工作流证据的发现范围不一致。PI 在 [comment 6397950402](https://github.com/DankerMu/SHUD-Harness/issues/322#issuecomment-6397950402) 明确批准整个根目录 `.workplans/` 为 local-only，并以单一 `.gitignore` 规则分界。

理由独立于任何一次闸是否变绿：这些文件是本机工作流生成、消费的执行与审查证据，不是交付源文件。已消费的 oracle 字节是后续判断的依据；为通过交付格式闸而重排、格式化或覆写它们会改变证据本身。应纠正发现边界，而不是修改 oracle，也不是放宽交付文件检查。

## 决定与所有权

仓库根 `.gitignore` 的 `/.workplans/` 是整个证据根目录唯一随仓库分发的排除来源，替代 issue-only 规则；Git 与现有 Prettier 默认发现共同使用它。不增加 `.prettierignore` 条目、不改格式命令、CI 或交付文件的阻断标准。

| 目录约定 | 所有者与用途 |
|---|---|
| `.workplans/issue-<number>/` | 对应 issue 的执行工作流，保存计划、执行与审查证据 |
| `.workplans/pr-<number>/` | 对应 PR 的独立审查工作流，保存 PR-only 审查证据 |
| `.workplans/<change-name>/` | 对应 OpenSpec change 的设计／stage-pipeline 工作流，保存设计与流水线证据 |

目录名只表达归属，不代表不同格式政策；三类及根目录内其他本地证据均适用同一边界。写入者只管理自己工作流的产物，不覆写其他所有者或已消费的证据。禁止在此放置生产源码、测试夹具或其他应交付文件；禁止 force-add 证据来绕过边界，禁止为格式闸修改已消费的 oracle 字节。

公开 PR 正文／评论必须保留离开本机后仍可审查的证据摘要：执行命令、输入／场景、实际结果与必要输出、失败和限制；本地路径不能代替公开摘要。不得把本机文件存在、未运行的命令或单独一条绿闸说成完成验收；敏感内容仍按保密要求处理。

## 工作流入口与迁移

当前 [project profile](../../../openspec/project-profile.md) 是本项目工作流契约入口，只保留一处本 ADR 指针。issue 工作流经 `subagent-workflow` 的既有 project-profile seam 读取它；canonical shared instructions 显式要求所有证据写入者（含 design/stage-pipeline）先读该 profile，不假设设计 skill 会自动消费它。共享指令的格式矩阵／enforcement 与 `constraints.yaml` 的既有格式描述镜像这一边界；生成指令从 canonical source 渲染，不手改 skill 投影或外部仓库。

本 checkout 只删除 `.git/info/exclude` 中精确的 `.workplans/pr-*/` 行；这是 issue 验收要求的本地迁移，不是可随提交传播的变更。保留该文件其他所有字节，尤其 `.review-gate.json`：根 review-gate 不在 `.workplans/` 内，现有独立 Git 排除、`.prettierignore` 豁免及其生产者不变。不修改、格式化或删除既有 `.workplans/` 文件来完成迁移。

## 后果与备选方案

- 好处：新 checkout 和三类工作流共享同一发现边界，不依赖每台机器的私有 exclude；交付格式闸与证据完整性不再冲突。
- 代价：本地证据不随 clone/PR 自动取得，公开摘要必须足够审查；误放在此的交付文件会被 Git/Prettier 隐藏，因此应交付内容必须从一开始放在正常受检目录。该边界不是保密机制，也不新增其他工具豁免或保留／删除政策。
- 不保留 issue-only 规则或逐前缀追加规则：会让 PR、设计与新工作流继续分裂，目录命名不应决定证据是否可被重写。
- 不仅使用 `.git/info/exclude`：它不随仓库传播，不能成为统一的 Git/Prettier 政策来源；也不在 `.prettierignore` 复制整根规则，避免双真相源。
- 不格式化已消费证据、不强制入库、不跳过整个格式闸：前两者破坏证据或交付边界，后者削弱正常源码约束。根 review-gate 的迁移是独立议题，不借此扩张范围。

## 验证与恢复

迁移证据由公开工具边界取得：三个命名空间的有效但未格式化 JSON 都应由 Git 指向仓库规则、由 Prettier 判为 ignored，带这些探针运行正常格式闸；非忽略源码位置的同类坏格式仍须失败、正确格式须通过。迁移前后比较既有证据哈希与无关 local exclude 字节，确认无证据被跟踪。探针只由其所有者清理，不对消费过的证据运行修复格式命令；这些是验收判据，不预先声称已经通过。

回退 tracked 规则会恢复旧发现范围，但不授权改写证据或跳过交付闸；应报告边界回归并重新取得政策决定，而非把 oracle 改到绿。本地已删的冗余 PR exclude 行不影响运行时；若要精确恢复迁移前本机配置，只恢复该行，其他行及证据字节不动。若发现证据已被意外改写，停止使用受影响结果，保留现状并向所有者报告差异；不得把重写后的文件冒充原始证明。

本记录不改变生产／科学运行行为，不代表 #293/#318 的 PI 功能验收。
