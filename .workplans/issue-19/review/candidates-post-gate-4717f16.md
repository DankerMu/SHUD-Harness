# Candidate findings — PR #48 post-gate follow-up 4717f16

Reviewed head SHA: `4717f1608058418a279365b385afc17e35e2238a`

Source reports:
- `.workplans/issue-19/review/followup-post-gate-4717f16-correctness.md`
- `.workplans/issue-19/review/followup-post-gate-4717f16-integration.md`
- `.workplans/issue-19/review/followup-post-gate-4717f16-security-perf.md`
- `.workplans/issue-19/review/followup-post-gate-4717f16-test-evidence.md`
- `.workplans/issue-19/review/followup-post-gate-4717f16-spec-compliance.md`
- `.workplans/issue-19/review/followup-post-gate-4717f16-invariant-state.md`

## cand-4717-01 — symlink alias hidden raw write false success

Originating reviewer: correctness.
Severity: P1.
Failure class: hidden-denial evidence / false success.
Invariant: symlink alias writes to `data/raw/**` are one of the six required escape classes and must return remediation-shaped failure plus `tool.failed`/audit evidence when denied by the OS sandbox.
Scenario family: create an allowed workspace symlink to protected raw, then write through the symlink while hiding stderr and normalizing exit status. Raw bytes are protected, but static target recognition may not know the symlink points into raw, so the wrapper can record `tool.completed/allowed`.
Representative scenario: `ln -s ../data/raw/symlink-hidden.txt workspace/link-to-raw.txt; printf hidden > workspace/link-to-raw.txt 2>/dev/null || true`.

## cand-4717-02 — process lifecycle containment remains incomplete

Originating reviewers: correctness, security-perf, invariant-state.
Severity: P1.
Failure class: process lifecycle containment / stale descendant mutation.
Invariant: a bash invocation must not leave invocation-owned descendants able to mutate workspace or evidence after the wrapper reaches a terminal ToolResult.
Scenario family: process/session creation hidden inside nested child shells, here-doc interpreter bodies, or obfuscated interpreter reflection can bypass current preflight and race PPID descendant sampling, producing post-return workspace writes.
Representative scenarios:
- `node -e 'const cp=require("child"+"_process"); cp.spawn("sh",["-c","sleep .25; printf leaked > workspace/node-dyn-leak.txt"],{["detached"]:true,stdio:"ignore"}).unref()'`
- `bash -c 'sleep 0.25; printf leaked > workspace/child-shell-bg-leak.txt &'`
- `python3 -c 'import os,time; f=getattr(os,"fork"); p=f(); os._exit(0) if p else None; getattr(os,"set"+"sid")(); p=f(); os._exit(0) if p else None; time.sleep(.3); open("workspace/post-return.txt","w").write("leaked")'`

## cand-4717-03 — over-budget hidden raw write false success

Originating reviewers: security-perf, test-evidence, spec-compliance, invariant-state.
Severity: P1.
Failure class: hidden-denial evidence / scan-budget false allowed.
Invariant: attempted `data/raw/**` mutations denied by the OS sandbox must not surface as `tool.completed/allowed`, including when command analysis exceeds budget.
Scenario family: over-budget commands hide stderr and normalize exit status after attempting a raw write; raw bytes are protected by seatbelt, but the wrapper can append an allowed completion row because over-budget analysis discards target evidence.
Representative scenarios:
- `printf hidden > data/raw/over-budget-hidden.txt 2>/dev/null; true # <140k filler>`
- `node -e 'require("fs").writeFileSync("data/raw/overbudget-node-hidden.txt","x")' 2>/dev/null || true # <140k filler>`

## cand-4717-04 — waited foreground child process false positive

Originating reviewer: test-evidence.
Severity: P2.
Failure class: compatibility / false-positive boundary coverage.
Invariant: legal workspace writes must remain allowed; process containment should reject escaping or unwaited descendants, not ordinary foreground subprocesses that are waited before exit.
Scenario family: foreground subprocess usage is rejected only because preflight treats any Python `subprocess.Popen` as containment-unavailable.
Representative scenario: `python3 -c 'import subprocess, sys; p=subprocess.Popen(["sh","-c","printf ok > workspace/popen-wait.txt"]); sys.exit(p.wait())'`.
