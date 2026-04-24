# SHUD-Harness v0.8 完善计划

> 当前状态：设计文档完成，零代码。本文件追踪从"设计完成"到"可运行"的所有待办事项。
> 预估总工作量：~120 人天（1.5 人团队 × 8 周，理想状态无 buffer）

---

## 1. Zero Runtime 扩展

### 1.1 Agent 角色定义
- [ ] Coordinator Agent system prompt 编写 (`packages/core/src/agent/coordinator.ts`)
  - 嵌入科研治理规则（禁止表述、PI 审批条件）
  - Park/Resume 决策逻辑
  - Budget 监控行为
  - Closure 判断标准（何时 awaiting_pi）
- [ ] Worker Agent system prompt 编写 (`worker.ts`)
- [ ] Reviewer Agent system prompt 编写 (`reviewer.ts`)
- [ ] 角色颜色 & 图标定义 (Coordinator=蓝, Worker=绿, Coder=紫, Reviewer=橙)

### 1.2 Park/Resume 长任务状态机
- [ ] Zero AgentLoop 添加 Park hook 点（submit job → 保存上下文 → 退出循环）
- [ ] 任务状态持久化设计（parked 状态存储格式：YAML? DB?）
- [ ] Job 完成检测机制（polling vs event-driven）
- [ ] WebSocket 推送 job 完成通知
- [ ] Resume 上下文恢复（重新加载 TaskCard + RunRecord 到 LLM 上下文）
- [ ] Resume 后 Agent 状态正确性验证

### 1.3 科研 Closure Classifier 扩展
- [ ] 在 Zero Closure Classifier 基础上扩展科研判断维度
  - "是否需要 PI 审批"（高风险变更检测）
  - "是否需要 holdout 验证"（calibration → validation 转换规则）
  - "是否缺少 baseline"（比较结论前必须有 baseline）
- [ ] 禁止表述自动检测（扫描报告中的"已验证"、"普遍改进"、"机制成立"）

### 1.4 Memory 系统修改
- [ ] 修改 Zero MemoryTool 默认 status 从 `verified` → `draft`
- [ ] 添加 `evidence_note` 类型（需 PI review）
- [ ] `pi_decision` 类型 note 支持
- [ ] 基于标签的检索（MVP 不用 embedding）

### 1.5 PI 审批 Gate Hook
- [ ] AgentLoop 添加 PI gate hook（高风险操作前暂停等待审批）
- [ ] 审批请求 → WebSocket 推送到前端
- [ ] 审批结果 → 恢复 Agent 执行
- [ ] 审批审计日志（谁批准、何时、原因）

---

## 2. TypeScript Monorepo 基础设施

### 2.1 项目脚手架
- [ ] `package.json` root workspace 配置
- [ ] `bunfig.toml` 配置
- [ ] `tsconfig.json` 层级（root + packages/core + packages/backend + packages/frontend）
- [ ] `.gitignore` 更新（node_modules, .bun, dist）
- [ ] ESLint/Biome 配置
- [ ] Vitest 测试框架配置

### 2.2 开发工具链
- [ ] `bun dev` 开发启动脚本（后端 + 前端热更新）
- [ ] `bun build` 生产构建
- [ ] `bun test` 全量测试
- [ ] `bun lint` 代码检查

---

## 3. Domain Schemas (Zod)

### 3.1 核心对象 Schema
- [ ] `TaskCard` schema (`packages/core/src/domain/schemas/task.ts`)
  - type 枚举 (engineering | science_assist | ops)
  - status 状态机 (created → planned → running → parked → reporting → awaiting_pi → done | cancelled)
  - inference_budget 嵌套对象 (mode, advisory_usd, advisory_model_calls)
- [ ] `StackLock` schema (`stacklock.ts`)
  - repos 对象 (commit + branch per repo)
  - runtime 对象 (os, r_version, r_packages_lock, python_version, sundials, gcc, gdal)
  - harness 对象 (version, prompt_pack, skills_version)
  - fingerprint (整体 SHA256)
- [ ] `DataProvenance` schema (`provenance.ts`)
  - sources 分类 (terrain, mesh, forcing, observations)
  - preprocess 对象 (script, params, output_sha256)
  - uncertainty_notes 自由文本
- [ ] `RunJob` schema (`job.ts`)
  - backend 枚举 (local_direct | local_job | docker_job)
  - status 状态机 (created → submitted → running → succeeded/failed/cancelled/timed_out → collected)
- [ ] `RunRecord` schema (`run-record.ts`)
  - artifacts 路径映射
  - numerical_health (water_balance_residual, cvode_failures, negative_state_count, max_solver_dt)
  - resources (wall_seconds, peak_memory_mb)
- [ ] `AnalysisPlan` schema (`analysis.ts`)
  - mode 判别联合 (sensitivity | calibration | benchmark | comparison)
  - 各模式特有字段 (parameters/strategy, calibration/holdout, etc.)
- [ ] `EvidenceReport` schema (`report.ts`)
  - status 枚举 (draft | pi_reviewed | accepted | rejected)
  - observations / limitations / pi_questions 数组
  - llm_cost / compute_cost 嵌套
- [ ] `ChangeRequest` schema (`change.ts`)
  - risk 枚举 (low | medium | high)
  - interface_impact (output_change: additive|breaking, backward_compatible: bool)
  - gates (needs_pi_approval, reason)
- [ ] `MemoryNote` schema (`note.ts`)
  - type 枚举 (failure_note | data_note | compatibility_note | pi_decision | playbook_note)
  - status 枚举 (draft | accepted | retired)

### 3.2 Schema 工具
- [ ] Schema validation helper 函数 (parse + error formatting)
- [ ] TypeScript 类型导出 (z.infer<typeof XxxSchema>)
- [ ] YAML ↔ Zod 序列化/反序列化

---

## 4. 后端 API (Hono)

### 4.1 REST 端点
- [ ] `POST /api/workspace/init` — workspace 目录树创建
- [ ] `POST /api/tasks` — 创建 TaskCard
- [ ] `GET /api/tasks` — 任务列表（支持 status 过滤）
- [ ] `GET /api/tasks/:id` — 任务详情（含 RunRecords, AnalysisPlan）
- [ ] `POST /api/tasks/:id/plan` — 生成执行计划
- [ ] `POST /api/tasks/:id/approve` — PI 审批（accept/revise/reject + 选择的 next action）
- [ ] `DELETE /api/tasks/:id/artifacts` — 清理临时文件
- [ ] `POST /api/stacks/lock` — 自动采集 repo commits + runtime versions
- [ ] `POST /api/data/register` — 数据源注册 + SHA256 校验
- [ ] `POST /api/tasks/:id/run-tiny` — tiny benchmark 触发
- [ ] `POST /api/jobs` — 提交长任务
- [ ] `GET /api/jobs/:id` — 查询 job 状态
- [ ] `POST /api/jobs/:id/collect` — 收集结果
- [ ] `POST /api/analysis/sensitivity` — 敏感性分析触发
- [ ] `POST /api/analysis/calibration` — 校准触发
- [ ] `GET /api/runs/:id/metrics` — RunRecord 指标
- [ ] `GET /api/runs/:id/hydrograph` — 水文过程线时间序列数据
- [ ] `GET /api/analysis/:id/heatmap` — 敏感性热力图矩阵数据
- [ ] `GET /api/analysis/:id/parameters` — 参数集表格数据
- [ ] `POST /api/tasks/:id/report` — 生成报告
- [ ] `GET /api/reports/:taskId` — 获取 Markdown 报告
- [ ] `GET /api/patches/:id/diff` — patch diff
- [ ] `POST /api/patches/:id/bundle` — patch 打包
- [ ] `POST /api/notes` — 添加笔记
- [ ] `GET /api/notes` — 笔记列表

### 4.2 WebSocket
- [ ] `WS /ws/session/:sessionId` — 统一 session 通道
  - Agent 活动流消息（多角色、带时间戳）
  - LLM streaming（逐 token 推送）
  - Job 日志流（实时 stdout/stderr）
  - 事件推送（job 完成、审批请求、成本告警）
- [ ] 消息类型 discriminator 设计（type 字段区分 agent_message | log | event | streaming）
- [ ] 断线重连 + 消息缓冲（late-joining clients 接收历史）
- [ ] Ping/pong 心跳 + 超时处理

### 4.3 中间件
- [ ] 认证中间件（MVP: 单用户 API key? 多用户 OAuth?）
- [ ] 请求/响应日志中间件
- [ ] 统一错误响应格式 (`{error: string, code: string, details?: any}`)
- [ ] CORS 配置
- [ ] 请求体大小限制

---

## 5. 前端 (React 科研工作台)

### 5.1 页面 & 路由
- [ ] React Router 配置
- [ ] `Dashboard.tsx` — 所有任务概览 + 最近活动
- [ ] `Workbench.tsx` — 四栏科研工作台（主工作界面）
- [ ] `ReportFullscreen.tsx` — 报告全屏阅读
- [ ] `CostAdmin.tsx` — 成本汇总（按任务/天/Agent）
- [ ] 404 / 错误页面

### 5.2 布局
- [ ] `WorkbenchLayout.tsx` — 四栏容器（可调整宽度？响应式断点？）

### 5.3 A 栏：左侧导航
- [ ] `SideNav.tsx` — 导航栏容器
- [ ] `ConversationHistory.tsx` — 会话历史列表（时间倒序、状态图标）
- [ ] `ResearchContext.tsx` — 当前任务上下文（StackLock / DataProvenance / Notes 可折叠）
- [ ] `CostMonitor.tsx` — 底部悬浮成本面板（advisory 超出时变色）

### 5.4 B 栏：Agent 活动流
- [ ] `AgentActivityFeed.tsx` — 多 Agent 消息流容器
- [ ] `AgentMessage.tsx` — 单条消息（角色颜色标识 + 时间戳 + 折叠详情）
- [ ] `PIInput.tsx` — PI 输入框（自然语言 + 指令）
- [ ] `StreamingText.tsx` — LLM 打字机效果

### 5.5 C 栏：实验详情
- [ ] `ExperimentHeader.tsx` — 实验头部（EXP-ID, basin, event, status, StackLock 摘要）
- [ ] `HydrographChart.tsx` — 交互式水文过程线
  - 图表库选择（ECharts? Plotly? D3? Recharts?）
  - 观测 vs baseline vs 实验 多系列叠加
  - 缩放、平移、tooltips
  - 多变量切换（eleygw, rivqdown 等）
- [ ] `RuntimeTerminal.tsx` — 嵌入式终端
  - 实时日志流（WebSocket）
  - 语法高亮（错误红、警告黄、成功绿）
  - 可收起/展开
- [ ] `ParameterSetTable.tsx` — 参数集表格
  - 可排序列
  - 最优组合高亮
  - 列: 参数值 | NSE | Peak Error | Timing | WB Residual

### 5.6 D 栏：结果面板
- [ ] `ResultsOverview.tsx` — 关键指标卡片
  - 4 卡布局：NSE, Peak Error, Timing, Peak Flow
  - 与 baseline 差异箭头（▲▼）+ 达标/未达标颜色
- [ ] `HydrographComparison.tsx` — baseline vs experiment 对比图
  - 差异带 (filled diff band) 高亮
- [ ] `SensitivityHeatmap.tsx` — 敏感性热力图
  - 参数 × 指标 颜色矩阵
  - 敏感(红) → 不敏感(蓝)
- [ ] `NextSuggestedAction.tsx` — 下一步建议面板
  - Coordinator 生成的结构化建议列表
  - PI 单选 + 执行/修改/终止 按钮

### 5.7 通用组件
- [ ] `StatusBar.tsx` — 底部状态栏（task ID, stack, budget, WS 连接状态）
- [ ] `MarkdownRenderer.tsx` — Markdown 渲染（选库: react-markdown? remark?）
- [ ] `DiffViewer.tsx` — 代码 diff 预览
- [ ] Error Boundary 组件
- [ ] Loading / Skeleton 组件
- [ ] Toast 通知组件

### 5.8 Hooks
- [ ] `useWebSocket.ts` — WebSocket 连接管理（session 生命周期、重连、消息路由）
- [ ] `useAgentStream.ts` — Agent 活动流订阅
- [ ] `useHydrograph.ts` — 水文数据加载与缓存

### 5.9 状态管理
- [ ] 全局状态方案选择（React Context? Zustand? Jotai?）
- [ ] Session 状态（当前 session ID, 连接状态）
- [ ] Task 状态（当前选中 task, 关联 runs/reports）
- [ ] Agent 消息队列状态

---

## 6. SHUD 专用工具 & 脚本

### 6.1 TypeScript 工具 (packages/core/src/tools/)
- [ ] `shud-build.ts` — `./configure && make shud` 包装
  - 编译错误检测 + stderr 解析
  - 构建产物验证
  - 并行编译 (-j flag) 支持
- [ ] `shud-run.ts` — `./shud <project>` 运行器
  - 输入目录校验
  - 实时 stdout/stderr 流式传输
  - CVODE solver 错误码检测
  - 超时处理
- [ ] `rshud-parse.ts` — rSHUD 输出解析包装
  - 调用 R 脚本（subprocess）
  - 输出变量映射 (eleygw, rivqdown, etc.)
  - R xts → JSON 数据格式转换
- [ ] `water-balance.ts` — 水量平衡计算包装
  - 调用 `wb.all()` R 脚本
  - 残差阈值检查 (< 0.01)

### 6.2 确定性脚本 (scripts/)
- [ ] `scripts/shud/build.sh` — SHUD 编译脚本
- [ ] `scripts/shud/run.sh` — SHUD 运行脚本（含参数修改）
- [ ] `scripts/rshud/read_output.R` — 输出读取（使用新 API: `read_mesh`, `read_river`）
- [ ] `scripts/rshud/water_balance.R` — 水量平衡计算
- [ ] `scripts/rshud/roundtrip_test.R` — 写入→读回→比较
- [ ] `scripts/metrics/sensitivity_table.ts` — 从批量 RunRecord 生成 Parquet
- [ ] `scripts/metrics/tornado_plot.ts` — 生成热力图数据结构

### 6.3 Skills (5 个 MVP)
- [ ] `skills/run-shud-tiny-case/SKILL.md`
  - 流程: lock → prep workspace → compile → run ccw 30-day → parse → water balance
  - 验收: compile OK, exit=0, WB<0.01, CVODE_failures=0
- [ ] `skills/diagnose-shud-run-failure/SKILL.md`
  - 分类: 编译错误 / CVODE 错误 / 数据缺失 / 超时 / 环境问题
- [ ] `skills/rshud-roundtrip-test/SKILL.md`
  - 测试: write mesh → write .dat → read back → compare
- [ ] `skills/summarize-sensitivity-results/SKILL.md`
  - 生成: 参数表 + tornado 图 from 批量 RunRecord
- [ ] `skills/build-task-report/SKILL.md`
  - 组装: 模板 + metrics + observations + limitations + pi_questions

---

## 7. 执行引擎 & Sandbox

### 7.1 RunJob 状态机
- [ ] 状态转换实现 (created → submitted → running → succeeded/failed → collected)
- [ ] 本地进程后端（spawn, PID 追踪, 信号处理）
- [ ] 本地 job 注册表（PID 文件格式, 状态轮询）
- [ ] stdout/stderr 流式捕获 + tail 缓存

### 7.2 Sandbox 安全
- [ ] 可写路径白名单 (workspaces/TASK-*/scratch, artifacts/, worktrees/, reports/, runs/)
- [ ] 只读路径强制 (data/raw/)
- [ ] 禁写路径强制 (benchmark baselines, canonical memory)
- [ ] 每条 bash 命令的 CommandTrace YAML 序列化
- [ ] Git worktree 创建/清理 helpers

### 7.3 失败恢复
- [ ] 重试逻辑 (max_retries_per_command: 2)
- [ ] 无进展检测 (3 步无进展 → block)
- [ ] Git worktree 回滚
- [ ] 临时文件清理
- [ ] 部分日志收集（job 被 kill 后）
- [ ] 孤儿 job 检测（stale PID 检查）

---

## 8. 报告 & 可视化

### 8.1 报告生成
- [ ] 模板引擎选择 (Jinja2 .j2? Handlebars? 纯 TS string template?)
- [ ] `task_report.md.j2` 模板编写
- [ ] `evidence_report.md.j2` 模板编写
- [ ] 确定性报告生成（模板 + 脚本输出指标）
- [ ] LLM 解释性文字生成（observations / limitations / pi_questions）
- [ ] 报告状态工作流 (draft → pi_reviewed → accepted → rejected)

### 8.2 数据可视化
- [ ] 图表库选型（ECharts? Plotly? D3? Recharts?）
- [ ] 水文过程线数据格式定义（JSON: timestamp + obs + baseline + experiment）
- [ ] 敏感性热力图数据格式定义（parameter × metric matrix）
- [ ] 图表交互设计（缩放、平移、tooltip、图例）
- [ ] 大数据量优化（1000+ 时间点渲染性能）
- [ ] 响应式图表尺寸

### 8.3 Markdown 渲染
- [ ] 渲染库选型 (react-markdown? marked + remark?)
- [ ] 代码块语法高亮
- [ ] 数学公式渲染（水文方程）
- [ ] 图片嵌入
- [ ] 表格样式

---

## 9. 数据管理 & 存储

### 9.1 Workspace 初始化
- [ ] workspace 目录树自动创建逻辑
- [ ] Task 专用 workspace 结构 (TASK-*/worktrees/, scratch/, artifacts/, traces/)
- [ ] 文件命名约定（runs/RUN-*/run_record.yaml, reports/TASK-*_report.md）

### 9.2 DuckDB 指标仓
- [ ] DuckDB 表结构设计（RunRecord 指标, 成本追踪, 参数扫描结果）
- [ ] Parquet 写入/读取
- [ ] 查询 API (sensitivity table, cost rollup)

### 9.3 StackLock 自动采集
- [ ] Git commit 采集 (SHUD/rSHUD/AutoSHUD)
- [ ] 运行时版本检测 (R, Python, SUNDIALS, GDAL, gcc)
- [ ] `renv.lock` 集成（R 包版本快照）
- [ ] 环境 fingerprint 生成 (整体 SHA256)

### 9.4 数据溯源
- [ ] 文件 SHA256 计算
- [ ] 预处理脚本输出追踪
- [ ] 观测数据版本管理

---

## 10. 成本追踪

- [ ] LLM 调用计数器（hook 到 Anthropic SDK）
- [ ] Token → USD 成本估算
- [ ] 按任务成本累计
- [ ] 实时成本 WebSocket 推送
- [ ] advisory 超出提醒（前端 CostMonitor 变色）
- [ ] 计算资源追踪（wall time, peak memory, storage）
- [ ] 成本报告模板（每任务的 LLM + compute 成本摘要）

---

## 11. 测试

### 11.1 单元测试
- [ ] Zod schema 验证测试（valid + invalid 输入）
- [ ] API route handler 测试
- [ ] Domain service 测试 (TaskService, JobService, ReportGenerator)
- [ ] Sandbox 隔离测试（路径白名单/黑名单）
- [ ] 成本追踪逻辑测试

### 11.2 集成测试
- [ ] 端到端任务流程 (create → plan → execute → report → approve)
- [ ] WebSocket 通信测试
- [ ] Park/Resume 生命周期测试
- [ ] Job 失败 + 恢复测试
- [ ] 多 Agent 消息传递测试

### 11.3 回归测试
- [ ] ccw tiny fixture baseline 建立（预期数值结果确定）
- [ ] 回归检测机制（输出与 baseline 对比, 浮点容差）
- [ ] rSHUD roundtrip 通过标准定义

### 11.4 前端测试
- [ ] React 组件渲染测试
- [ ] WebSocket hook 测试
- [ ] 图表渲染测试
- [ ] E2E 测试（Playwright? Cypress?）

---

## 12. 部署 & DevOps

### 12.1 Docker
- [ ] SHUD 环境 Dockerfile (C++14, SUNDIALS/CVODE 6.0+, OpenMP)
- [ ] R 环境 Dockerfile (R 4.4.1, rSHUD, AutoSHUD, 所有依赖包)
- [ ] Harness 应用 Dockerfile (Bun + 编译后代码)
- [ ] docker-compose.yml (Harness + SHUD env + R env)
- [ ] 开发 vs 生产 image 区分

### 12.2 CI/CD
- [ ] GitHub Actions: lint + type check
- [ ] GitHub Actions: unit test + integration test
- [ ] GitHub Actions: Docker build + push
- [ ] 部署到 staging/production 流程

### 12.3 本地开发环境
- [ ] `.env.example` 模板
- [ ] 开发环境一键启动脚本
- [ ] 依赖安装文档 (Bun, R, C++ compiler, SUNDIALS)
- [ ] DuckDB 初始化脚本
- [ ] 种子数据创建

---

## 13. 文档

### 13.1 用户文档
- [ ] 快速开始指南（PI 如何登录、创建第一个任务、查看报告）
- [ ] 任务创建教程
- [ ] 参数扫描教程
- [ ] 报告阅读指南
- [ ] 审批流程指南

### 13.2 开发者文档
- [ ] 架构总览（新开发者入门）
- [ ] 代码结构 walk-through
- [ ] Zero 扩展点说明
- [ ] Skill 开发指南
- [ ] 添加新 SHUD 工具指南
- [ ] Contributing 规范

### 13.3 运维文档
- [ ] workspace 备份/恢复流程
- [ ] 数据保留策略
- [ ] 日志轮转配置
- [ ] 监控/告警设置
- [ ] 故障排查指南

---

## 14. 安全 & 认证

- [ ] 认证方案决策（单用户 API key? 多用户 OAuth? 会话 token?）
- [ ] Session 管理（cookie vs token）
- [ ] 权限模型（谁能创建任务? 谁能审批?）
- [ ] XSS 防护（前端输入消毒）
- [ ] CSRF 防护
- [ ] HTTPS 强制
- [ ] API 密钥管理（LLM API key 存储）
- [ ] 速率限制

---

## 15. 可观测性 & 监控

- [ ] 日志策略（结构化日志, 输出位置, 轮转）
- [ ] 健康检查端点 (`GET /health`)
- [ ] 告警规则（磁盘满、job 超时、LLM 配额耗尽）
- [ ] 请求追踪（OpenTelemetry? 自建?）
- [ ] Agent 行为审计日志

---

## 16. SHUD 领域专项

### 16.1 水文模型知识
- [ ] SHUD ~50 个输出变量完整列表 + 单位 + 物理含义
- [ ] CVODE 错误码 → 含义映射
- [ ] 数值健康指标阈值校准（WB residual < 0.01 是否合适?）
- [ ] NSE / KGE 计算公式确认
- [ ] Peak flow error / timing error 定义形式化

### 16.2 流域 & 事件管理
- [ ] 流域元数据 schema（面积、气候带、地质、观测站）
- [ ] 事件元数据 schema（暴雨持续时间、峰值强度、前期条件）
- [ ] 流域特定参数范围文档（不同土壤类型的 ksat 范围）

### 16.3 校准 & 敏感性边界
- [ ] 允许参数范围定义（ksat_multiplier: 0.1–10.0? mannings_n: 0.5–2.0?）
- [ ] 禁止校准参数清单（CVODE tolerances 已标记，还有哪些?）
- [ ] Holdout 事件选择标准
- [ ] 校准收敛判据

### 16.4 R 环境集成
- [ ] R 脚本从 TypeScript 调用方式 (subprocess)
- [ ] R stderr 解析（错误检测）
- [ ] renv 环境快照/恢复流程
- [ ] R 包版本冲突处理

---

## 17. 待决策项

> 以下问题需要 PI 决策后才能确定实现方案。

- [ ] **单用户 vs 多用户**: CLAUDE.md 暗示单用户 PI，但多用户影响 auth 设计
- [ ] **移动端支持**: 四栏布局是否需要响应式? 还是纯桌面端?
- [ ] **数据保留策略**: 旧 workspace 数据何时可以删除? 有合规要求吗?
- [ ] **并发任务限制**: PI 同时启动两个 engineering task 怎么处理?
- [ ] **存储预算**: artifacts/runs 空间上限? 何时归档?
- [ ] **审计要求**: 是否需要记录谁批准了什么（用于合规）?
- [ ] **中英文切换**: 用户可以 session 中途切换语言吗?
- [ ] **回滚深度**: revert patch 后能回退几个版本?
- [ ] **离线支持**: parked 任务是否支持离线查看?
- [ ] **图表库**: ECharts vs Plotly vs D3 vs Recharts（性能/交互/bundle size 权衡）

---

## 18. 优先级排序

### P0 — 阻塞性（不做就无法启动 Week 1）
- Bun monorepo 脚手架
- TaskCard Zod schema
- Hono 基础路由 (tasks CRUD)
- React 四栏布局壳
- WebSocket 基础连接

### P1 — 核心路径（Week 1-4 必须完成）
- Zero Park/Resume hook
- Agent 角色 system prompts
- RunJob 执行引擎
- Sandbox 安全
- HydrographChart + ResultsOverview
- AgentActivityFeed + RuntimeTerminal

### P2 — 核心路径（Week 5-8 必须完成）
- 5 个 Skills
- 敏感性分析 + 热力图
- 报告生成 + Markdown 渲染
- PI 审批界面 + NextSuggestedAction
- 成本追踪 + CostMonitor
- LLM streaming + 对话驱动

### P3 — 可延期（8 周后）
- Docker 环境容器化
- CI/CD 流水线
- 用户/开发者/运维文档
- E2E 测试
- 性能优化
- 国际化
