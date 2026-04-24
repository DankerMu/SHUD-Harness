# ZeRo 参考点

本附录说明如何在不 fork ZeRo 的前提下借鉴其实现。

## 1. 可参考模块

### Agent loop

参考点：

```text
- max iterations；
- model/tool loop；
- hooks；
- interruption / closure control。
```

Lite 改造：

```text
- 不做同步长 loop；
- 使用 Brief/Plan/Submit/Park/Collect/Report；
- 任务状态保存在 YAML + job registry。
```

### Bash tool

参考点：

```text
- cwd 控制；
- timeout；
- stdout/stderr capture；
- unsafe command filtering。
```

Lite 改造：

```text
- 加 task workspace；
- 加 raw data read-only；
- 加 file diff tracking；
- 加 RunRecord。
```

### Skills

参考点：

```text
- SKILL.md directory；
- YAML frontmatter name/description；
- skill retrieval。
```

Lite 改造：

```text
- 只保留 5 个初始 skills；
- 生命周期 draft/active/retired；
- 不做复杂 promotion。
```

### Memory

参考点：

```text
- markdown-backed memory；
- retrieval。
```

Lite 改造：

```text
- 普通 MemoryNote 直接 draft；
- evidence/scientific note 需要 PI review；
- 不默认 verified。
```

### Observability

参考点：

```text
- session logs；
- metrics；
- traces。
```

Lite 改造：

```text
- command trace；
- job trace；
- RunRecord；
- Markdown report。
```

## 2. 不参考或暂不采用

```text
- 多 channel adapters；
- heavy Web control plane；
- always-on supervisor；
- complex multi-agent orchestration；
- upstream fork maintenance。
```

## 3. 接入 ZeRo 的触发条件

```text
- Lite 已证明有稳定使用场景；
- 需要 session UI 或复杂 agent orchestration；
- 有工程能力维护 TypeScript runtime；
- 已明确要替换哪些 Lite 模块。
```
