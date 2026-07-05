# Follow-up Final Review - correctness - 90c4c39

Reviewer agent: review-correctness
Review round: follow-up final after e4f00c3 fixes
Reviewed head SHA: `90c4c397d09d2dee2360b1aa9cc7a4f50db3cd9b`

Summary: Not clean; e4f00c3 fixes closed several prior gaps, but raw authority can still drift through mutable root arrays, Python Popen containment has a reachable false allow, and the child env allowlist still leaks broad `LC_*` ambient variables.

## Invariant Matrix Coverage

- Raw write denied by OS sandbox authority: missing - stable config paths are protected, but `RawDataSandboxedBashTool` stores caller-owned root arrays by reference, so post-construction mutation can move the protected root away from `data/raw`.
- Raw read allowed under same profile: covered.
- Legal workspace write and waited foreground child allowed: covered.
- Statically detectable un-awaited Python Popen rejected: missing - any later lexical `p.wait()`/`p.communicate()` is treated as proof even when unreachable.
- Advisory/static same-root raw write may pre-deny with remediation/audit/WS: covered under stable config.
- Post-exec process output/exit code remains generic lifecycle evidence: covered.
- Hidden denial telemetry and arbitrary descendant ownership out of #19 scope: covered.
- Pre-existing hardlink residual demonstrated and bounded `nlink>1` scan detects: covered.
- e4f00c3 stale protected raw root setup failure: covered.
- e4f00c3 generic WS `ErrorRecord` snapshot: covered.
- e4f00c3 fuse rule object snapshot: covered for fuse rules, but sibling root-array config snapshot is missing.
- Minimal sandbox child environment / explicit `envSecrets` redaction: partially covered - common ambient secrets are stripped and explicit secrets redact, but broad `LC_*` passthrough remains.
- `zero` diff and pin: covered.

## Findings

- Severity: P1
  Failure class: mutable configuration aliasing / raw byte authority bypass
  Contract or invariant: Protected raw roots used by the SHUD bash wrapper must be fixed at construction/registry assembly time; caller-owned mutable inputs must not be able to change the authority boundary after the tool is registered.
  Evidence: `RawDataSandboxedBashTool` clones only `fuseRules` and stores the rest of `options` shallowly, preserving `protectedRawPaths`, `allowedWriteRoots`, and `protectedEvidencePaths` array references. `createShudSandboxedBashTool` forwards the same root arrays into the tool.
  Scenario or repro: Construct `RawDataSandboxedBashTool` with `protectedRawPaths = [root/data/raw]` and `allowedWriteRoots = [root]`, then mutate the original `protectedRawPaths[0]` to an existing non-raw directory such as `root/workspace` before calling `run()`. The generated seatbelt profile protects the mutated directory, not the original `data/raw`, so `printf MUTATED > data/raw/input.csv` can succeed and audit as allowed.
  Consequence: A valid caller boundary can silently disable raw byte protection after tool construction, violating the core Issue #19 invariant.
  Fix direction: Snapshot all array-valued sandbox options at construction and registry boundaries, ideally into frozen copies: `protectedRawPaths`, `allowedWriteRoots`, `protectedEvidencePaths`, and `fuseRules`.
  Required verification: Add regressions that mutate each original root array after `new RawDataSandboxedBashTool()` and after `createShudSandboxedBashTool()`; assert the original raw root remains protected, raw bytes are unchanged, and audit/profile metadata still binds the original roots.
  Sibling surfaces: `createShudRuntimeToolRegistry`, future sandbox/executor constructors storing path arrays, and public profile builders that retain caller-owned config across async work.
  Blocks merge: Yes.

- Severity: P1
  Failure class: process lifecycle / false waited-child proof
  Contract or invariant: Normal completion must not report allowed while a statically detectable un-awaited interpreter child can continue mutating workspace after the wrapper returns.
  Evidence: `isPythonPopenCallStaticallyWaited()` treats any later lexical `p.wait()` or `p.communicate()` as proof that the `Popen` call is waited, without checking reachability or top-level sequencing.
  Scenario or repro: `python3 -c 'import subprocess; p=subprocess.Popen(["sh","-c","sleep 0.25; printf leaked > workspace/fake-wait.txt"]); if False: p.wait()'`. The regex sees `p.wait(` after the call, so preflight allows it; Python exits immediately, the tool can emit `tool.completed` / `decision=allowed`, and the child writes later.
  Consequence: The e4f00c3 un-awaited `Popen` fix is bypassable with a simple unreachable wait, recreating the prior lifecycle false-allow.
  Fix direction: Make the waited proof conservative: only allow immediate chained waits or a simple same/top-level statement proven to execute after assignment, or fail closed for ambiguous assigned `Popen` forms.
  Required verification: Add a regression with `if False: p.wait()` and another with reassignment before `p.wait()`; assert `policy_gate_process_containment_unavailable` and no delayed workspace file, while the existing direct `p.wait()` foreground case remains allowed.
  Sibling surfaces: Python `.communicate()` handling, Node/Ruby/R process-creation preflight if later expanded, and normal-completion descendant handling.
  Blocks merge: Yes.

- Severity: P1
  Failure class: information disclosure / incomplete ambient environment deny
  Contract or invariant: Sandboxed bash must not inherit ambient host secrets; explicit secrets must pass only through `envSecrets`/`stdinSecretRef` so the secret filter can redact them.
  Evidence: `buildSanitizedToolProcessEnv()` copies any env var accepted by `isLocaleEnvName()`, which currently accepts any `LC_[A-Z_]+`.
  Scenario or repro: Set `process.env.LC_API_KEY = "ambient-secret"` or `process.env.LC_PASSWORD = "ambient-secret"` in the host, then run sandboxed bash with `printf "$LC_API_KEY"`. The value is inherited because it matches `LC_*`, and it is not registered with `secretFilter`.
  Consequence: A parent-process secret with an `LC_*` name can be printed or exfiltrated by arbitrary sandboxed commands despite the minimal-env fix.
  Fix direction: Replace the broad `LC_*` regex with an exact allowlist of known locale categories, or drop all ambient `LC_*` variables except those explicitly required and safe.
  Required verification: Add an ambient `LC_API_KEY`/`LC_PASSWORD` regression asserting the variable is absent from `env` and output, plus a positive test for intended locale variables such as `LC_ALL` or `LC_CTYPE`.
  Sibling surfaces: Any future executor env builder and Zero bash wrappers that compose this helper.
  Blocks merge: Yes.

- Severity: P2
  Failure class: state-transition / pre-execute terminal metadata gap
  Contract or invariant: Wrapper-owned terminal paths should mark the running tool handle finished with failure metadata.
  Evidence: `RawDataSandboxedBashTool.fuseCheck()` can throw before `execute()`; `finalizeToolResult()` is only called inside `execute()`. The upstream `BaseTool.run()` catch path returns a failure result but does not mark the harness running handle.
  Scenario or repro: Register a running handle for `currentToolUseId`, configure a fuse rule matching the command, and call `RawDataSandboxedBashTool.run()`. The command is rejected before `execute()`, but the handle remains `running` with no terminal metadata.
  Consequence: UI/session state can remain stale for fuse-denied bash calls even though the tool returned a failure.
  Fix direction: Move fuse denial into a finalized execution path, or add a shared wrapper-level finalization catch that marks the running handle for pre-execute failures.
  Required verification: Add a `TestRunningToolRegistry` regression for fuse denial and, separately, for outer policy-gate denial/misconfiguration if that path is expected to own terminal state.
  Sibling surfaces: `PolicyGatedBaseToolAdapter.run()` deny branches.
  Blocks merge: No, unless running-tool terminal metadata is part of this gate's merge criteria.

## Non-blocking Notes

- Prior e4f00c3 findings for stale protected raw root finalization, generic WS error snapshotting, and fuse rule object cloning appear closed on this head.
- Reviewer did not rerun the Bun/OpenSpec suites; assessment is from read-only code/diff/spec inspection plus orchestrator-reported verification.
