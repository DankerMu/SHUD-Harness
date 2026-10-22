# Tasks

## 1. 限时 spike：回答 design Open Questions（O1–O4）

- [ ] 1.1 在 `../dsh-spike`（不进入本仓库）用一次性插件验证：O1 teardown 与 `job_kill` 在 producer `cancel` 中能否区分；O2 `detached: true` 直接 spawn 的包装进程能否活过宿主 SIGTERM 与 SIGKILL；O3 脚本能否重启 dsh 并恢复同一会话观察唤醒（headless 或 Web HTTP 接口，记录可用命令）；O4 工具执行上下文能否取得本次响应的 model id。以用户可见步骤收尾：在 `dsh --profile shud` 的 Web 里跑 ccw，重启 dsh 后 shud 仍在运行（ADR-0004 K13）。验证：`docs/Migration_Plan_dsh.md` 新增 spike 记录（命令、session log 路径、观察结果），design.md 的 O1–O4 改写为已答结论（若任一结论推翻 D1/D4/D5/D7，停下并回报，由编排方重开设计决策）

- Suggested fixture level: none - 只产出记录与 design 结论，不合入代码
- Minimal mergeable slice: atomic - 一份 spike 记录与对应 design 更新，拆开会让结论与依据分离

## 2. 里程碑边界：M1→M2 dsh 升级评估

- [ ] 2.1 按 Phased_Plan §6 评估升级：核对 npm `@deepseek-ai/dsh` 的 latest/next 与钉版 `0.2.1-rc.2`，读 `../deepseek-harness/docs/upgrade-guide/` 中 rc.2 之后的条目（若有），重点看 `jobs`、`jobs-local`、`tool-jobs`、`storage` 与 session 恢复；无新版本时记录"跳过及原因"，#233 保持 open 待真正升级时复核。验证：`docs/Migration_Plan_dsh.md` 日志节新增一条带日期的评估记录；`pnpm run docs:check` 通过

- Suggested fixture level: none - 只读评估与一条记录
- Minimal mergeable slice: atomic - 单条记录

## 3. seam 白名单放宽（ADR-0006）

- [ ] 3.1 修改 `eslint.config.mjs` 的 `no-restricted-imports`：运行时允许 `@deepseek-ai/dsh-tools`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-jobs`、`@deepseek-ai/dsh-jobs-local`；其它 `@deepseek-ai/*` 只允许 `import type`；`deepseek-harness/**` 路径仍全部拒绝。验证：`pnpm run lint` 0 错 0 警
- [ ] 3.2 `scripts/guardrails/test-guardrails.sh` 增加正反例：两包运行时 import 通过、`@deepseek-ai/dsh-agent` 运行时 import 被拒、`import type { ... } from "@deepseek-ai/dsh-agent"` 通过、`deepseek-harness/` 相对路径 import 被拒。验证：`pnpm run test-guardrails` 全绿且新增用例计入总数

- Suggested fixture level: compact - 改共享 lint 闸与其自证，无运行时行为
- Minimal mergeable slice: atomic - 规则与其闸自证必须同 PR，否则 Enforcement Index 声明无证据

## 4. RunJob/RunRecord schema（Critical Path #7）

- [ ] 4.1 在 `packages/dsh-shud-core/src/schemas/` 新增 id 品牌类型与生成函数（`JOB-`/`RUN-` + UTC `YYYYMMDDTHHMMSS` + 4 位小写十六进制，同作业共享随机段）与 RunJob Zod schema（run-records spec「Run identifiers」「RunJob record」）；`pnpm run schema:generate` 刷新 `docs/generated/`；修订 `docs/03_SPEC/Minimal_Schemas.md` 的 RunJob 段（id 规范、M2 状态集、新增字段、`timed_out` 推迟 M3，文首注明修订来源 `m2-run-chain`）。验证：`core-schemas.test.ts` 对每条 scenario 有正反例；`pnpm run schema:check`、`pnpm run test:coverage` 通过
- [ ] 4.2 新增退出码类别映射与 RunRecord Zod schema（「RunRecord record」，含 `exit_class` 九值、可空 `numerical_health`、必填 `llm.response_model`）；`schema:generate`；修订 Minimal_Schemas 的 RunRecord 段；`openspec/glossary.md` 补 `exit_class`、`run_dir` 两态术语。验证：同上，覆盖退出码 0/10/12/13/19/20/其它、`cancelled`、`lost` 各一例

- Suggested fixture level: expanded - Critical Path #7（schema 与生成投影），字段契约为后续所有组的上游
- Minimal mergeable slice: 4.1 首刀（id + RunJob 连同其生成投影与文档段，可独立保绿）；4.2 为后继

## 5. 作业注册表骨架：行为不变的替换（Critical Path #4）

- [ ] 5.1 新建 `packages/dsh-shud-jobs`（`@shud-harness/dsh-shud-jobs`，依赖钉版 `@deepseek-ai/dsh-jobs`、`@deepseek-ai/dsh-jobs-local`）：`ShudJobRegistry extends LocalJobRegistry`，只做配置校验（`stateDir`、`shudBin` 必填，未知键拒绝，`stateDir` 可写、`shudBin` 可执行），非 shud 行为全部委托父类；knip workspaces 登记。验证：配置校验每种失败各一测试；用宿主公开测试方式（或最小 cordis 装配）证明 `bash` 后台作业登记、读取、结算与父类一致
- [ ] 5.2 profile patch 加 `- id: jobs` 指向新包（不含机器路径）；`profile:smoke` 与 `raw-guard:probes` 改为生成临时 overlay（临时 `stateDir` 与一个可执行的占位 `shudBin`）并以 `--patch` 传入；`profile:smoke` 增加 shud-profile spec 新断言（`jobs`、`shud-tools` 行在 5.2 只断言 `jobs`，`shud-tools` 断言随 12.1 加入）。验证：`pnpm run profile:smoke` 本机与 CI 通过；`pnpm run raw-guard:probes` 两次 T1–T5 PASS、md5 不变（证明非 shud 行为未变）

- Suggested fixture level: expanded - 替换宿主唯一的作业注册表，影响所有后台作业；Critical Path #4
- Minimal mergeable slice: 5.1 首刀（包与配置校验，未挂载时不影响 profile，可独立保绿）；5.2 为后继

## 6. shud 作业提交与脱离运行（Critical Path #4）

- [ ] 6.1 实现提交：分配 id、建 `runs/<run_id>/`、完整复制输入、按需改写副本 `END`、原子写 `run-job.json` 与 `stateDir/active.json`，以 `kind: shud` 经父类登记并把 `stdout.log` 作为输出源（shud-run-jobs spec「Shud job submission」）。验证：伪 `shudBin` 集成测试覆盖原输入字节不变、`END` 改写、复制失败即 `failed` 不启动、`job_output` 读到增量
- [ ] 6.2 实现包装进程：直接 spawn `/bin/sh`（`detached`、stdio 到文件、`unref`），执行 `<shudBin> -o output/<project>.out <project>`，结束写 `exit_code.tmp` 后 rename；记录 pid 与进程启动时间；宿主在线时据 `exit_code` 结算为 `succeeded`/`failed`（「Detached execution and exit capture」）。验证：伪 `shudBin` 退出 0 与 13 各一测试；测试进程模拟宿主退出（子进程中启动后 SIGKILL 该子进程）后包装进程仍写出 `exit_code`

- Suggested fixture level: expanded - 进程生命周期与持久化文件的原子性，Critical Path #4
- Minimal mergeable slice: 6.1 首刀（提交与落盘，无 spawn 时作业停在 `created`，测试可独立保绿）；6.2 为后继

## 7. 结算时自动 collect

- [ ] 7.1 实现 collect：读 `exit_code`、按映射得 `exit_class`、扫描 `output/<project>.out/` 生成相对路径与字节数清单、算 `wall_seconds`、复制 `llm.response_model`，写 `run-record.json` 并置 `collected`；已存在则原样返回（「Automatic collect」与 run-records「RunRecord record」）。验证：七个退出码与 `lost` 的集成测试；重复 collect 文件 mtime 不变；输出 RunRecord 经 core schema 解析通过

- Suggested fixture level: expanded - 产出不可变结果记录，幂等性属 Critical Path #4
- Minimal mergeable slice: atomic - collect 是单一函数及其测试，拆开无法单独验证幂等

## 8. 单并发 FIFO 队列

- [ ] 8.1 实现全机单 `running`：后续提交置 `submitted` 并按提交顺序排入 `active.json`；前一个进入终态后启动队首（「Single-run queue」）。验证：两作业与三作业顺序测试；中途以新注册表实例模拟重启后顺序不变

- Suggested fixture level: expanded - 队列状态持久化与重启语义，Critical Path #4
- Minimal mergeable slice: atomic - 队列入出与其持久化是同一不变量

## 9. 取消与宿主 teardown

- [ ] 9.1 实现 `job_kill`：运行中对包装进程组 SIGTERM，宽限后 SIGKILL，置 `cancelled` 并 collect；排队中直接出队置 `cancelled`（「Cancellation」）。验证：运行中与排队中各一测试，后者确认从未启动 SHUD
- [ ] 9.2 实现 teardown 放手：按 spike O1 结论识别宿主 teardown，不杀包装进程，本次登记以终态结算并说明后台继续，`run-job.json` 与索引保持（「Host teardown keeps shud running」）。验证：释放注册表实例后包装进程存活、无 `run-record.json`、无唤醒

- Suggested fixture level: expanded - 区分模型 kill 与宿主退出是持久化正确性的核心，Critical Path #4
- Minimal mergeable slice: 9.1 首刀（模型取消独立于 teardown，可独立保绿）；9.2 为后继

## 10. 启动对账

- [ ] 10.1 实现启动对账五种情形（已退出未 collect、仍运行且启动时间一致则接管并追加 `dsh_job_ids`、进程不存在或启动时间不一致则 `lost`、`submitted` 重新入队、已 collect 未唤醒只补唤醒标记）与幂等（「Startup reconciliation」）。验证：每种情形一个集成测试（新注册表实例读取同一 `stateDir`）；重复对账不产生第二份 RunRecord

- Suggested fixture level: expanded - park-resume 对账，Critical Path #4
- Minimal mergeable slice: atomic - 五种情形共享同一索引读取与状态判定，任何一种单独合入都会让其余情形在重启时被误判

## 11. 至少一次唤醒

- [ ] 11.1 实现唤醒：宿主在线时以含 RunRecord 摘要的 outcome 结算交 `tool-jobs` 唤醒；停机期间结算者在对账时 `resolveAgent` → `followup`（`source.kind: shud-jobs`）→ `flush` 后置 `notify.status: delivered`；owner 不可恢复置 `unreachable` 不再重试，随后移出索引（「At-least-once wake」）。验证：以宿主测试替身注入 `sessionController`/`sessions` 的集成测试覆盖 delivered、崩溃窗口重投、unreachable 三种情形；类型只经 `import type`（ADR-0006）

- Suggested fixture level: expanded - 唤醒投递语义与会话恢复，Critical Path #4
- Minimal mergeable slice: atomic - 在线与对账两条路径共用 `notify` 状态机，拆开会出现漏投或双投窗口

## 12. 模型工具包 `dsh-shud-tools`

- [ ] 12.1 新建 `packages/dsh-shud-tools` 并实现 `shud_run`（参数契约、未知参数拒绝、校验项、立即返回 ids 与状态；经 `ctx.jobs` 提交），profile patch 插入 `shud-tools` 行，`profile:smoke` 增加该行断言（shud-run-tools spec「shud_run arguments」「shud_run validation」，shud-profile「Profile composition」）。验证：每条 scenario 一测试；`pnpm run profile:smoke` 通过
- [ ] 12.2 实现 `shud_collect`（`job_id`/`run_id` 二选一、终态未 collect 先 collect、非终态与不存在报错、多次调用同一记录）。验证：每条 scenario 一测试

- Suggested fixture level: compact - 工具层参数契约与委托，持久化逻辑在 dsh-shud-jobs
- Minimal mergeable slice: 12.1 首刀（`shud_run` 与挂载可独立保绿）；12.2 为后继

## 13. raw-guard 识别 `shud_run`（Critical Path #1/#2）

- [ ] 13.1 在 `decideRawAccess` 增加 `shud_run` 判定：有效工作目录在 raw 内 deny，`input_dir` 在 raw 内 ask，二者都不触及时 next，`input_dir` 缺失或类型不符不抛错；测试放新文件 `decide-shud-run.test.ts`（`decide.test.ts` 已近 1000 行）（raw-data-guard「shud_run is guarded」）。验证：每条 scenario 含符号链接与 macOS `/var` 别名各有正反例；改动前对 origin/main 的 `decide.ts` 新 deny/ask 行为红；`pnpm run raw-guard:probes` 两次 T1–T5 PASS、md5 不变

- Suggested fixture level: expanded - 策略门决策与 raw 保护，Critical Path #1/#2
- Minimal mergeable slice: atomic - 单一判定分支与其测试表

## 14. 重启验收脚本与不变量进矩阵

- [ ] 14.1 新增 `scripts/runtime/shud-restart.sh` 与 `pnpm run shud:restart`：按 spike O3 结论驱动 dsh，在临时 `DSH_HOME` 与工作区以真实 ccw 跑 SIGTERM、SIGKILL 两个用例，判据取 session log 与运行目录（「Restart acceptance script」）；缺 SHUD、dsh 或 `DMXAPI_KEY` 时先行非 0 退出。验证：本机两次完整运行均 PASS，PR 附 session log 路径与运行目录摘录；缺二进制负例非 0
- [ ] 14.2 控制面登记：`instructions/agents/` 源的 Verification Matrix 与 Enforcement Index 增加 `shud:restart`（本机，block），`pnpm run instructions:render`；`constraints.yaml` verification 镜像增加该命令并移除 "runtime invariant companions" 的 review_only 条目；`CONTEXT.md` Jobs 上下文的不变量指向 `shud:restart` 与第 6–11 组的集成测试。验证：`pnpm run docs:check`、`pnpm run check` 通过，生成物无漂移

- Suggested fixture level: compact - 本机脚本与控制面文档，无产品代码
- Minimal mergeable slice: 14.1 首刀（脚本可独立运行与评审）；14.2 为后继（矩阵登记必须指向已存在的命令）

## 15. `scripts/schema/generate.ts` 拆分

- [ ] 15.1 把 renderer 等可分离部分抽到同目录模块，使 `generate.ts` 及每个新文件 ≤1000 行，并修掉其 3 处 eslint 类型安全基线；`constraints.yaml` 删除该文件的 `max_file_lines` 与 `eslint_type_safety` 基线条目，同步 `.large-file-guard.json`（若有对应排除）。验证：拆分前后 `pnpm run schema:generate` 产物逐字节相同；`pnpm run schema:check`、`pnpm run lint`、`pnpm run check` 通过

- Suggested fixture level: compact - 机械重构，生成物逐字节不变即为证明
- Minimal mergeable slice: atomic - 拆分与基线移除必须同 PR，否则基线条目指向已不成立的事实

## 16. Epic 收口 PI 功能验收（ADR-0007）

- [ ] 16.1 第 1–15 组全部合并后，PI 在 `dsh --profile shud` Web 里一句话让 agent 用 `shud_run` 跑 ccw，运行中重启 dsh，完成后会话被唤醒并给出 RunRecord；编排方从 session log 摘录 `tool/call shud_run`、重启后的 `shud-jobs` 唤醒消息与运行目录 `run-record.json`，记入 `docs/Migration_Plan_dsh.md`（「Epic-close manual acceptance」）。验证：PI 明确给出验收结论；记录 PR 的 `docs:check` 通过

- Suggested fixture level: none - 人工验收与证据记录
- Minimal mergeable slice: atomic - 单次验收记录
