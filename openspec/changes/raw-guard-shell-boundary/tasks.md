# Tasks

## 1. Decision core (`packages/dsh-shud-raw-guard`)

- [x] 1.1 `decide.test.ts`：按 design "Required evidence" 新增用例，动词/cmdlet/别名**按完整清单逐项迭代**（参照 `:63` 的 `split(" ")` 循环，不得只抽样）：glob/brace/反引号提及、短前缀 glob 为 next（已记录漏报）、兄弟路径 next、前缀/转义/`sudo` 动词、`unlink rmdir shred`、`-delete`（含 `-delete;`）/`--remove-files`、管道末尾动词（bash `xargs rm`、pwsh `| Remove-Item`）、pwsh 小写 cmdlet、`--rm`/`arm` 非动词、默认 rawDirs 下 `*`/`?`/`{,}` 三形态删除 deny 与 `*` 读 ask（字符串拼接构造）；先对当前源码运行并在报告中列出红的用例清单。
- [x] 1.2 `decide.ts`：提及边界改为 `(?![A-Za-z0-9._-])`；`WRITE_VERBS` 改为 lookbehind 锚定、收尾 `(?=\s|$)`、补动词、补标志（后继 `(?=$|[\s;&|)])`）、补 pwsh cmdlet/别名（不区分大小写）；不引入 `\S*` 贪婪前缀。全部测试绿。
- [x] 1.3 `pnpm run check` 绿（覆盖率、knip、dup、lint 不放宽）。

Suggested fixture level: expanded
Minimal mergeable slice: atomic

## 2. Spec sync

- [x] 2.1 本 change 的 spec delta 与 `WRITE_VERBS`/`PWSH_WRITES` 常量逐项核对一致（归档时折入 `openspec/specs/raw-data-guard/spec.md`）。

## 3. Runtime evidence (Critical Path #1/#2)

- [x] 3.1 `pnpm run raw-guard:probes`（真实模型，需 `DMXAPI_KEY`）T1–T5 PASS、md5 PASS；结果贴进 PR。
- [ ] 3.2 reviewer 子代理白盒审查记录（本地在 `.workplans/issue-245/review/`，该目录 gitignored）、`pnpm run check` 输出摘要与 3.1 结果**贴进 PR 正文/评论**（issue 验收最后一条）。

## Risk packs

- Auth / permissions — selected：判定结果直接决定 PI 审批卡是否出现；由 1.1 的 deny/ask/next 三向用例覆盖。
- File IO / path safety — selected：glob/brace/兄弟路径边界；由 1.1 覆盖，canonical 路径逻辑不动。
- Legacy compatibility — selected：既有 7 个 test（含仅 darwin 的 1 个）必须原样通过；探针 T1–T5 由 3.1 覆盖。
- Documentation / migration notes — selected：spec delta 2.1。
- Public API / CLI — not selected：`decideRawAccess` 签名与返回形状不变。
- Config / project setup — not selected：`normalizeRawDirs` 不动。
- Schema / fields — not selected：无 schema。
- Concurrency / shared state — not selected：纯函数。
- Resource limits — not selected：正则无贪婪 `\S*` 前缀（design Review focus 2 让 reviewer 核对）。
- Error handling / rollback — not selected：无新错误路径。
- Release / packaging — not selected：无依赖变化。
