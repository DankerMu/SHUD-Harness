# Design

Change surface: `packages/dsh-shud-raw-guard/src/decide.ts`。

新增：
- 模块常量 `RAW_ANCESTOR_LEVELS`；
- 祖先前后边界常量 `ANCESTOR_BEFORE` / `ANCESTOR_AFTER`；
- 切换目录操作数剥离正则 `CHDIR_OPERAND`；
- 破坏性动词正则 `ANCESTOR_DESTRUCTIVE` / `PWSH_ANCESTOR_DESTRUCTIVE`；
- 专用决策 `ANCESTOR_DENY`（`code: "raw-ancestor-write"`）；
- 未导出辅助函数 `rawAncestors`；
- `decideRawAccess` shell 分支：在原有 rawDirs 循环之后加第二遍祖先判定。

不改：
- `texts` 构造，沿用 #255/#260/#263 的全部候选副本；
- mention 正则与 raw 侧文本；
- `WRITE_VERBS`、`PWSH_WRITES`、`DISCARD_REDIRECT`；
- workdir 包含判定；
- 文件工具分支；
- 导出。

PI 决策（#273 评论，2026-10-21）：
1. 改代码。
2. 只读祖先放行。
3. 祖先只查 3 级。
4. 只有破坏性动词才触发祖先规则（PR #278 第 1 轮审查后补充）。

Must preserve:
- `decide.test.ts` 现有全部行逐行结果不变，包括 #245 边界表、#247 拼写表、#248 丢弃表、#255 fd 表、#260 quote split 表、#263 parent fold 表、兄弟路径行与大小写行。
- 第一遍循环（mention / workdir → `DENY`/`ASK`）的行为与顺序不变，包括多个 raw 时以第一个命中者为准。
- 祖先判定只在第一遍没有任何 raw 命中时进行，结果只会从 next 收紧到 deny。
- 探针 T1–T5 判定不变。
- 只读祖先仍为 next。

Must add/change:
- 常量与辅助函数，注释风格同文件内其他常量：
  ```ts
  // #273 (PI 2026-10-21): a destructive command naming a strict ancestor of a raw dir,
  // up to three levels (parent, grandparent, great-grandparent), is denied. Other
  // writes (redirects, cp, mkdir, heredocs, interpreter one-liners) and reads pass
  // through, so a script mentioning the word data is not blocked.
  const RAW_ANCESTOR_LEVELS = 3;
  // Verbs that remove, move or re-permission a whole directory tree (same anchors as
  // WRITE_VERBS); pwsh adds its cmdlets and aliases.
  const ANCESTOR_DESTRUCTIVE =
    /(?<![A-Za-z0-9_.-])(rm|rmdir|unlink|mv|chmod|chown|chgrp|shred|rsync)(?=$|[\s;&|)}'"`])|(^|\s)(-delete|--remove-files)(?=$|[\s;&|)}'"`])|(?<![A-Za-z0-9_.-])git\s+clean(?=$|[\s;&|)}'"`])/i;
  const PWSH_ANCESTOR_DESTRUCTIVE =
    /(?<![A-Za-z0-9_.-])(Remove-Item|Move-Item|Rename-Item|del|erase|ri|rd|ren|rni|move|mi)(?=$|[\s;&|)}'"`])/i;
  // Ancestor text stands alone: before it, start or a shell boundary (optionally ./);
  // after it, end, a boundary, a glob, a brace, or / followed by those (data/, data/*,
  // data/{raw,x}), never / plus a name (data/derived).
  const ANCESTOR_BEFORE = String.raw`(?<![^\s;&|()<>'"\`=:,{])(?:\./)*`;
  const ANCESTOR_AFTER = String.raw`(?=$|[\s;&|()<>'"\`,{}*?[\]]|/(?=$|[\s;&|()<>'"\`,{}*?[\]]))`;
  const CHDIR_OPERAND = /(^|[\s;&|(`{])(?:cd|pushd|set-location|push-location|sl)(?:\s+-[^\s;&|()<>]*)*\s+[^\s;&|()<>]+/gi;
  const ANCESTOR_DENY: RawGuardDecision = {
    kind: "deny",
    code: "raw-ancestor-write",
    reason:
      "Raw data is immutable: this command deletes, moves or re-permissions while naming a directory that contains raw data. Target an explicit path inside that directory, or split the command so the destructive part does not name it.",
  };
  // Strict ancestors, nearest first; "/" and spellings ending in . or .. are not.
  function rawAncestors(path: string): string[] { /* 与 r2 版相同 */ }
  ```
  `ANCESTOR_BEFORE` 加入了 `:`，用于 pwsh 的 `-Path:sub`、`-LiteralPath:sub`。
- 第二遍祖先判定：原循环结束、尚未返回时进行。原循环中的 `continue` 分支恢复为单行 `continue`。
  ```ts
  // Second pass, only when no raw dir is touched: a destructive verb naming an ancestor.
  if (ANCESTOR_DESTRUCTIVE.test(command) || (pwsh && PWSH_ANCESTOR_DESTRUCTIVE.test(command))) {
    const unchdired = texts.map((text) => text.replace(CHDIR_OPERAND, "$1"));
    for (const raw of options.rawDirs) {
      const root = canonical(raw, cwd);
      const flags = caseInsensitiveRoot(root) ? "i" : "";
      const spelled = normalizeCommandPaths(raw);
      const ancestors = new Set([
        ...rawAncestors(spelled),
        ...rawAncestors(root),
        ...rawAncestors(resolve(cwd, spelled)),
      ]);
      if ([...ancestors].some(/* ANCESTOR_BEFORE + escaped + ANCESTOR_AFTER，任一 unchdired 候选 */)) return ANCESTOR_DENY;
    }
  }
  ```
  - 祖先有三个来源：配置原文（规范化后）、规范根（realpath）、字面绝对路径 `resolve(cwd, 配置原文)`（realpath 之前的拼写）。最后一个来源让 cwd 经符号链接到达时，模型照 cwd 拼出的绝对路径也能命中。三个来源合并去重，每个来源至多 3 级。
  - 破坏性动词只在原命令 `command` 上判定。动词被引号或转义拆开的写法（如 `r"m"`）另由 #279 处理，本 change 不涉及。
  - 两遍判定保证：命令只要直接触及任一 raw，就按原有 `DENY`/`ASK` 返回，code 不会被祖先规则覆盖，结果与 rawDirs 的顺序无关。
- 测试：`decide.test.ts` 的 `ancestorCases` 表断言 `kind`；deny 行还要断言 `reason` 匹配 `/immutable/`、`code` 为 `raw-ancestor-write`。
  - 测试目录：workspace `W` 取 realpath 后的 mkdtemp 之下两层，内建 `sub/raw/`、`sub/rawx/`、`sub/derived/`、`a/b/c/d/raw/`；另在 mkdtemp 下建符号链接 `alias` → `W`。
  - deny（`rawDirs: ["sub/raw"]`）：
    - bash：`rm -rf sub`、`rm -rf sub/`、`rm -rf ./sub`、`rm -rf sub/*`、`rm -rf {sub,x}`、`rm -rf "sub"`、`mv sub x`、`chmod -R 000 sub`、`rm -rf sub/rawx/..`、`rm -rf sub/.`、`rmdir sub`、`find sub -delete`、`git clean -fdx sub`、`rsync -a --delete x/ sub/`、`tar --remove-files -cf o.tar sub`。
    - pwsh：`Remove-Item -Recurse sub`、`Remove-Item -Recurse .\sub`、`Remove-Item -Recurse -Path:sub`、`Move-Item sub x`。
    - 绝对路径：`rm -rf ${W}/sub`、`rm -rf ${W}`、`rm -rf ${dirname(W)}`。
    - 字面 cwd 拼写：以 `cwd = <alias>` 调用，`rm -rf <alias>/sub`。
  - deny（默认配置）：`rm -rf <rawParent>`。
  - deny（`rawDirs: ["a/b/c/d/raw"]`）：`rm -rf a/b/c/d`、`rm -rf a/b`。
  - 边界字符 deny：
    - 分隔符与引号：`(rm -rf sub)`、`rm -rf sub;ls`、`rm -rf sub&&ls`、`rm -rf sub|cat`、`` `rm -rf sub` ``、`rm -rf sub>x`、`mv x --target-directory=sub`。
    - glob 与 brace：`rm -rf sub/?aw`、`rm -rf sub/[r]aw`、`rm -rf {x,sub}`、`rm -rf sub*`、`rm -rf sub/{raw,x}`、`rm -rf sub{,x}`。
    - 命令替换：`rm -rf $(true)sub`、`` rm -rf `true`sub ``。
  - 补钉住（review round 2）deny：`rm -rf sub/ x`、`rm -rf sub/&&ls`（`/` 后接空白或分隔符）；`chown -R 0 sub`、`chgrp -R 0 sub`、`unlink sub`、`shred sub`（其余 POSIX 动词）；pwsh `ri -r sub`、`del -Recurse sub`、`Rename-Item sub x`（pwsh 别名与 Rename-Item）；bash `pwsh -c "Remove-Item -Recurse sub"`（pwsh 包裹）；`runIf(caseInsensitive)` 下 `RM -rf sub`（动词大小写）。
  - 复合命令（已接受误报，deny）：默认配置 `ls <父> && rm -f tmp.csv`。
  - 切换目录 deny：`cd -P&&rm -rf sub`、pwsh `Set-Location -Path:x;Remove-Item -Recurse sub`、`cd ${W} && rm -rf sub`、`mv abcd sub`（`abcd` 不得被当作 `cd` 剥离）。
  - 大小写 deny（`test.runIf(caseInsensitive)`）：`rm -rf SUB`。
  - 多 raw：`rawDirs` 为 `["sub/raw", "protected"]` 与 `["protected", "sub/raw"]` 两种顺序下，`rm -rf sub protected/x` 都为 `deny`、`code` 为 `raw-immutable`；`ls sub && cat protected/x` 为 ask。
  - 已接受误报（deny）：`mv x.csv sub`（移入祖先）、`chmod -R g+w sub`。
  - 非破坏性写入 next（PI 补充决策）：
    - 默认配置，用 `rawParent` 拼接：`ls <父>`、`grep -r foo <父>`、`ls <父> > files.txt`、`mkdir -p <父>`、`cp out.csv <父>/`、`tar -xf a.tar -C <父>`；
    - heredoc：`cat > scripts/a.py <<'EOF'` 后接一行 `<父> = 1`，再接 `EOF`；
    - 解释器与文本：`python -c "<父> = 1" > out.log`、`Rscript -e '<父> <- 1'`、`echo 'load <父>' >> notes.md`、`grep -rn <父> src > hits.txt`；
    - stand-in：`ls sub > out.txt`、`cp out.csv sub/`。
  - 切换目录 next：`cd sub && rm -rf derived`、`cd ${W} && python run.py > log.txt`、pwsh `Set-Location sub; Remove-Item -Recurse derived`。
  - 只读 next：`ls sub`、`grep -r foo sub`、`du -sh sub`、`ls sub 2>/dev/null`。
  - 反例 next：`rm -rf sub/derived`、`rm sub/rawx/y`、`rm -rf subx`、`rm -rf mysub`、`rm -rf other/sub`、`rm -rf sub.bak`、`echo ok > sub/derived.txt`、`rm -rf other:subx`。
  - 级数上限 next：`rm -rf ${dirname(dirname(W))}`、`rm -rf a`。
  - `..` 结尾排除 next：`rawDirs: ["../outside/raw"]` 下 `mv out.csv ..`。
  - 已记录漏报 next：`rm -rf .`、`rm -rf *`、`cd sub && rm -rf raw`；`workdir: "sub"` 下 `rm -rf raw`；`rm -rf sub/r*`；默认配置 `python -c "import shutil; shutil.rmtree('<父>')"`。
  - 资源（走到祖先分支）：`"rm -rf" + " sub/".repeat(2e5)` → deny；`"rm -f x " + "./".repeat(5e5) + "subx"` → next（含破坏性动词，进入第二遍）。均在默认超时内完成。

Governing invariant:
- 祖先判定只在没有任何 raw 被直接触及、且命令含破坏性动词时进行，结果只会从 next 收紧到 deny。
- 点名祖先要求严格边界：左边界成立，且不得以 `/` 加普通路径名结尾。
- 切换目录的操作数不算点名。

Sibling surfaces:
- 文件工具分支不改。
- `WRITE_VERBS` 动词被引号拆开、tar 解包选项位置等问题由 #279 处理。
- 配置原文带前导 `./` 的问题由 #277 处理。
- `scripts/guardrails/no-bypass.sh` 不在本 change 范围。
- 探针 T1–T5 由 live 两次运行确认。
- `lib/decide.js` 由 build 生成。

Seams under test: `decideRawAccess(call, options)`（vitest）；live 探针 T1–T5。

Required evidence:
- 新增 deny 行在改动前的 `decide.ts`（origin/main）上为红（next），改后为绿；next 行与多 raw 行改动前后都为绿；既有行不变。
- 突变：
  1. 去掉第二遍祖先判定 → 全部祖先 deny 行变红。
  2. `ANCESTOR_BEFORE` 置空 → `rm -rf mysub`、`rm -rf other/sub` 变红；只去掉 lookbehind 而保留 `(?:\./)*` 时，`./` 对抗行退化为平方复杂度，测试以超时失败（去掉该行后上述两行变红）。
  3. 右边界允许 `/` 加普通路径名 → `rm -rf sub/derived` 变红。
  4. 右边界不接受 `/` 后跟行尾或 glob → `rm -rf sub/`、`rm -rf sub/*` 变红。
  5. `RAW_ANCESTOR_LEVELS = 4` → `rm -rf a` 与第 4 级绝对路径行变红。
  6. `RAW_ANCESTOR_LEVELS = 2` → `rm -rf a/b` 与 `rm -rf ${dirname(W)}` 变红。
  7. 只读祖先改为 ASK（无破坏性动词时返回 ASK）→ 只读行与非破坏性写入行变红。
  8. 只取配置原文的祖先 → 三条绝对路径 deny 行与 alias 行变红。
  9. 只取规范根的祖先 → 相对路径 deny 行与 alias 行变红。
  10. 不排除以 `.`/`..` 结尾的祖先 → `mv out.csv ..` 变红。
  11. 只匹配原命令（不用 `texts` 副本）→ `rm -rf sub/rawx/..`、pwsh `.\sub`、`rm -rf sub/.` 变红。
  12. 祖先判定改用 `WRITE_VERBS`/`PWSH_WRITES`（任意写都算）→ 非破坏性写入 next 行变红。
  13. 祖先正则不带大小写 `flags` → `rm -rf SUB` 变红（仅限大小写不敏感文件系统）。
  14. 祖先判定并回第一遍循环（单遍、按 rawDirs 顺序返回）→ 多 raw 两种顺序的 `code` 断言变红。
  15. `ANCESTOR_AFTER` 收窄：
      - 第一个字符类去掉 `*?[]` → `rm -rf sub*` 变红；
      - 第一个字符类去掉 `{` → `rm -rf sub{,x}` 变红；
      - `/` 之后的字符类去掉 `{` → `rm -rf sub/{raw,x}` 变红。
  16. 不剥离切换目录操作数 → 切换目录 next 行变红。
  17. 祖先写入改用通用 `DENY` → 祖先 deny 行的 `code` 断言变红。
  18. 切换目录选项子模式改用 `-\S*` → `cd -P&&rm -rf sub` 与 pwsh `Set-Location -Path:x;…` 行变红。
  19. 不取字面 cwd 拼写的祖先 → alias 行变红。
  20. `ANCESTOR_BEFORE` 收窄：
      - 去掉 `:` → pwsh `-Path:sub` 行变红；
      - 去掉 `)` 与反引号 → `$(true)sub`、`` `true`sub `` 行变红。
  21. 破坏性动词表收窄：
      - 去掉 pwsh 部分 → pwsh `Remove-Item`/`Move-Item` 行变红；
      - 去掉 `-delete|--remove-files` → `find sub -delete`、`tar --remove-files` 行变红；
      - 去掉 `git clean` → 该行变红。
  22. `CHDIR_OPERAND` 左边界允许字母 → `mv abcd sub` 变红。
  23. `ANCESTOR_AFTER` 中 `/` 之后的字符类去掉 `\s` → `rm -rf sub/ x` 变红。
  24. `ANCESTOR_AFTER` 中 `/` 之后的字符类去掉 `;&|()<>` → `rm -rf sub/&&ls` 变红。
  25. POSIX 破坏性动词表分别去掉 `chown`、`chgrp`、`unlink`、`shred` → 对应行变红。
  26. pwsh 破坏性动词表只保留 `Remove-Item|Move-Item` → `ri -r sub`、`del -Recurse sub`、`Rename-Item sub x` 变红。
  27. pwsh 破坏性动词只对 `call.name === "pwsh"` 生效 → bash `pwsh -c "Remove-Item -Recurse sub"` 变红。
  28. 破坏性动词正则去掉 `/i` → `RM -rf sub` 变红（只在大小写不敏感文件系统上）。
- `pnpm vitest run packages/dsh-shud-raw-guard` 全绿；`pnpm run check` exit 0，覆盖率不降；`pnpm run build`；`pnpm run test-guardrails`。
- live `pnpm run raw-guard:probes`（编排方）运行两次：T1–T5 PASS（INCONCLUSIVE 则重跑），md5 不变。

Non-goals:
- 第 4 级及以上的祖先。
- 隐式写法：`rm -rf .`、`rm -rf *`、workdir 或 `cd` 位于祖先时以相对名写入。
- `~` 与变量展开。
- 非破坏性写入（重定向、`cp`、`tar -x`、`tee`、`mkdir`）对祖先内文件的覆盖。
- 解释器一行程序删除祖先，如 `python -c "shutil.rmtree('data')"`。
- 按参数位置区分实际删的是哪个路径：整条命令只要含破坏性动词即判定，含复合命令（`ls data && rm -f tmp.csv`）。
- 动词被引号拆开（#279）。
- 前导 `./` 配置（#277）。
- 文件工具分支；`WRITE_VERBS` 常量本身。
