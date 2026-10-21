# Design

Change surface: `packages/dsh-shud-raw-guard/src/decide.ts` 的两个常量 `WRITE_VERBS`（`:33-34`）与 `DISCARD_REDIRECT`（`:44`）及其注释。`decideRawAccess` 流程、`PWSH_WRITES`、`PWSH_COMMAND`、`normalizeCommandPaths`、`caseInsensitiveRoot`、mention 判定、文件工具分支不改。

Must preserve:
- `decide.test.ts` 现有全部用例逐行结果不变（含 #245 边界表、#248 丢弃型重定向表、#247 拼写表）。
- fd 复制、移动与关闭不是写：`2>&1`、`>&2`、`>& 2`、`1>&-`、`2>&1-`、`3>&1-`、`2>&1 | wc -l`、`2>&1;`、引号内 `'... >&2'` 仍 `ask`。
- 输入重定向 `<`、进程替换 `<(...)`、heredoc `<<` 不是写。
- 探针 T2 `cat <默认 raw>/obs.csv` → ask；T3 `echo bad >> <默认 raw>/obs.csv` → deny。
- `DENY`/`ASK`/`NEXT` 与 `RAW_READ_PROVENANCE_REASON` 导出不变。

Must add/change:
- `WRITE_VERBS` 追加两支（放在原重定向子式之后，`|` 连接）：
  - `(^|[^<])>&\s*(?!(?:[0-9]+-?|-)(?![A-Za-z0-9._/-]))\S`：`>&` 后可选空白，若接下来是「一串数字、一串数字加 `-`（fd 移动，bash 5.3.15 实测 `echo e 1>&2-` 不建文件）或单个 `-`，且其后不是路径名字符 `[A-Za-z0-9._/-]`」则是 fd 复制/移动/关闭，不算写；否则只要还有一个非空白字符就算写。`>&2x`、`>&2/x` 是文件。`>&$fd` 按写（deny 方向误报，运行时可能是 fd 号）。`(^|[^<])` 与原子式一致，使 `<>&` 这类畸形不归此支。`N>&word`（N≥2）在 bash 中报 ambiguous redirect、不写文件，按写处理属 deny 方向误报，可接受。
  - `<>\s*\S`：读写重定向，`N<>`/`<>` 皆中。命令文本里任何 `<>` 后接非空白都中，含 SQL 不等号，deny 方向误报（spec 写明）。
  - `\s*` 后接否定前瞻与单字符 `\S`，回溯量与输入长度线性，无 ReDoS。
- `DISCARD_REDIRECT` = `/(?:&?>{1,2}|>&|<>)\s*\/dev\/null(?![A-Za-z0-9._/-])/g`：`>&/dev/null`、`N>&/dev/null`、`<>/dev/null`、`N<>/dev/null` 也剥除；仍只从 `&`/`>`/`<` 起剥，不吞前导 fd 数字（`bzip2>/dev/null` 不变）。剥除先于 `WRITE_VERBS`，所以 `>&/dev/null` 是读、`>&/dev/nullx` 是写。
- 注释：重定向子式注释说明三支各自覆盖什么、为何排除纯数字/`-`；`DISCARD_REDIRECT` 注释补 `>&`、`<>`。
- 测试（`decide.test.ts` 新增一张 `test.each` 表，`rawDirs: ["protected"]` 替身 + 默认 raw 各至少一行；每行断言 `kind`，deny 行 `reason` 含 `immutable`，ask 行 `reason` 为 `RAW_READ_PROVENANCE_REASON`）：
  - deny：`echo x >&protected/b`、`echo x >& protected/b`、`echo x 1>&protected/b`、`cat protected/a >&out.txt`、`echo x >&2x protected/a`（触及 raw 的同时写到文件 `2x`）、`echo XY 1<>protected/a`、`: <>protected/newfile`、`exec 3<>protected/newfile`、`cat protected/a 0<>protected/b`、`cat protected/a 2>/dev/null >&protected/b`、`echo XY 1<>protected/a 2>/dev/null`、`head protected/a >&/dev/nullx`、默认 raw `echo x >&<默认 raw>/b`。
  - ask：`head protected/a 2>&1`、`head protected/a >&2`、`head protected/a >& 2`、`head protected/a 1>&-`、`head protected/a 2>&1-`、`cat protected/a 3>&1-`、`head protected/a 2>&1 | wc -l`、`head protected/a 2>&1;`、`sh -c 'head protected/a >&2'`、`head protected/a >&/dev/null`、`head protected/a 3<>/dev/null`、`head protected/a <protected/b`、`diff <(cat protected/a) b`、`cat protected/a <<EOF`、默认 raw `head <默认 raw>/a 2>&1`。
  - 对照（已在 #248 表）：`echo x &>protected/b`、`&>>`、`> protected/b` 仍 deny。

Governing invariant: 触及 raw 的命令中，任何把输出写到真实文件的重定向（`>`、`>>`、`&>`、`&>>`、文件形态 `>&`、`<>`）都使判定为 deny；fd 复制/关闭与 `/dev/null` 丢弃不算写；不触及 raw 的命令仍 `next`。

Sibling surfaces:
- `PWSH_WRITES`：pwsh 的 `*>&1` 等流重定向——`>&1` 为纯数字，不中新支，不变。
- `scripts/runtime/raw-guard-probes.sh` T2/T3 谓词——不变。
- 构建产物 `lib/decide.js`：`pnpm run build` 生成，探针走它。
- #260（引号/反斜杠拆分、pwsh 反斜杠）与后续 `..` 回溯 issue 改的是 mention 判定（"Shell command touches raw"），与本 change 的写动词 Requirement 不冲突。

Seams under test: `decideRawAccess(call, options)` 纯函数（vitest）；live 探针 T2/T3。

Required evidence:
- 新增 deny 行中 `>&` 与 `<>` 文件形态在改动前红、改后绿；新增 ask 行改前改后都绿（钉住"不过宽"）。
- `pnpm vitest run packages/dsh-shud-raw-guard` 全绿；`pnpm run check` exit 0。
- 突变：去掉 `>&` 支 → `>&protected/b` 行红；去掉 `<>` 支 → `1<>` 行红；否定前瞻去掉内层 `(?![A-Za-z0-9._/-])` → `>&2x` 行红；`DISCARD_REDIRECT` 去掉 `>&` → `>&/dev/null` ask 行红；内层去掉 `-?` → `2>&1-` ask 行红。
- 资源上限：对抗输入 `">&" + " ".repeat(1e6)`、`"1>&".repeat(3e5)`、`"<>" + " ".repeat(1e6)`（各前置 `cat protected/a `）作为 vitest 行，三行均断言 `kind` 为 `ask`、`reason` 为 `RAW_READ_PROVENANCE_REASON`（`>&`、`<>` 后全是空白，无 `\S`，不算写；`1>&` 重复串中每个 `>&1` 都是 fd 复制，末尾 `>&` 后为空），且在默认超时内完成；fixture review 用 node 实测各 ≤7 ms。
- `pnpm run build` 后 `pnpm run raw-guard:probes` T1–T5 PASS（或 INCONCLUSIVE 重跑）、md5 不变。

Non-goals: 其余重定向形态已实测无需改动——`>|` 由原 `>` 支判 deny；`&>>` 在 #248 表已覆盖；`>>&` 是 bash 语法错误、原正则已判 deny；`<&word`、here-string `<<<` 只读不写，仍 ask。zsh 专属重定向（`>!`、`>&|`）；pwsh `> $null`、`Out-Null`；`/dev/stdout`、`/dev/stderr` 等其他设备文件；shell 语法解析；mention 判定的拼写问题（#247 已合、#260 另做）。

Review focus:
1. `2>&1` 及其变体（`>& 2`、`2>&1;`、`2>&1)`、引号内）绝不落 deny——它是模型最常用的读命令后缀。
2. `\s*` 回溯不会让 `>& 2` 通过「零空白 + 空白字符作 `\S`」误中（`\S` 不匹配空白）。
3. `DISCARD_REDIRECT` 扩展后不剥 `>&/dev/nullx`、`<>/dev/null/x`，且不吞前导数字。
4. `<>` 支的 deny 方向误报（SQL 不等号）已在 spec 写明且可接受。
5. 新正则无 ReDoS（1e6 字符对抗输入，见资源上限测试行）。
6. fd 移动 `N>&M-` 仍 ask。
