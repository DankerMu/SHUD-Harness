# glm-provider

GLM 5.2 运行时模型 providers 配置与连通冒烟（ADR-0002 D9）。权威源：[ADR-0002](../../../../../docs/adr/0002-mvp-reality-anchoring.md) D9、[Zero_Reuse_Matrix §3](../../../../../docs/02_ARCHITECTURE/Zero_Reuse_Matrix.md) Provider 配置行、[Config_Secrets §3](../../../../../docs/03_SPEC/Config_Secrets_And_Environment_Spec.md)（SecretRef 形态）。

## ADDED Requirements

### Requirement: GLM providers 配置

zero `providers:` 配置块 SHALL 配置 GLM 5.2 第三方 OpenAI 兼容端点：`api_type: openai_chat_completions`、`base_url`、`api_key_ref`、`fallback_chain`，并按功能选模型（task_closure_model 等占位）。`api_key_ref` MUST 为 SecretRef 形态 `env:GLM_API_KEY`（provider=env，purpose=llm；[GRILL-3] 已定案 2026-07-03，Config_Secrets §4 已补行），配置、日志与任何落盘对象 MUST NOT 出现 secret 明文。

M1 临时 carrier `deepseek-v4-pro-guan` MUST NOT 出现在 Zero 消费的 `providers.*.models`、运行时 `default_model`、`fallback_chain`、`task_closure_model` 或 `context_compaction_model` 中；Zero provider 模型表与运行时 selector 仅保留/指向 `glm-dmxapi/target`。顶层 `smoke_model` 与 `fallback_smoke_model` 仅保存 raw carrier model id，供 smoke/后续迁移使用，不是 Zero model ref，不构成运行时准入。

Canonical readiness evidence MUST load exactly `<repoRoot>/config/providers/glm.dmxapi.json`; canonical CLI/API MUST NOT accept an alternate config path that can mint the same readiness note.

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

- **WHEN** 操作者尝试向 canonical smoke CLI/API 传入 repo 外或非默认 config
- **THEN** 调用被拒绝，且不能写出 canonical passing readiness note

### Requirement: 连通冒烟

系统 SHALL 提供冒烟脚本：以最小 prompt 经配置的 provider 完成一次往返，得到非空 completion，且请求实际命中配置的 `base_url`，脚本 exit 0。失败允许重试一次并记录。

每次运行前 SHALL 使旧 passing note 失效。若 owned `workspace/readiness` 下的 canonical final entry 是 symlink、hardlink 或其他不安全非目录项，失效逻辑 SHALL 仅移除该目录项、MUST NOT 跟随或改写外部 target；随后发布当前结果或保持 canonical path 不可读为 pass。

#### Scenario: 冒烟通过

- **WHEN** 端点可达且 key 有效时运行冒烟脚本
- **THEN** 得到非空 completion、验证命中配置的 `base_url`、exit 0，结论记入 readiness notes

#### Scenario: key 缺失有明确错误

- **WHEN** 环境变量未设置时运行冒烟脚本
- **THEN** 脚本以明确错误退出（指出缺失的变量名），不泄露任何已配置的 secret 值

#### Scenario: unsafe final entry 不保留旧 pass

- **WHEN** canonical note 是指向 passing JSON 的 symlink/hardlink，随后当前 smoke 失败
- **THEN** 外部 target 内容不变，canonical note 不存在或为当前 failed note，绝不仍可读为 passed

### Requirement: 冒烟不等于准入

冒烟通过 SHALL NOT 视为模型准入；正式准入门 = M8 金样 eval 全量首跑（治理/注入类达标）。M1 冒烟结论仅记入 readiness notes，MUST NOT 产生准入类记录或写入 StackLock。

#### Scenario: 无准入侧写

- **WHEN** M1 冒烟通过后检查系统状态
- **THEN** 不存在模型准入记录；StackLock 对象尚未创建（M2 交付）
