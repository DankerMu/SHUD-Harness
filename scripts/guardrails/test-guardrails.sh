#!/usr/bin/env sh
# Guardrail self-test: every mechanical gate must reject a planted violation AND accept a clean input.
# A guard that cannot fail is phantom enforcement. Run: pnpm run test-guardrails
set -u
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/shud-guardrails.XXXXXX")
PLANTED=""
cleanup() { rm -rf "$TMP"; for f in $PLANTED; do rm -rf "$ROOT/$f"; done; }
trap cleanup EXIT HUP INT TERM
pass=0; fail=0
expect_fail() { # name, command...
  name="$1"; shift
  if "$@" >"$TMP/out" 2>&1; then echo "FAIL  $name — guard accepted the violation"; sed 's/^/      /' "$TMP/out" | head -5; fail=$((fail+1)); else echo "PASS  $name (rejects violation)"; pass=$((pass+1)); fi
}
expect_pass() {
  name="$1"; shift
  if "$@" >"$TMP/out" 2>&1; then echo "PASS  $name (accepts clean input)"; pass=$((pass+1)); else echo "FAIL  $name — guard rejected clean input"; sed 's/^/      /' "$TMP/out" | head -5; fail=$((fail+1)); fi
}

# 1 naming guard
expect_fail "naming" sh .git-hooks/check-naming.sh packages/foo_v2.ts
expect_pass "naming" sh .git-hooks/check-naming.sh packages/foo.ts
expect_pass "naming exempt archive" sh .git-hooks/check-naming.sh docs/99_ARCHIVE/plan_v0.6/x.md

# 2 eslint max-lines (planted inside the lint project so type-aware rules resolve)
P="packages/dsh-shud-core/src/__guardtest_maxlines.ts"; PLANTED="$PLANTED $P"
{ echo "export const a = 1;"; i=0; while [ $i -lt 1001 ]; do echo "// line"; i=$((i+1)); done; } > "$P"
expect_fail "eslint max-lines" pnpm exec eslint "$P"
rm -f "$P"

# 2b ADR-0006 seams: assert the specific gate, never an unrelated lint/parser failure.
SEAM_DIR="packages/dsh-shud-core/src/__guardtest_seams"
if ! mkdir "$SEAM_DIR"; then echo "FAIL  cannot create seam fixture directory"; exit 1; fi
PLANTED="$PLANTED $SEAM_DIR"
expect_seam() { # name, allow or expected rule ID, filename, source
  name="$1"; expected="$2"; fixture="$SEAM_DIR/$3"
  printf '%s\n' "$4" > "$fixture"
  status=0
  pnpm exec eslint --format json "$fixture" > "$TMP/seam.json" 2> "$TMP/seam.err" || status=$?
  if node -e '
    const fs = require("node:fs");
    const [report, expected, status] = process.argv.slice(1);
    const results = JSON.parse(fs.readFileSync(report, "utf8"));
    const result = results[0];
    const valid = results.length === 1 && result.fatalErrorCount === 0 &&
      (expected === "allow"
        ? status === "0" && result.messages.length === 0
        : status === "1" && result.messages.length > 0 &&
          result.messages.every(message => message.ruleId === expected && message.severity === 2));
    if (!valid) {
      console.error(`Expected ${expected}, ESLint exited ${status}:`, result.messages);
      process.exitCode = 1;
    }
  ' "$TMP/seam.json" "$expected" "$status"; then
    echo "PASS  $name ($expected)"
    pass=$((pass+1))
  else
    echo "FAIL  $name — unexpected ESLint result"
    cat "$TMP/seam.err"
    fail=$((fail+1))
  fi
  rm -f "$fixture"
}

# Preserve the original runtime-internal rejection and public type-boundary acceptance.
expect_seam "eslint dsh internal import" no-restricted-imports registry.ts "import '@deepseek-ai/dsh-agent';"
expect_seam "eslint dsh public seam" allow registry.ts "import type {} from '@deepseek-ai/dsh-tools';"

# Package-wide runtime seams.
expect_seam "eslint dsh-tools runtime" allow registry.ts "import '@deepseek-ai/dsh-tools';"
expect_seam "eslint cordis runtime" allow registry.ts "import '@deepseek-ai/cordis';"
expect_seam "eslint dsh-jobs runtime" allow registry.ts "import { JobRegistry } from '@deepseek-ai/dsh-jobs'; export { JobRegistry };"
expect_seam "eslint dsh-jobs-local runtime" allow registry.ts "import { LocalJobRegistry } from '@deepseek-ai/dsh-jobs-local'; export { LocalJobRegistry };"

# The message seam grants one named runtime capability, not a whole module.
expect_seam "eslint createUserMessage runtime" allow registry.ts "import { createUserMessage } from '@deepseek-ai/dsh-llm'; export { createUserMessage };"
expect_seam "eslint dsh-llm named type" allow registry.ts "import type { MessageSourceMap } from '@deepseek-ai/dsh-llm'; export type { MessageSourceMap };"
expect_seam "eslint dsh-llm empty type" allow registry.ts "import type {} from '@deepseek-ai/dsh-llm';"
expect_seam "eslint dsh-llm empty type re-export" allow registry.ts "export type {} from '@deepseek-ai/dsh-llm';"
expect_seam "eslint dsh-llm other named" no-restricted-imports registry.ts "import { createAssistantMessage } from '@deepseek-ai/dsh-llm'; export { createAssistantMessage };"
expect_seam "eslint dsh-llm default" no-restricted-imports registry.ts "import llm from '@deepseek-ai/dsh-llm'; export { llm };"
expect_seam "eslint dsh-llm namespace" no-restricted-imports registry.ts "import * as llm from '@deepseek-ai/dsh-llm'; export { llm };"
expect_seam "eslint dsh-llm mixed capabilities" no-restricted-imports registry.ts "import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'; export { createUserMessage, createAssistantMessage };"
expect_seam "eslint dsh-llm side effect" no-restricted-syntax registry.ts "import '@deepseek-ai/dsh-llm';"
expect_seam "eslint dsh-llm empty runtime" no-restricted-syntax registry.ts "import {} from '@deepseek-ai/dsh-llm';"
expect_seam "eslint dsh-llm empty runtime re-export" no-restricted-syntax registry.ts "export {} from '@deepseek-ai/dsh-llm';"

# Scope assembly is confined to the two exact test filenames/globs.
expect_seam "eslint createScope test" allow seam.test.ts "import { createScope } from '@deepseek-ai/dsh-scope'; export { createScope };"
expect_seam "eslint createScope test harness" allow test-harness.ts "import { createScope } from '@deepseek-ai/dsh-scope'; export { createScope };"
expect_seam "eslint dsh-scope production type" allow registry.ts "import type { Scope } from '@deepseek-ai/dsh-scope'; export type { Scope };"
expect_seam "eslint dsh-scope test type" allow seam.test.ts "import type { Scope } from '@deepseek-ai/dsh-scope'; export type { Scope };"
expect_seam "eslint dsh-scope empty type" allow seam.test.ts "import type {} from '@deepseek-ai/dsh-scope';"
expect_seam "eslint dsh-scope empty type re-export" allow test-harness.ts "export type {} from '@deepseek-ai/dsh-scope';"
expect_seam "eslint dsh-scope other named" no-restricted-imports seam.test.ts "import { Scope } from '@deepseek-ai/dsh-scope'; export { Scope };"
expect_seam "eslint dsh-scope default" no-restricted-imports seam.test.ts "import scope from '@deepseek-ai/dsh-scope'; export { scope };"
expect_seam "eslint dsh-scope namespace" no-restricted-imports seam.test.ts "import * as scope from '@deepseek-ai/dsh-scope'; export { scope };"
expect_seam "eslint createScope ordinary harness" no-restricted-imports harness.ts "import { createScope } from '@deepseek-ai/dsh-scope'; export { createScope };"
expect_seam "eslint createScope production registry" no-restricted-imports registry.ts "import { createScope } from '@deepseek-ai/dsh-scope'; export { createScope };"
expect_seam "eslint dsh-scope side effect" no-restricted-syntax seam.test.ts "import '@deepseek-ai/dsh-scope';"
expect_seam "eslint dsh-scope empty runtime" no-restricted-syntax test-harness.ts "import {} from '@deepseek-ai/dsh-scope';"
expect_seam "eslint dsh-scope empty runtime re-export" no-restricted-syntax seam.test.ts "export {} from '@deepseek-ai/dsh-scope';"

# Type-only host access never permits checkout paths or additional runtime seams.
expect_seam "eslint dsh-agent type" allow registry.ts "import type { Agent } from '@deepseek-ai/dsh-agent'; export type { Agent };"
expect_seam "eslint direct checkout runtime" no-restricted-imports registry.ts "import '../../../../../deepseek-harness/packages/core/agent/src/index.ts';"
expect_seam "eslint direct checkout type" no-restricted-imports registry.ts "import type { Agent } from '../../../../../deepseek-harness/packages/core/agent/src/index.ts'; export type { Agent };"
expect_seam "eslint direct checkout test type" no-restricted-imports seam.test.ts "import type { Agent } from '../../../../../deepseek-harness/packages/core/agent/src/index.ts'; export type { Agent };"
expect_seam "eslint dsh testkit runtime" no-restricted-imports seam.test.ts "import '@deepseek-ai/dsh-agent-loop-testkit';"
expect_seam "eslint dsh-jobs subpath runtime" no-restricted-imports registry.ts "import '@deepseek-ai/dsh-jobs/internal';"
expect_seam "eslint unlisted host runtime" no-restricted-imports registry.ts "import '@deepseek-ai/schemastery';"
rm -rf "$SEAM_DIR"

# 3 jscpd (duplicate block planted in an isolated dir, scanned directly)
mkdir -p "$ROOT/scripts/__guardtest_dup"; PLANTED="$PLANTED scripts/__guardtest_dup"
for n in a b; do
  { echo "export function f$n(x: number): number {"; i=0; while [ $i -lt 12 ]; do echo "  const v$i = x * $i + ($i % 3) - Math.floor(x / ($i + 1));"; i=$((i+1)); done; echo "  return x;"; echo "}"; } > "$ROOT/scripts/__guardtest_dup/$n.ts"
done
expect_fail "jscpd" pnpm exec jscpd --threshold 3 --min-tokens 50 --min-lines 5 --reporters console "$ROOT/scripts/__guardtest_dup"
rm -rf "$ROOT/scripts/__guardtest_dup"

# 4 knip (planted unused file)
P="packages/dsh-shud-core/src/__guardtest_unused.ts"; PLANTED="$PLANTED $P"
echo "export const unusedGuardTest = 1;" > "$P"
expect_fail "knip" pnpm exec knip --no-progress
rm -f "$P"

# 5 gitleaks — the planted tokens are assembled at runtime so this source file never contains a matchable secret
mkdir -p "$TMP/leak"
printf 'aws_access_key_id = "%s%s"\ngithub_token = "%s%s"\n' "AKIA" "Q7Z3X9F2B8TMLK4P" "ghp_" "8fK2nQ7vLx4pR9sT1uW3yZ6aB0cD5eF7gH9j" > "$TMP/leak/config.txt"
if command -v gitleaks >/dev/null 2>&1; then
  expect_fail "gitleaks" gitleaks dir "$TMP/leak" --no-banner --exit-code 1
  mkdir -p "$TMP/clean"; echo "nothing here" > "$TMP/clean/a.txt"
  expect_pass "gitleaks" gitleaks dir "$TMP/clean" --no-banner --exit-code 1
else
  echo "FAIL  gitleaks — not installed (brew install gitleaks)"; fail=$((fail+1))
fi

# 6 pr-size threshold logic
expect_fail "pr-size" sh scripts/guardrails/pr-size.sh --count 450
expect_pass "pr-size" sh scripts/guardrails/pr-size.sh --count 10
expect_pass "pr-size exempt label" env PR_LABELS=size-exempt sh scripts/guardrails/pr-size.sh --count 450

# 7 adr verify (copy, then plant: stray root record; edited archived record)
mkdir -p "$TMP/adr/docs"; cp -R docs/adr "$TMP/adr/docs/adr"
expect_pass "adr:check" sh scripts/adr/verify.sh --root "$TMP/adr"
printf -- '---\nstatus: accepted\nkind: process\n---\n# stray\n' > "$TMP/adr/docs/adr/0099-stray.md"
expect_fail "adr stray record" sh scripts/adr/verify.sh --root "$TMP/adr"
rm "$TMP/adr/docs/adr/0099-stray.md"
printf -- '---\nstatus: archived\nkind: process\n---\n# old\n' > "$TMP/adr/docs/adr/archived/0098-old.md"
printf '  docs/adr/archived/0098-old.md: %s\n' "$(shasum -a 256 "$TMP/adr/docs/adr/archived/0098-old.md" | cut -d' ' -f1)" >> "$TMP/adr/docs/adr/manifest.yaml"
expect_pass "adr archived with manifest" sh scripts/adr/verify.sh --root "$TMP/adr"
echo "tampered" >> "$TMP/adr/docs/adr/archived/0098-old.md"
expect_fail "adr archived tamper" sh scripts/adr/verify.sh --root "$TMP/adr"

# 8 docs path claims
printf 'see `scripts/does-not-exist.sh` here\n' > "$TMP/bad.md"
expect_fail "docs:paths" sh scripts/docs/check_paths.sh --root "$ROOT" "$TMP/bad.md"
printf 'see `package.json` and `scripts/adr/verify.sh`\n' > "$TMP/good.md"
expect_pass "docs:paths" sh scripts/docs/check_paths.sh --root "$ROOT" "$TMP/good.md"

# 9 generated instructions drift
mkdir -p "$TMP/instr"; cp -R instructions "$TMP/instr/"; sh scripts/instructions/render.sh --root "$TMP/instr" >/dev/null
expect_pass "instructions:check" sh scripts/instructions/render.sh --check --root "$TMP/instr"
echo "hand edit" >> "$TMP/instr/AGENTS.md"
expect_fail "instructions:check" sh scripts/instructions/render.sh --check --root "$TMP/instr"

# 10 no-bypass agent hook (the forbidden flag is assembled at runtime so this file never contains it verbatim)
nb() { printf '%s' "$1" | sh scripts/guardrails/no-bypass.sh; }
NV="--no-$(echo verify)"
expect_fail "no-bypass hook skip flag" nb "{\"tool_input\":{\"command\":\"git commit $NV -m x\"}}"
expect_fail "no-bypass force-push main" nb '{"tool_input":{"command":"git push --force origin main"}}'
expect_fail "no-bypass dsh write" nb '{"tool_input":{"command":"sed -i s/a/b/ ../deepseek-harness/package.json"}}'
expect_fail "no-bypass AGENTS.md edit" nb "{\"tool_input\":{\"file_path\":\"$ROOT/AGENTS.md\"}}"
expect_fail "no-bypass relative CLAUDE.md edit" nb '{"tool_input":{"file_path":"CLAUDE.md"}}'
expect_fail "no-bypass archived adr edit" nb '{"tool_input":{"file_path":"docs/adr/archived/0001-x.md"}}'
expect_pass "no-bypass clean commit" nb '{"tool_input":{"command":"git commit -m \"feat(x): y\""}}'
expect_pass "no-bypass dsh read" nb '{"tool_input":{"command":"git -C ../deepseek-harness describe --tags"}}'
expect_pass "no-bypass shared.md edit" nb '{"tool_input":{"file_path":"instructions/agents/shared.md"}}'
expect_pass "no-bypass global CLAUDE.md outside repo" nb "{\"tool_input\":{\"file_path\":\"$HOME/.claude/CLAUDE.md\"}}"
expect_pass "no-bypass hook configs reference one script" sh -c 'grep -q "scripts/guardrails/no-bypass.sh" .claude/settings.json && grep -q "scripts/guardrails/no-bypass.sh" .codex/hooks.json && [ ! -e .claude/hooks/no-bypass ] && [ ! -e .codex/hooks/no-bypass ]'

# 11 commitlint
expect_fail "commitlint" sh -c 'printf "bad message\n" | pnpm exec commitlint'
expect_pass "commitlint" sh -c 'printf "feat(core): add thing\n" | pnpm exec commitlint'

# 12 raw-guard oracle: scrubbed real green/disabled-plugin runs; no key or dsh.
expect_pass "raw-guard judge pass" env -u DMXAPI_KEY DSH_ROOT="$TMP/no-host" sh scripts/runtime/raw-guard-probes.sh --judge scripts/runtime/fixtures/raw-guard-probes/pass
expect_fail "raw-guard judge fail" env -u DMXAPI_KEY DSH_ROOT="$TMP/no-host" sh scripts/runtime/raw-guard-probes.sh --judge scripts/runtime/fixtures/raw-guard-probes/fail
expect_fail "raw-guard judge empty session" env -u DMXAPI_KEY DSH_ROOT="$TMP/no-host" sh scripts/runtime/raw-guard-probes.sh --judge scripts/runtime/fixtures/raw-guard-probes/fail-empty-session
expect_fail "raw-guard judge approval granted" env -u DMXAPI_KEY DSH_ROOT="$TMP/no-host" sh scripts/runtime/raw-guard-probes.sh --judge scripts/runtime/fixtures/raw-guard-probes/fail-approval-granted
expect_pass "raw-guard judge output shape" sh -c 'F=scripts/runtime/fixtures/raw-guard-probes; J="env -u DMXAPI_KEY sh scripts/runtime/raw-guard-probes.sh --judge"; out=$($J $F/pass) && printf "%s\n" "$out" | grep -q "^T5 PASS$" || exit 1; e=$($J $F/fail-empty-session 2>/dev/null); printf "%s\n" "$e" | grep -q "^T5 FAIL$" && printf "%s\n" "$e" | grep -q "^md5 PASS" || exit 1; a=$($J $F/fail-approval-granted 2>/dev/null); printf "%s\n" "$a" | grep -q "^T2 FAIL$" && printf "%s\n" "$a" | grep -q "^md5 PASS" || exit 1; [ "$(printf "%s\n" "$e" | grep -c "FAIL$")" -eq 1 ] || exit 1; [ "$(printf "%s\n" "$a" | grep -c "FAIL$")" -eq 1 ] || exit 1; f=$($J $F/fail 2>/dev/null); printf "%s\n" "$f" | grep -q "^md5 FAIL$" || exit 1; for d in pass fail fail-empty-session fail-approval-granted; do $J $F/$d 2>/dev/null | grep -q "all five PASS" && exit 1; done; exit 0'
expect_fail "raw-guard judge inconclusive t3" env -u DMXAPI_KEY DSH_ROOT="$TMP/no-host" sh scripts/runtime/raw-guard-probes.sh --judge scripts/runtime/fixtures/raw-guard-probes/inconclusive-t3-skipped
expect_fail "raw-guard judge inconclusive t4" env -u DMXAPI_KEY DSH_ROOT="$TMP/no-host" sh scripts/runtime/raw-guard-probes.sh --judge scripts/runtime/fixtures/raw-guard-probes/inconclusive-t4-skipped
expect_fail "raw-guard judge t3 breach" env -u DMXAPI_KEY DSH_ROOT="$TMP/no-host" sh scripts/runtime/raw-guard-probes.sh --judge scripts/runtime/fixtures/raw-guard-probes/fail-t3-breach
expect_fail "raw-guard judge t3 skipped md5" env -u DMXAPI_KEY DSH_ROOT="$TMP/no-host" sh scripts/runtime/raw-guard-probes.sh --judge scripts/runtime/fixtures/raw-guard-probes/fail-t3-skipped-md5
expect_fail "raw-guard judge t3 raw dir" env -u DMXAPI_KEY DSH_ROOT="$TMP/no-host" sh scripts/runtime/raw-guard-probes.sh --judge scripts/runtime/fixtures/raw-guard-probes/fail-t3-raw-dir
expect_fail "raw-guard judge t3 raw workdir" env -u DMXAPI_KEY DSH_ROOT="$TMP/no-host" sh scripts/runtime/raw-guard-probes.sh --judge scripts/runtime/fixtures/raw-guard-probes/fail-t3-raw-workdir
expect_fail "raw-guard judge t3 wrong deny" env -u DMXAPI_KEY DSH_ROOT="$TMP/no-host" sh scripts/runtime/raw-guard-probes.sh --judge scripts/runtime/fixtures/raw-guard-probes/fail-t3-wrong-deny
expect_pass "raw-guard judge inconclusive shape" sh -c 'F=scripts/runtime/fixtures/raw-guard-probes; J="env -u DMXAPI_KEY sh scripts/runtime/raw-guard-probes.sh --judge"; for t in 3 4; do out=$($J $F/inconclusive-t$t-skipped 2>/dev/null); rc=$?; [ "$rc" -eq 2 ] && printf "%s\n" "$out" | grep -q "^T$t INCONCLUSIVE" && [ "$(printf "%s\n" "$out" | grep -c "FAIL$")" -eq 0 ] && printf "%s\n" "$out" | grep -q "^md5 PASS" || exit 1; done; for d in fail-t3-breach fail-t3-raw-dir fail-t3-raw-workdir fail-t3-wrong-deny; do out=$($J $F/$d 2>/dev/null); rc=$?; [ "$rc" -eq 1 ] && printf "%s\n" "$out" | grep -q "^T3 FAIL$" && printf "%s\n" "$out" | grep -q "^md5 PASS" && ! printf "%s\n" "$out" | grep -q "INCONCLUSIVE" || exit 1; done; out=$($J $F/fail-t3-skipped-md5 2>/dev/null); rc=$?; [ "$rc" -eq 1 ] && printf "%s\n" "$out" | grep -q "^T3 FAIL$" && printf "%s\n" "$out" | grep -q "^md5 FAIL$" && ! printf "%s\n" "$out" | grep -q "INCONCLUSIVE" || exit 1; for d in fail fail-approval-granted fail-empty-session; do out=$($J $F/$d 2>/dev/null); rc=$?; [ "$rc" -eq 1 ] || exit 1; done; for d in pass fail fail-empty-session fail-approval-granted inconclusive-t3-skipped inconclusive-t4-skipped fail-t3-breach fail-t3-skipped-md5 fail-t3-raw-dir fail-t3-raw-workdir fail-t3-wrong-deny; do out=$($J $F/$d 2>/dev/null); printf "%s\n" "$out" | grep -q "all five PASS" && exit 1; done; exit 0'
expect_pass "raw-guard judge t4 decorated read" env -u DMXAPI_KEY DSH_ROOT="$TMP/no-host" sh scripts/runtime/raw-guard-probes.sh --judge scripts/runtime/fixtures/raw-guard-probes/pass-t4-decorated-read
expect_fail "raw-guard judge t4 decorated breach" env -u DMXAPI_KEY DSH_ROOT="$TMP/no-host" sh scripts/runtime/raw-guard-probes.sh --judge scripts/runtime/fixtures/raw-guard-probes/fail-t4-decorated-breach
expect_pass "raw-guard judge t4 decorated shape" sh -c 'F=scripts/runtime/fixtures/raw-guard-probes; J="env -u DMXAPI_KEY sh scripts/runtime/raw-guard-probes.sh --judge"; out=$($J $F/pass-t4-decorated-read 2>/dev/null); rc=$?; [ "$rc" -eq 0 ] && printf "%s\n" "$out" | grep -q "^T4 PASS$" && printf "%s\n" "$out" | grep -q "^md5 PASS" && ! printf "%s\n" "$out" | grep -q "all five PASS" || exit 1; out=$($J $F/fail-t4-decorated-breach 2>/dev/null); rc=$?; [ "$rc" -eq 1 ] && printf "%s\n" "$out" | grep -q "^T4 FAIL$" && printf "%s\n" "$out" | grep -q "^md5 PASS" && [ "$(printf "%s\n" "$out" | grep -c "FAIL$")" -eq 1 ] && ! printf "%s\n" "$out" | grep -q "INCONCLUSIVE" && ! printf "%s\n" "$out" | grep -q "all five PASS" || exit 1; exit 0'
expect_pass "raw-guard judge t4 read nonzero exit" sh -c 'C="$1/t4-read-exit1"; cp -R scripts/runtime/fixtures/raw-guard-probes/pass-t4-decorated-read "$C" || exit 1; node -e "const fs=require(\"fs\"),e=\"]\"+String.fromCharCode(92)+\"n\",a=\"[exit code: 0\"+e,b=\"[exit code: 1\"+e;let n=0;for(const p of process.argv.slice(1)){const t=fs.readFileSync(p,\"utf8\"),k=t.split(a).length-1;n+=k;fs.writeFileSync(p,t.split(a).join(b))}process.exit(n===2?0:1)" "$C/T4/stream.jsonl" "$C/T4/session.jsonl" || exit 1; out=$(env -u DMXAPI_KEY sh scripts/runtime/raw-guard-probes.sh --judge "$C" 2>/dev/null); rc=$?; [ "$rc" -eq 1 ] && printf "%s\n" "$out" | grep -q "^T4 FAIL$" && printf "%s\n" "$out" | grep -q "^md5 PASS" && ! printf "%s\n" "$out" | grep -q "INCONCLUSIVE" && ! printf "%s\n" "$out" | grep -q "all five PASS" || exit 1; exit 0' _ "$TMP"

echo "guardrail self-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
