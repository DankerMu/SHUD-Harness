# Proposal

## Why

#260：raw-guard shell 分支的「提及」判定是纯文本匹配（`packages/dsh-shud-raw-guard/src/decide.ts:138-147`，候选文本只有原命令与 `//`/`/.` 规范化后的命令）。shell 在词法阶段会把 `prot"ected"`、`prot'ected'`、`prot\ected` 拼成 raw 名，PowerShell 在 Unix 上把 `sub\x` 当作 `sub/x`；这些写法既不 deny 也不 ask，直接落 `next()`：写 raw 不被拒，读 raw 也不弹 provenance 审批卡。dev/probe 形态下 raw 在 workspace 内，沙箱不兜底。比 #255（落 ask）更严重。另外 `pwsh` 判定在 mention 之后才算（`:149`），pwsh 专属写法无法参与 mention。名字中段 glob（`p*d`、`protecte?`、`prot[e]cted`）同样落 next，但修它需要 glob 匹配或分词，属 #247 的 Non-goal「shell 语法解析」。属 Critical Paths #1/#2。

## What Changes

- `decide.ts` shell 分支：`pwsh` 判定（`call.name === "pwsh" || PWSH_COMMAND.test(command)`）移到 rawDirs 循环之前；候选文本由 `[command, normalize(command)]` 扩为：pwsh 语境下基底为 `[command, command 的 \ → /]`，否则为 `[command]`；对每个基底再加去掉 `"`、`'`、`\` 的副本；对上述每个再加 `normalizeCommandPaths` 副本。纯加法：只增加候选文本，不改匹配模式、raw 侧文本、写动词判定、workdir 判定。
- `decide.test.ts`：issue 验收表全部入表（deny/ask/next 钉住行与反例）。
- 顺手订正（PR #265 review 备注，同文件）：`decide.test.ts` fail-closed 注释块中「all of these name files」措辞不准（`` >&2` x` `` 在 `x` 不是命令时展开为 fd 复制），改为准确描述；只改注释，不改断言。
- 规范 `raw-data-guard` "Shell command touches raw"：加入去引号/转义与 pwsh `\` 分隔符两条触及条款、误报说明；已记录漏报从三处增为四处（名字中段 glob）；加三个场景。

## Triage

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent（issue-scribe，Readiness implementation-ready）；触发词：策略门决策与 raw 保护（Critical Paths #1/#2）、next→deny/ask 收紧
Blast radius: 去引号过宽 → 兄弟名误判为触及（deny/ask 方向，可接受，需写明并钉住）；bash 也做 `\`→`/` 会把 `subx` 误判为 `sub/x`（必须只在 pwsh 语境）；pwsh 判定前移不得改变非 pwsh 命令的写动词判定；探针 T1–T5 不含这些写法，必须不变
Selected risk packs: Public API / CLI / script entry; File IO / path safety; Auth / permissions / secrets; Legacy compatibility; Documentation / migration notes; Resource limits
Evidence floor: 新增 deny/ask 行先红后绿，next 钉住行与反例改前改后都绿；既有全部行不变；`pnpm run check`；`pnpm run raw-guard:probes` 两次 T1–T5 PASS、md5 不变

## Capabilities

### Modified Capabilities

- `raw-data-guard`: "Shell command touches raw"。

## Impact

- 代码：`packages/dsh-shud-raw-guard/src/decide.ts`（shell 分支约 3 行）、`decide.test.ts`。
- 规范：`openspec/specs/raw-data-guard/spec.md` 一条 Requirement。
- 运行时：`lib/decide.js` 由 `pnpm run build` 产出；探针不改。
