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

# 2b documented dsh seams: reject internals, accept the public type boundary.
P="packages/dsh-shud-core/src/__guardtest_seam.ts"; PLANTED="$PLANTED $P"
printf "import '@deepseek-ai/dsh-agent';\n" > "$P"
expect_fail "eslint dsh internal import" pnpm exec eslint "$P"
printf "import type {} from '@deepseek-ai/dsh-tools';\n" > "$P"
expect_pass "eslint dsh public seam" pnpm exec eslint "$P"
rm -f "$P"

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
expect_pass "raw-guard judge inconclusive shape" sh -c 'F=scripts/runtime/fixtures/raw-guard-probes; J="env -u DMXAPI_KEY sh scripts/runtime/raw-guard-probes.sh --judge"; for t in 3 4; do out=$($J $F/inconclusive-t$t-skipped 2>/dev/null); rc=$?; [ "$rc" -eq 2 ] && printf "%s\n" "$out" | grep -q "^T$t INCONCLUSIVE" && [ "$(printf "%s\n" "$out" | grep -c "FAIL$")" -eq 0 ] && printf "%s\n" "$out" | grep -q "^md5 PASS" || exit 1; done; out=$($J $F/fail-t3-breach 2>/dev/null); rc=$?; [ "$rc" -eq 1 ] && printf "%s\n" "$out" | grep -q "^T3 FAIL$" && printf "%s\n" "$out" | grep -q "^md5 PASS" && ! printf "%s\n" "$out" | grep -q "INCONCLUSIVE" || exit 1; out=$($J $F/fail-t3-skipped-md5 2>/dev/null); rc=$?; [ "$rc" -eq 1 ] && printf "%s\n" "$out" | grep -q "^T3 FAIL$" && printf "%s\n" "$out" | grep -q "^md5 FAIL$" && ! printf "%s\n" "$out" | grep -q "INCONCLUSIVE" || exit 1; for d in fail fail-approval-granted fail-empty-session; do out=$($J $F/$d 2>/dev/null); rc=$?; [ "$rc" -eq 1 ] || exit 1; done; for d in pass fail fail-empty-session fail-approval-granted inconclusive-t3-skipped inconclusive-t4-skipped fail-t3-breach fail-t3-skipped-md5; do out=$($J $F/$d 2>/dev/null); printf "%s\n" "$out" | grep -q "all five PASS" && exit 1; done; exit 0'

echo "guardrail self-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
