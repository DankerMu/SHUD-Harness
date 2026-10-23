Project profile: SHUD-Harness（dsh 内核，ADR-0004）

Living artifact maintained by `subagent-workflow` Phase 0.0/0.5. Rewritten 2026-10-20 at the Phase 4 reset; the Zero-era profile is in tag `archive/zero-v0.8.3`.

Entry surfaces:
- `packages/dsh-shud-*/` TypeScript plugin packages (pnpm workspace, `tsc` → `lib/`, vitest). Present: `dsh-shud-core` (8 object Zod schemas, policy-gate-core, role-tool-map). Planned per `docs/04_IMPLEMENTATION/Repository_Layout.md`: `raw-guard`, `jobs`, `tools`, `records`, `presets`.
- `profile/shud/` dsh bundle (`package.json` + `cordis.patch.yml`): model routing, outbound channel switches, plugin mounts by workspace package specifier. The bundle declares `dependencies["@shud-harness/dsh-shud-raw-guard"] = "workspace:*"`; its patch inserts `name: '@shud-harness/dsh-shud-raw-guard'`. The product is `dsh --profile shud`; there is no app of our own.
- `scripts/schema/` (Zod → `docs/generated/{schema,json-schema}`), `scripts/docs/` (link checker); `skills/`, `scripts/` (R/bash), `templates/` to come with M3.
- Contract sources: `docs/adr/implemented/0004-dsh-kernel.md`, `docs/04_IMPLEMENTATION/Phased_Plan.md` (M1–M6, sole truth for gates), `docs/03_SPEC/*`, `docs/00_INDEX/CANONICAL_CONTRACTS.md`, `openspec/changes/*`.
- Host: dsh checkout `../deepseek-harness` pinned `dsh-v0.2.1-rc.2` — read-only runtime host, never modified, never imported from loop internals. Plugin types come from published devDependencies `@deepseek-ai/dsh-tools@0.2.1-rc.2` and `@deepseek-ai/cordis@4.0.5`, not the checkout. Spike evidence: `../dsh-spike/runs/1.1–1.5`.
- Read-only submodules: `SHUD/`, `rSHUD/`, `AutoSHUD/`.

Contracts:
- Plugins touch only documented seams: `tools/pre-execute` waterfall (`allow|deny|cancel|ask`), `ctx.tools.guard()`, `ctx.approval` (fail-closed), `ctx.jobs` (`JobRegistry`), `ctx.sandbox`, `ctx.storage`, agent presets. A needed-but-missing seam is a reported deviation, not a fork.
- 8 core objects (TaskCard, StackLock, DataProvenance, RunJob, RunRecord, AnalysisPlan, EvidenceReport, ChangeRequest); field source = `docs/03_SPEC/Minimal_Schemas.md`, code = `packages/dsh-shud-core/src/schemas/`, projection = `docs/generated/` (must not drift).
- StackLock.llm = `base_url` + `request_alias` + `response_model` (K4); response_model recorded, never auto-invalidates a lock. Code still carries the old llm fields until M3 (recorded drift, `docs/04_IMPLEMENTATION/Port_List.md`).
- Governance invariants (K12): physics/default-parameter/benchmark-baseline changes need PI approval via `ask`; single-basin metric gain ≠ model improvement; calibration ≠ structural validation; raw data deletion forbidden or PI-gated, `data/raw` lives outside the workspace root (Seatbelt read-only).
- Scope rule (K13): no spike may start unless it ends in one user-visible step of the first task (ccw run → RunRecord → EvidenceReport).
- Outbound: only `session-log-deepseek` disabled (K9); every dsh upgrade re-audits new outbound rows.
- Deployment: default `rawDirs: ["data/raw"]` is for development/probes. The user overrides it with `- id: shud-raw-guard` + `config: { rawDirs: ["<absolute data_root/raw path outside the workspace>", ...] }` in `$DSH_HOME/profiles/shud/cordis.patch.yml`. `profile:install` requires an absolute executable regular-file `SHUD_BIN` and owns only the unique `shud-jobs` patch item: `shudBin` and `stateDir: $DSH_HOME/profiles/<name>/shud-jobs`. Raw overrides and all unrelated bytes are preserved; identical repeat installs leave the patch unchanged. State-directory ownership and atomic serialized indexes are implemented by `dsh-shud-jobs` at apply time, requiring Darwin `lockf` or Linux `flock` plus `ps` (`procps` in Linux slim environments); see [Runtime Lifecycle](../instructions/agents/shared.md#runtime-lifecycle) for guard/metadata lifetime and conservative process-identity limits.
- Submitted-stage API: `ShudJobRegistry.submitShud(request, producer)` requires an explicit producer, safely copies inputs, persists the submitted record/index and registers through a transient unscoped controller. Accepted transactions, including rollback, drain before state ownership is released. Wrapper execution, running transitions, polling and reconciliation are not yet implemented; see Runtime Lifecycle above.

Risk axes:
- dsh pre-stable API drift (seam renames, config schema changes) across `chore(dsh-upgrade)` issues; `--patch` ordering (must precede app args).
- Job durability: in-memory `jobs-local` dies with the process (SIGTERM kills child without `job/settled`, SIGKILL orphans it, restart → `unknown job`); M2's durable backend must survive both.
- Raw-data byte protection relies on `<data_root>/raw` being outside the workspace root; any plugin that widens the sandbox or resolves symlinks into it breaks the invariant.
- Schema drift between `Minimal_Schemas.md`, Zod code, generated docs and issue text.
- Secrets: `DMXAPI_KEY` only via env (`apiKeyEnv`); never in RunRecord, reports, session logs committed as fixtures, or git.
- Scientific governance boundaries: agent never states scientific conclusions; report wording rules are tested constants, not prompts alone.
- Ported >1000-line files (`policy-gate-core.ts` + test) are guard-excluded; new code must not hide behind that exclusion.

Typical evidence:
- `pnpm run check` (typecheck, lint, format, coverage, dup, deadcode, naming, schema drift, docs gate); focused `pnpm vitest run <file>`; `pnpm run test-guardrails` after touching any gate.
- `openspec validate <change> --strict --no-interactive`; `git diff --check`; `git status --short` clean of `lib/`, `node_modules/`, workspace output.
- dsh boot (headless template with the bundle linked): from this repository root, first `pnpm run build`, then `export DSH_HOME="$(mktemp -d)"`, export `SHUD_BIN` as the absolute path of a built executable SHUD file, run `PROFILE_NAME=shud-probe PROFILE_TEMPLATE=headless pnpm run profile:install`, and launch `node ../deepseek-harness/apps/cli/lib/bin.js --profile shud-probe --json "<task>"`. Keep the exported `DSH_HOME` for both installation and launch; inspect the session log (`session.v4.jsonl.zstd`) for `approval/asked|decided`, `job/settled`, `tool/result`. Live tasks require `DMXAPI_KEY` via the environment.
- Spike probes as regression after any dsh upgrade: `../dsh-spike/runs/*/NOTES.md` procedures.

Command entry points:
- Toolchain: Node ≥ 24 (runs `.ts` directly for `scripts/schema/generate.ts`), `pnpm@11.28.5` (brew). `ALL_PROXY` must be unset for dsh/gh runs on this machine.
- Default local/CI check: `pnpm run check`; full command surface and levels in `AGENTS.md` ## Verification Matrix; build: `pnpm run build`.
- Schema regeneration after a Zod change: `pnpm run schema:generate` then commit `docs/generated/`.
- Host run (Web): from this repository root, first `pnpm run build`, then `export DSH_HOME="$(mktemp -d)"`, export `SHUD_BIN` as an absolute executable regular-file path, run `pnpm run profile:install` (defaults: `PROFILE_NAME=shud`, `PROFILE_TEMPLATE=web`), and inspect `node ../deepseek-harness/apps/cli/lib/bin.js --profile shud --dump-config`; launch with `node ../deepseek-harness/apps/cli/lib/bin.js --profile shud --no-open --port <p>` using that same exported `DSH_HOME`. The installer disables old `jobs`, mounts `shud-jobs`, and updates only its user-patch item; machine paths are not bundled. The profile selects the Web app; do not add a `web` positional argument. These commands use the checkout bin when `dsh` is not global. To run from a research workspace, use its absolute bin path and retain `DSH_HOME`; `pnpm dsh` inside the dsh repo fixes cwd to that repo. Optional `--patch <overlay>` must precede app args such as `--no-open` or `--json`; it is not the bundle installation path.
- Browser probes: `agent-browser` with `--executable-path` to cached chromium 1243; avoid `wait --load networkidle` (long-lived WS connection hangs it).
- Fixture/hygiene: `openspec validate <change> --strict --no-interactive`; `git diff --check`.

Verification matrix:
- Canonical home is `AGENTS.md` ## Verification Matrix (mirrored in `constraints.yaml` verification); this profile only adds the per-surface evidence expectations below.
- Schema surface → focused vitest + schema drift → zero drift, positive/negative parse cases named.
- Governance surface → focused vitest + typecheck → decision table rows asserted, reserved rule ids intact.
- Plugin seam surface → unit tests with a fake `ctx` + one headless-template profile boot with the bundle linked + session-log assertions.
- Job durability surface → SIGTERM and SIGKILL restart cases against a real ccw tiny run → `job/settled` persisted, RunRecord produced.
- Profile/config surface → `pnpm run profile:smoke` (routed model, disabled channel, no secret material).
- Docs/spec surface → `pnpm run docs:check` → 0 broken links/path claims, generated instructions and decision records in sync.

Domain risk packs:
- Scientific governance / PI gate / evidence lineage.
- Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility (SUNDIALS at `~/sundials`, ccw full run ≈ 4m45s, tiny END=30 < 2 min). Facts and review checklists: `docs/01_CODEBASE/SHUD_IO_Facts.md`, `docs/01_CODEBASE/rSHUD_AutoSHUD_Quirks.md`; Park/Resume checklist: `docs/03_SPEC/Park_Resume_Design.md` 附录 A; spec ambiguities: `docs/03_SPEC/Spec_Gaps_Register.md`.
- dsh seam / profile / outbound-channel governance.

Domain expanded-triggers:
- `TaskCard`, `StackLock`, `RunJob`, `RunRecord`, `EvidenceReport`, `DataProvenance`, `raw`, `guard_class`, `remediation`.
- `SHUD`, `rSHUD`, `AutoSHUD`, `ccw`, `dsh`, `cordis`, `profile`, `patch`, `seam`, `ctx.jobs`, `ctx.approval`, `DMXAPI`, `deepseek-flash-guan`.
