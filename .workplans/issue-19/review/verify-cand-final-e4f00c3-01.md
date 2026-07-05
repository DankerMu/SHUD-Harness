# Finding Verification - cand-final-e4f00c3-01

Verifier verdict for: cand-e4f00c3-01-ambient-env-secrets
Reviewed head SHA: `e4f00c39aebc0fa6bfbc609a973ec9ff3d8c5c6a`
Verdict: CONFIRMED

Evidence: `packages/core/src/tools/raw-data-sandbox.ts:1635-1638` spawns the sandboxed bash process with `env: { ...buildSanitizedToolProcessEnv(ctx), ...resolvedSecrets.env }`; `:1952-1960` copies all defined `process.env` entries and deletes only `BASH_ENV`, `ENV`, and `BASH_FUNC_*`, so `GLM_API_KEY`/`OPENAI_API_KEY`/`SMTP_PASSWORD` remain. Captured stdout/stderr becomes `ToolResult.output` at `:1735-1748`. Ambient env values are not registered because no secret input returns `secrets: []` at `:1827-1828`, and `ctx.secretFilter?.addSecret(...)` is only called while resolving explicit secret refs at `:1948`; filtering at `:2559-2565` can only redact registered values. The spec lists those env secrets at `docs/03_SPEC/Config_Secrets_And_Environment_Spec.md:57-64` and requires secret redaction/no secret values in artifacts at `:48` and `:72-80`.

Note: The output leak path is constructible with `printf "$GLM_API_KEY"`; the profile also allows network via `(allow network*)`.
