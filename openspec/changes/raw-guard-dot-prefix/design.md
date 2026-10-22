# Design

Change surface: `packages/dsh-shud-raw-guard/src/decide.ts` 的 `normalizeRawDirs` 返回值一行。

不改：
- `decideRawAccess` 的 shell 分支、文件工具分支、祖先判定；
- `normalizeCommandPaths`（命令侧规则，不复用到配置侧）；
- 校验与错误信息；
- 导出。

Must preserve:
- `decide.test.ts` 现有全部行逐行结果不变，含 `normalizeRawDirs()` 默认值、`["data/raw/", "/"]` → `["data/raw", "/"]`、`["deep-link/.."]`（`..` 不动）、`["../outside/raw"]`（`..` 前缀不动）。
- 绝对路径配置的规范化结果只可能折叠 `//` 与 `/.`，`canonical` 解析结果不变。
- 探针 T1–T5 判定不变（默认配置 `["data/raw"]` 的规范化结果不变）。

Must add/change:
- `normalizeRawDirs` 返回值改为：
  ```ts
  // #277: configured text is normalized once, so mention, ancestor and canonical
  // checks compare the same spelling: `//` collapses, a `/.` segment (followed by
  // `/` or end) drops, then one leading `./` (the folding leaves at most one)
  // drops unless nothing follows it. Unlike commands, no shell boundary ends a
  // segment here, so `a/. b` stays a path to `. b`.
  return {
    rawDirs: (dirs as string[]).map(
      (dir) =>
        dir
          .replace(/\/{2,}/g, "/")
          .replace(/\/\.(?=\/|$)/g, "")
          .replace(/^\.\/(?=.)/, "")
          .replace(/\/+$/, "") || "/",
    ),
  };
  ```
  `//` 折叠必须在前导 `./` 之前：否则 `.//sub/raw` 去前导后成为绝对路径 `/sub/raw`。
  逐例推演：
  - `./sub/raw` → `sub/raw`；
  - `././sub/raw/`：折叠 `/.` 得 `./sub/raw/`，去前导得 `sub/raw/`，去结尾得 `sub/raw`；
  - `./sub/./raw` → `sub/raw`；
  - `./`：前导规则因 `(?=.)` 不生效，去结尾得 `.`；
  - `.` → `.`；`./.`、`././` → `.`；
  - `/`、`//`、`/./` → `/`；
  - `data/raw/` → `data/raw`；
  - `.//sub/raw` → `sub/raw`；`/data/./raw/` → `/data/raw`；
  - `../outside/raw`、`deep-link/..`、`.raw`、`sub/. raw` 不变。
- `decide.test.ts`：
  - `normalizeRawDirs` 单测：`["./sub/raw"]` → `["sub/raw"]`；`["././sub/raw/"]` → `["sub/raw"]`；`["./sub/./raw"]` → `["sub/raw"]`；`["./"]`、`["."]`、`["./."]` → `["."]`；`["//"]` → `["/"]`；`[".//sub/raw"]` → `["sub/raw"]`；`["/data/./raw/"]` → `["/data/raw"]`；`["/data/raw"]`、`[".raw", "../outside/raw", "deep-link/..", "sub/. raw"]` 不变；既有默认值与 `["data/raw/", "/"]` 行不变。
  - shell 决策表（`rawDirs` 依次为 `["./sub/raw"]`、`["././sub/raw"]`、`["./sub/./raw"]`，workspace 下已建 `sub/raw/`）：
    - deny（`code: "raw-immutable"`）：`rm -rf sub/raw`、`rm -rf sub/raw/x`、`cp a sub/raw/b`、`echo hi > sub/raw/f`、`rm -rf ./sub/raw`、`rm -rf <abs>/sub/raw`（`<abs>` 取 `realpathSync(cwd)`，同既有绝对路径行；不加直接拼 cwd 的写法，它在 macOS `/var` → `/private/var` 下改前为红、Linux 下为绿）；
    - ask：`cat sub/raw/x`；
    - next：`rm -rf sub/rawx`、`rm -rf sub/raw.bak`、`rm -rf sub/raw_old`。
  - 祖先：`rawDirs: ["./sub/raw"]` 下 `rm -rf sub` → deny，`code: "raw-ancestor-write"`。
  - 工作区：`rawDirs: ["./"]` 与 `["."]` 下 `write` `x.csv` → deny（两行）。
  - 文件工具：`rawDirs: ["./sub/raw"]` 下 `write` `sub/raw/x` 与 `./sub/raw/x` → deny（改前改后都绿）。

Governing invariant:
- 规范化只做词法等价变换（`//`、`/.`、前导 `./`、结尾 `/`），不解析 `..`、不解析符号链接；规范化后的相对项与原文以 cwd 解析到同一路径。
- 规范化永远不会把非根配置变成 `/`。

Sibling surfaces:
- 提及判定的配置侧文本 `[raw, normalizeCommandPaths(raw), root]`（`decide.ts:207`）与祖先推导 `normalizeCommandPaths(raw)`（`decide.ts:225`）自动消费规范化后的文本，不改；对规范化后的文本，`normalizeCommandPaths(raw)` 只在名字含 `/.` 后接 shell 边界字符时不同，与改前相同。
- `canonical(raw, cwd)` 用 `resolve`，对 `./x` 与 `x` 结果相同，不受影响。
- `index.ts:29` 是唯一调用方；logger 只记 `kind`/工具名/code，不记 rawDirs。
- 命令侧 `./` 写法（`rm -rf ./sub/raw`）本已命中，不改。
- `WRITE_VERBS` 只检查原命令的问题由 #279 处理。

Seams under test: `normalizeRawDirs(config)`、`decideRawAccess(call, options)`（vitest）；live 探针 T1–T5。

Required evidence:
- 改动前（origin/main 的 `decide.ts`）的红绿划分，改后全部为绿，既有行不变：
  - 改前为红：
    - 单测 `["./sub/raw"]`、`["././sub/raw/"]`、`["./sub/./raw"]`、`["./."]`、`[".//sub/raw"]`、`["/data/./raw/"]`；
    - 三种配置下的 `rm -rf sub/raw`、`rm -rf sub/raw/x`、`cp a sub/raw/b`、`echo hi > sub/raw/f`（deny）与 `cat sub/raw/x`（ask）；
    - 祖先行 `rm -rf sub`。
  - 改前就为绿（钉住行，不得删除；其中 `["./"]` 是突变 3 唯一的击杀行）：
    - 三种配置下的 `rm -rf ./sub/raw` 与绝对路径写法；
    - 单测 `["./"]`、`["."]` → `["."]`，`["//"]` → `["/"]`，`["/data/raw"]` 与 `[".raw", "../outside/raw", "deep-link/..", "sub/. raw"]` 不变；
    - 工作区 `["./"]` 与 `["."]` 下 `write` 行；
    - next 反例行与文件工具行。
- 突变，每项至少让一行变红：
  1. 去掉 `/.` 段规则 → `["././sub/raw"]` 的 deny 行与单测变红。
  2. 去掉前导 `./` 规则 → `["./sub/raw"]` 的 deny/ask 行与祖先行变红。
  3. 去掉 `(?=.)` → `["./"]` 单测变红（变为 `/`）。
  4. 先去前导 `./` 再做 `//`、`/.` 折叠 → `["././sub/raw"]` 行与 `[".//sub/raw"]` 单测变红。
  5. 前导规则改为 `^\.+\/`（吞掉 `..`）→ `["../outside/raw"]` 单测变红。
  6. 去掉 `//` 折叠 → `[".//sub/raw"]` 单测变红（变为 `/sub/raw`）。
  7. `//` 与 `/.` 两步改用 `normalizeCommandPaths`（`/.` 后接 shell 边界也去除），前导 `./` 规则保留 → `["sub/. raw"]` 单测变红。
- `pnpm run check`、`pnpm run build`、`pnpm run test-guardrails` 绿。
- live `pnpm run raw-guard:probes` 两次 T1–T5 PASS、md5 不变。

Non-goals:
- `..` 段的语义（`../outside/raw` 保持原文）。
- 命令侧写法的规范化（#247/#260/#263 已覆盖）。
- 配置项去重（`["sub/raw", "./sub/raw"]` 规范化后重复，结果不变，只是多比较一次）。
- 环境变量或 `~` 展开。
