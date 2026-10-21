# Design

Change surface: `packages/dsh-shud-raw-guard/src/decide.ts` 的 shell 分支（`decideRawAccess` `:98-111`）：新增一个丢弃型重定向常量，`WRITE_VERBS.test(...)` 的输入改为剥除后的文本。`WRITE_VERBS`、`PWSH_WRITES`、`PWSH_COMMAND`、`canonical`、`contains`、mention 判定不改。

Must preserve:
- `decide.test.ts` 现有全部用例（含 PR #246 的 glob/前缀动词/pwsh/GNU 前缀行）逐行结果不变。
- 探针 T3 `echo bad >> data/raw/obs.csv`（默认 `rawDirs`）→ `deny`；T2 `cat data/raw/obs.csv` → `ask`；T4/T5 不触及 raw-guard 判定。
- `DENY`/`ASK`/`NEXT` 对象与 `RAW_READ_PROVENANCE_REASON` 导出不变（探针 judge 导入它）。
- "raw 仅作为源、重定向到真实文件"仍 deny（`cat <raw>/x | sort > out.txt`）。
- mention 判定使用原文：剥除只影响写动词判定，不影响"是否触及 raw"。

Must add/change:
- 常量：`const DISCARD_REDIRECT = /&?>{1,2}\s*\/dev\/null(?![A-Za-z0-9._\/-])/g;`——`>`、`>>`、`&>`、`&>>` 到 `/dev/null`（`N>`/`N>>` 只剥 `>` 起的部分，fd 数字留作孤立 token，不匹配任何写动词），目标后不是路径名字符或 `/`（`/dev/nullx`、`/dev/null/x`、`/dev/null.bak` 不剥）。正则 SHALL NOT 吞前导数字：`bzip2>/dev/null <raw>/x` 中 bash 运行的是 `bzip2`（压缩并删除 raw 文件），若剥掉 `2>/dev/null` 会留下 `bzip`，真写被判 `ask`（fixture review 发现）。
- 判定：`const checked = command.replace(DISCARD_REDIRECT, " ");` 然后 `WRITE_VERBS.test(checked) || (pwsh && PWSH_WRITES.test(command)) ? DENY : ASK`。用空格替换（不是空串），避免把两侧 token 粘成新词（`a>/dev/nullrm` 之类不可能，但 `x 2>/dev/null;rm` 剥后 `x 2 ;rm` 仍能命中 `rm`）。
- 测试（`decide.test.ts`，沿用 `test.each` 表）：
  - ask（`rawDirs: ["protected"]` 替身 + 默认 `data/raw` 各至少一行）：`head protected/obs.csv 2>/dev/null`、`ls protected >/dev/null`、`cat protected/x 2>/dev/null | wc -l`、`ls protected &>/dev/null`、`head protected/a 1>/dev/null 2>&1`、`head protected/a >>/dev/null`、`head protected/a 2> /dev/null`（空格）、`cat data/raw/obs.csv 2>/dev/null`。
  - deny：`echo bad >> protected/x`、`cat protected/x | sort > out.txt`、`cat protected/a 2>/dev/null > protected/b`、`head protected/a > /dev/nullx`、`head protected/a > /dev/null/x`、`head protected/a >/dev/null; rm protected/a`、`cat protected/a 2>/dev/null | tee protected/b`、`bzip2>/dev/null protected/x`（命令名末位数字不被剥除）、默认配置 `echo bad >> data/raw/obs.csv`。
  - 对照：`head protected/obs.csv 2>&1` → ask（现状）。
  - 每行 `reason`：ask 行为 `RAW_READ_PROVENANCE_REASON`，deny 行含 `immutable`。
- 规范：Requirement "Shell write under raw is denied" 的 `>`/`>>` 重定向条目改为 "`>`/`>>` 重定向（目标为 `/dev/null` 的丢弃型重定向 `>`、`>>`、`N>`、`N>>`、`&>`、`&>>` 除外：它们不写任何文件，剥除后再看其余写动词；`/dev/nullx`、`/dev/null/x` 不是 `/dev/null`）"；末句 "raw 仅作为源的 `cp`/重定向也 deny" 加 "（指写到真实文件的重定向）"。新增场景 "discarding redirect keeps a read an ask" 与 "discarding redirect does not mask a real write"。

Governing invariant: 只有写到 `/dev/null` 的重定向可以从写动词判定中剥除；剥除后文本中的任何写动词或非 `/dev/null` 重定向仍 deny；触及 raw 的判定不因剥除而改变。

Sibling surfaces:
- `PWSH_WRITES`：pwsh 的 `> $null`/`Out-Null` 不在本 change（Non-goal，未观测到）。
- 探针 `scripts/runtime/raw-guard-probes.sh` T3 谓词依赖 deny 结果含 `immutable`——不变。
- `openspec/specs/raw-data-guard/spec.md` 其余 Requirement 不改。
- 构建产物 `lib/decide.js` 由 `pnpm run build` 生成，profile 以 `link:` 装入，`profile:smoke`/probes 都走它。

Seams under test: `decideRawAccess(call, options)` 纯函数（vitest）；live 探针 T2/T3。

Required evidence:
- 新增 ask 行在改动前的 `decide.ts` 上失败（红）、改后全绿；新增 deny 行改前改后都绿（它们钉住"不过宽"）；现有行不变。
- `pnpm vitest run packages/dsh-shud-raw-guard/src/decide.test.ts` 全绿；`pnpm run check` exit 0（覆盖率 ≥80%）。
- `pnpm run build` 后 `pnpm run raw-guard:probes` T1–T5 PASS（或 INCONCLUSIVE 重跑）、md5 不变。

Non-goals: `>&word` 文件重定向（bash 中等价于 `&>word`、会写文件，现被通用子式的 `[^&]` 放过而判 `ask`；本 change 不改通用子式，另立 #255 跟踪；剥除后 `cat <raw>/a 2>/dev/null >&<raw>/b` 也随之由 deny 变 ask，与独立的 `>&<raw>/b` 现状同为 ask，不新增绕过，同归 #255）；pwsh `> $null`/`Out-Null`；`/dev/stdout`、`/dev/stderr`、`/dev/zero` 等其它设备文件；raw 作为源重定向到 workspace 文件的 deny 方向误报（spec 接受）；路径写法规范化（#247）；shell 语法解析。

Review focus:
1. `DISCARD_REDIRECT` 不吞前导数字（`bzip2>/dev/null` 仍 deny）；不会剥掉 `/dev/nullx`、`/dev/null/x`、`/dev/null.bak`；不会剥掉 `2>&1`、`>&2`。
2. 剥除后 `cat <raw>/a 2>/dev/null > <raw>/b` 的第二个 `>` 仍被 `(^|[^<])>{1,2}\s*[^&]` 命中。
3. mention 判定与 `PWSH_WRITES` 仍用原文，`checked` 只喂 `WRITE_VERBS`。
4. 替换为空格而非空串；`g` 标志的 `RegExp.lastIndex` 在 `replace` 下无状态泄漏（`test` 不能用于 `g` 正则——确认代码没对 `DISCARD_REDIRECT` 调 `test`）。
5. 新增 ask 行确有红→绿证据；默认 `data/raw` 的 T3 形态有 deny 行。
