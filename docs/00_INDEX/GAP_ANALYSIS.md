# 文档设计 vs 代码现实：差距分析

> 本文写于 v0.5 设计阶段。当前权威规格为 `SPEC_v0.8_Final.md`。
> 其中 3.4 R 环境依赖已在 v0.7 StackLock 中通过 `r_version` + `renv.lock` 解决。

**日期**: 2026-04-24
**方法**: 对比 v0.5 方案设计 与 四个 repo 的实际代码探索结果

## 1. 总体判断

v0.5 方案设计质量很高，但它是**纯设计文档**——当前没有任何 SHUD-Harness 运行时代码存在。
四个 repo 都是独立项目，Zero 尚未被 fork 或定制。差距不在于设计错误，而在于**从设计到代码的距离为 100%**。

## 2. 各 repo 与 Harness 设计的对齐度

### 2.1 SHUD ← 设计假设基本成立

| 设计假设 | 代码现实 | 对齐度 |
|----------|----------|--------|
| C++ 求解器, CVODE | 确认: C++14, SUNDIALS/CVODE 6.0 | ✅ |
| `make shud` 可编译 | 确认: Makefile 支持 serial/omp/debug | ✅ |
| `./shud <project>` 可运行 | 确认: 从 `input/<project>/` 读取 | ✅ |
| 二进制 `.dat` 输出 | 确认: ~50 个输出变量 | ✅ |
| 无自动化测试 | 确认: 仅示例数据集 | ⚠️ 设计中未充分关注 |
| 3 个示例流域 | 确认: ccw, heihe, qhh | ✅ |
| 近期有关键 bugfix | 发现: `9b55b0c` 注释 4 行, `077ff33` 递减率 10x 修正 | ⚠️ 设计未涉及 |

**差距**: SHUD 本身没有测试套件，Harness 的 `run-shud-tiny-case` skill 需要自行创建 benchmark fixture 和预期结果。设计中默认的 "tiny case" 需要明确选用哪个流域、哪个时段。

### 2.2 rSHUD ← 设计假设基本成立, 但接口细节需更新

| 设计假设 | 代码现实 | 对齐度 |
|----------|----------|--------|
| R 包, 能读 SHUD 输出 | 确认: `read_output()` 读二进制 .dat | ✅ |
| 能生成 SHUD 输入 | 确认: `shud_auto_build()` 全流程 | ✅ |
| 水量平衡计算 | 确认: `wb.all()` | ✅ |
| 已迁移到 terra/sf | 确认: v2.2.0 完成迁移 | ✅ |
| 有测试 | 确认: 10 个 testthat 文件 | ✅ |
| API 名称 (readmesh → read_mesh) | 确认: 新旧两套 API 共存 | ⚠️ 设计中旧名仍出现 |

**差距**: 设计中多处使用旧函数名 (`readmesh`, `readriv`)，实际代码已迁移到 snake_case (`read_mesh`, `read_river`)。`rshud-roundtrip-test` skill 需要对齐实际函数名。rSHUD v3.0 开发中，可能有进一步 API 变化。

### 2.3 AutoSHUD ← 设计假设成立, 但接口方式不同

| 设计假设 | 代码现实 | 对齐度 |
|----------|----------|--------|
| 自动化建模流水线 | 确认: 7 步 R 脚本链 | ✅ |
| 配置驱动 | 确认: `.autoshud.txt` 键值对 | ✅ |
| 依赖 rSHUD | 确认: `shud.triangle()`, `write.mesh()` 等 | ✅ |
| 能自动编译运行 SHUD | 确认: Step4 git clone + make + run | ✅ |
| 多源数据支持 | 确认: HWSD/ISRIC/SSURGO + GLC/NLCD + 多个 LDAS | ✅ |
| 版本管理 | 发现: V2→V3 过渡, tag-v2-freeze.sh | ⚠️ 设计未涉及 |

**差距**: AutoSHUD 不是 R 包而是脚本集合，没有测试套件。Harness 需要把 AutoSHUD 当作"可执行脚本链"而非"可调用 API"来编排。设计中 `add-shud-output-diagnostics` skill 假设能修改 AutoSHUD，实际上 AutoSHUD 的"report"阶段比较简单。

### 2.4 Zero ← 设计假设高度成立, 但细节差异存在

| 设计假设 | 代码现实 | 对齐度 |
|----------|----------|--------|
| Bun + TypeScript monorepo | 确认 | ✅ |
| Agent loop + hooks | 确认: 12 个 hook 点 | ✅ |
| bash/read/write/edit/spawn 工具 | 确认: 18 个工具 | ✅ |
| Skills 从 .zero/skills/ 加载 | 确认: SKILL.md + YAML frontmatter | ✅ |
| Memory 默认 verified | 确认: `status: verified, confidence: 0.85` | ✅ (这正是需要修的) |
| Roles: Explorer/Coder/Reviewer | 确认: 从 `.zero/roles/` 加载 | ✅ |
| Task closure: finish/continue/block | 确认: 含研究类任务附加规则 | ✅ |
| Web 控制面板 | 确认: Hono + React + WebSocket | ✅ |
| 无 SHUD 定制 | 确认: grep SHUD 无结果 | ✅ |
| macOS Keychain 依赖 | 确认: `secrets/vault.ts` | ⚠️ Linux 需 fallback |

**差距**: Zero 的 Task Orchestrator (`task/orchestrator.ts`) 在设计中未被提及，实际是 DAG 编排器，可能对 Harness 有用。Zero 还有 CodexTool（OpenAI Codex 委派），设计中没有考虑是否保留。

## 3. 设计中尚未与代码对齐的关键项

### 3.1 Tiny Benchmark Fixture 未定义
设计反复提到 `run-shud-tiny-case`，但未指定:
- 用哪个流域 (ccw? qhh?)
- 用什么时段
- 预期输出的验收阈值
- fixture 数据放在哪里

**建议**: 用 `input/qhh/` (最小) 或创建一个人工 synthetic 小流域。

### 3.2 SHUD 输出变量映射未落实
设计提到 "event-scale diagnostics"，但 SHUD 当前已有 ~50 个输出变量:
- 设计需要明确哪些是"已有但未被 rSHUD 充分使用"
- 哪些是"SHUD 需要新增"

### 3.3 跨仓库 worktree 的实操路径未验证
设计假设可以为 SHUD/rSHUD/AutoSHUD 创建 git worktree。
但这三个 repo 当前作为 SHUD-Harness 的子目录存在，不是 git submodule。
需要确定: 是把它们改成 submodule? 还是在 episode 中 clone fresh copies?

### 3.4 R 环境依赖 ~~未被设计覆盖~~ ✅ 已在 v0.7 解决
rSHUD 和 AutoSHUD 都需要完整 R 环境 + 大量 R 包。
~~设计中 StackLock 只锁了 repo commits + compiler + container image，
未显式锁 R 版本和 R 包版本。~~
**v0.7 更新**: StackLock 已包含 `r_version` 和 `r_packages_lock: renv.lock` 字段。

## 4. 优先补齐建议

| 优先级 | 项目 | 原因 |
|--------|------|------|
| P0 | 确定 tiny benchmark fixture | 没有它, 第一个闭环无法启动 |
| P0 | 确认 repo 管理策略 (submodule vs clone) | 影响 sandbox 设计 |
| P0 | 创建 R 环境 StackLock schema 扩展 | rSHUD/AutoSHUD 强依赖 |
| P1 | 对齐 rSHUD API 名称 | skill 脚本会调用这些函数 |
| P1 | 盘点 SHUD 现有输出变量 vs 诊断需求缺口 | 确定 event diagnostics 范围 |
| P2 | 评估 Zero TaskOrchestrator 是否可复用 | 可能比自建 DAG 更快 |
