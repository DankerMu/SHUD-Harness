# Design

Change surface: `packages/dsh-shud-raw-guard/src/decide.ts` 的 `decideRawAccess` shell 分支（`:135-152`）：候选文本数组 `texts` 与 `pwsh` 判定位置。`normalizeCommandPaths`、`caseInsensitiveRoot`、mention 正则（`${escaped}(?![A-Za-z0-9._-])` 与 `i` 标志）、raw 侧文本 `[raw, normalizeCommandPaths(raw), root]`、`DISCARD_REDIRECT`、`WRITE_VERBS`、`PWSH_WRITES`、workdir 包含判定、文件工具分支不改。

Must preserve:
- `decide.test.ts` 现有全部行（#245 边界表、#247 拼写表、#248 丢弃表、#255 fd 重定向表、glob/brace/反引号行、兄弟路径行 `rm protectedx/x`、`rm protected2/x`、`rm protected.bak`、`cat protected_old/x`、更短 glob 前缀 `rm -rf protecte*` → next、`..` 回溯 → next、大小写行）逐行结果不变。
- `pwsh` 的取值语义不变（同一表达式，只是提前计算）；非 pwsh 命令的写动词判定不变。
- 探针 T1–T5 判定不变。
- 导出不变。

Must add/change:
- shell 分支开头（`const command = …` 之后）计算 `const pwsh = call.name === "pwsh" || PWSH_COMMAND.test(command);`，删除循环内原 `const pwsh`。
- 候选文本：
  ```ts
  const bases = pwsh ? [command, command.replace(/\\/g, "/")] : [command];
  const texts = bases
    .flatMap((text) => [text, text.replace(/\\\n|["'\\]/g, "")])
    .flatMap((text) => [text, normalizeCommandPaths(text)]);
  ```
  - 去引号：先去掉反斜杠续行（`\` 紧跟换行，bash 把两侧拼成一个词），再去掉全部 `"`、`'`、`\`。bash 的引号拼接、反斜杠转义与续行在词法阶段合成同一个词，所以 `prot"ected"`、`prot'ected'`、`prot\ected`、`"prot"ected/obs.csv`、`prot''ected`、`prot\<换行>ected` 都是 `protected`。
  - pwsh：`\` → `/` 只在 pwsh 语境做（PowerShell 在 Unix 上接受两种分隔符；pwsh 的转义符是反引号，`\` 是字面字符）。bash 里 `sub\x` 是 `subx`，换成 `/` 会把兄弟名误判为 raw。
  - 每个文本最多 8 份（pwsh）或 4 份（bash），都是线性替换，无新正则回溯。
  - 注释：在 `texts` 上方用 2–3 行说明三种额外拼写与 pwsh 限定，风格同 `normalizeCommandPaths` 注释。
- 测试（`decide.test.ts` 新 `test.each` 表，`kind` + `reason` 断言，deny 行 `reason` 含 `immutable`，ask 行为 `RAW_READ_PROVENANCE_REASON`）：
  - deny（`rawDirs: ["protected"]`，bash）：`rm -rf prot"ected"`、`rm -rf prot'ected'`、`rm -rf prot\ected`、`rm -rf "prot"ected/obs.csv`、`rm -rf prot""ected`、`rm -rf prot\` + 换行 + `ected`（JS 字面量中 `"prot\\\nected"`）。
  - ask（bash）：`cat prot''ected/obs.csv`。
  - deny（`rawDirs: ["sub/x"]`）：pwsh `Remove-Item sub\x`；bash `pwsh -c "Remove-Item sub\x"`。
  - ask：pwsh `Get-Content sub\x\obs.csv`。
  - next 钉住（已记录漏报，`rawDirs: ["protected"]`，bash）：`rm -rf p*d`、`rm -rf protecte?`、`rm -rf prot[e]cted`、`rm -rf prot{e,}cted`、`rm -rf protect{ed,}`。
  - 反例（next）：bash `rm "prot ected"`；bash `rm sub\x`（`rawDirs: ["sub/x"]`）；pwsh `Remove-Item sub\xy`、`Get-Content sub\x.bak`（`rawDirs: ["sub/x"]`，兄弟名）。
  - 已接受误报（钉住为 deny）：bash `rm 'prot\ected'`、pwsh `Remove-Item 'prot''ected'`（`rawDirs: ["protected"]`）；pwsh `Remove-Item sub\x`（`rawDirs: ["subx"]`：pwsh 语境下未换 `/` 的基底也做去 `\`，得 `subx`）；bash `grep -l pwsh notes; rm sub\x`（`rawDirs: ["sub/x"]`：命令含 `pwsh` 词即对全文做 `\`→`/`）。
  - 默认 raw 至少一行：`rm -rf data/r"aw"` 形态（用测试文件里已有的 `defaultRaw` 拼接方式，在 raw 名中插入引号）→ deny。
  - 运行环境：沿用 `decide.test.ts` 现有的临时 workspace（含 `protected/`）；`sub/x` 行不需要建目录——`canonical()` 对不存在的路径段逐级上溯，mention 只做文本匹配，与已有 `missing/raw` 行（`decide.test.ts:462`、`:479`）同理。
- 注释订正：`decide.test.ts` fail-closed 块（#255 fix pass 2 加入，注释写 "all of these name files"）改为说明「bash 写文件，或引号包裹形态按 fail-closed 判为文件」，涵盖 `` >&2` x` `` 在 `x` 不是命令时实为 fd 复制的情况。只改注释。

Governing invariant: 「触及 raw」是加法判定——任一候选拼写命中 raw 原文、规范化原文或绝对路径即触及；新增的候选拼写只来自 shell/pwsh 词法下与原命令等价（或 fail-closed 近似）的文本；不触及时仍 `next()`。

Sibling surfaces:
- `normalizeCommandPaths` 与 #247 的拼写表——叠加使用，不改。
- `caseInsensitiveRoot` 的 `i` 标志——作用于所有候选文本，不改。
- #263（`..` 回溯）会改同一 Requirement 与同一 `texts` 构造——本 change 先合并、归档后 #263 再开。
- `scripts/guardrails/no-bypass.sh` 的 `writes_to()`（agent 侧 hook，不在 dsh pre-execute 路径）——不在本 change（#245 已说明不合并）。
- 探针 `scripts/runtime/raw-guard-probes.sh` T1–T5 命令不含引号拆分或反斜杠——不受影响。
- 构建产物 `lib/decide.js` 由 `pnpm run build` 生成。

Seams under test: `decideRawAccess(call, options)`（vitest）；live 探针 T1–T5。

Required evidence:
- 新增 deny/ask 行在改动前的 `decide.ts` 上红（next），改后绿；next 钉住行与反例改前改后都绿；既有行不变。
- 突变：去掉去引号副本 → 引号/转义 deny 行红；去引号正则去掉 `\\\n` 分支 → 续行 deny 行红；去掉 pwsh `\`→`/` 基底 → pwsh 行红；`\`→`/` 改为对所有命令都做 → bash `rm sub\x` 反例红；`pwsh` 判定放回循环内且 mention 用不到它（即只对 `call.name === "pwsh"` 做替换）→ bash `pwsh -c "Remove-Item sub\x"` 行红。
- `pnpm vitest run packages/dsh-shud-raw-guard` 全绿；`pnpm run check` exit 0（覆盖率不降）；`pnpm run build`。
- live `pnpm run raw-guard:probes` 两次 T1–T5 PASS（或 INCONCLUSIVE 重跑），md5 不变（编排方）。

Non-goals: 名字中段 glob 或 brace 的识别（登记为第四处已记录漏报）；ANSI-C 与 locale 引号（`$'prot\x65cted'`、`prot$''ected`）；pwsh 反引号转义（`` Remove-Item pr`otected ``）；变量/命令替换（`$D`、`eval`、base64）；`..` 回溯（#263）；persistent `cd`；Unicode 规范化；完整 shell 词法解析；pwsh 的大小写不敏感路径；`WRITE_VERBS` 常量。

Review focus:
1. 去引号只在候选文本侧做，raw 侧文本不变；不会让兄弟名（`protectedx`、`protected.bak`）因去引号而误中（`"protected".bak` 去引号后为 `protected.bak`，后继 `.` 是路径名字符，不中——原文 `"protected"` 后继 `"` 本来就中，属既有行为）。
2. `\`→`/` 只在 pwsh 语境。
3. `pwsh` 前移不改变其值，也不改变写动词判定。
4. 已接受误报（含 pwsh 去 `\` 与 bash 中出现 `pwsh` 词两种）写进 spec 并有钉住行。
