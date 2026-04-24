# SHUD-Harness v0.8 设计方案完善计划

> 本文件追踪 PRD + SPEC 层面尚未设计或设计不充分的方案空白。
> 每一项的交付物是**设计文档/规格定义**，不是代码。
> 完成本清单后，任何工程师拿到文档即可直接编码，无需再做设计决策。

---

## 1. 主 Agent 架构方案 ⭐

> 当前空白：SPEC 只定义了 Coordinator 的 system prompt 和状态机，但没有回答关键架构问题。

- [ ] **Agent 实例模型**：Coordinator/Worker/Reviewer 是同一个 LLM 实例切换 prompt，还是独立 spawn 的子 agent？各自的生命周期是什么？
- [ ] **Agent 间通信协议**：Coordinator 如何把任务派给 Worker？Worker 结果如何回传？消息格式是什么？
- [ ] **Coordinator 决策树完整化**：当前 SPEC 6.3 只有 Brief/Plan/Execute/Report 四阶段的伪代码，需要补齐所有分支条件和边界情况
- [ ] **科研 Closure 判据**：任务何时算"完成"？何时必须进入 awaiting_pi？判据清单和优先级
- [ ] **Agent 上下文管理**：每次 agent 轮次加载哪些对象到 context？如何控制 token 消耗？context 压缩策略
- [ ] **多 Agent 并发规则**：敏感性分析 6 组参数扫描，是串行 Worker 还是并行 spawn？并发上限？

**交付物**: `docs/02_ARCHITECTURE/Agent_Architecture.md`

---

## 2. Park/Resume 详细设计

> 当前空白：SPEC 5.3 只有一段文字描述，缺少状态持久化格式、恢复流程、边界条件。

- [ ] **Parked 状态存储格式**：agent 退出时保存什么？TaskCard + 当前 plan step + 已完成的 RunRecords？文件格式(YAML? JSON?)
- [ ] **Job 完成检测**：轮询 PID？文件锁 sentinel？后端 watcher 进程？
- [ ] **Resume 触发机制**：后端自动检测并恢复？还是 PI 在前端手动点击 "Resume"？
- [ ] **Resume 上下文重建**：恢复时给 Coordinator 的 prompt 长什么样？包含哪些历史信息？
- [ ] **异常场景**：parked 期间服务重启怎么办？Job 完成但 agent 已过期怎么办？多个 parked task 同时恢复的优先级？

**交付物**: `docs/03_SPEC/Park_Resume_Design.md`

---

## 3. WebSocket 消息协议

> 当前空白：SPEC 只写了 `WS /ws/session/:sessionId`，没有定义消息格式。

- [ ] **消息类型枚举**：agent_message / llm_streaming / job_log / system_event / cost_update / approval_request
- [ ] **每种消息的 JSON schema**：必填字段、可选字段、类型定义
- [ ] **Agent 角色消息格式**：如何区分 Coordinator / Worker / Coder / Reviewer？折叠详情的数据结构？
- [ ] **LLM streaming 格式**：逐 token 推送？逐句推送？delta 格式？
- [ ] **日志流格式**：是否需要 ANSI 颜色码？行号？时间戳精度？
- [ ] **断线重连协议**：重连后如何补发错过的消息？消息缓冲深度？
- [ ] **心跳机制**：ping 间隔？超时判定？

**交付物**: `docs/03_SPEC/WebSocket_Protocol.md`

---

## 4. 前端状态管理 & 数据流

> 当前空白：组件列表已完整，但组件之间如何协作没有设计。

- [ ] **全局状态结构**：Session / Tasks / AgentMessages / RunRecords / CostMetrics 的状态树设计
- [ ] **状态管理方案选型**：React Context vs Zustand vs Jotai？选型理由
- [ ] **WebSocket → 状态更新流**：消息到达后如何路由到对应组件？
- [ ] **四栏联动规则**：点击 SideNav 切换会话 → 哪些面板跟着更新？Agent Feed 收到新 RunRecord → Experiment Dashboard 如何自动刷新？
- [ ] **乐观更新策略**：PI 点击审批后，前端立即更新还是等后端确认？
- [ ] **缓存 & 分页**：会话历史是否分页？大量 Agent 消息的虚拟滚动？

**交付物**: `docs/03_SPEC/Frontend_State_Design.md`

---

## 5. 可视化数据规格

> 当前空白：图表组件已定义，但图表的数据接口未规定。

- [ ] **水文过程线数据格式**：时间戳精度？多系列(obs/baseline/exp)的 JSON 结构？数据量上限？
- [ ] **敏感性热力图数据格式**：参数 × 指标矩阵的 JSON 结构？归一化方式？颜色映射规则？
- [ ] **参数集表格数据格式**：列定义？排序键？最优高亮规则？
- [ ] **指标卡片数据格式**：NSE/Peak Error/Timing 的计算公式确认？与 baseline 的 delta 计算方式？
- [ ] **图表库选型**：ECharts vs Plotly vs D3 vs Recharts — 性能/交互/bundle size/学习曲线权衡分析
- [ ] **图表交互规格**：缩放范围限制？tooltip 内容？图例行为？导出(PNG/SVG)？

**交付物**: `docs/03_SPEC/Visualization_Data_Spec.md`

---

## 6. 认证 & 权限模型

> 当前空白：完全未设计。影响所有 API 和前端。

- [ ] **用户模型**：单用户(PI only)？多用户(PI + 工程师 + 数据支持)？
- [ ] **认证方式**：API Key？OAuth2？用户名密码？Session cookie vs JWT？
- [ ] **权限矩阵**：谁能创建 task？谁能审批？谁能删除数据？谁能查看成本？
- [ ] **会话管理**：session 过期时间？并发 session 限制？
- [ ] **API 密钥管理**：LLM API key 在哪里配置？如何安全存储？

**交付物**: `docs/03_SPEC/Auth_Permission_Design.md`

---

## 7. 报告生成规格

> 当前空白：SPEC 4.7 有 EvidenceReport schema，但生成流程和模板结构未定义。

- [ ] **模板引擎选型**：Jinja2 (.j2)? Handlebars? 纯 TS template literal? Mustache?
- [ ] **报告模板结构**：每个 section 的数据来源映射（哪些字段从 RunRecord 取？哪些从 AnalysisPlan 取？哪些 LLM 生成？）
- [ ] **LLM 生成文字的约束**：observations 只描述数据不做因果推断 — 如何在 prompt 中强制？质量检查机制？
- [ ] **报告审批流转**：draft → pi_reviewed → accepted 的状态转换由谁触发？PI 可以 inline 批注吗？
- [ ] **报告版本管理**：修订后旧版本保留吗？diff 展示？
- [ ] **报告导出格式**：Markdown only？PDF？HTML？

**交付物**: `docs/03_SPEC/Report_Generation_Spec.md`

---

## 8. 错误处理 & 异常流规格

> 当前空白：SPEC 5.4 列了失败场景表格，但缺少统一的错误处理架构。

- [ ] **API 错误响应格式**：统一 JSON 结构 (code/message/details)？HTTP 状态码映射？
- [ ] **Agent 执行错误分类**：编译失败 / 运行崩溃 / 超时 / 数据缺失 / 权限拒绝 — 每种错误的处理路径和用户呈现方式
- [ ] **前端错误展示策略**：Toast？Modal？内嵌错误面板？Agent 活动流中展示？
- [ ] **重试策略**：哪些错误可重试？退避间隔？最大次数？
- [ ] **降级策略**：WebSocket 断开时前端降级为轮询？LLM 超时时回退到模板报告？

**交付物**: `docs/03_SPEC/Error_Handling_Spec.md`

---

## 9. Sandbox 安全规格细化

> 当前空白：SPEC 5.2 定义了可写/只读/禁写路径，但缺少实施细节。

- [ ] **路径白名单精确定义**：正则表达式？glob 模式？runtime 注入还是静态配置？
- [ ] **bash 命令安全检查**：哪些命令禁止（rm -rf /, curl 外部地址）？fuse list 设计？
- [ ] **文件系统变更追踪**：每条命令执行后扫描文件变更的方式？inotify? 前后 diff?
- [ ] **网络访问控制**：sandbox 内是否允许网络请求？白名单域名？
- [ ] **资源限制**：单命令内存/CPU 上限？cgroup? ulimit?

**交付物**: 更新 `docs/03_SPEC/Sandbox_and_Executor.md` 增加实施细节

---

## 10. Zero 扩展点映射

> 当前空白：Zero_Reuse_Matrix 列了 [E]/[O]/[A] 标记，但没有具体到代码层面。

- [ ] **AgentLoop Hook 扩展清单**：需要添加哪些 hook？每个 hook 的签名和触发时机？
- [ ] **Tool 注册方式**：SHUD 专用工具如何注册到 Zero 的 ToolRegistry？BaseTool 子类结构？
- [ ] **Role 定义文件格式**：Zero 用 `.zero/roles/*.toml`，SHUD 的 Coordinator/Worker/Reviewer 用同样格式还是扩展？
- [ ] **Session 扩展**：如何在 Zero Session 中存储 SHUD 领域状态（当前 TaskCard, StackLock）？
- [ ] **Memory 系统修改方案**：具体改 Zero 哪个文件的哪个函数？fork 还是 monkey-patch？
- [ ] **Prompt 构建扩展**：如何把 SHUD 领域 context (StackLock, DataProvenance, Notes) 注入到 system prompt？

**交付物**: `docs/02_ARCHITECTURE/Zero_Extension_Map.md`

---

## 11. 部署架构

> 当前空白：完全未设计。

- [ ] **部署拓扑**：单机部署？前后端分离？容器编排？
- [ ] **SHUD 运行环境**：是和 Harness 同一台机器？还是 SSH 到远程服务器？Docker 隔离？
- [ ] **R 环境方案**：R 直接装在 host？Docker 容器中？renv 环境如何保证一致性？
- [ ] **数据持久化**：workspace 和 DuckDB 存储在哪？volume mount？备份策略？
- [ ] **HTTPS & 域名**：是否需要？自签名证书还是 Let's Encrypt？
- [ ] **资源需求**：最低硬件配置（CPU/RAM/Disk）？推荐配置？

**交付物**: `docs/04_IMPLEMENTATION/Deployment_Architecture.md`

---

## 12. SHUD 输出变量目录

> 当前空白：SPEC 提到 "~50 个输出变量" 但从未列举。影响 HydrographChart 变量切换、ResultsOverview 指标选择。

- [ ] **完整变量清单**：变量名 / 物理含义 / 单位 / 数据类型 / 典型值范围
- [ ] **变量分类**：地表水 / 地下水 / 河道 / 蒸散发 / 土壤水 等
- [ ] **前端展示优先级**：哪些变量默认展示？哪些可选？
- [ ] **诊断变量定义**：SPEC 提到 "event-scale diagnostics" 到底是哪些变量？已有还是需要新增？
- [ ] **数值健康指标公式**：water_balance_residual, NSE, KGE, Peak Error, Timing Error 的精确计算公式

**交付物**: `docs/03_SPEC/SHUD_Output_Variables.md`

---

## 13. 敏感性分析 & 校准规格细化

> 当前空白：AnalysisPlan schema 已定义，但参数空间和执行策略未设计。

- [ ] **参数空间定义**：每个可调参数的名称、物理含义、允许范围、默认值、推荐扫描值
- [ ] **扫描策略**：one_at_a_time? full factorial? Latin hypercube? 策略选择依据
- [ ] **批量执行方案**：6 组参数 → 6 次 SHUD 运行，串行还是并行？资源分配？
- [ ] **结果聚合方式**：如何从 6 个 RunRecord 生成一张 sensitivity table？聚合脚本的输入输出格式
- [ ] **校准 → 验证转换规则**：何时从 sensitivity 模式切换到 calibration？holdout 事件如何选择？
- [ ] **校准收敛判据**：多少轮迭代？目标函数值阈值？

**交付物**: 更新 `docs/03_SPEC/Sensitivity_Calibration_Benchmark.md` 增加上述内容

---

## 14. Workspace & 文件约定

> 当前空白：SPEC 5.1 列了目录树，但文件命名、ID 生成、清理策略未定义。

- [ ] **ID 生成规则**：TASK-0001 递增？UUID？时间戳前缀？
- [ ] **文件命名约定**：RunRecord 文件名、报告文件名、patch 文件名的模式定义
- [ ] **文件生命周期**：scratch 何时清理？artifacts 保留多久？runs 是否可归档？
- [ ] **存储上限**：单任务 workspace 大小上限？总存储预算？
- [ ] **跨任务引用**：TASK-0002 能引用 TASK-0001 的 RunRecord 吗？如何 link？

**交付物**: `docs/03_SPEC/Workspace_Conventions.md`

---

## 15. 国际化 & 本地化

> 当前空白：CLAUDE.md 要求"中文回复"，但前端 UI 语言方案未确定。

- [ ] **默认语言**：前端 UI 中文？英文？可切换？
- [ ] **Agent 输出语言**：Coordinator 报告用中文还是英文？可配置？
- [ ] **日期/数字格式**：跟随浏览器 locale？固定 ISO 格式？
- [ ] **技术方案**：i18next? react-intl? 静态编译?

**交付物**: 在 SPEC 中补充一节，或独立文档

---

## 16. 成本追踪详细设计

> 当前空白：Cost_Inference_Budget 定义了 advisory 模式，但追踪机制未设计。

- [ ] **LLM 成本计算公式**：input tokens × price + output tokens × price？模型价格表？
- [ ] **计算成本计算公式**：wall time × CPU 单价？还是纯粹记录 wall time？
- [ ] **成本数据存储**：每次 LLM 调用记录到哪？DuckDB? 内存? 文件?
- [ ] **成本 Dashboard 数据聚合**：按任务/按天/按 Agent 的聚合 SQL？
- [ ] **advisory 超出通知方式**：CostMonitor 组件变色的触发逻辑？阈值计算？

**交付物**: 更新 `docs/03_SPEC/Cost_Inference_Budget.md` 增加追踪机制

---

## 17. 测试策略

> 当前空白：无测试相关设计文档。

- [ ] **测试金字塔定义**：单元 / 集成 / E2E 的比例和覆盖目标
- [ ] **测试框架选型**：Vitest? Jest? 前端 Testing Library? E2E 用 Playwright?
- [ ] **Tiny fixture baseline**：ccw 30-day 的预期输出数值是什么？浮点容差多少？
- [ ] **rSHUD roundtrip 通过标准**：数值精度要求？
- [ ] **Mock 策略**：测试中如何 mock LLM 调用？mock SHUD 运行？

**交付物**: `docs/04_IMPLEMENTATION/Testing_Strategy.md`

---

## 18. CI/CD & 发布流程

> 当前空白：无 DevOps 设计。

- [ ] **分支策略**：main + feature branches? GitFlow? Trunk-based?
- [ ] **CI 流水线定义**：lint → type check → unit test → build → integration test
- [ ] **发布策略**：语义版本？tag 触发？changelog 生成？
- [ ] **环境管理**：dev / staging / production 的区分和配置

**交付物**: `docs/04_IMPLEMENTATION/CICD_Release.md`

---

## 优先级

| 优先级 | 项目 | 理由 |
|--------|------|------|
| **P0** | 1. 主 Agent 架构 | 所有 Agent 行为的根基，不决定无法写代码 |
| **P0** | 10. Zero 扩展点映射 | 决定如何与 Zero 集成，影响整个代码结构 |
| **P0** | 3. WebSocket 消息协议 | 前后端通信契约，不定义无法并行开发 |
| **P1** | 2. Park/Resume 详细设计 | 核心差异化特性，影响状态机 |
| **P1** | 6. 认证 & 权限 | 影响所有 API 和前端 |
| **P1** | 12. SHUD 输出变量目录 | 影响可视化组件和 Skill 设计 |
| **P1** | 5. 可视化数据规格 | 前端核心组件的数据契约 |
| **P2** | 4. 前端状态管理 | 可以在实现中迭代，但提前设计减少返工 |
| **P2** | 7. 报告生成规格 | Week 7 才需要，但模板结构提前定 |
| **P2** | 9. Sandbox 安全细化 | 已有框架，补细节 |
| **P2** | 11. 部署架构 | 影响 Week 8 交付 |
| **P2** | 13. 敏感性分析细化 | Week 6 需要 |
| **P3** | 8. 错误处理规格 | 可在实现中逐步完善 |
| **P3** | 14. Workspace 约定 | 简单决策，文档化即可 |
| **P3** | 15. 国际化 | MVP 后再考虑 |
| **P3** | 16. 成本追踪细化 | 已有框架，补实现细节 |
| **P3** | 17. 测试策略 | 可与实现同步推进 |
| **P3** | 18. CI/CD | 8 周后再完善 |
