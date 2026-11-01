---
status: proposed
kind: architecture
---

# ADR-0012: Full-access approval regression 的测试专用公开 seam

## 背景

[#511](https://github.com/DankerMu/SHUD-Harness/issues/511) 的 full-access 预设在钉版 dsh 0.2.1-rc.2 中把 approval policy 设为 never。真实 ApprovalService 在发出 approval/request 之前自动拒绝；仅替换 approval.request 的既有测试无法发现该问题。asked/decided 日志也不能单独证明审批请求曾到达 answerer。

[ADR-0006](../implemented/0006-dsh-jobs-seam-imports.md) 默认禁止这些宿主服务的运行时导入。本记录按 [full-access-pi-approval design](../../../openspec/changes/full-access-pi-approval/design.md) 为一个行为回归提出窄例外，不扩大生产 seam，也不宣称已获 PI 接受。

## 选择与边界

仅 `packages/dsh-shud-policy-gate/src/full-access-approval.test.ts` 可具名运行时导入下列已发布包的公开能力：

| 包 | 唯一允许的运行时名称 | 用途 |
| --- | --- | --- |
| @deepseek-ai/dsh-permission-presets | PermissionPresetService | 走真实预设选择及持久 knob 写入 |
| @deepseek-ai/dsh-user-approval | ApprovalService | 执行实际 policy-before-answerer 路由 |
| @deepseek-ai/dsh-session | SessionStore | 创建真实 Session、追加 turn 与审批事件 |
| @deepseek-ai/dsh-session-projection | SessionProjectionRegistry | 折叠真实权限状态 |
| @deepseek-ai/dsh-system-prompt | SystemPrompt | 满足真实 ToolRuntime/ApprovalService 装配，不伪造内部 prompt 服务 |

既有 Cordis、ToolRuntime、defineTool 和测试专用 createScope 规则不变。禁止这些新能力的 default、namespace、其它具名、空声明与副作用导入；同名文件在其它目录、其它测试、共享 harness、生产文件均无例外。宿主 checkout 路径（含类型）、内部 subpath、agent-loop-testkit 和其它未授权宿主运行时入口继续被拒。类型导入仍遵守 ADR-0006 的 declaration-level 规则。

`eslint.config.mjs` 使用精确文件路径和能力名称实施此边界；`scripts/guardrails/test-guardrails.sh` 保留原有具化 fixture 的 type-aware CLI 自证。需要注入精确授权路径的正反例改用 ESLint API `lintText`：正常加载仓库配置，仅在该自证实例追加 `disableTypeChecked`，以独立解析所提供的 fixture 字节，避免 typed project 重用同路径真实文件的 SourceFile。导入限制是语法规则，仍使用该精确路径的原配置；不覆盖真实测试文件、不放宽限制、不允许空诊断冒充反例。生产 lint 与完整质量闸仍保持 type-aware，原有正反例及精确 rule/severity 校验不变。

## 回归与依赖

测试读取 canonical `profile/shud/cordis.patch.yml`，按既有 profile-patch 元数据读取模式把 Loader 的 !!js 保持为惰性字符串。approval/permission 的 id patch 替换完整 config；缺少 patch 时保留钉版 base 的原行为，而非因缺配置失败。

基线取自钉版 dsh-base 的 approval/permission 配置：从 DSH_PERMISSION_MODE 读取启动模式，full-access 启动默认 never、其它模式默认 ask；catalog 保留 read-only、workspace-write、danger-full-access 三项，最后一项对应 never。它不是 PermissionPresetService 仅两项的类默认值，也不是测试内预先改成 ask 的“修复”。该已核对基线是测试输入，不从本地证据目录读取，也不依赖宿主 checkout 的运行时导入。宿主升级时须同时重新核对该基线与公开服务行为。

最小新增 devDependencies 均精确钉版 0.2.1-rc.2：

- @deepseek-ai/dsh-permission-presets：被测真实公开服务。
- @deepseek-ai/dsh-commands：该已发布服务在模块加载时实际导入 commands/brand；非可省略的类型依赖。

其它所需运行时 peers（包括 approval、session、projection、sandbox-policy、typert-protocol、scope、brand、system-prompt）已由 policy-gate 测试包声明。commands 的 util-crypto 是其已发布直接依赖，由锁文件记录。不为未执行的 shell/command 服务扩大依赖闭包；autoInstallPeers 仍为 false，不新增 npm dsh 宿主依赖。

测试使用真实 ToolRuntime 和 SHUD policy-gate，把 report_submit/report_decide 的执行端限制为计数边界，不复制报告状态机；Agent 和不执行命令的 filesystem executor 仅提供服务所需的外部身份/默认模式。真实 approval/request answerer 持有未完成的响应，测试与工具实际结算竞速，断言 full-access 仍被选中、请求实际到达、工具尚未执行且没有决定事件，随后仅 allowed-once 放行一次。拒绝、取消与未安装 answerer 的不可用路径均断言不执行。finally 取消请求、释放响应、在 watchdog 界限内观察操作、dispose Cordis 并删除自有临时目录；watchdog 超时不代表操作已经结算。

覆盖还包括三种模式的实际 knob 转换和重复选择无事件追加、环境选定 full-access 的初始 ask 与真实 dispatch、旧 full-access/never 会话事件 replay 后保持原策略及历史，直到显式公开预设重选才追加 ask 并允许审批。所有 helper 留在这个精确授权文件；不扩展共享 harness 或生产导入许可。

## 证据限制

父工作流负责运行 focused RED/GREEN、完整质量闸及隔离的 full-access Web 验证，并将实际命令、结果和限制记录在关联 PR；本 ADR 不维护瞬时验证状态。测试不能替代真实 Web 卡显示、session 文件持久化恢复或 PI 功能验收；执行计数边界不声称验证报告/TaskCard 写入。既有报告决定测试不替换或删除。
