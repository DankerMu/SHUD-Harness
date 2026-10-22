# Design

Change surface: `packages/dsh-shud-raw-guard/src/decide.ts`。

新增或修改：
- `TAR_COMMAND` 命令名加 `bsdtar`（`(?:[gG]|[bB][sS][dD])?[tT][aA][rR]`）；
- 未导出函数 `tarArguments`：从 `tarExtracts` 中提出"按段、从第一个 tar 起取其后文本"，每段另加 `(`、反引号之后的子段（只增加候选，防止段内先出现的 `bsdtar` 等 tar 词遮住 `$( )`/反引号里的 tar）；`tarExtracts` 改为调用它（结果只会收紧）；
- 常量 `TAR_ARCHIVE_WRITE`（写归档模式）、`TAR_ARCHIVE_OPERAND`（归档操作数）与未导出函数 `tarArchives`；
- 第一遍循环：写判定额外检查 `tarArchives` 得到的操作数是否在 raw 下。

不改：
- `WRITE_VERBS`、`PWSH_WRITES`、`DISCARD_REDIRECT`、`TAR_EXTRACT_OPTION`、`COMMAND_SEGMENT`、`unquote`；
- mention 判定、workdir 判定、祖先判定（tar 不是破坏性动词）、文件工具分支；
- 导出。

Must preserve:
- `decide.test.ts`、`decide-spelling.test.ts` 现有全部行逐行结果不变，特别是 #279 钉住的 `tar -cf o.tar prot`、`tar -cf o.tar -C prot .` 为 `ask`。若有既有行结果变化，停下报告，不改断言。
- 新判定只会把 ask 收紧为 deny（只在已触及 raw 的分支内追加一个 OR）。
- 探针 T1–T5 判定不变。

Must add/change:
- 代码（注释风格同文件内其他常量）：
  ```ts
  // #279/#283: tar, gtar and bsdtar (any case), not after a path-name character.
  const TAR_COMMAND = /(?<![A-Za-z0-9_.-])(?:[gG]|[bB][sS][dD])?[tT][aA][rR]\s/;
  // The text after the first tar of each command segment, from the blank after
  // the name. Each segment also yields the pieces after its ( and ` so a tar
  // inside $( ) or backticks is not hidden by an earlier tar-like word (bsdtar -tf
  // a $(tar xf b -C <raw>)); pieces only add candidates. Scanning from the first
  // tar of each piece keeps the checks linear.
  function tarArguments(text: string): string[] {
    return text
      .split(COMMAND_SEGMENT)
      .flatMap((segment) => [segment, ...segment.split(/[(`]/).slice(1)])
      .flatMap((segment) => {
        const tar = TAR_COMMAND.exec(segment);
        return tar === null ? [] : [segment.slice(tar.index + tar[0].length - 1)];
      });
  }
  function tarExtracts(text: string): boolean {
    return tarArguments(text).some((options) => TAR_EXTRACT_OPTION.test(options));
  }
  // #283: tar writes the archive named after f in create, append, update,
  // catenate or delete mode (c r u A, case-sensitive: -C changes directory). The
  // archive is the word after the first f of a short cluster (or glued to it),
  // after --file/--fil, or after an old-style first cluster holding f. - is
  // stdout. Stopping at the first f keeps the operand scan linear.
  const TAR_ARCHIVE_WRITE =
    /^\s+[A-Za-z]*[cruA]|\s(?:-[A-Za-z]*[cruA]|--(?:cr|ap|up|ca|conc|dele)[a-z]*(?![A-Za-z0-9-]))/;
  const TAR_ARCHIVE_OPERAND =
    /^\s+[A-Za-eg-z]*f[A-Za-z]*\s+(\S+)|\s-[A-Za-eg-z]*f\s*(\S+)|\s--file?(?:=|\s+)(\S+)/g;
  function tarArchives(text: string): string[] {
    return tarArguments(text)
      .filter((options) => TAR_ARCHIVE_WRITE.test(options))
      .flatMap((options) =>
        [...options.matchAll(TAR_ARCHIVE_OPERAND)].map((match) => match[1] ?? match[2] ?? match[3]),
      )
      .filter((archive) => archive !== "-");
  }
  ```
  - `TAR_ARCHIVE_OPERAND` 带 `g`，只用于 `matchAll`（不产生 `lastIndex` 状态）。
- `decideRawAccess` shell 分支，只在已触及 raw 的分支内（`continue` 之后）计算，且对全部 rawDirs 比对（命令触及 `prot` 而归档写在另一个 raw `raw2` 下时也要 deny；循环在第一个被触及的 raw 处返回）。操作数去重，每个只做一次 `canonical`；操作数与重定向互不影响，不剥丢弃重定向：
  ```ts
  const archives = new Set([command, unquote(command)].flatMap(tarArchives));
  const roots = archives.size > 0 ? options.rawDirs.map((dir) => canonical(dir, cwd)) : [];
  const writesArchive = [...archives].some((archive) => {
    const target = canonical(archive, workdir);
    return roots.some((other) => contains(other, target));
  });
  return writes || writesArchive || (pwsh && PWSH_WRITES.test(command)) ? DENY : ASK;
  ```
  `canonical` 对操作数抛错时异常上抛：ENOTDIR（`file.txt/a.tar`）、ENAMETOOLONG（超长段或总长）、EACCES（无权限祖先）、ERR_INVALID_ARG_VALUE（含 NUL）；`archives` 非空时 `roots` 对全部 rawDirs 求 `canonical`，配置异常的后续 raw 同样可能抛错。dsh `prepareExecution` 记为工具错误且不执行（fail-closed，与既有 `canonical` 调用相同）。
- 测试（新建 `tarArchiveCases`，放 `decide-spelling.test.ts`，复用其 `prot/` workspace 并建 `prot/sub/`；`rawDirs: ["prot"]`；deny 断言 `code: "raw-immutable"`，ask 断言 provenance reason）：
  - 写归档 deny：`tar -cf prot/a.tar x`、`tar -rf prot/a.tar x`、`tar -uf prot/a.tar x`、`tar -Af prot/a.tar b.tar`、`tar --delete -f prot/a.tar x`、`tar cf prot/a.tar x`、`tar --create --file=prot/a.tar x`、`tar --append --file prot/a.tar x`、`tar --up -f prot/a.tar x`、`tar --cat -f prot/a.tar b.tar`、`tar --conc -f prot/a.tar b.tar`、`tar --cr --fil=prot/a.tar x`、`tar -c -f prot/sub/a.tar x`、`tar -f prot/a.tar -c x`、`tar -cfprot/a.tar x`、`tar -c -f "prot/a.tar" x`、`tar -cf prot/a.tar x 2>/dev/null`、`gtar -rf prot/a.tar x`、`bsdtar -cf prot/a.tar x`、`BSDTAR -cf prot/a.tar x`；fixture review r1 补：`tar -zcf prot/a.tgz x`（模式字母不在簇首）、`tar zcf prot/a.tgz x`（旧式模式字母不在簇首）、`tar cfv prot/a.tar x`（旧式 `f` 不在簇尾）、`tar --ca -f prot/a.tar b.tar`。
  - review round 1 补 deny：
    - 旧式模式字母：`tar rf prot/a.tar x`、`tar uf prot/a.tar x`、`tar Af prot/a.tar b.tar`；
    - 簇内字母类与位置：`tar Jcf prot/a.txz x`、`tar zvcf prot/a.tgz x`、`tar cfvP prot/a.tar x`；
    - 空白：`tar` 接两个空格再接 `cf prot/a.tar x`、`tar` 接制表符再接 `cf prot/a.tar x`、`tar` 接制表符再接 `-cf prot/a.tar x`、`tar -c` 接制表符再接 `-f prot/a.tar x`、`tar -cf` 接两个空格再接 `prot/a.tar x`、`tar -cf` 接制表符再接 `prot/a.tar x`、`tar cf` 接两个空格再接 `prot/a.tar x`、`tar cf` 接制表符再接 `prot/a.tar x`、`tar -c --file` 接两个空格再接 `prot/a.tar x`、`tar -c --file` 接制表符再接 `prot/a.tar x`、`tar -c` 接制表符再接 `--file=prot/a.tar x`；
    - 非末段：`tar -cf prot/a.tar x && ls`；
    - 子段：`bsdtar -tf a.tar $(tar xf b.tar -C prot)`、`` bsdtar -tf a.tar `tar xf b.tar -C prot` ``（main 上为 deny，不得放宽）。
  - review round 1 补 ask（已记录漏报，`cd` 改变目录后的相对操作数）：`cd prot && tar -cf a.tar x`、`cd prot; tar -cf a.tar x`。
  - 多 raw deny：`rawDirs: ["prot", "raw2"]`（workspace 下建 `raw2/`）时 `tar -cf raw2/a.tar prot/x`。
  - 第一个 `f` deny：`rawDirs: ["ref/raw"]`（workspace 下建 `ref/raw/`）时 `tar -cfref/raw/a.tar x`（贪婪取最后一个 `f` 会得到 `/raw/a.tar`）。
  - bsdtar 解包 deny：`bsdtar -xf a.tar -C prot`、`/usr/bin/bsdtar -xf a.tar -C prot`。
  - workdir deny：`workdir: "prot"` 下 `tar -cf a.tar x`（操作数按 workdir 解析）。
  - ask：`tar -cf o.tar prot`、`tar -cf o.tar -C prot .`、`tar -C prot -cf o.tar .`、`tar -cf - prot | wc -c`、`bsdtar -tf prot/a.tar`、`cat prot/mybsdtar.log`、`tar -tvf prot/a.tar -C work`、`tar -tf prot/a.tar | grep -c -f prot/pat`、`tar -tf prot/a.tar --delay`；`workdir: "prot"` 下 `tar -cf - x`。
  - next：`tar -cf protx/a.tar x`。
  - 资源：`"tar -c " + "-f x ".repeat(2e5)` → next；`"tar -c " + "-f x ".repeat(2e5) + "prot"` → ask（触及 raw，操作数去重后只解析一次）；`"tar -c -" + "a".repeat(5e5) + " prot"` → ask；`"tar c" + "f".repeat(5e5) + "/ prot"` → ask（触及 raw，走旧式操作数分支）。均在默认超时内完成。
  - 已接受误报 deny：`tar -tf prot/a.tar -Hustar`（选项与参数连写，参数含模式字母）；`grep "tar -cf prot/a.tar" prot/log`（`tar` 作为文本）。
  - `tar -xf prot/a.tar -C work` 自 #279 起为 deny（raw 仅作为解包源，已接受误报），不放进 ask 组。

Governing invariant:
- 写归档只在归档操作数位于 raw 下时判写；raw 仅作为打包源不判写。
- 模式字母区分大小写；命令名不区分大小写。
- 新判定只在已触及 raw 的分支内追加，结果只会从 ask 收紧为 deny。
- 每个辅助判定对命令长度线性。

Sibling surfaces:
- `WRITE_VERBS` 里的 `g?tar\s+-[a-zA-Z]*x` 子式保留；`bsdtar -x…` 由 `tarExtracts` 覆盖。
- 归档操作数经符号链接指向 raw、或用变量拼写（`$PWD/<raw>/a.tar`、`$(pwd)/…`）而命令未字面提及 raw 时，不进入第一遍循环或解析不到，与其他 shell 写同属已记录漏报，不改。
- `TAPE` 环境变量、默认设备、`cbf 20 a.tar` 这类多参数旧式簇（取第一个词）不在范围。
- `lib/decide.js` 由 build 生成。

Seams under test: `decideRawAccess(call, options)`（vitest）；live 探针 T1–T5。

Required evidence:
- 改动前（origin/main 的 `decide.ts`）：design 列出的全部 deny 行（写归档、bsdtar、workdir、多 raw、`ref/raw`、已接受误报、review round 1 补行）为红（ask），两条子段行除外（main 上已为 deny，作为不放宽的钉住行）；ask/next 行与资源行为绿。改后全部为绿，既有行不变。
- 突变，每项至少让一行变红：
  1. 不检查 `writesArchive` → 写归档 deny 行变红。
  2. `TAR_COMMAND` 去掉 `bsdtar` 分支 → 全部 `bsdtar` deny 行变红。
  3. `bsdtar` 分支只认小写 → `BSDTAR` 行变红。
  4. `TAR_ARCHIVE_WRITE` 加 `/i`（`-C` 也算写模式）→ `tar -tvf prot/a.tar -C work` 变红。
  5. 模式字母分别去掉 `c`、`r`、`u`、`A` → 对应 deny 行变红。
  6. 去掉旧式模式分支 → `tar cf prot/a.tar x` 变红。
  7. 长选项分别去掉 `cr`、`ap`、`up`、`ca`、`conc`、`dele` → 对应长选项行变红；`dele` 改为 `del` → `--delay` ask 行变红；`ca` 改为 `cat` → `--ca` 行变红。
  8. 操作数正则分别去掉旧式分支、短簇分支、`--file` 分支 → 对应行变红。
  9. 短簇操作数 `\s*` 改为 `\s+` → `-cfprot/a.tar` 行变红。
  10. `--file?` 改为 `--file` → `--fil=` 行变红。
  11. 不排除 `-` → `workdir: "prot"` 下 `tar -cf - x` 变红。
  12. 操作数按 `cwd` 而非 `workdir` 解析 → workdir deny 行变红。
  13. `archives` 只取原文（去掉 `unquote(command)`）→ 引号操作数行变红。
  14. `tarArguments` 不分段 → `tar -tf prot/a.tar | grep -c -f prot/pat` 变红。
  15. 短簇模式只认首字母（`\s-[cruA]`）→ `tar -zcf prot/a.tgz x` 变红。
  16. 旧式模式只认首字母（`^\s+[cruA]`）→ `tar zcf prot/a.tgz x` 变红。
  17. 旧式操作数要求 `f` 在簇尾（去掉 `f` 后的 `[A-Za-z]*`）→ `tar cfv prot/a.tar x` 变红。
  18. 只与当前 raw 比对（`contains(root, target)`）→ 多 raw 行变红。
  19. 操作数前缀类 `[A-Za-eg-z]*` 改回 `[A-Za-z]*`：短簇分支 → `tar -cfref/raw/a.tar x` 变红；旧式分支 → `"tar c" + "f".repeat(5e5) + "/ prot"` 资源行平方级超时。
  20. 只在旧式分支单独去掉 `r` / `u` / `A` → 对应旧式行变红。
  21. 旧式模式前缀 `[A-Za-z]*` 改为 `[a-z]*` 或 `[A-Za-z]?` → `tar Jcf …` / `tar zvcf …` 变红；旧式操作数 `f` 后 `[A-Za-z]*` 改为 `[a-z]*` 或去掉 → `tar cfvP …` 变红；旧式操作数前缀改为 `[a-eg-z]*` → `tar Jcf …` 变红。
  22. 两个正则中任一 `\s` 改为空格、`\s+` 改为 `\s`、`\s*` 改为 `\s?` → 对应空白行变红。
  23. `tarArguments` 只取最后一段 → `tar -cf prot/a.tar x && ls` 变红。
  24. 去掉子段（不按 `(`、反引号再切）→ 两条子段行变红。
- `pnpm run check`、`pnpm run build`、`pnpm run test-guardrails` 绿。
- live `pnpm run raw-guard:probes` 两次 T1–T5 PASS、md5 不变。

Non-goals:
- raw 作为打包源判写（issue 备选方案，需 PI 决定，不取）。
- 符号链接归档路径、`TAPE`、默认设备、多参数旧式簇。
- pax/cpio/zip 等其他归档工具。
- 完整 shell 词法解析。
