# Design

Change surface: `packages/dsh-shud-raw-guard/src/decide.ts` 的两个常量 `WRITE_VERBS`（`:33-34`）与 `DISCARD_REDIRECT`（`:44`）及其注释。`decideRawAccess` 流程、`PWSH_WRITES`、`PWSH_COMMAND`、`normalizeCommandPaths`、`caseInsensitiveRoot`、mention 判定、文件工具分支不改。

Must preserve:
- `decide.test.ts` 现有全部用例逐行结果不变（含 #245 边界表、#248 丢弃型重定向表、#247 拼写表）。
- 未加引号的 fd 复制、移动与关闭不是写：`2>&1`、`>&2`、`>& 2`、`1>&-`、`2>&1-`、`3>&1-`、`2>&1 | wc -l`、`2>&1;`、`$(... 2>&1)` 仍 `ask`（引号包裹形态见 fail-closed 取舍）。
- 输入重定向 `<`、进程替换 `<(...)`、heredoc `<<` 不是写。
- 探针 T2 `cat <默认 raw>/obs.csv` → ask；T3 `echo bad >> <默认 raw>/obs.csv` → deny。
- `DENY`/`ASK`/`NEXT` 与 `RAW_READ_PROVENANCE_REASON` 导出不变。

Must add/change:
- `WRITE_VERBS` 追加两支（放在原重定向子式之后，`|` 连接）：
  - `(^|[^<])>&[ \t\n]*(?!(?:[0-9]+-?|-)(?=$|[ \t\n;&|()<>]))[^ \t\n]`：`>&` 后可选空白，若接下来是「一串数字、一串数字加 `-`（fd 移动，bash 5.3.15 实测 `echo e 1>&2-` 不建文件）或单个 `-`，且其后**紧接**行尾、空格、制表、换行或 `;&|()<>`」则是 fd 复制/移动/关闭，不算写；否则只要还有一个非空白字符就算写。bash 的 word 只在空格/制表/换行与元字符处断开：引号从不结束 word（开引号把引号内文本并入同一 word），`}` 也不是元字符，所以 `>&2x`、`>&2:x`、`>&2$x`、`>&2\x`、`>&2"x"`、`>&2" "`、`>&2';x'`、`>&2}`、`>&2\r` 都是文件（round 1/2 review 在 bash 5.3.15 实测建文件，`>&2"/../<raw>/b"`、`>&2" /../<raw>/b"` 改写了替身 raw 文件；`echo x >&2}` 建文件 `2}`）。空白只认 `[ \t\n]`（JS `\s` 还含 `\r \f \v \u00a0` 等，bash 不在这些字符处断词）。
  - **fail-closed 取舍（round 2，fix pass 2）**：正则无法区分开引号与闭引号，因此不放行任何引号。代价是引号或反引号包裹的读命令中 fd 号后紧跟闭引号的写法判 deny：`sh -c 'head <raw>/a >&2'`、`bash -c "cat <raw>/a 2>&1"`、`` x `cat <raw>/a 2>&1` ``、`>&2''`，以及 `{ cat <raw>/a >&2}` 这类。这是 deny 方向误报，与 `grep '>' <raw>` 判 deny 同类，spec 写明接受；M1 的用户可见步骤与探针 T2 用裸命令，不受影响；`$(cmd 2>&1)`、`"$(cmd 2>&1)"` 以 `)` 为边界，仍为 ask。不做引号状态扫描：那是 #247 Non-goal 的 shell 词法解析。`>&$fd` 按写（deny 方向误报，运行时可能是 fd 号）。`(^|[^<])` 与原子式一致，使 `<>&` 这类畸形不归此支。`N>&word`（N≥2）在 bash 中报 ambiguous redirect、不写文件，按写处理属 deny 方向误报，可接受。
  - `<>[ \t\n]*[^ \t\n]`：读写重定向，`N<>`/`<>` 皆中。命令文本里任何 `<>` 后接非空白都中，含 SQL 不等号，deny 方向误报（spec 写明）。
  - `[ \t\n]*` 后接否定前瞻与单字符 `[^ \t\n]`，回溯量与输入长度线性，无 ReDoS。
- `DISCARD_REDIRECT` = `/(?:&?>{1,2}|>&|<>)\s*\/dev\/null(?![A-Za-z0-9._/-])/g`：`>&/dev/null`、`N>&/dev/null`、`<>/dev/null`、`N<>/dev/null` 也剥除；仍只从 `&`/`>`/`<` 起剥，不吞前导 fd 数字（`bzip2>/dev/null` 不变）。剥除先于 `WRITE_VERBS`，所以 `>&/dev/null` 是读、`>&/dev/nullx` 是写。
- 注释：重定向子式注释说明三支各自覆盖什么、为何排除纯数字/`-`；`DISCARD_REDIRECT` 注释补 `>&`、`<>`。
- 测试（`decide.test.ts` 新增一张 `test.each` 表，`rawDirs: ["protected"]` 替身 + 默认 raw 各至少一行；每行断言 `kind`，deny 行 `reason` 含 `immutable`，ask 行 `reason` 为 `RAW_READ_PROVENANCE_REASON`）：
  - deny：`echo x >&protected/b`、`echo x >& protected/b`、`echo x 1>&protected/b`、`cat protected/a >&out.txt`、`echo x >&2x protected/a`（触及 raw 的同时写到文件 `2x`）、`echo XY 1<>protected/a`、`: <>protected/newfile`、`exec 3<>protected/newfile`、`cat protected/a 0<>protected/b`、`cat protected/a 2>/dev/null >&protected/b`、`echo XY 1<>protected/a 2>/dev/null`、`head protected/a >&/dev/nullx`、默认 raw `echo x >&<默认 raw>/b`。
  - ask：`head protected/a 2>&1`、`head protected/a >&2`、`head protected/a >& 2`、`head protected/a 1>&-`、`head protected/a 2>&1-`、`cat protected/a 3>&1-`、`head protected/a 2>&1 | wc -l`、`head protected/a 2>&1;`、`head protected/a >&/dev/null`、`head protected/a 3<>/dev/null`、`head protected/a <protected/b`、`diff <(cat protected/a) b`、`cat protected/a <<EOF`、默认 raw `head <默认 raw>/a 2>&1`。
  - 对照（round 1 review 发现此前并无专门行，本次补入）：`echo x &>protected/b`、`echo x &>>protected/b` → deny；`bzip2<>/dev/null protected/x` → deny（钉住 `DISCARD_REDIRECT` 的 `<>` 分支：去掉该分支时 `&?>{1,2}` 只剥 `>/dev/null`，余下 `bzip2<` 不再命中写动词）。
  - fd 号后的词边界（round 1 review）：deny：`echo x >&1,/../protected/x`、`cat protected/a >&2:out`、`cat protected/a >&2,`、`cat protected/a >&2$x`、`cat protected/a >&2\x`、`cat protected/a >&2-"q"`、`cat protected/a >&2"/../protected/b"`、`cat protected/a >&2'y'`、`workdir: protected` 下 `echo x >&2"x"`、默认 raw `cat <默认 raw>/a >&2:out`；ask：`cat protected/a 2>&1)`、`cat protected/a 2>&1&&x`、`{ cat protected/a >&2; }`、`x "$(cat protected/a 2>&1)"`、`cat protected/a 2>&1>/dev/null`、`cat protected/a 2>&1<x`、`cat protected/a 2>&1` 后接换行、`cat protected/a 2>&1\t#c`。
  - round 2 review（fix pass 2）：deny：`cat protected/a >&2" "`、`>&2" x"`、`>&2";x"`、`>&2' '`、`` >&2` x` ``、`>&2" /../protected/b"`、`>&2}`、`>&2\r`、`>&2\fx`、`>&2\u00a0x`（均以 `cat protected/a ` 开头）、`workdir: protected` 下 `echo x >&2" "`；由 ask 改判 deny（fail-closed 取舍）：`sh -c 'head protected/a >&2'`、`sh -c "head protected/a >&2"`、`` x `cat protected/a 2>&1` ``、`cat protected/a >&2''`。

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
- 突变：去掉 `>&` 支 → `>&protected/b` 行红；去掉 `<>` 支 → `1<>` 行红；去掉内层边界前瞻 `(?=$|[ \t\n;&|()<>])` → `>&2x` 与边界 deny 行红；`DISCARD_REDIRECT` 去掉 `>&` → `>&/dev/null` ask 行红；内层去掉 `-?` → `2>&1-` ask 行红；边界前瞻改回 `(?![A-Za-z0-9._/-])` → `>&2:out` 等边界 deny 行红；边界恢复引号放行 `['"`]*` → round 2 引号 deny 行红；边界与两支的 `[ \t\n]` 换回 `\s` → `\r`、`\f`、`\u00a0` deny 行红；边界加回 `}` → `>&2}` deny 行红；`DISCARD_REDIRECT` 去掉 `<>` → `bzip2<>/dev/null` deny 行红。
- 资源上限：对抗输入 `">&" + " ".repeat(1e6)`、`"1>&".repeat(3e5)`、`"<>" + " ".repeat(1e6)`（各前置 `cat protected/a `）作为 vitest 行，三行均断言 `kind` 为 `ask`、`reason` 为 `RAW_READ_PROVENANCE_REASON`（`>&`、`<>` 后全是空白，无 `\S`，不算写；`1>&` 重复串中每个 `>&1` 都是 fd 复制，末尾 `>&` 后为空），且在默认超时内完成；fixture review 用 node 实测各 ≤7 ms。
- `pnpm run build` 后 `pnpm run raw-guard:probes` T1–T5 PASS（或 INCONCLUSIVE 重跑）、md5 不变。

Non-goals: 其余重定向形态已实测无需改动——`>|` 由原 `>` 支判 deny；`&>>` 在 #248 表已覆盖；`>>&` 是 bash 语法错误、原正则已判 deny；`<&word`、here-string `<<<` 只读不写，仍 ask。zsh 专属重定向（`>!`、`>&|`）；pwsh `> $null`、`Out-Null`；`/dev/stdout`、`/dev/stderr` 等其他设备文件；shell 语法解析；mention 判定的拼写问题（#247 已合、#260 另做）。

Review focus:
1. 未加引号的 `2>&1` 及其变体（`>& 2`、`2>&1;`、`2>&1)`、`$(… 2>&1)`）绝不落 deny——它是模型最常用的读命令后缀；引号包裹形态按 fail-closed 取舍判 deny。
2. `[ \t\n]*` 回溯不会让 `>& 2` 通过「零空白 + 空白字符作 `[^ \t\n]`」误中（`[^ \t\n]` 不匹配空白）。
3. `DISCARD_REDIRECT` 扩展后不剥 `>&/dev/nullx`、`<>/dev/null/x`，且不吞前导数字。
4. `<>` 支的 deny 方向误报（SQL 不等号）已在 spec 写明且可接受。
5. 新正则无 ReDoS（1e6 字符对抗输入，见资源上限测试行）。
6. fd 移动 `N>&M-` 仍 ask。
7. fd 号后的边界与 bash word 断词一致：只有行尾、`[ \t\n]` 与元字符 `;&|()<>` 结束 fd 号；引号与 `}` 不结束。

Known residual（round 1 review）：`DISCARD_REDIRECT` 的 `/dev/null` 尾边界沿用 #248 的路径名字符集，`>&/dev/null"/../x"`、`<>/dev/null"x"` 会被剥除；bash 实测前者报 Not a directory 不写入，后者目标是 `/dev/nullx`（不在 raw），不改。
