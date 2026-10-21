# Design

Change surface: `packages/dsh-shud-raw-guard/src/decide.ts` shell 分支的 mention 判定（`:106-113`，#248 合并后行号）；新增模块内函数 `normalizeCommandPaths` 与导出函数 `caseInsensitiveRoot`（供测试直接断言探测结果）。`WRITE_VERBS`/`PWSH_WRITES`/#248 的丢弃型重定向剥除、`canonical`、`contains`、文件工具分支不改。

Must preserve:
- `decide.test.ts` 全部既有行逐行结果不变，特别是兄弟路径 `rm protectedx/x` → next、`protected.bak`/`protected_old` → next、`echo ok > derived.txt` → next、glob/brace/反引号紧随原文 → 触及。
- 原文与 realpath 绝对路径的匹配仍存在（规范化是加法：`mentioned = 原文匹配 || 规范化匹配`）。
- workdir 位于 raw 内 → 触及（不变）。
- 探针 T1–T5 判定不变。
- 配置校验 `normalizeRawDirs` 不变。
- 真实下游：`packages/dsh-shud-raw-guard/src/index.ts:36`（pre-execute 监听器调用 `decideRawAccess`）与 `scripts/runtime/raw-guard-probes.sh:30`（导入 `RAW_READ_PROVENANCE_REASON`）——决策返回结构与常量不变。

Must add/change:
- `normalizeCommandPaths(command)`：`command.replace(/\/{2,}/g, "/").replace(/\/\.(?=\/|$|[\s;&|)}'"`])/g, "")`——折叠连续 `/`；去掉作为路径段的 `/.`（后继是 `/`、行尾或命令边界字符），不动 `./x` 开头（原文 `data/raw` 本就包含于 `./data/raw`）、不动 `..`（Non-goal）。
- `export function caseInsensitiveRoot(root)`：`root` 为 canonical 绝对路径。`variant = root.toUpperCase() !== root ? root.toUpperCase() : root.toLowerCase()`；若 `variant === root`（根中无字母）→ false。否则 `try { return realpathSync.native(variant) === root } catch { return false }`（ENOENT 含"根不存在"→ 敏感，不误伤）。全大写根（如 `/DATA/RAW`）因此用小写拼写探测，不被误判为敏感。**不缓存**：每次判定 `canonical()` 本就要做 realpath，多一次 realpath 代价同量级；缓存会把"根不存在"在进程生命周期内永久记成敏感（PI 事后建好 raw 目录后仍漏报）。编排方已在本机 APFS 实测：`realpathSync.native` 把全大写拼写规范回实际大小写、与 root 相等；JS 版 `realpathSync` 原样返回大写，不可替代。knip：test 文件是 entry，导出被测试使用即不算死代码。
- mention 判定：
  ```ts
  const flags = caseInsensitiveRoot(root) ? "i" : "";
  const texts = [command, normalizeCommandPaths(command)];
  const mentioned = [raw, root].some((text) => {
    const pattern = new RegExp(`${escape(text)}(?![A-Za-z0-9._-])`, flags);
    return texts.some((candidate) => pattern.test(candidate));
  });
  ```
  `raw` 原文自身也可能含 `//`/`/./`（用户配置怪写法）：对 `raw` 也先 `normalizeCommandPaths` 一次再比较（`normalizeRawDirs` 已去尾部 `/`）。
- 测试（`decide.test.ts`）：
  - 默认配置（`rawDirs` 缺省 `data/raw`，cwd 为临时 workspace，**实建 `data/raw/`**）：大小写双分支——先用 `existsSync(join(tmp, "DATA/RAW"))` 判定 FS 敏感性，不敏感 → `rm -rf DATA/RAW` deny，敏感 → next；`rm -rf data/./raw` → deny；`rm -rf data//raw` → deny；`rm -rf ./data//./raw/` → deny；`cat data/./raw/x` → ask（reason 为 provenance 常量）；`rm data/raw-x` → next；`rm data/rawx/y` → next。
  - 替身配置 `rawDirs: ["protected"]`（临时目录实建 `protected/`）：**先**用 `existsSync(join(tmp, "PROTECTED"))` 独立判定 FS 敏感性（在建任何异例目录之前）——不敏感 → `caseInsensitiveRoot(root)` 为 true、`rm -rf PROTECTED` deny、`rm -rf Protected/x` deny、`cat PROTECTED/x` ask、`cat Protected/x` ask；敏感 → `caseInsensitiveRoot(root)` 为 false、四者 next，**再**实建独立目录 `PROTECTED/`，断言 `caseInsensitiveRoot(root)` 仍为 false、`rm -rf PROTECTED` 仍 next（同名异例目录不误伤，行为层断言）。两个分支写在同一测试里按条件断言，macOS 本机走不敏感分支、CI Linux 走敏感分支。
  - 探测逻辑隔离测试（新文件 `packages/dsh-shud-raw-guard/src/case-probe.test.ts`，`vi.mock("node:fs")` 部分 mock：`realpathSync.native` 为默认委托原函数的 `vi.fn`，只在个别用例用 `mockImplementationOnce` 覆盖；独立文件使 mock 不影响 `decide.test.ts`，两个平台都执行）：
    1. 全大写根 `/CASE/ROOT`：`native` 收到 `/case/root` 时返回 `/CASE/ROOT` → `caseInsensitiveRoot` 为 true，且断言调用参数是小写拼写（钉住小写回退；临时目录路径总含小写字母，真实目录无法构造全大写根）。
    2. realpath 成功但返回不同路径（`native` 返回 `/case/root-other`）→ false（钉住「解析成功 ≠ 不敏感，必须回到同一路径」；两个平台的真实目录都走不到此情形）。
    3. `native` 抛错 → false。
    这三条也让 Linux CI 执行探测成功返回 true 的路径。
  - 无字母根：`caseInsensitiveRoot("/1/2")` 为 false（两个平台都执行该早返回）。
  - 根不存在：`rawDirs: ["missing/raw"]`，`rm -rf MISSING/RAW` → next（探测 ENOENT → 敏感）；`rm -rf missing/./raw` → deny（规范化不依赖存在性）。
- 规范：Requirement "Shell command touches raw" 的触及定义加"命令文本中 raw 的等价写法——连续 `/` 折叠、`/.` 段去除后匹配原文或绝对路径——SHALL 视为触及；raw 根所在文件系统大小写不敏感时（以大写拼写能否解析回同一路径探测，根不存在视为敏感）大小写变体 SHALL 视为触及，大小写敏感时 SHALL NOT 视为触及"；已记录漏报加第三处："`..` 回溯写法（`data/x/../raw`）不被识别"。场景：`dot and double-slash spellings are touching`、`case variant on a case-insensitive filesystem is touching`、`case variant on a case-sensitive filesystem is a documented gap`、`parent traversal spelling is a documented gap`。

Governing invariant: 同一 raw 路径的等价拼写（重复分隔符、`.` 段、不敏感文件系统上的大小写）得到与原文相同的判定；兄弟路径与大小写敏感文件系统上的异例拼写不被误判为 raw。

Sibling surfaces:
- 文件工具分支（`write`/`edit`/`str_replace_editor`）已走 `canonical()`——不改，但测试加一行 `write data/./raw/x` → deny 钉住现状。
- #248（已合并，PR #256）的 `checked`（剥除丢弃型重定向的文本）只喂 `WRITE_VERBS`，与 mention 判定互不影响；本 change 不触碰 `DISCARD_REDIRECT` 与 `checked` 两行。
- 探针 T2/T3 用原文 `data/raw/obs.csv`——不受影响。
- `openspec/specs/raw-data-guard/spec.md` "Raw directory configuration" 的 `sibling prefix is not raw` 场景——规范化不得破坏。

Seams under test: `decideRawAccess(call, options)`（vitest，临时目录）；live 探针。

Required evidence:
- 新增 deny/ask 行对未改代码红（`rm -rf data/./raw`、`rm -rf data//raw`、`cat data/./raw/x`、不敏感 FS 上 `rm -rf PROTECTED`），改后绿；next 行改前改后绿。
- `pnpm vitest run packages/dsh-shud-raw-guard/src/decide.test.ts` 全绿；`pnpm run check` exit 0。覆盖率说明：Linux CI 上 mention 的 `"i"` 标志分支不会执行（只有 macOS 走到；探测函数本身由 `case-probe.test.ts` 在两个平台全分支覆盖）；全局阈值 80%，现 branches 89.06%，一两个平台专属分支不会跌破，PR 报告列出 CI 与本机各自的覆盖率。
- `pnpm run build` + `pnpm run raw-guard:probes` 5/5 PASS、md5 不变。

Non-goals: `..` 回溯（登记为已记录漏报）；变量/命令替换（`$D/raw`、`eval`、base64）；比原文更短的 glob 前缀、persistent `cd`（既有漏报）；Unicode 规范化（NFC/NFD）；shell 语法解析；放宽规范（issue 备选 b）。

Review focus:
1. 规范化不会把 `data/raw-x`、`data/rawx`、`data/raw.bak` 变成触及；`/.` 去除只针对路径段（`a/.hidden` 不受影响：后继是 `h`）。
2. 大小写探测：根不存在 → 敏感；全非字母根 → 敏感；大小写敏感 FS 上真实存在的 `DATA/RAW` 另一目录 → realpath 返回大写路径 ≠ root → 敏感（不误伤）。
3. `i` 标志只在探测为不敏感时加；`(?![A-Za-z0-9._-])` 边界在 `i` 下仍正确。
4. 无缓存、无模块级状态；探测参数是 canonical root，不是配置原文；全大写根走小写拼写。
5. mention 仍为加法，所有既有行不变；文件工具分支未被触碰。
