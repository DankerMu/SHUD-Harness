# Spec Delta

## MODIFIED Requirements

### Requirement: Governance roots are write-protected from model file and shell tools
raw-guard SHALL 把会话 cwd 下一组固定、不可配置的治理根视为模型文件/shell 工具的写保护目标：`tasks`、`stacks`、`provenance`、`reports`、`runs`、`changes`、`patches`、`verifications`、`builds`、`analyses`（共十个，相对调用 session cwd 解析；不经 rawDirs 或任何 profile/运行时配置增删）。`repos/` 不在集合内：coder 必须经 `edit`/`bash` 修改 `repos/SHUD`。治理对象只能经对应工具写入：`task_create`、`analysis_create`、`shud_run`、`change_create`、`change_submit`、`shud_build`、`verification_run`、`report_generate`/`report_validate`/`report_submit`/`report_decide`；`analyses` 下的 AnalysisPlan 只由 `analysis_create` 写入，创建后任何工具都不改写（见 analysis-plans「AnalysisPlan workspace file」）；本要求不改变这些工具自身的判定。

文件工具：`write`、`edit`（参数 `file_path`）以及 `str_replace_editor` 的非 `view` 命令（参数 `path`），目标等于或位于任一治理根内时 SHALL 返回 `deny`，`code` 为 `governance-immutable`，`reason` 含 `immutable` 并说明治理对象只能经上列对应工具写入；SHALL NOT 提供审批路径。路径身份与 raw 相同：文件工具相对路径按 session cwd 解析；额外的 `workdir` 参数不改变目标（钉版宿主文件工具不消费该参数）。复用 realpath/最近存在祖先、物理别名（符号链接与本机大小写别名）与路径包含规则；兄弟前缀（如 `tasks-old`、`changes.bak`、`analyses-old`）SHALL NOT 视为同一根。`str_replace_editor` 的 `view` 命令与 `read` 工具 SHALL 委托下一个监听器（治理文件不是敏感数据，读取不 ask）。

shell 工具：对 `bash`（含 persistent 变体）与 `pwsh`，"触及治理根" SHALL 复用「Shell command touches raw」的全部规则，把每个治理根当作一个配置项（配置原文为根名、解析后绝对路径为 session cwd 下该根的 canonical 路径），即字面文本与解析后绝对路径的边界匹配、路径等价规范化、去引号/续行副本、pwsh `\` 语境、`..` 词法折叠、本机大小写不敏感判定，以及有效工作目录 `realpath(workdir ?? session cwd)` 位于治理根内。触及任一治理根且按「Shell write under raw is denied」的写 denylist（写动词、工具形态含 `python -c` 等解释器一行程序、`>`/`>>` 等重定向、tar 解包与写归档规则、pwsh cmdlet，以及同样的 `/dev/null` 丢弃型重定向剥除）判为写时 SHALL 返回 `deny`，`code` 为 `governance-immutable`，`reason` 同文件工具；只读触及（无写判定）SHALL 委托下一个监听器恰好一次，SHALL NOT ask。根名作为普通词出现在写命令中（如 `grep -rn runs src > out.txt`）也判 `deny`，属已接受的 deny 方向误报；「Shell command touches raw」所列漏报（persistent `cd` 后相对写入、短于根名的 glob 前缀、名字中段的 glob/brace、经符号链接或前导 `..` 的回溯、ANSI-C 引号等）同样适用于治理根，且「Shell write to a raw ancestor is denied」的祖先规则 SHALL NOT 扩展到治理根（如 `rm -rf .`、`rm -rf *` 不经本要求识别）。治理根位于 workspace 内、没有沙箱兜底，这些漏报是登记于 M4 change（`openspec/changes/archive/2026-11-05-m4-mvp-2/design.md`）D15 的残余风险。

判定与角色无关：coordinator、worker、coder、reviewer 与 unknown 一律适用；`sandbox_permissions` 等额外参数 SHALL NOT 改变判定。raw 判定优先：同一调用中 raw-guard 的既有判定（「File mutation under raw is denied」「Shell command touches raw」「Shell write under raw is denied」「Shell write to a raw ancestor is denied」）给出 `deny` 或 `ask` 时 SHALL 以其结果为准，既有 `code`（如 `raw-immutable`、`raw-ancestor-write`）与审批路径不变；只有既有判定会委托下一个监听器时才按本要求判定治理根。未命中本要求时 SHALL 委托下一个监听器恰好一次，SHALL NOT 返回 `{kind: "allow"}`。参数缺失或类型不符时不抛错，缺失即视为不触及。每条 deny 照常经「Decision audit」记录为 `deny <tool id> governance-immutable`，不含路径或参数。

#### Scenario: coder edit into a change request is denied
- **WHEN** 当前 preset 投影为 coder 的 Agent 调用 `edit`，`file_path` 为 `changes/<change_id>.json`（文件存在）或 `changes/new.json`（文件不存在）
- **THEN** 决策 `kind` 为 `deny`，`code` 为 `governance-immutable`，`reason` 含 `immutable` 与 `change_create`；文件字节不变，不发起审批卡；logger 收到以 `deny edit governance-immutable` 开头且不含该路径的一行

#### Scenario: shell redirect into a governance root is denied
- **WHEN** coder 调用 `bash`，`command` 为 `cat > changes/x.json <<'J'` 接 heredoc 内容，或 `echo {} > ./changes//x.json`，或 `workdir` 为 `changes` 时 `command` 为 `echo {} > x.json`
- **THEN** 三次决策 `kind` 均为 `deny`，`code` 为 `governance-immutable`，`next()` 未被调用

#### Scenario: interpreter one-liner writing a task card is denied
- **WHEN** coder 调用 `bash`，`command` 为 `python -c "open('tasks/TASK-20261102T090000-1a2b/task.json','w').write('{}')"`
- **THEN** 决策 `kind` 为 `deny`，`code` 为 `governance-immutable`，TaskCard 字节不变

#### Scenario: read-only touch of a governance root passes
- **WHEN** coder 调用 `bash`，`command` 为 `cat changes/x.json` 或 `ls builds`；或调用 `str_replace_editor` 的 `view` 命令、`read` 工具读取 `changes/x.json`
- **THEN** 不作判定，`next()` 被调用恰好一次并返回其结果，不发起审批卡

#### Scenario: source checkout edits pass
- **WHEN** coder 调用 `edit`，`file_path` 为 `repos/SHUD/src/Model/MD_rhs_core.cpp`；或调用 `bash`，`command` 为 `sed -i 's/a/b/' repos/SHUD/Makefile`
- **THEN** 不作判定，`next()` 被调用恰好一次并返回其结果

#### Scenario: protection is role independent
- **WHEN** 当前 preset 投影为 worker、reviewer、coordinator 或缺 preset 投影（unknown）的调用触发 raw-guard，工具为 `write`，`file_path` 为 `verifications/x.json`，或工具为 `bash`，`command` 为 `rm -rf builds/BUILD-20261102T100000-7b2d`（不论该工具是否在该角色工具面内）
- **THEN** raw-guard 决策 `kind` 均为 `deny`，`code` 为 `governance-immutable`

#### Scenario: sandbox permissions do not change the decision
- **WHEN** coder 调用 `write`，`file_path` 为 `reports/r.md`，`arguments` 另含 `sandbox_permissions`；或调用 `bash`，`command` 为 `touch runs/x`，同样附带 `sandbox_permissions`
- **THEN** 决策 `kind` 为 `deny`，`code` 为 `governance-immutable`

#### Scenario: physical aliases and sibling prefixes
- **WHEN** `alias` 是指向 `changes` 的符号链接，coder 调用 `write`，`file_path` 为 `alias/x.json`；在大小写不敏感文件系统上 `file_path` 为 `CHANGES/x.json`；另以 `file_path` 为 `changes-old/x.json` 或 `tasks.bak`
- **THEN** 前两者决策为 `deny`（`governance-immutable`）；后两者不作判定，返回 `next()` 的结果

#### Scenario: raw judgment takes precedence
- **WHEN** rawDirs 为 `changes`，coder 调用 `write`，`file_path` 为 `changes/x.json`；或默认 rawDirs 下调用 `bash`，`command` 为 `cat data/raw/obs.csv > tasks/x`；或 `command` 为 `cat data/raw/obs.csv; ls tasks`
- **THEN** 前两者决策为 `deny`，`code` 为 `raw-immutable`（不是 `governance-immutable`）；第三者按 raw 判定为 `ask`，不因治理根改为 `deny` 或委托

#### Scenario: unsupported file workdir cannot redirect the guard
- **WHEN** 调用 `write` 或 `edit`，`file_path` 为 `changes/x.json` 且额外 `workdir` 为 `repos/SHUD`；另一次调用 `file_path` 为 `repos/SHUD/x` 且额外 `workdir` 为 `changes`
- **THEN** 第一项 deny `governance-immutable`，第二项返回下一个监听器的结果；两者均按 session cwd 解析真实文件目标。shell 的有效 workdir 规则不变

#### Scenario: unrelated tools do not enter file or shell argument classification
- **WHEN** a raw-specific decision returns NEXT for a tool other than write, edit, str_replace_editor, bash or pwsh, or such a tool reaches generic raw fallback
- **THEN** the shared file/shell classifier returns NEXT without reading that call envelope's arguments; the specialized raw decision remains authoritative and all supported file/shell protections are unchanged

#### Scenario: model writes into analyses are denied
- **WHEN** coordinator 调用 `write`，`file_path` 为 `analyses/PLAN-20261108T093000-5c1e.json`（文件存在）或 `analyses/new.json`（文件不存在）；worker 调用 `bash`，`command` 为 `sed -i 's/2/3/' analyses/PLAN-20261108T093000-5c1e.json` 或 `echo {} > analyses/x.json`
- **THEN** 四次决策 `kind` 均为 `deny`，`code` 为 `governance-immutable`，`reason` 含 `immutable` 与 `analysis_create`；plan 文件字节不变，不发起审批卡；logger 收到的行不含该路径

#### Scenario: read-only touch of analyses passes
- **WHEN** coder 调用 `bash`，`command` 为 `cat analyses/PLAN-20261108T093000-5c1e.json` 或 `ls analyses`；或调用 `read` 读取该文件
- **THEN** 不作判定，`next()` 被调用恰好一次并返回其结果，不发起审批卡

#### Scenario: analyses aliases and sibling prefixes
- **WHEN** `alias` 是指向 `analyses` 的符号链接，调用 `write`，`file_path` 为 `alias/x.json`；在大小写不敏感文件系统上 `file_path` 为 `ANALYSES/x.json`；另以 `file_path` 为 `analyses-old/x.json`
- **THEN** 前两者决策为 `deny`（`governance-immutable`）；后者不作判定，返回 `next()` 的结果

## ADDED Requirements

### Requirement: Off-role raw asks defer to the role surface
raw-guard 在按其它要求得到 `ask` 决策后、返回之前 SHALL 以与策略门相同的方式解析调用者角色（`presetIdToRole(readCallerPresetId(execution.agent))`）并以 core `isRoleToolIdAllowed` 判定该工具是否在角色工具面（`ROLE_TOOL_MAP` 的 `inherited ∪ local`）内。角色为 coordinator、worker、coder 或 reviewer 且工具不在其工具面内时 SHALL 改为委托下一个监听器恰好一次，SHALL NOT 返回 `ask`，并经 `ctx.logger('shud-raw-guard')` 输出一行 `next <tool id> role-deferred`（不含参数、路径或 raw 内容）；该次不计入 dispose 的 ask 计数。角色为 `unknown`，或工具在角色工具面内时，`ask` 决策、`reason`、`displayReason` 与计数不变。`deny` 决策（raw 写、raw 祖先写、治理根写及其它既有 deny）SHALL NOT 读取角色，照常最先返回。依据 [ADR-0016](../../../../../docs/adr/implemented/0016-role-deny-before-raw-ask.md)。

#### Scenario: off-role raw read defers to the role deny
- **WHEN** preset `worker` 以 raw 内 `input_dir` 调用 `analysis_create`
- **THEN** raw-guard 委托下一个监听器恰好一次且未返回 `ask`，logger 收到 `next analysis_create role-deferred`，dispose 的 `ask` 计数不增加

#### Scenario: off-role raw write is still denied first
- **WHEN** preset `coordinator`（工具面不含 `bash`）以 `bash` 向 raw 内写入
- **THEN** raw-guard 返回 `deny`（`raw-immutable`），不委托下一个监听器，审计行为 `deny bash raw-immutable`

#### Scenario: unknown role and on-role calls keep the provenance ask
- **WHEN** `role: "unknown"` 的 Agent 以 `bash` 读取 raw；preset `worker` 以 raw 内 `input_dir` 调用 `shud_run`
- **THEN** 两次决策 `kind` 均为 `ask`，`reason` 为 provenance 常量，均不输出 `role-deferred`

### Requirement: Analysis plan creation protects its fixed output root
`analysis_create` SHALL 在工具执行前经 raw-guard 判定，判定方式沿「Task creation protects its fixed output root」与「Change, build and verification tools protect their fixed output roots」：以调用 session cwd 解析，复用既有 realpath/最近存在祖先、物理别名（符号链接与本机大小写别名）与路径包含规则（目标已存在时使用其 realpath，不存在时以最近存在祖先的 realpath 拼接余段）。写入判定目标为：待分配 id 的写入根 `analyses`，以及经 core TaskId 校验的 `task_id` 的确切写入目标 `tasks/<task_id>/task.json`（`linked_analyses` 回写）；`task_id` 缺失、类型不符或未通过品牌校验时 SHALL NOT 用其拼接路径，改为只判定固定根 `tasks`，SHALL NOT 抛错，参数错误仍交由工具参数校验拒绝。任一写入判定目标等于或位于任一 raw 根之内（含 raw 根为其受保护祖先）时，SHALL 在工具执行前返回 `deny`，`code` 为 `raw-immutable`，`reason` 含 `immutable`，SHALL NOT 提供写审批路径，SHALL NOT 创建目录或写入、删除任何文件；目标不存在时也 SHALL 保护。raw 根仅覆盖 `analyses` 下的另一个 plan 或另一任务目录而不包含本次判定目标时 SHALL NOT 据此拒绝。

`analysis_create` 读取 `arguments.input_dir`（相对路径按 session cwd 解析，自身可为符号链接，按解析后目录判定）以校验 calib 乘积：写入判定目标均不受保护而 `input_dir` 等于或位于任一 raw 根之内时，SHALL 返回 `ask`，`reason` 为与「shud_run is guarded」相同的 provenance 文案常量，与 `shud_run` 的 raw 输入判定一致；`input_dir` 缺失或不是字符串时 SHALL 仍按上述写入目标判定，SHALL NOT 抛错。写入拒绝 SHALL 先于输入读取审批，不依赖 rawDirs 的顺序。判定 SHALL NOT 依赖 `parameter_sets`、`rationale_basis` 等参数中出现的路径文本，SHALL NOT 读取路径解析以外的任何文件（包括 TaskCard、AnalysisPlan 与输入文件的内容）。判定目标均不触及 raw 时 SHALL 委托下一个监听器恰好一次。每条决策照常经「Decision audit」记录。策略只由 raw-guard 拥有，不复制到工具或记录 writer；`shud_run` 读取 `analyses/<analysis_plan_id>.json` 是读取，不纳入 `shud_run` 的写入根，`shud_run` 的既有判定不变。

#### Scenario: analyses root configured as raw is immutable
- **WHEN** rawDirs 为相对 `analyses`，分别覆盖该根已存在与尚不存在的情形，经真实注册的 ToolRuntime 以合法参数调用 `analysis_create`
- **THEN** 返回 raw-immutable 拒绝，工具 execute 与 approval 均不发生，`analyses/`、`tasks/` 与 raw 快照不变，不分配 `analysis_plan_id`

#### Scenario: plan creation protects its exact task target
- **WHEN** rawDirs 覆盖 `tasks`、`tasks/<task_id>` 或 `tasks/<task_id>/task.json`，分别覆盖路径存在与不存在，以该合法 `task_id` 调用 `analysis_create`
- **THEN** 在执行与审批之前返回 raw-immutable 拒绝，不写 plan 或 TaskCard

#### Scenario: raw input asks with the provenance reason
- **WHEN** rawDirs 为 `prot`，`analyses` 与 `tasks` 均在 raw 之外，调用 `analysis_create`，`input_dir` 为 `prot/ccw` 或工作区内指向 `prot/ccw` 的符号链接
- **THEN** 决策 `kind` 为 `ask`，`reason` 等于 `shud_run` 使用的 provenance 常量；审批结果不是 `allowed-once` 时工具不执行，`analyses/` 与卡片不变

#### Scenario: write denial precedes raw input approval
- **WHEN** 一个 rawDir 覆盖 `input_dir`，另一个覆盖 `analyses`；或 `input_dir` 缺失、为数字
- **THEN** 只要写入目标受保护就 deny，不请求审批；rawDirs 顺序不改变结果；`input_dir` 参数错误不使判定抛错

#### Scenario: aliases retain containment and siblings do not
- **WHEN** session cwd 或 `analyses` 经符号链接或本机大小写别名指向配置的 raw 根或其内部；另以 rawDirs 为兄弟前缀目录 `analyses-input`
- **THEN** 前者使用同一 canonical 包含关系拒绝；后者不被当作同一写入根，调用继续到下一个监听器

#### Scenario: invalid task id falls back to the tasks root
- **WHEN** 以 `task_id: "TASK-0001"` 或 `arguments: null` 调用 `analysis_create`，rawDirs 为 `tasks`
- **THEN** 不拼接非法 id 路径、不抛错，按固定根 `tasks` 判定为 raw-immutable 拒绝；rawDirs 改为 `data/raw` 时委托下一个监听器，由工具参数校验拒绝

#### Scenario: disjoint plan creation continues
- **WHEN** rawDirs 为不与 `analyses`、`tasks/<task_id>/task.json` 或 `input_dir` 重叠的 `data/raw`，`rationale_basis` 含文本 `data/raw/x`，以合法参数调用 `analysis_create`
- **THEN** `next()` 被调用恰好一次并返回其结果，raw-guard 不新增审批，raw 内容不变
