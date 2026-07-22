# local-auth

D6 收缩口径鉴权：localhost 绑定 + 单一本地 token（grill 定案 1）。权威源：[ADR-0002](../../../../../docs/adr/0002-mvp-reality-anchoring.md) D6、[Auth_Permission_Design §1/§5](../../../../../docs/03_SPEC/Auth_Permission_Design.md)（local_single_user 模式）、[Schemas_APIs_CLIs §1.2](../../../../../docs/04_IMPLEMENTATION/Schemas_APIs_CLIs.md)（health 认证豁免规则）、[Config_Secrets_And_Environment_Spec](../../../../../docs/03_SPEC/Config_Secrets_And_Environment_Spec.md)（secrets 存放）。

## ADDED Requirements

### Requirement: workspace local-token mutation consistency

所有修改 `workspace/secrets/local-token` 及其协议条目的 SHUD-Harness writer SHALL 先在已打开的 `secrets` 目录 descriptor 上取得 exclusive nonblocking mutation lock；只有成功持锁才能构造并传递 mutation capability，publication、recovery、rollback 与 cleanup helper MUST 接受该 capability，不得接受裸目录 descriptor 作为写权限证明。持锁 writer SHALL 在 pathname mutation 前后校验已观察 generation，并在可观察 mismatch 时以 `LocalTokenStorageError` fail closed，不返回 authority。若当前 publication/recovery 调用已经观察到 foreign generation，该调用可为保持可恢复状态而清理 identity-proven 自有协议条目或恢复 foreign generation，但 MUST 失败且不得采纳该 generation 为 authority；只有后续独立调用 MAY 重新验证并复用稳定 canonical token。

本契约提供 cooperative-writer serialization，不声称 macOS/Linux 对一个拥有目录写权限且忽略 mutation lock 的进程提供 `rename/unlink only if pathname still names expected inode` 的线性化 compare-and-mutate 语义。已经在 mutation 前观察到的 foreign generation MUST NOT 被故意覆盖或删除；mutation 后观察到干扰时 MUST fail closed。

`secrets` mutation lock 尚不存在时，workspace leaf 与 `secrets` 目录创建属于 cooperative bootstrap。所有 SHUD-Harness creator MUST 先确认当前 process umask 与父目录 mode 不会把请求的 private `0700` 转换为其他 mode，再对最终目录名执行 no-clobber `mkdirat`；若创建环境会转换 mode，MUST 在 mkdir 前 fail closed 且不遗留最终名。creator 不得以 rename 替换该最终目录名，也不得创建随机目录-staging 名。初始观察为 absent 后若 `mkdirat` 返回 collision，当前调用 MUST fail closed；后续独立调用 MAY 重新打开并验证已存在的 private directory。进程在最终目录 mkdir 后终止时，重启 MUST 通过验证该最终目录继续收敛，且不得遗留不可发现的随机 bootstrap staging 条目。拥有父目录写权限、却替换刚创建 bootstrap pathname 的进程不在 cooperative bootstrap serialization 契约内；模块不承诺阻止该 active replacement，但现有 rebind/binding check 一旦观察到 replacement，MUST 返回 `LocalTokenStorageError` 且不得返回 authority。

#### Scenario: cooperative creator 并发创建 workspace leaf

- **WHEN** 两个 SHUD-Harness creator 经 barrier 同时从 absent observation 竞争最终 workspace-leaf 名称
- **THEN** 恰好一个公开 seam 调用成功、一个得到 `LocalTokenStorageError`；两者都不 rename 或覆盖最终目录名，失败方独立重试后复用成功方的 canonical token

#### Scenario: cooperative creator 并发创建 secrets

- **WHEN** 两个 SHUD-Harness creator 经 barrier 同时从 absent observation 竞争最终 `secrets` 名称
- **THEN** 恰好一个公开 seam 调用成功、一个得到 `LocalTokenStorageError`；两者都不 rename 或覆盖最终目录名，失败方独立重试后复用成功方的 canonical token

#### Scenario: bootstrap mkdir 后进程终止

- **WHEN** 进程在最终 workspace leaf 或 `secrets` mkdir 后、完成 token publication 前终止
- **THEN** 重启验证遗留的最终 private directory 并收敛，且父目录中不存在随机 bootstrap staging residue

#### Scenario: bootstrap 创建环境会转换 private mode

- **WHEN** process umask 会屏蔽 `0700` owner bits，或父目录的 setgid inheritance 会把新目录变为非精确 `0700`
- **THEN** workspace leaf 与 `secrets` 两个 creator 都在 `mkdirat` 前返回 `LocalTokenStorageError`，最终目录名不存在，后续在安全环境中可正常重试

#### Scenario: cooperative writer 被 mutation lock 串行化

- **WHEN** writer A 持有同一 `secrets` 目录 inode 的 exclusive mutation lock，writer B 通过公开 token-store seam 尝试 publication/recovery
- **THEN** writer B 在 2 秒内得到 `LocalTokenStorageError`，且不创建、rename 或 unlink 条目；A 释放 lock 后，B 可正常继续

#### Scenario: mutation 前已观察到 foreign generation

- **WHEN** 持锁 writer 在 mutation 前发现 pathname 不再指向先前观察的 `(dev, ino)`
- **THEN** 保留当前 generation、返回 `LocalTokenStorageError`，且不声称拥有 compare-and-mutate authority

#### Scenario: publication 或 recovery 观察到 foreign token generation

- **WHEN** live no-clobber publication collision、publishing recovery 或 rolling-back recovery 已经观察到与本 transaction 不同的 canonical/candidate generation
- **THEN** 当前调用保留 foreign inode/bytes、仅清理 identity-proven 自有协议条目并返回 `LocalTokenStorageError`；后续独立调用才可验证并复用稳定 canonical token

#### Scenario: token 通过真实 Bearer Header seam

- **WHEN** token store 读取或生成 token
- **THEN** 仅接受 1–4096 bytes 的 visible ASCII（`0x21`–`0x7e`）且排除 comma；该 token 经 Bun 1.2.19 的真实 `Headers`/`Request` 以 `Authorization: Bearer <token>` 精确 round-trip；non-ASCII、control、whitespace、comma、NUL、malformed UTF-8 均 fail closed 且不覆盖原文件

### Requirement: localhost 绑定

后端进程 SHALL 仅监听 `127.0.0.1`（不监听 0.0.0.0 或外网接口）；绑定地址 MUST 可测试断言。

#### Scenario: 服务不暴露非回环接口

- **WHEN** 检查服务启动配置/监听参数
- **THEN** 监听地址为 127.0.0.1

### Requirement: 单一本地 token 中间件

全部 `/api/**` 路由 SHALL 校验 `Authorization: Bearer <token>`；token 来源：`HARNESS_LOCAL_TOKEN` 环境变量，缺失时生成并持久化到 `workspace/secrets/local-token`（文件 0600、目录 0700）。`workspace/secrets/` 为本 change 新建目录：SHALL 加入 `WORKSPACE_CANONICAL_DIRECTORIES` 并联动 ready 检查，该子树 MUST NOT 被任何目录列举/读取端点服务（deny 子树，配套 requirement 见 artifact-evidence 与 data-provenance spec），token 值受 redaction 覆盖。豁免：`GET /api/health/live` 与 `GET /api/health/ready`（注册表 §1.2 行为规则）；Bearer 校验仅适用 `/api/**`，非 `/api` 面（前端入口页/静态资源）不做 Bearer 校验（token 经该面 bootstrap 分发，见「浏览器客户端 token bootstrap」）。校验失败 → 401 canonical envelope（`category=permission_error`——design D1：Error_Handling_Spec §1 frozen 枚举无 `auth` 类别，复用既有权限类别，不扩枚举），MUST NOT 回显 token 或期望值；token 值 MUST NOT 出现在任何日志（NDJSON 行只允许出现校验结果）。

#### Scenario: 无 token 请求被拒

- **WHEN** 不带 Authorization 调用 `GET /api/tasks`
- **THEN** 401 canonical envelope（`category=permission_error`）；NDJSON 日志记录 401 但不含 token 信息

#### Scenario: 正确 token 放行

- **WHEN** 带正确 Bearer token 调用 `GET /api/tasks`
- **THEN** 200，行为与 M1 一致

#### Scenario: health 探针豁免

- **WHEN** 不带 token 调用 `GET /api/health/live` 与 `GET /api/health/ready`
- **THEN** 均 200（ready 不泄露敏感路径，维持 M1 契约）

#### Scenario: 错误 token 被拒且不泄露

- **WHEN** 带错误 Bearer token 调用任意 `/api` 路由
- **THEN** 401；响应体与日志均不含正确 token 的任何字节

### Requirement: 浏览器客户端 token bootstrap（获取与携带）

后端 serve 前端入口页时 SHALL 将 token 注入页面 bootstrap 配置（inline `window.__HARNESS_BOOTSTRAP__`；仅回环监听 + 同源可读，不设 CORS 头，跨源页面无法读取注入值——design D1）。前端 SHALL 经统一 fetch wrapper（api 层唯一出口）为全部 `/api/**` 请求附加 `Authorization: Bearer <token>`；M1 既有 `window.fetch` 直连调用点（Dashboard 建卡/列表）MUST 迁移到该 wrapper。token MUST NOT 出现在 URL/query，MUST NOT 写入 localStorage 等持久化存储（页内存态，刷新随入口页重新注入）。本 requirement 是 M2 验收门「SideNav 浏览器走查」与 W2 UI/E2E 三条在 token 体制下的可达性前提。

#### Scenario: 浏览器端建卡在 token 体制下端到端成功

- **WHEN** 浏览器加载入口页后经 Dashboard 表单建卡并读取任务列表
- **THEN** 请求经 fetch wrapper 附带 Bearer token，全部成功；M1 浏览器建卡走查在 token 体制下可复现

#### Scenario: ResearchContext 读取附带 token

- **WHEN** activeTask 绑定 stack/data 后 SideNav 发起 `GET /api/stacks/:stackId` 与 `GET /api/data/:dataId`
- **THEN** 两请求均带 Bearer token 且 200（8.1 SideNav 走查可达）

#### Scenario: token 不落 URL 与持久化存储

- **WHEN** 检视入口页注入与全部前端请求
- **THEN** token 只出现在 bootstrap 注入与 Authorization header，不出现在任何 URL/query 或 localStorage

### Requirement: 既有测试面迁移

中间件落地的同一变更 SHALL 迁移 M1 全部路由测试到带 token 体制（测试 helper 统一注入），迁移后 M1 全部套件 MUST 保持绿（不弱化既有断言）。迁移范围 SHALL 含 `bun run check` 之外直打 `/api` 的 harness：`scripts/perf/api.ts`（PERF-API-001）注入测试 token。

#### Scenario: M1 回归保持绿

- **WHEN** 中间件合入后运行 `bun run check`
- **THEN** 全部既有套件通过，无跳过新增

#### Scenario: perf 冒烟在 token 体制下不回归

- **WHEN** 中间件合入后运行 `bun run test:perf:api`
- **THEN** PERF-API-001 各端点按预期状态码通过（无 401）
