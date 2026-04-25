# CI/CD 与发布

**状态：** P2 实施规范  
**适用范围：** GitHub Actions、schema drift、文档检查、submodule lock、release  
**目标：** 防止设计、schema、实现和 submodule 状态漂移。

## 1. CI 阶段

推荐流水线：

```text
checkout with submodules
→ install dependencies
→ lint markdown
→ typecheck TypeScript
→ test schema
→ test reducers
→ test WebSocket protocol
→ test sandbox path policy
→ build web app
→ package docs
```

## 2. Submodule 检查

CI 应检查：

- 四个 submodule 是否初始化；
- StackLock 测试是否能读取 commit；
- submodule path 是否与文档一致；
- release tag 是否记录 submodule commit。

## 3. Schema drift 检查

如果存在 Zod schema 和 Markdown schema，两者必须同步。推荐生成 schema docs，而不是手工维护两份。

CI 检查：

```text
bun run schema:generate
 git diff --exit-code docs/generated/schema
```

## 4. 文档检查

Markdown lint 至少检查：

- 链接是否存在；
- 同名标题；
- 代码块闭合；
- 文件路径是否英文；
- canonical/superseded 标注。

## 5. Release 内容

每次 release 应包含：

```yaml
release:
  version: 0.8.x
  harness_commit: ...
  submodules:
    SHUD: ...
    rSHUD: ...
    AutoSHUD: ...
    zero: ...
  schema_version: ...
  prompt_version: ...
  skills_version: ...
```

## 6. Artifact 发布

可发布：

- Web build；
- docs zip；
- schema JSON；
- sample workspace；
- tiny fixture instructions。

不要发布：

- API keys；
- raw large data；
- 用户私有 RunRecord；
- 大型模型输出。

## 7. 版本策略

建议：

```text
0.8.0-design      # 设计补齐
0.8.1-skeleton    # deterministic skeleton
0.8.2-tiny-run    # ccw tiny run
0.8.3-zero-agent  # 接入 Zero AgentLoop
```

## 8. 验收标准

- [ ] CI 能 checkout submodules。
- [ ] TypeScript typecheck 通过。
- [ ] schema drift 检查通过。
- [ ] 文档链接检查通过。
- [ ] release manifest 记录四个 submodule commit。
- [ ] docs zip 使用英文文件名，内容可为中文。
