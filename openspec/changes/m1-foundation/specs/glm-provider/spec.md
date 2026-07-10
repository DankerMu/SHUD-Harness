# glm-provider

GLM 5.2 运行时模型 providers 配置与连通冒烟（ADR-0002 D9）。权威源：[ADR-0002](../../../../../docs/adr/0002-mvp-reality-anchoring.md) D9、[Zero_Reuse_Matrix §3](../../../../../docs/02_ARCHITECTURE/Zero_Reuse_Matrix.md) Provider 配置行、[Config_Secrets §3](../../../../../docs/03_SPEC/Config_Secrets_And_Environment_Spec.md)（SecretRef 形态）。

## ADDED Requirements

### Requirement: GLM providers 配置

zero `providers:` 配置块 SHALL 配置 GLM 5.2 第三方 OpenAI 兼容端点：`api_type: openai_chat_completions`、`base_url`、`api_key_ref`、`fallback_chain`，并按功能选模型（task_closure_model 等占位）。`api_key_ref` MUST 为 SecretRef 形态 `env:GLM_API_KEY`（provider=env，purpose=llm；[GRILL-3] 已定案 2026-07-03，Config_Secrets §4 已补行），配置、日志与任何落盘对象 MUST NOT 出现 secret 明文。

M1 临时 carrier `deepseek-v4-pro-guan` MUST NOT 出现在 Zero 消费的 `providers.*.models`、运行时 `default_model`、`fallback_chain`、`task_closure_model` 或 `context_compaction_model` 中；Zero provider 模型表与运行时 selector 仅保留/指向 `glm-dmxapi/target`。顶层 `smoke_model` 与 `fallback_smoke_model` 仅保存 raw carrier model id，供 smoke/后续迁移使用，不是 Zero model ref，不构成运行时准入。

Canonical readiness evidence MUST load exactly `<canonicalRepoRoot>/config/providers/glm.dmxapi.json`, where `canonicalRepoRoot` is resolved from the source checkout rather than caller input. Canonical CLI/API MUST NOT accept repo root, config path, fetch transport, environment, clock, or timeout overrides that can mint the same readiness note. The canonical storage writer and full canonical schema validation MUST be private to the fixed-authority canonical engine; no exported non-smoke function may write `glm_provider_smoke.json`. Test-only dependency injection MUST use an explicitly noncanonical fixture entrypoint, MUST NOT target `canonicalRepoRoot`, and MUST write a different note filename carrying `evidence_scope: fixture` so #38 cannot consume it as canonical readiness.

#### Scenario: secret 不落盘

- **WHEN** 加载 providers 配置并运行冒烟
- **THEN** 所有日志、配置快照与产物中仅出现 `env:GLM_API_KEY` 形式的 ref，无 key 明文

#### Scenario: 临时 carrier 不进入运行时 fallback

- **WHEN** Zero loader 加载 M1 provider 配置且 target 不可用
- **THEN** 运行时 `fallback_chain` 不包含 `glm-dmxapi/smoke`，ModelRouter 不会选择临时 carrier

#### Scenario: 临时 carrier 不进入 Zero registry

- **WHEN** Zero loader/ModelRouter 加载 M1 provider 配置
- **THEN** model list/resolve/switch 均不包含或选择 `deepseek-v4-pro-guan` carrier，smoke 脚本仍以顶层 `smoke_model` 调用 provider

#### Scenario: canonical evidence 绑定 tracked config

- **WHEN** 操作者尝试向 canonical smoke CLI/API 传入 repo root、repo 外/非默认 config 或其他 evidence-authority override
- **THEN** 调用被拒绝，且不能写出 canonical passing readiness note

#### Scenario: fixture evidence 不冒充 canonical readiness

- **WHEN** 离线测试以 temp root、fake fetch/env/clock 或短 timeout 运行 smoke fixture
- **THEN** 仅产生带 `evidence_scope: fixture` 的非 canonical 文件，不能写 canonical filename，也不能以 canonical repo root 运行

### Requirement: 连通冒烟

系统 SHALL 提供冒烟脚本：以最小 prompt 经配置的 provider 完成一次往返，得到非空 completion，且请求实际命中配置的 `base_url`，脚本 exit 0。每次 attempt timeout 固定为 15000ms，失败允许重试一次并记录；canonical CLI/API 不提供 timeout override。取得 Response 后若因 endpoint validation 或 non-2xx 提前失败，系统 MUST 在同一 attempt deadline 内取消未读 body 并 abort request，MUST NOT 为清理读取 provider 内容。失败结果、readiness note 与 CLI 输出 MUST 仅包含本地构造的结构化事实，MUST NOT 持久化或输出 provider response body、status text、headers 或外部异常原文。

每次 canonical 运行前 SHALL 使旧 passing note 失效，包含 CLI unsupported/incomplete/invalid preflight 失败。若 canonical `workspace`、`workspace/readiness` ancestor 或 final entry 是 symlink / 非预期类型，失效逻辑 SHALL 仅移除 canonical checkout 下的本地不安全目录项、MUST NOT 跟随或改写外部 target；随后发布当前结果或保持 canonical path 不可读为 pass。若 expected realpath/type 的 ancestor 由当前 uid 拥有但 mode 缺少 owner rwx，canonical authority SHALL 恢复 owner rwx 后再失效/发布，不得删除目录或改写 sibling readiness notes；非当前 uid 所有的目录仍为 authority error。final hardlink 采用同样的 external-target 不变规则。单链接 regular 旧 note 在读取前 MUST 以 metadata size 上限检查；超限文件 MUST 在不读取内容的前提下安全移除/替换；size 内但因权限不可读的 leaf MUST 在目录 authority 恢复后按不可信旧证据移除，不能保留可能的 pass。

#### Scenario: 冒烟通过

- **WHEN** 端点可达且 key 有效时运行冒烟脚本
- **THEN** 得到非空 completion、验证命中配置的 `base_url`、exit 0，结论记入 readiness notes

#### Scenario: key 缺失有明确错误

- **WHEN** 环境变量未设置时运行冒烟脚本
- **THEN** 脚本以明确错误退出（指出缺失的变量名），不泄露任何已配置的 secret 值

#### Scenario: unsafe final entry 不保留旧 pass

- **WHEN** canonical note 是指向 passing JSON 的 symlink/hardlink，随后当前 smoke 失败
- **THEN** 外部 target 内容不变，canonical note 不存在或为当前 failed note，绝不仍可读为 passed

#### Scenario: CLI preflight 失败不保留旧 pass

- **WHEN** 已有 passing note 后以 unsupported、incomplete 或 invalid 参数调用 canonical CLI
- **THEN** CLI 以固定本地错误退出且不回显 raw argv，canonical note 不存在或为当前 failed note，绝不仍为 passed

#### Scenario: oversized 旧 note 有界失效

- **WHEN** canonical note 是超过本地 size cap 的单链接 regular file
- **THEN** 失效逻辑不读取其内容，安全移除/替换，并能继续发布当前结果或保持 canonical path 不可读为 pass

#### Scenario: unsafe ancestor 不保留外部旧 pass

- **WHEN** canonical `workspace` 或 `workspace/readiness` 是指向含 passing note 外部目录的 symlink，随后 unsupported CLI 或 missing-key canonical smoke 失败
- **THEN** 仅本地 symlink 被移除，外部目录/note 内容不变，canonical path 不存在或为当前 failed note，绝不仍可读为 passed

#### Scenario: owned 目录权限不足不保留旧 pass

- **WHEN** 当前 uid 所有的 canonical `workspace` / `workspace/readiness` 缺少 owner 写/执行权限，或 canonical regular leaf 在 size cap 内但不可读，随后 unsupported CLI 或 missing-key smoke 失败
- **THEN** authority 恢复 owned ancestor 的 owner rwx、保留 sibling notes，移除不可信 leaf 或发布当前 failed note，canonical path 绝不仍为 passed

#### Scenario: no-read 失败关闭 response body

- **WHEN** provider 返回 non-2xx 或 final URL validation 失败且 body 是未结束 stream
- **THEN** body cancellation/request abort 在 15000ms attempt deadline 内发生，不读取/落盘 body 内容，最多重试一次

### Requirement: 冒烟不等于准入

冒烟通过 SHALL NOT 视为模型准入；正式准入门 = M8 金样 eval 全量首跑（治理/注入类达标）。M1 冒烟结论仅记入 readiness notes，MUST NOT 产生准入类记录或写入 StackLock。

#### Scenario: 无准入侧写

- **WHEN** M1 冒烟通过后检查系统状态
- **THEN** 不存在模型准入记录；StackLock 对象尚未创建（M2 交付）
