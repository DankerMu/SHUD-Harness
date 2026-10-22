# Design

Change surface: `packages/dsh-shud-raw-guard/src/decide.ts`：
- 新增模块常量 `RAW_ANCESTOR_LEVELS`；
- 新增未导出的辅助函数 `rawAncestors`；
- 新增祖先匹配的前后边界常量与切换目录操作数的剥离正则；
- 新增祖先写入专用的 deny 决策常量（`code: "raw-ancestor-write"`）；
- 改动 `decideRawAccess` shell 分支 rawDirs 循环内的 `continue` 分支。

以下不改：
- `texts` 构造（沿用 #255/#260/#263 的全部候选副本）；
- mention 正则与 raw 侧文本；
- `WRITE_VERBS`、`PWSH_WRITES`、`DISCARD_REDIRECT`；
- workdir 包含判定；
- 文件工具分支；
- 导出。

Must preserve:
- `decide.test.ts` 现有全部行逐行结果不变，包括：#245 边界表、#247 拼写表、#248 丢弃表、#255 fd 表、#260 quote split 表、#263 parent fold 表、兄弟路径行与大小写行。任何一行结果变化都视为回归，并须在报告中列出。
- 已触及 raw 的命令仍走原有的 deny/ask 判定；新判定只作用于原先落 `continue` 的情形，所以只会把 next 收紧为 deny。
- 探针 T1–T5 判定不变：T1–T5 都直接点名 raw；T4 的 `../outside/raw` 在配置下的祖先 `..` 被排除。
- 只读祖先仍落 next，按 PI 决定不新增 ask。

Must add/change:
- 常量与辅助函数（注释风格同文件内其他常量）：
  ```ts
  // #273 (PI 2026-10-21): a write naming a strict ancestor of a raw dir, up to three
  // levels (parent, grandparent, great-grandparent), is denied; reads pass through.
  const RAW_ANCESTOR_LEVELS = 3;
  // Ancestor text stands alone: before it, start or a shell boundary (optionally ./);
  // after it, end, a boundary, a glob, or / followed by those (data/, data/*), never
  // / plus a name (data/derived).
  const ANCESTOR_BEFORE = String.raw`(?<![^\s;&|()<>'"\`=,{])(?:\./)*`;
  const ANCESTOR_AFTER = String.raw`(?=$|[\s;&|()<>'"\`,{}*?[\]]|/(?=$|[\s;&|()<>'"\`,{}*?[\]]))`;

  // Changing directory is not naming: the operand of cd/pushd (pwsh: Set-Location,
  // sl, Push-Location) is dropped before ancestor matching.
  const CHDIR_OPERAND = /(^|[\s;&|(`{])(?:cd|pushd|set-location|push-location|sl)(?:\s+-[^\s;&|()<>]*)*\s+[^\s;&|()<>]+/gi;
  const ANCESTOR_DENY: RawGuardDecision = {
    kind: "deny",
    code: "raw-ancestor-write",
    reason:
      "Raw data is immutable: this command writes while naming a directory that contains raw data. Write to an explicit path inside that directory instead.",
  };

  // Strict ancestors, nearest first; "/" and spellings ending in . or .. are not.
  function rawAncestors(path: string): string[] {
    const ancestors: string[] = [];
    let current = path;
    while (ancestors.length < RAW_ANCESTOR_LEVELS) {
      const cut = current.lastIndexOf("/");
      if (cut <= 0) break;
      current = current.slice(0, cut);
      if (/(?:^|\/)\.\.?$/.test(current)) break;
      ancestors.push(current);
    }
    return ancestors;
  }
  ```
- 循环内：原来的 `if (!mentioned && !contains(root, workdir)) continue;` 改为：先算写判定（`WRITE_VERBS.test(checked) || (pwsh && PWSH_WRITES.test(command))`，`checked` 照旧去掉丢弃型重定向），未触及时检查祖先：
  ```ts
  if (!mentioned && !contains(root, workdir)) {
    const named = [...rawAncestors(normalizeCommandPaths(raw)), ...rawAncestors(root)].some((ancestor) => {
      const escaped = ancestor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`${ANCESTOR_BEFORE}${escaped}${ANCESTOR_AFTER}`, flags);
      return texts.some((candidate) => pattern.test(candidate.replace(CHDIR_OPERAND, "$1")));
    });
    if (named && writes()) return ANCESTOR_DENY;
    continue;
  }
  return writes() ? DENY : ASK;
  ```
  - 写判定可以惰性计算，例如写成闭包或只在需要时计算，避免对不触及 raw 也不点名祖先的命令跑 `WRITE_VERBS`。具体写法由实现者决定，行为须一致。
  - 大小写标志 `flags` 沿用该 raw 根的探测结果。
  - 点名但不写时必须 `continue`（不得 `return NEXT`），后续 raw 仍要检查。
  - `CHDIR_OPERAND` 每个候选文本只替换一次（`texts` 可在循环外预先算好剥离后的副本），保持线性。
- 测试：新增 `decide.test.ts` `ancestorCases` 表，断言 `kind`，deny 行同时断言 `reason` 匹配 `/immutable/`。准备一个新的临时 workspace：`W` 取 `realpath(mkdtemp(...))` 之下再深两层的目录（保证 `W`、`dirname(W)`、`dirname(dirname(W))` 在 Linux `/tmp` 上也都是真实的非根目录），建好 `sub/raw/`、`sub/rawx/`、`sub/derived/`、`a/b/c/d/raw/`；以 `W` 作为 `cwd`。
  - deny（`rawDirs: ["sub/raw"]`）：
    - bash：`rm -rf sub`、`rm -rf sub/`、`rm -rf ./sub`、`rm -rf sub/*`、`rm -rf {sub,x}`、`rm -rf "sub"`、`mv sub x`、`chmod -R 000 sub`、`rm -rf sub/rawx/..`（经 #263 折叠）、`rm -rf sub/.`（经规范化）；
    - pwsh：`Remove-Item -Recurse sub`、`Remove-Item -Recurse .\sub`；
    - 绝对路径：`rm -rf ${W}/sub`、`rm -rf ${W}`、`rm -rf ${dirname(W)}`。
  - deny（默认配置，用 `rawParent` 拼接，在 `defaultWs` 下运行）：`rm -rf <rawParent>`。
  - deny（`rawDirs: ["a/b/c/d/raw"]`）：`rm -rf a/b/c/d`、`rm -rf a/b`。
  - 边界字符（review fixture r1）deny：`(rm -rf sub)`、`rm -rf sub;ls`、`rm -rf sub&&ls`、`rm -rf sub|cat`、`` `rm -rf sub` ``、`rm -rf sub>x`、`cp -r x --target-directory=sub`、`rm -rf sub/?aw`、`rm -rf sub/[r]aw`、`rm -rf {x,sub}`。
  - 大小写（`test.runIf(caseInsensitive)`，沿用文件中已有的大小写探测）deny：`rm -rf SUB`。
  - 多 raw（`rawDirs: ["sub/raw", "protected"]`）ask：`ls sub && cat protected/x`（只读祖先后仍检查下一个 raw）。
  - 已接受误报（deny，`code` 为 `raw-ancestor-write`）：`ls sub > out.txt`、`cp out.csv sub/`、`mv x.csv sub`。
  - 切换目录选项不越过分隔符（review fixture r2）deny：`cd -P&&rm -rf sub`、pwsh `Set-Location -Path:x;Remove-Item -Recurse sub`。
  - 切换目录（next）：`cd sub && rm -rf derived`、`cd ${W} && python run.py > log.txt`、pwsh `Set-Location sub; Remove-Item -Recurse derived`；对照 deny：`cd ${W} && rm -rf sub`。
  - 更短 glob 前缀（next，已记录漏报）：`rm -rf sub/r*`。
  - 只读（next）：`ls sub`、`grep -r foo sub`、`du -sh sub`、`ls sub 2>/dev/null`。
  - 反例（next）：`rm -rf sub/derived`、`rm sub/rawx/y`、`rm -rf subx`、`rm -rf mysub`、`rm -rf other/sub`、`rm -rf sub.bak`、`echo ok > sub/derived.txt`。
  - 级数上限（next）：`rm -rf ${dirname(dirname(W))}`（`sub/raw` 的第 4 级）、`rm -rf a`（`a/b/c/d/raw` 的第 4 级）。
  - `..` 结尾排除（next）：`rawDirs: ["../outside/raw"]`，`mv out.csv ..`（`cd ..` 的操作数已被切换目录剥离，不能用来钉住此规则）。
  - 已记录漏报（next）：`rm -rf .`、`rm -rf *`、`cd sub && rm -rf raw`；`workdir: "sub"` 下 `rm -rf raw`。
  - 资源（走到祖先分支）：`"rm -rf" + " sub/".repeat(2e5)` → deny；`"ls " + "./".repeat(5e5) + "subx"` → next；均在默认超时内。
  - 所有祖先 deny 行断言 `code === "raw-ancestor-write"`。

Governing invariant: 新判定只作用于原先落 `continue` 的情形，判定结果只会从 next 收紧到 deny；只读不受影响。点名祖先的边界比 raw mention 更严：要求左边界成立，且不得以 `/` 加普通路径名结尾。这样 workspace 内对 `data/…` 子路径的普通写入不会被误伤。

Sibling surfaces:
- 文件工具分支（`write`/`edit`/`str_replace_editor`）只作用于单个文件，删不了祖先目录，本次不改。
- `scripts/guardrails/no-bypass.sh`（agent 侧 hook，不走 dsh pre-execute）不在本 change 范围内。
- 探针 `scripts/runtime/raw-guard-probes.sh` 的 T1–T5 不受影响，由 live 两次运行确认。
- 构建产物 `lib/decide.js` 由 `pnpm run build` 生成。

Seams under test: `decideRawAccess(call, options)`（vitest）；live 探针 T1–T5。

Required evidence:
- 新增的 deny 行在改动前的 `decide.ts` 上为红（当前结果为 next），改动后为绿；next 行改动前后都为绿；既有行全部不变。
- 突变：
  1. 去掉祖先检查 → 全部祖先 deny 行变红。
  2. 去掉左边界（`ANCESTOR_BEFORE` 置空）→ `rm -rf mysub`、`rm -rf other/sub` 变红。
  3. 右边界允许 `/` 加普通路径名 → `rm -rf sub/derived` 变红。
  4. 右边界不接受 `/` 后跟行尾或 glob → `rm -rf sub/`、`rm -rf sub/*` 变红。
  5. `RAW_ANCESTOR_LEVELS = 4` → `rm -rf a` 与第 4 级绝对路径行变红。
  6. `RAW_ANCESTOR_LEVELS = 2` → `rm -rf a/b` 与 `rm -rf ${dirname(W)}` 变红。
  7. 只读祖先改为 ASK → `ls sub` 等只读行变红。
  8. 只取配置原文的祖先（不取绝对路径）→ 三条绝对路径 deny 行变红。
  9. 只取绝对路径的祖先（不取配置原文）→ 相对路径 deny 行变红。
  10. 不排除以 `.`/`..` 结尾的祖先 → `mv out.csv ..` 变红。
  11. 只匹配原命令（不用 `texts` 副本）→ `rm -rf sub/rawx/..`、pwsh `.\sub`、`rm -rf sub/.` 变红。
  12. 判写时不去掉丢弃型重定向 → `ls sub 2>/dev/null` 变红。
  13. 祖先正则不带大小写 `flags` → `rm -rf SUB` 变红（大小写不敏感文件系统）。
  14. 点名但不写时 `return NEXT` 而非 `continue` → 多 raw 行 `ls sub && cat protected/x` 变红。
  15. 前后边界字符集收窄到空白、`{`、`,`、引号、`*` → 十条边界字符行变红。
  16. 不剥离切换目录操作数 → `cd sub && rm -rf derived`、`cd ${W} && python run.py > log.txt`、pwsh `Set-Location` 行变红。
  17. 祖先写入用通用 `DENY`（不用 `ANCESTOR_DENY`）→ 祖先 deny 行的 `code` 断言变红。
  18. 切换目录选项子模式用 `-\S*`（可越过 `;`、`&&`）→ `cd -P&&rm -rf sub` 与 pwsh `Set-Location -Path:x;…` 行变红。
- `pnpm vitest run packages/dsh-shud-raw-guard` 全绿；`pnpm run check` exit 0，覆盖率不降；`pnpm run build`；`pnpm run test-guardrails`。
- live `pnpm run raw-guard:probes` 由编排方跑两次：T1–T5 PASS（INCONCLUSIVE 则重跑），md5 不变。

Non-goals:
- 第 4 级及以上的祖先：按 PI 决定登记为已记录漏报。
- 隐式写法：`rm -rf .`、`rm -rf *`、workdir 位于祖先时以相对名写入。
- `~` 与变量展开。
- 按参数位置区分"写的是哪个路径"，整条命令只要含写动词即判定，与 raw mention 相同（切换目录操作数是唯一例外）。
- 配置原文带 `./` 前缀（如 `rawDirs: ["./data/raw"]`）时 `rm -rf data/raw` 不被识别：既有问题，另立 issue。
- 只读祖先的 provenance ask：PI 决定放行。
- 文件工具分支；`WRITE_VERBS` 常量本身。
