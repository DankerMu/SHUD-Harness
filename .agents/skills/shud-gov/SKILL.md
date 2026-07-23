---
name: shud-gov
description: >
  SHUD-Harness 项目级治理 review。读取当前分支 diff，按 config.yaml 匹配 review 维度，
  运行确定性检查脚本 + 组装 codex review prompt 模板。所有输出均为 ADVISORY（建议性），
  不阻断流程，不自动 reject。
trigger: >
  当用户在 SHUD-Harness 仓库中说 "shud-gov"、"治理 review"、"governance review"、
  "跑一下治理检查"、"review governance"，或 cc-cx-workflow Phase 4 前需要补充 review 维度时。
arguments: "[dimension]  可选，指定只跑某个维度（如 zero-seam-guard）。省略则按 diff 自动匹配。"
---

# SHUD-Harness 项目治理 Review

## 安全契约（最高优先级）

1. **纯 ADVISORY**：所有输出是建议，不是裁决。Findings 进 Phase 5 人工综合，不自动阻断。
2. **以代码为准**：如果 `knowledge/` 中的描述与当前代码矛盾，以代码现实为准。标注 knowledge 需要更新，不要基于过时 knowledge 产生 false positive。
3. **check 脚本不阻断**：`checks/*.sh` 永远 exit 0，只输出带 `[WARNING]` 前缀的行。
4. **review 模板不下结论**：模板用"验证是否…"、"检查是否…"、"标注如果…"语气，不用"必须"、"禁止"、"拒绝"。
5. **宁可漏报，不可误报**：不确定的 finding 标注 `[UNCERTAIN]`，让人决定。

## 文件读取规则

本 skill 的资源文件必须按需读取，不要一次性全部加载。以下是明确的读取时机：

### 启动时读取（每次调用必读）
- `config.yaml` — 确定哪些 review 维度被触发

### 维度命中后按需读取
对每个命中的维度，按以下顺序读取：
1. **checks 脚本**（如有）：读取并执行 `checks/<script>.sh`
2. **review 模板**：读取 `reviews/<dimension>.md`
3. **knowledge 文件**：读取 review 模板中 `@` 引用的 `knowledge/*.md`

### 不要读取的情况
- 未命中的维度：不读取其 review 模板和 knowledge 文件
- 如果用户指定了 `[dimension]` 参数：只读取该维度相关的文件

### knowledge 与 review 的关系
- `knowledge/*.md` 是事实参考，被 `reviews/*.md` 引用
- review 模板中的 `@knowledge/xxx.md` 表示"读取该 knowledge 文件作为 review 上下文"
- 如果是组装 codex prompt（供 codeagent 使用），将 knowledge 内容内联到 prompt 中
- 如果是 Codex 自己做 review，直接读取 knowledge 文件理解领域背景

### 文件路径
所有路径相对于本 skill 目录（`.Codex/skills/shud-gov/`）：
```
config.yaml              ← 启动时读
checks/<script>.sh       ← 维度命中且有 checks 字段时执行
reviews/<dimension>.md   ← 维度命中时读
knowledge/<name>.md      ← review 模板引用时读
```

## 工作流程

### Step 1: 获取 diff 范围

```bash
# 检测默认分支，fallback 到 main
BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||' || echo main)
DIFF_FILES=$(git diff "$BASE"...HEAD --name-only 2>/dev/null || git diff HEAD~1 --name-only)
```

### Step 2: 读取 config.yaml，匹配维度

读取本 skill 目录下的 `config.yaml`。对每个维度：
- 检查 `patterns` 是否匹配任何 diff 文件路径（glob 匹配）
- 检查 `keywords` 是否出现在 diff 内容中（可选）
- 如果用户指定了 `[dimension]` 参数，只跑该维度
- 记录命中的维度列表，后续步骤只处理命中的维度

### Step 3: 运行确定性检查

对每个**命中**维度，如果 config.yaml 中有 `checks` 字段：
1. 读取对应的 `checks/<script>.sh`
2. 执行脚本，传入项目根目录：
```bash
bash .Codex/skills/shud-gov/checks/<script>.sh "$(git rev-parse --show-toplevel)"
```
3. 收集所有 `[WARNING]` 行。脚本只输出事实，不做判断。

### Step 4: 读取 review 模板 + knowledge

对每个**命中**维度：
1. 读取 `reviews/<dimension>.md`（review 模板）
2. 解析模板中的 `@` 引用（如 `@.Codex/skills/shud-gov/knowledge/zero-patterns.md`）
3. 读取被引用的 `knowledge/*.md` 文件
4. 组装完整的 review context（模板 + knowledge 内容）

### Step 5: 输出

输出两部分：
1. **确定性检查结果**：`[WARNING]` 行列表（可能为空 = 全部通过）
2. **Review 维度建议**：每个命中维度的名称 + 完整 review context

用户可以：
- 将 review context 贴入 cc-cx-workflow Phase 4 的 `--parallel` codex 调用
- 直接作为 review 参考自行阅读
- 忽略（这是 advisory，不是 mandate）

## knowledge 维护规则

`knowledge/` 下的文件包含从源码提取的领域事实。每条事实标注：
- **Source**: 源文件路径和行号
- **Verified**: 验证日期

当实现代码改变了 knowledge 描述的行为时，应该更新 knowledge，而不是基于旧 knowledge 产生 review findings。

如果 review 过程中发现 knowledge 条目与代码矛盾，输出中应标注：
```
[STALE-KNOWLEDGE] knowledge/xxx.md 第 N 行描述与当前代码不符，建议更新
```
