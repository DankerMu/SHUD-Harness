# Spec Delta

## ADDED Requirements

### Requirement: Change, build and verification tools protect their fixed output roots
`change_create`、`change_submit`、`shud_build`、`verification_run` SHALL 在工具执行前经 raw-guard 保护各自的判定目标，判定方式沿「Task creation protects its fixed output root」与「Report generation and validation protect write targets」：以调用 session cwd 解析，复用既有 realpath/最近存在祖先、物理别名（符号链接与本机大小写别名）与路径包含规则（目标已存在时使用其 realpath，不存在时以最近存在祖先的 realpath 拼接余段）。各工具的判定目标为：`change_create`——待分配 id 的 `changes`、`patches` 两个写入根，经 core TaskId 校验的 `task_id` 的确切写入目标 `tasks/<task_id>/task.json`，以及源检出根 `repos/SHUD`；`change_submit`——经 core ChangeId 校验的 `change_id` 的确切写入目标 `changes/<change_id>.json`；`shud_build`——待分配 id 的写入根 `builds`（构建只在 `builds/.tmp-<build_id>/` 内写文件，见 shud-build「shud_build」），以及源检出根 `repos/SHUD`；`verification_run`——待分配 id 的 `verifications` 写入根，以及经 core TaskId 校验的 `task_id` 的确切写入目标 `tasks/<task_id>/task.json`。`shud_build` SHALL NOT 向 `repos/SHUD` 写任何文件，`repos/SHUD` 不是它的写入根；`repos/SHUD` 对 `change_create` 与 `shud_build` 是判定目标的理由是：源检出是 code_change 工作流的修改对象（coder 在其中编辑、`change_create` 从中观测 diff、`shud_build` 从中归档构建），不能是 raw。`task_id` 或 `change_id` 缺失、类型不符或未通过品牌校验时，SHALL NOT 用其拼接路径，改按「Task creation protects its fixed output root」只判定对应的固定根（`tasks` 或 `changes`），SHALL NOT 抛错，参数错误仍交由工具参数校验拒绝。任一判定目标等于或位于任一 raw 根之内（含 raw 根为其受保护祖先）时，SHALL 在工具执行前返回 `deny`，`code` 为 `raw-immutable`，`reason` 含 `immutable`，SHALL NOT 提供写审批路径，SHALL NOT 创建目录或写入、删除任何文件；目标不存在时也 SHALL 保护。raw 根仅位于某个判定根之内而不包含本次判定目标时（如 raw 只覆盖另一任务的目录、另一 ChangeRequest 文件、`builds` 下的另一构建，或 `repos/SHUD` 内的某个子目录），SHALL NOT 据此拒绝：不因其它任务或其它对象被保护而误拒绝；`repos/SHUD` 内被 raw 覆盖的子路径仍由「File mutation under raw is denied」与「Shell write under raw is denied」保护。`task_create` 对 `type: code_change` 读取 `repos/SHUD` 的 `HEAD`（钉定 `source_base_commit`）是只读观测，raw-guard 对 `task_create` 的判定不变（仍只判定 `tasks` 根），SHALL NOT 因 `repos/SHUD` 位于 raw 内而拒绝 `task_create`；此时后续 `change_create` 与 `shud_build` 按本要求拒绝。判定 SHALL NOT 依赖参数中出现的路径文本，除用经品牌校验的 id 拼接确切目标外不使用参数，SHALL NOT 读取路径解析以外的任何文件（包括 ChangeRequest、BuildRecord、RunRecord 与 TaskCard 的内容）。raw-guard 位于 policy-gate 之前：`change_submit` 的写入目标受保护时 SHALL 先 deny，policy-gate 的高风险 `ask` 不发生，PI allowed-once SHALL NOT 授权 raw 写入。判定目标均不在 raw 内时 SHALL 委托下一个监听器恰好一次。每条决策照常经「Decision audit」记录。`shud_run` 的判定不变：提交引用 `build_id` 时 `builds` 是读取源，SHALL NOT 纳入 `shud_run` 的写入根。策略只由 raw-guard 拥有，不复制到工具或记录 writer；本要求不改变其它工具的既有判定。

#### Scenario: change outputs configured as raw are immutable
- **WHEN** rawDirs 分别为相对 `changes` 或 `patches`，覆盖该根已存在与尚不存在的情形，经真实注册的 ToolRuntime 以合法参数调用 `change_create`
- **THEN** 返回 raw-immutable 拒绝，工具 execute 与 approval 均不发生，`changes/`、`patches/`、`tasks/` 与 raw 快照不变，不分配 `change_id`

#### Scenario: change creation protects its exact task target
- **WHEN** rawDirs 覆盖 `tasks`、`tasks/<task_id>` 或 `tasks/<task_id>/task.json`，分别覆盖路径存在与不存在，以该合法 `task_id` 调用 `change_create`
- **THEN** 在执行与审批之前返回 raw-immutable 拒绝，不写 ChangeRequest、patch 或 TaskCard

#### Scenario: change submit write denial precedes approval
- **WHEN** rawDirs 覆盖 `changes`、`changes/<change_id>.json`，或经符号链接指向该文件的物理位置，以一个 `semantic_level: numerical_implementation` 的合法 `change_id` 调用 `change_submit`，approval 服务即使配置为 allowed-once
- **THEN** raw-immutable 拒绝，approval 不被调用、execute 不运行，ChangeRequest 字节与修改时间不变

#### Scenario: build roots configured as raw are immutable
- **WHEN** rawDirs 为 `builds`、`repos` 或 `repos/SHUD`，分别覆盖路径已存在与不存在的情形，调用 `shud_build`
- **THEN** 返回 raw-immutable 拒绝，不执行 `git archive` 与 `make`，不创建 `builds/` 下任何目录（含 `.tmp-*`），`repos/SHUD` 字节与修改时间不变

#### Scenario: source checkout configured as raw denies change creation
- **WHEN** rawDirs 为 `repos` 或 `repos/SHUD`（含经符号链接或本机大小写别名指向同一物理位置），以合法 `task_id` 调用 `change_create`，`changes`、`patches`、`tasks` 均不在 raw 内
- **THEN** 返回 raw-immutable 拒绝，工具 execute 不发生，不运行任何 git 命令，不写 `changes/`、`patches/`，TaskCard 字节不变

#### Scenario: code_change task creation is not judged by the checkout
- **WHEN** rawDirs 为 `repos/SHUD`，`tasks` 不在 raw 内，调用 `type: code_change` 的 `task_create`，随后以该卡调用 `change_create`
- **THEN** raw-guard 对 `task_create` 委托下一个监听器恰好一次（只读 HEAD 不经 raw-guard 判定）；对随后的 `change_create` 返回 raw-immutable 拒绝

#### Scenario: verification outputs configured as raw are immutable
- **WHEN** rawDirs 为 `verifications`，或覆盖本次合法 `task_id` 的 `tasks/<task_id>/task.json`（含其祖先），调用 `verification_run`
- **THEN** 返回 raw-immutable 拒绝，工具 execute 不发生，不写 VerificationCase，不改写 TaskCard

#### Scenario: unrelated protected objects do not deny
- **WHEN** rawDirs 只覆盖另一任务的 `tasks/<other_task_id>`、另一 ChangeRequest 的 `changes/<other_change_id>.json`、`builds/<other_build_id>` 或 `repos/SHUD/input/ccw`，本次调用的全部判定目标不在 raw 内，依次调用 `change_create`、`change_submit`、`shud_build`、`verification_run`
- **THEN** 均不被 raw-guard 拒绝，委托下一个监听器；`change_submit` 仍按 policy-gate 判定是否 ask

#### Scenario: physical aliases retain containment and sibling prefixes do not
- **WHEN** session cwd、`changes`、`builds` 或 `verifications` 经符号链接或本机大小写别名指向配置的 raw 根或其内部；另以 rawDirs 为兄弟前缀目录 `changes-input` 或 `builds-old`
- **THEN** 前者使用同一 canonical 包含关系拒绝；后者不被当作同一写入根，调用继续到下一个监听器

#### Scenario: invalid ids fall back to the fixed root
- **WHEN** 以 `task_id: "TASK-0001"` 调用 `verification_run`、以缺失 `change_id` 调用 `change_submit`，或 `arguments` 为 `null`；rawDirs 分别为 `tasks` 与 `changes`
- **THEN** 不拼接非法 id 路径、不抛错，按固定根 `tasks` 或 `changes` 判定为 raw-immutable 拒绝；rawDirs 改为 `data/raw` 时委托下一个监听器，由工具参数校验拒绝

#### Scenario: argument text does not affect the decision
- **WHEN** rawDirs 为 `data/raw`，`change_create` 的 `description` 含 `data/raw/x` 文本
- **THEN** 不因参数文本而拒绝，继续到下一个监听器

#### Scenario: disjoint tools continue
- **WHEN** rawDirs 为不与任何判定目标重叠的 `data/raw`，以合法参数依次调用四个工具
- **THEN** 每次调用 `next()` 恰好一次并返回其结果，raw-guard 不新增审批，raw 内容不变

#### Scenario: shud_run build source is not a write root
- **WHEN** rawDirs 为 `builds`，`input_dir` 与 `runs`、`stacks`、`provenance` 均在 raw 之外，以 `build_id` 调用 `shud_run`
- **THEN** raw-guard 不因 `builds` 拒绝或请求审批，委托下一个监听器

### Requirement: Governance roots are write-protected from model file and shell tools
raw-guard SHALL 把会话 cwd 下一组固定、不可配置的治理根视为模型文件/shell 工具的写保护目标：`tasks`、`stacks`、`provenance`、`reports`、`runs`、`changes`、`patches`、`verifications`、`builds`（共九个，相对调用 session cwd 解析；不经 rawDirs 或任何 profile/运行时配置增删）。`repos/` 不在集合内：coder 必须经 `edit`/`bash` 修改 `repos/SHUD`。治理对象只能经对应工具写入：`task_create`、`shud_run`、`change_create`、`change_submit`、`shud_build`、`verification_run`、`report_generate`/`report_validate`/`report_submit`/`report_decide`；本要求不改变这些工具自身的判定。

文件工具：`write`、`edit`（参数 `file_path`）以及 `str_replace_editor` 的非 `view` 命令（参数 `path`），目标等于或位于任一治理根内时 SHALL 返回 `deny`，`code` 为 `governance-immutable`，`reason` 含 `immutable` 并说明治理对象只能经上列对应工具写入；SHALL NOT 提供审批路径。路径身份与 raw 相同：文件工具相对路径按 session cwd 解析；额外的 `workdir` 参数不改变目标（钉版宿主文件工具不消费该参数）。复用 realpath/最近存在祖先、物理别名（符号链接与本机大小写别名）与路径包含规则；兄弟前缀（如 `tasks-old`、`changes.bak`）SHALL NOT 视为同一根。`str_replace_editor` 的 `view` 命令与 `read` 工具 SHALL 委托下一个监听器（治理文件不是敏感数据，读取不 ask）。

shell 工具：对 `bash`（含 persistent 变体）与 `pwsh`，"触及治理根" SHALL 复用「Shell command touches raw」的全部规则，把每个治理根当作一个配置项（配置原文为根名、解析后绝对路径为 session cwd 下该根的 canonical 路径），即字面文本与解析后绝对路径的边界匹配、路径等价规范化、去引号/续行副本、pwsh `\` 语境、`..` 词法折叠、本机大小写不敏感判定，以及有效工作目录 `realpath(workdir ?? session cwd)` 位于治理根内。触及任一治理根且按「Shell write under raw is denied」的写 denylist（写动词、工具形态含 `python -c` 等解释器一行程序、`>`/`>>` 等重定向、tar 解包与写归档规则、pwsh cmdlet，以及同样的 `/dev/null` 丢弃型重定向剥除）判为写时 SHALL 返回 `deny`，`code` 为 `governance-immutable`，`reason` 同文件工具；只读触及（无写判定）SHALL 委托下一个监听器恰好一次，SHALL NOT ask。根名作为普通词出现在写命令中（如 `grep -rn runs src > out.txt`）也判 `deny`，属已接受的 deny 方向误报；「Shell command touches raw」所列漏报（persistent `cd` 后相对写入、短于根名的 glob 前缀、名字中段的 glob/brace、经符号链接或前导 `..` 的回溯、ANSI-C 引号等）同样适用于治理根，且「Shell write to a raw ancestor is denied」的祖先规则 SHALL NOT 扩展到治理根（如 `rm -rf .`、`rm -rf *` 不经本要求识别）。治理根位于 workspace 内、没有沙箱兜底，这些漏报是登记于 design D15 的残余风险。

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
