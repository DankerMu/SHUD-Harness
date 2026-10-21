# Design

Change surface: `packages/dsh-shud-raw-guard/src/decide.ts`：新增 `foldParentSegments`（放在 `normalizeCommandPaths` 之后），`decideRawAccess` shell 分支 `texts` 构造的第二层 `flatMap`。`normalizeCommandPaths`、`canonical`、`caseInsensitiveRoot`、mention 正则（`${escaped}(?![A-Za-z0-9._-])` 与 `i` 标志）、raw 侧文本 `[raw, normalizeCommandPaths(raw), root]`、`DISCARD_REDIRECT`、`WRITE_VERBS`、`PWSH_WRITES`、`pwsh` 判定、workdir 包含判定、文件工具分支不改。

Must preserve:
- `decide.test.ts` 现有全部行（#245 边界表、#247 拼写表、#248 丢弃表、#255 fd 重定向表、#260 quote split 表、glob/brace/反引号行、兄弟路径行、更短 glob 前缀 next、大小写行）逐行结果不变；唯一例外是 #247 拼写表中默认配置 `rm -rf data/x/../raw` 的 next 钉住行，按 issue 改为 deny。
- `<raw>/../other` 写法（`rm -rf data/raw/../other` → deny、`cat data/raw/../other/f` → ask）不变：它们由原文命中，折叠副本只追加不替换。
- 探针 T1–T5 判定不变（不含 `..`）。
- 导出不变（`foldParentSegments` 不导出）。

Must add/change:
- 新函数（注释风格同 `normalizeCommandPaths`）：
  ```ts
  // Lexical `..`: inside one shell word a `..` segment cancels the plain segment
  // before it (not empty, `.` or `..`). Symlinks are not resolved.
  function foldParentSegments(text: string): string {
    return text.replace(/[^\s;&|()<>'"`]+/g, (word) => {
      const kept: string[] = [];
      for (const segment of word.split("/")) {
        const top = kept.at(-1);
        if (segment === ".." && top !== undefined && top !== "" && top !== "." && top !== "..") kept.pop();
        else kept.push(segment);
      }
      return kept.join("/");
    });
  }
  ```
  - 词边界：空白、`;&|()<>`、`'`、`"`、反引号——与 bash 元字符一致；引号作边界只影响原文副本，去引号副本（#260）已无引号。
  - 栈：`..` 只与前一个普通段相消，所以 `../raw` 的前导 `..`、绝对路径根的空段、`./` 的 `.` 都保留；多级 `x/y/../../raw` 由栈自然处理。
  - 复杂度：一次正则扫描 + 每词一次 `split`/`join`，线性；不做不动点反复替换（对抗输入下会退化为平方）。
- `texts` 第二层：
  ```ts
  .flatMap((text) => {
    const normalized = normalizeCommandPaths(text);
    return [text, normalized, foldParentSegments(normalized)];
  });
  ```
  候选文本 pwsh 至多 12 份、bash 6 份。折叠作用于规范化之后（`data//x/./../raw` 需先折 `//` 与 `/.`）。
- 测试（`decide.test.ts` 新 `test.each` 表 `parentFoldCases`，`kind` + `reason` 断言，deny 行 `reason` 含 `immutable`，ask 行为 `RAW_READ_PROVENANCE_REASON`；替身 `rawDirs: ["sub/raw"]`，在新建的临时 workspace 下建 `sub/raw/`、`sub/x/`、`sub/other/`，符号链接 `sub/lnk` → workspace 外的目录、`lnk2` → `sub/x`；该 workspace 作为 `cwd` 传入）：
  - deny：`rm -rf sub/x/../raw`、`rm sub/x/../raw/f`、`rm -rf ./sub/x/../raw`、`rm -rf <ws 的 realpath>/sub/x/../raw`、`rm -rf sub/x/y/../../raw`、`rm -rf {sub/x/../raw,y}`。
  - ask：`cat sub/x/../raw/f`、`cat sub//x/./../raw/f`。
  - 组合 deny：pwsh `Remove-Item sub\x\..\raw`；bash `rm -rf sub/x/"../"raw`。
  - 默认 raw：#247 拼写表那行 `rm -rf data/x/../raw` 改为 deny；新增 `cat <defaultRaw 父段>/x/../<叶段>/f` → ask（用 #260 已有的 `rawParent`/`rawLeaf`）；spec 场景 "parent traversal spelling is touching" 的默认配置命令逐条入表（同样用 `rawParent`/`rawLeaf` 拼接）：`rm -rf <父>/x/y/../../<叶>` → deny、`cat <父>//x/./../<叶>/f` → ask、`rm -rf <父>/x/../<叶>x` → next、`rm -rf <父>/x/../../<叶>` → next、`cat <父>/a b/../<叶>` → next、`rm -rf <父>/<叶>/../other` → deny。
  - 反例（next）：`rm -rf sub/x/../rawx`、`rm -rf sub/x/../raw.bak`、`rm -rf sub/rawx`、`cat sub/a b/../raw`（跨词不相消）、`rm -rf sub/x/../../raw`（折叠为 workspace 根下的 `raw`）。
  - 不回归：`rm -rf sub/raw/../other` → deny、`cat sub/raw/../other/f` → ask、`rm -rf sub//raw/../other` → deny（靠规范化副本命中，折叠副本不得替换它）。
  - 残留钉住：`rm -rf sub/lnk/../raw` → deny（已接受误报，`sub/lnk` 是真实符号链接）；`rm -rf lnk2/../raw` → next（已记录漏报，`lnk2` 是真实符号链接，物理上是 `sub/raw`）；`workdir: "sub/x"` 下 `rm -rf ../raw` 与 `cat ../raw/f` → next（已记录漏报）；同一命令 `cd sub/x && rm -rf ../raw` → next（已记录漏报，前导 `..` 同类）。
  - 资源：一行 1e6 字符级对抗输入 `rm -rf sub/` + `"a/".repeat(2e5) + "../".repeat(2e5) + "raw"` → deny（折叠为 `sub/raw`，证明长输入上折叠做完；不动点反复替换的写法会超时），沿用 #255 对抗行的超时写法。

Governing invariant: 「触及 raw」是加法判定——任一候选拼写命中 raw 原文、规范化原文或绝对路径即触及；折叠副本只追加，不替换已有候选；不触及时仍 `next()`。

Sibling surfaces:
- 文件工具分支 `canonical()` 已经 realpath 处理 `..`——不改。
- #264（stack-lock）不触及本文件。
- `scripts/guardrails/no-bypass.sh` 的 `writes_to()`（agent 侧 hook，不在 dsh pre-execute 路径）——不在本 change。
- 探针 `scripts/runtime/raw-guard-probes.sh` T1–T5 命令不含 `..`——不受影响。
- 构建产物 `lib/decide.js` 由 `pnpm run build` 生成。

Seams under test: `decideRawAccess(call, options)`（vitest）；live 探针 T1–T5。

Required evidence:
- 新增 deny/ask 行在改动前的 `decide.ts` 上红（next），改后绿；反例、不回归、残留行改前改后都绿；既有行不变（`data/x/../raw` 钉住行除外）。
- 突变：
  1. 去掉折叠副本 → 全部新 deny/ask 行红。
  2. 折叠作用于未规范化文本（`foldParentSegments(text)`）→ `cat sub//x/./../raw/f` 行红。
  3. 每词只消第一对 `seg/..`（无栈）→ `rm -rf sub/x/y/../../raw` 行红。
  4. 不切词，对整条命令折叠 → 反例 `cat sub/a b/../raw` 红。
  5. 折叠副本替换规范化副本（`[text, foldParentSegments(normalized)]`）→ `rm -rf sub//raw/../other` 行红。
  6. 折叠只作用于原命令（不作用于去引号/pwsh 副本）→ 两条组合行红。
- `pnpm vitest run packages/dsh-shud-raw-guard` 全绿；`pnpm run check` exit 0（覆盖率不降）；`pnpm run build`。
- live `pnpm run raw-guard:probes` 两次 T1–T5 PASS（或 INCONCLUSIVE 重跑），md5 不变（编排方）。

Non-goals: 符号链接感知的物理解析（s2）与相对 workdir 的前导 `..`（w1）——两者需要对 shell 词做 `canonical()`，即逐词 shell 分词与 realpath I/O，留作已记录漏报；让 `<raw>/../other` 转为 next（需放宽「文本含 raw 原文即触及」，单独决策）；变量/命令替换；persistent `cd`；完整 shell 词法解析；`WRITE_VERBS` 常量。
