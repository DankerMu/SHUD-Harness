Verifier verdicts for batch: test-evidence-round-5-c (1 candidates)
Reviewed head SHA: 02ba5189e938c7c04018555ec0347945dc15e829

Candidate: CAND-R5-03
Verdict: CONFIRMED
Disposition: FIX_NOW
Evidence: T1（通过，可达性）: `source-ingress.test.ts:105-139` 的 AST 仅拒绝列出的标识符及未允许的 `process`/`Bun` 用法；`Worker` 不在拒绝集合中，且两个证据文件均无 `Worker` 处理。`ingress.ts:358-362` 显示 admission 后、descriptor-relative revalidation 前存在实际 post-admission 执行点。独立窄复现于 Darwin/Bun 1.2.19 用同一 `authority-preload.ts` 在该钩子中直接创建 `Worker`；Worker 以绝对输入路径执行 `Bun.file(...).arrayBuffer()`，结果为 `{exit:0, workerBytes:1604, events:[]}`，即读已发生而 guard 未拒绝。`authority-preload.ts:7,52-74,116-145` 只在加载它的 realm 保存 state、patch builtin/Bun 对象并 mock 模块，未拒绝 Worker 或为其 realm 安装补丁。T2（通过，可观察影响）: 该复现仍产生直接 source-ingress 成功 receipt 且 stderr 为空，同时事件数组为空；因此一项 post-admission ambient-path read 可以让活动证据/CI 维持 green，而外部依赖的“仅 retained-descriptor reads”直接命令安全边界已被违反。未变更的直接命令也独立实测为 exit 0、精确成功 receipt。T3（通过，oracle anchor）: `design.md:902-912` 将 admission 后每次 read/replacement check 限为 retained descriptors；`:938-940` 明定 post-admission tripwire 必须实现零 root/ambient absolute-path open、每个允许 lookup 均须 descriptor-relative；`tasks.md:32-35` 将该验证列为 #168.A 的必需证明。`git diff main...HEAD -- .../source-ingress.test.ts .../authority-preload.ts` 显示二者均为本 PR 新增，故该证据缺口由当前变更引入并满足 FIX_NOW 条件。当前树没有任何 Worker 测试，因而也没有候选要求的 Darwin/Linux 拒绝证明。
Note: Darwin 上的直接 Worker 路径已可构造并绕过 guard；应在合入前补齐对该路径的拒绝/拦截及双平台证据。
