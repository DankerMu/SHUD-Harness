# Proposal

## Why

#264：`collectRepositoryRevision`（`packages/dsh-shud-core/src/stack-lock/repository-revision.ts`）的 git 失败映射有三处与契约不符的残留：

- R1：status 捕获 `ENOBUFS` 即记 `dirty: true`（`:75-83`），注释假设溢出只来自 stdout。Node `execFileSync` 的 `maxBuffer` 对 stdout、stderr 分别计数；仅 stderr 溢出（如 5000 个 `chmod 000` 未跟踪目录的 `could not open directory` 警告，stdout 0 字节）也抛 `ENOBUFS`，干净工作区随警告量翻转为 dirty。
- R2：`symbolic-ref` 非 detached 失败时抛 `cannot read git branch`（`:54-64`）的分支无测试；原 design 把它列为「难以稳定构造」的已知缺口，现可用 PATH shim 稳定构造。
- R3（issue 评论补充）：`.git/HEAD` 写成 `ref: refs/tags/v1` 时 `symbolic-ref --short -q HEAD` 输出 `v1`（exit 0），记成 `branch: "v1"`，把 tag 名当分支名；`:57` 注释「Git forbids a branch named "HEAD"」过强（`git update-ref refs/heads/HEAD` 可创建）。

## What Changes

- `repository-revision.ts`：
  - status：`ENOBUFS` 且 `error.stdout` 为非空字符串时 `dirty = true`，否则抛 `cannot read git status at <repoPath>: …`；注释改为「任何 porcelain 输出即 dirty，stdout 为空的溢出是失败」。
  - branch：改用 `git symbolic-ref -q HEAD`（全名）。以 `refs/heads/` 开头 → 去掉前缀为分支名；其他 symref 目标（如 tag：annotated tag 下 `rev-parse --verify HEAD` 得 tag 对象而非提交）或去前缀后恰为 `HEAD`（与 detached 哨兵冲突）→ 抛 `cannot read git branch at <repoPath>: …`；detached（退出 1 且无输出）→ `HEAD` 不变；其他失败抛错不变。订正 `:57` 注释。
- `repository-revision.test.ts`：stderr-only 溢出与「非溢出失败带输出」（PATH shim）、`symbolic-ref` 退出 128 与「退出 1 但有输出」（PATH shim）、HEAD → tag、同名 tag 的分支、`refs/heads/HEAD` 七个用例。
- 规范 `stack-lock` "Read-only repository revision collection"：命令列表、`branch` 语义、stdout/stderr 溢出区分，新增四个场景（含 tag/`refs/heads/HEAD`/`symbolic-ref` 失败合并的抛错场景）。

## Triage

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent（issue-scribe，Readiness implementation-ready）；触发词：采集 fail-loud 契约、spec 措辞与实现不符、git 子进程错误映射
Blast radius: 误把 stdout 溢出当失败 → 真实脏仓库采集抛错（现有 6000 文件用例必须仍为 dirty）；branch 改全名后同名 tag 场景由 `heads/v1` 变为 `v1`（有意，记入 spec）；HEAD → tag 由返回 tag 名变为抛错、`refs/heads/HEAD` 由返回 `heads/HEAD` 变为抛错（有意，fail-loud）；PATH shim 必须只作用于单个用例且 `exec` 真 git，不得污染其他用例；三个 submodule 的真实输入均为普通分支或 detached，不受影响
Selected risk packs: Public API / CLI / script entry; Error handling / rollback; Legacy compatibility; Documentation / migration notes; File IO / path safety
Evidence floor: 新用例先红后绿；现有全部用例不变；`pnpm run check`；突变表

## Capabilities

### Modified Capabilities

- `stack-lock`: "Read-only repository revision collection"。

## Impact

- 代码：`packages/dsh-shud-core/src/stack-lock/repository-revision.ts`（约 10 行）、`repository-revision.test.ts`。
- 规范：`openspec/specs/stack-lock/spec.md` 一条 Requirement。
- 无 schema 改动（`branch` 仍为非空字符串），无生成投影变化。
