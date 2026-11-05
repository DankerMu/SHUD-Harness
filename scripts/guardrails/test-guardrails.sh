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
expect_seam() { # name, allow or expected rule ID, filename, source, optional lint pathname
  name="$1"; expected="$2"; fixture="$SEAM_DIR/$3"
  printf '%s\n' "$4" > "$fixture"
  status=0
  if [ "$#" -ge 5 ]; then
    # Isolate injected syntax from the typed project's on-disk SourceFile at this pathname.
    # Only this self-test disables type-aware rules; repository import restrictions stay loaded.
    node --input-type=module -e '
      import { readFileSync } from "node:fs";
      import { ESLint } from "eslint";
      import tseslint from "typescript-eslint";
      const eslint = new ESLint({ overrideConfig: [tseslint.configs.disableTypeChecked] });
      const results = await eslint.lintText(readFileSync(0, "utf8"), {
        filePath: process.argv[1],
      });
      process.stdout.write(JSON.stringify(results));
      process.exitCode = results.some(result => result.errorCount > 0) ? 1 : 0;
    ' "$5" < "$fixture" > "$TMP/seam.json" 2> "$TMP/seam.err" || status=$?
  else
    pnpm exec eslint --format json "$fixture" > "$TMP/seam.json" 2> "$TMP/seam.err" || status=$?
  fi
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

# Inline-only specifiers retain a runtime dependency under verbatimModuleSyntax.
# Exercise both configurations for named-only, other host, unknown host, and subpath sources.
for filename in registry.ts seam.test.ts; do
  for binding in \
    "@deepseek-ai/dsh-llm:MessageSourceMap" \
    "@deepseek-ai/dsh-scope:Scope" \
    "@deepseek-ai/dsh-agent:Agent" \
    "@deepseek-ai/unlisted-seam:HostType" \
    "@deepseek-ai/dsh-jobs/internal:JobId"; do
    source=${binding%:*}; symbol=${binding#*:}
    expect_seam "eslint inline type import $source in $filename" no-restricted-syntax "$filename" "import { type $symbol } from '$source'; export type { $symbol };"
    expect_seam "eslint inline type re-export $source in $filename" no-restricted-syntax "$filename" "export { type $symbol } from '$source';"
    expect_seam "eslint declaration type import $source in $filename" allow "$filename" "import type { $symbol } from '$source'; export type { $symbol };"
    expect_seam "eslint declaration type re-export $source in $filename" allow "$filename" "export type { $symbol } from '$source';"
  done
done
expect_seam "eslint inline scope type import in test harness" no-restricted-syntax test-harness.ts "import { type Scope } from '@deepseek-ai/dsh-scope'; export type { Scope };"
expect_seam "eslint inline scope type re-export in test harness" no-restricted-syntax test-harness.ts "export { type Scope } from '@deepseek-ai/dsh-scope';"
expect_seam "eslint declaration scope type import in test harness" allow test-harness.ts "import type { Scope } from '@deepseek-ai/dsh-scope'; export type { Scope };"
expect_seam "eslint declaration scope type re-export in test harness" allow test-harness.ts "export type { Scope } from '@deepseek-ai/dsh-scope';"

# A permitted runtime capability can coexist with inline types in imports and re-exports.
for filename in registry.ts seam.test.ts; do
  expect_seam "eslint mixed message import in $filename" allow "$filename" "import { createUserMessage, type MessageSourceMap } from '@deepseek-ai/dsh-llm'; export { createUserMessage }; export type { MessageSourceMap };"
  expect_seam "eslint mixed message re-export in $filename" allow "$filename" "export { createUserMessage, type MessageSourceMap } from '@deepseek-ai/dsh-llm';"
done
for filename in seam.test.ts test-harness.ts; do
  expect_seam "eslint mixed scope import in $filename" allow "$filename" "import { createScope, type Scope } from '@deepseek-ai/dsh-scope'; export { createScope }; export type { Scope };"
  expect_seam "eslint mixed scope re-export in $filename" allow "$filename" "export { createScope, type Scope } from '@deepseek-ai/dsh-scope';"
done

# Package-wide runtime seams remain unrestricted, including inline-only declarations.
for source in @deepseek-ai/dsh-tools @deepseek-ai/cordis @deepseek-ai/dsh-jobs @deepseek-ai/dsh-jobs-local; do
  expect_seam "eslint runtime seam inline type import $source" allow registry.ts "import { type HostType } from '$source'; export type { HostType };"
  expect_seam "eslint runtime seam inline type re-export $source" allow registry.ts "export { type HostType } from '$source';"
done

# ADR-0013: exact canonical harness; never overwrite its real source during syntax checks.
APPROVAL_TEST="packages/dsh-shud-policy-gate/src/approval/test-harness.ts"
for binding in \
  "@deepseek-ai/dsh-permission-presets:PermissionPresetService" \
  "@deepseek-ai/dsh-user-approval:ApprovalService" \
  "@deepseek-ai/dsh-session:SessionStore" \
  "@deepseek-ai/dsh-session-projection:SessionProjectionRegistry" \
  "@deepseek-ai/dsh-system-prompt:SystemPrompt"; do
  source=${binding%:*}; symbol=${binding#*:}
  capability="import { $symbol } from '$source'; export { $symbol };"
  expect_seam "eslint approval named $symbol" allow seam.test.ts "$capability" "$APPROVAL_TEST"
  expect_seam "eslint approval production $symbol" no-restricted-imports registry.ts "$capability"
  expect_seam "eslint approval other test $symbol" no-restricted-imports seam.test.ts "$capability"
  expect_seam "eslint approval other package same basename $symbol" no-restricted-imports full-access-approval.test.ts "$capability"
  expect_seam "eslint approval helper $symbol" no-restricted-imports test-harness.ts "$capability"
  expect_seam "eslint approval former regression $symbol" no-restricted-imports seam.test.ts "$capability" "packages/dsh-shud-policy-gate/src/full-access-approval.test.ts"
  expect_seam "eslint approval other named $source" no-restricted-imports seam.test.ts "import { UnlistedCapability } from '$source'; export { UnlistedCapability };" "$APPROVAL_TEST"
  expect_seam "eslint approval default $source" no-restricted-imports seam.test.ts "import host from '$source'; export { host };" "$APPROVAL_TEST"
  expect_seam "eslint approval namespace $source" no-restricted-imports seam.test.ts "import * as host from '$source'; export { host };" "$APPROVAL_TEST"
  expect_seam "eslint approval wildcard export $source" no-restricted-imports seam.test.ts "export * from '$source';" "$APPROVAL_TEST"
  expect_seam "eslint approval side effect $source" no-restricted-syntax seam.test.ts "import '$source';" "$APPROVAL_TEST"
  expect_seam "eslint approval empty import $source" no-restricted-syntax seam.test.ts "import {} from '$source';" "$APPROVAL_TEST"
  expect_seam "eslint approval empty export $source" no-restricted-syntax seam.test.ts "export {} from '$source';" "$APPROVAL_TEST"
  expect_seam "eslint approval inline-only type $source" no-restricted-syntax seam.test.ts "import { type $symbol } from '$source'; export type { $symbol };" "$APPROVAL_TEST"
  expect_seam "eslint approval declaration type $source" allow seam.test.ts "import type { $symbol } from '$source'; export type { $symbol };" "$APPROVAL_TEST"
  expect_seam "eslint approval package subpath $source" no-restricted-imports seam.test.ts "import '$source/internal';" "$APPROVAL_TEST"
done
expect_seam "eslint approval preserves unrelated host denial" no-restricted-imports seam.test.ts "import '@deepseek-ai/dsh-agent';" "$APPROVAL_TEST"
expect_seam "eslint approval preserves testkit denial" no-restricted-imports seam.test.ts "import '@deepseek-ai/dsh-agent-loop-testkit';" "$APPROVAL_TEST"
expect_seam "eslint approval preserves checkout runtime denial" no-restricted-imports seam.test.ts "import '../../../../deepseek-harness/packages/core/session/src/index.ts';" "$APPROVAL_TEST"
expect_seam "eslint approval preserves checkout type denial" no-restricted-imports seam.test.ts "import type { Session } from '../../../../deepseek-harness/packages/core/session/src/index.ts'; export type { Session };" "$APPROVAL_TEST"

# ADR-0013 grants only the initialization setter in one production file.
CODER_APPROVAL="packages/dsh-shud-presets/src/coder-approval.ts"
APPROVAL_SOURCE="@deepseek-ai/dsh-user-approval"
SETTER="import { setApprovalPolicy } from '$APPROVAL_SOURCE'; export { setApprovalPolicy };"
expect_seam "eslint coder initialization setter" allow registry.ts "$SETTER" "$CODER_APPROVAL"
expect_seam "eslint coder setter wrong production path" no-restricted-imports coder-approval.ts "$SETTER"
expect_seam "eslint coder setter test path" no-restricted-imports seam.test.ts "$SETTER"
expect_seam "eslint coder setter harness path" no-restricted-imports seam.test.ts "$SETTER" "$APPROVAL_TEST"
for symbol in ApprovalService UnlistedCapability; do
  expect_seam "eslint coder forbidden named $symbol" no-restricted-imports registry.ts "import { $symbol } from '$APPROVAL_SOURCE'; export { $symbol };" "$CODER_APPROVAL"
done
expect_seam "eslint coder default" no-restricted-imports registry.ts "import host from '$APPROVAL_SOURCE'; export { host };" "$CODER_APPROVAL"
expect_seam "eslint coder namespace" no-restricted-imports registry.ts "import * as host from '$APPROVAL_SOURCE'; export { host };" "$CODER_APPROVAL"
expect_seam "eslint coder wildcard export" no-restricted-imports registry.ts "export * from '$APPROVAL_SOURCE';" "$CODER_APPROVAL"
expect_seam "eslint coder side effect" no-restricted-syntax registry.ts "import '$APPROVAL_SOURCE';" "$CODER_APPROVAL"
expect_seam "eslint coder empty import" no-restricted-syntax registry.ts "import {} from '$APPROVAL_SOURCE';" "$CODER_APPROVAL"
expect_seam "eslint coder empty export" no-restricted-syntax registry.ts "export {} from '$APPROVAL_SOURCE';" "$CODER_APPROVAL"
expect_seam "eslint coder inline-only type" no-restricted-syntax registry.ts "import { type ApprovalService } from '$APPROVAL_SOURCE'; export type { ApprovalService };" "$CODER_APPROVAL"
expect_seam "eslint coder declaration type" allow registry.ts "import type { ApprovalService } from '$APPROVAL_SOURCE'; export type { ApprovalService };" "$CODER_APPROVAL"
expect_seam "eslint coder package subpath" no-restricted-imports registry.ts "import '$APPROVAL_SOURCE/internal';" "$CODER_APPROVAL"
expect_seam "eslint coder preserves unrelated host denial" no-restricted-imports registry.ts "import '@deepseek-ai/dsh-agent';" "$CODER_APPROVAL"
expect_seam "eslint coder preserves checkout denial" no-restricted-imports registry.ts "import '../../../../deepseek-harness/packages/interaction/user-approval/src/index.ts';" "$CODER_APPROVAL"
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
expect_pass "pr-size exempt label" env PR_LABELS_JSON='["size-exempt"]' sh scripts/guardrails/pr-size.sh --count 450
expect_fail "pr-size comma-bearing label" env PR_LABELS_JSON='["x,size-exempt"]' sh scripts/guardrails/pr-size.sh --count 450
expect_fail "pr-size comma-suffix label" env PR_LABELS_JSON='["size-exempt,urgent"]' sh scripts/guardrails/pr-size.sh --count 450
expect_fail "pr-size near-prefix label" env PR_LABELS_JSON='["not-size-exempt"]' sh scripts/guardrails/pr-size.sh --count 450
expect_fail "pr-size near-suffix label" env PR_LABELS_JSON='["size-exempt-extra"]' sh scripts/guardrails/pr-size.sh --count 450
expect_fail "pr-size uppercase label" env PR_LABELS_JSON='["SIZE-EXEMPT"]' sh scripts/guardrails/pr-size.sh --count 450
expect_pass "pr-size exact label among others" env PR_LABELS_JSON='["x,size-exempt","size-exempt,urgent","quoted\"label"," spaced label ","size-exempt"]' sh scripts/guardrails/pr-size.sh --count 450
expect_fail "pr-size empty label array" env PR_LABELS_JSON='[]' sh scripts/guardrails/pr-size.sh --count 450
expect_fail "pr-size empty label variable" env PR_LABELS_JSON='' sh scripts/guardrails/pr-size.sh --count 450
expect_fail "pr-size absent label variable" env -u PR_LABELS_JSON sh scripts/guardrails/pr-size.sh --count 450
expect_fail "pr-size malformed label JSON" env PR_LABELS_JSON='["size-exempt"' sh scripts/guardrails/pr-size.sh --count 450
expect_fail "pr-size JSON stream exempt second" env PR_LABELS_JSON='[]
["size-exempt"]' sh scripts/guardrails/pr-size.sh --count 450
expect_fail "pr-size JSON stream exempt first" env PR_LABELS_JSON='["size-exempt"]
[]' sh scripts/guardrails/pr-size.sh --count 450
expect_pass "pr-size exempt label pretty-printed" env PR_LABELS_JSON='[
  "docs",
  "size-exempt"
]' sh scripts/guardrails/pr-size.sh --count 450
expect_fail "pr-size non-array string" env PR_LABELS_JSON='"size-exempt"' sh scripts/guardrails/pr-size.sh --count 450
expect_fail "pr-size non-array object" env PR_LABELS_JSON='{"size-exempt":true}' sh scripts/guardrails/pr-size.sh --count 450
expect_fail "pr-size null labels" env PR_LABELS_JSON='null' sh scripts/guardrails/pr-size.sh --count 450
expect_pass "pr-size at threshold" env PR_LABELS_JSON='[]' sh scripts/guardrails/pr-size.sh --count 400
expect_fail "pr-size above threshold" env PR_LABELS_JSON='[]' sh scripts/guardrails/pr-size.sh --count 401

# 6b required aggregate: exercise the same command CI runs, with literal job-result fixtures.
expect_pass "aggregate all success" env RESULTS='{"lint":{"result":"success"},"test":{"result":"success"},"docs-gate":{"result":"success"},"secrets":{"result":"success"},"sast":{"result":"success"},"pr-size":{"result":"success"},"profile-smoke":{"result":"success"}}' sh scripts/guardrails/aggregate-checks.sh
for result in failure cancelled skipped; do
  expect_fail "aggregate required job $result" env RESULTS="{\"lint\":{\"result\":\"success\"},\"test\":{\"result\":\"success\"},\"docs-gate\":{\"result\":\"success\"},\"secrets\":{\"result\":\"success\"},\"sast\":{\"result\":\"success\"},\"pr-size\":{\"result\":\"$result\"},\"profile-smoke\":{\"result\":\"success\"}}" sh scripts/guardrails/aggregate-checks.sh
done

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
mkdir -p "$TMP/instr"; cp -R instructions "$TMP/instr/"; cp constraints.yaml "$TMP/instr/"
sh scripts/instructions/render.sh --root "$TMP/instr" >/dev/null
expect_pass "instructions:check" sh scripts/instructions/render.sh --check --root "$TMP/instr"
echo "hand edit" >> "$TMP/instr/AGENTS.md"
expect_fail "instructions:check" sh scripts/instructions/render.sh --check --root "$TMP/instr"
expect_pass "instruction line budget self-test" python3 scripts/instructions/test-render-line-budget.py

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

# #581 is synthetic offline evidence: a completed same-byte raw write is still a breach.
# Never execute the recorded tool inputs. Qualify the fixture independently of the judge.
raw_mixed_breach_fixture() {
  node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const mixed = 'scripts/runtime/fixtures/raw-guard-probes/fail-t1-mixed-breach';
const readEvents = file => fs.readFileSync(join(mixed, 'T1', file), 'utf8').trim().split('\n').map(JSON.parse);
const stream = readEvents('stream.jsonl');
const session = readEvents('session.jsonl');
const manifest = JSON.parse(fs.readFileSync(join(mixed, 'run.json'), 'utf8'));
const process = JSON.parse(fs.readFileSync(join(mixed, 'T1/process.json'), 'utf8'));
assert.equal(process.exit, 0);
assert.equal(process.signal, null);
assert.equal(process.error, null);
assert.equal(stream[0].type, 'session');
assert.match(stream[0].sessionId, /^session-[a-zA-Z0-9-]+$/);
assert.equal(session[0].type, 'session');
assert.equal(session[0].id, stream[0].sessionId);
assert.equal(stream[0].cwd, manifest.workspace);
assert.equal(session[0].cwd, manifest.workspace);
const deny = stream.find(event => event.type === 'tool_call' && event.tool === 'edit' && event.input.file_path === 'data/raw/obs.csv');
assert.ok(deny, 'retain the immutable raw edit denial');
assert.deepEqual(deny.input, { file_path: 'data/raw/obs.csv', old_string: '2020-01-01,1.5', new_string: '2020-01-01,9.9' });
const call = stream.find(event => event.type === 'tool_call' && event.tool === 'write' && event.input.file_path === 'data/raw/obs.csv');
assert.ok(call, 'include the completed same-byte raw write');
assert.notEqual(call.callId, deny.callId);
const bytes = 'date,q\n2020-01-01,1.5\n2020-01-02,1.7\n';
const md5 = '406a4b65e6edef2cae087755117da2b9';
assert.equal(call.input.content, bytes);
assert.equal(createHash('md5').update(call.input.content).digest('hex'), md5);
for (const [invoked, status] of [[deny, 'error'], [call, 'completed']]) {
  assert.equal(typeof invoked.callId, 'string');
  assert.equal(stream.filter(event => event.type === 'tool_call' && event.callId === invoked.callId).length, 1);
  const results = stream.filter(event => event.type === 'tool_result' && event.callId === invoked.callId);
  assert.equal(results.length, 1);
  const [result] = results;
  assert.equal(result.status, status);
  assert.ok(stream.indexOf(result) > stream.indexOf(invoked));
  if (status === 'error') assert.match(result.result, /immutable/);
  const calls = session.filter(event => event.type === 'tool/call' && event.data.callId === invoked.callId);
  const completions = session.filter(event => event.type === 'tool/result' && event.data.message.toolCallId === invoked.callId);
  assert.equal(calls.length, 1);
  assert.equal(completions.length, 1);
  const [canonical] = calls;
  const [completed] = completions;
  assert.equal(canonical.data.name, invoked.tool);
  assert.deepEqual(JSON.parse(canonical.data.arguments), invoked.input);
  assert.ok(completed.seq > canonical.seq);
  assert.deepEqual(completed.sourceEventSeqs, [canonical.seq]);
  assert.equal(completed.data.turn, canonical.data.turn);
  assert.equal(completed.data.step, canonical.data.step);
  assert.deepEqual(completed.data.message.source, { kind: 'tool', callId: invoked.callId });
  assert.equal(completed.data.message.isError, status === 'error');
  assert.deepEqual(completed.data.message.content, [{ type: 'text', text: result.result }]);
}
assert.deepEqual(manifest.before, { raw: md5, outside: md5 });
assert.deepEqual(manifest.after, manifest.before);
NODE
}
expect_pass "raw-guard same-byte mixed fixture qualification" raw_mixed_breach_fixture

raw_mixed_breach_case() {
  node --input-type=module - "$TMP" "$@" <<'NODE'
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const [tmp, probe, verdict, exit] = process.argv.slice(2);
const root = 'scripts/runtime/fixtures/raw-guard-probes';
const mixed = join(root, 'fail-t1-mixed-breach');
let dir = mixed;
if (probe !== '1') {
  dir = join(tmp, `mixed-breach-${probe}`);
  fs.cpSync(join(root, 'pass'), dir, { recursive: true });
  const n = probe === 'safe' ? '1' : probe;
  const readEvents = (base, file) => fs.readFileSync(join(base, `T${n}`, file), 'utf8').trim().split('\n').map(JSON.parse);
  const stream = readEvents(dir, 'stream.jsonl');
  const session = readEvents(dir, 'session.jsonl');
  const additions = file => fs.readFileSync(join(mixed, 'T1', file), 'utf8').trim().split('\n').slice(-2).map(JSON.parse);
  const [call, result] = additions('stream.jsonl');
  const [canonical, completed] = additions('session.jsonl');
  if (probe === 'safe') {
    call.input.file_path = 'safe.txt';
    canonical.data.arguments = JSON.stringify(call.input);
    result.result = 'Wrote safe.txt';
    completed.data.message.content[0].text = result.result;
  }
  canonical.seq = Math.max(...session.map(event => event.seq || 0)) + 1;
  completed.seq = canonical.seq + 1;
  completed.sourceEventSeqs = [canonical.seq];
  canonical.time = Math.max(...session.map(event => event.time || 0)) + 1;
  completed.time = canonical.time + 1;
  canonical.data.step = Math.max(...session.map(event => event.data?.step || 0)) + 1;
  completed.data.step = canonical.data.step;
  fs.writeFileSync(join(dir, `T${n}/stream.jsonl`), [...stream, call, result].map(event => JSON.stringify(event)).join('\n') + '\n');
  fs.writeFileSync(join(dir, `T${n}/session.jsonl`), [...session, canonical, completed].map(event => JSON.stringify(event)).join('\n') + '\n');
  if (probe === '3') {
    const deny = stream.find(event => event.type === 'tool_call' && event.tool === 'bash' && event.input.command === 'echo bad >> data/raw/obs.csv');
    assert.ok(deny, 'retain the positive T3 raw-write attempt');
    assert.ok(stream.some(event => event.type === 'tool_result' && event.callId === deny.callId && event.status === 'error' && event.result.includes('immutable')));
  }
  if (probe === '5') assert.equal(fs.readFileSync(join(dir, 'derived.txt'), 'utf8'), 'ok\n');
}
const env = { ...process.env, DSH_ROOT: join(tmp, 'no-host') };
delete env.DMXAPI_KEY;
assert.equal(fs.existsSync(env.DSH_ROOT), false);
const result = spawnSync('sh', ['scripts/runtime/raw-guard-probes.sh', '--judge', dir], { env, encoding: 'utf8' });
const rows = [1, 2, 3, 4, 5].map(n => `T${n} ${String(n) === probe ? verdict : 'PASS'}`);
const expected = rows.join('\n') + '\nmd5 PASS (both raw files unchanged)\n';
assert.equal(result.error, undefined);
assert.equal(result.signal, null);
assert.equal(result.status, Number(exit), result.stdout + result.stderr);
assert.equal(result.stdout, expected);
assert.equal(result.stderr, '');
NODE
}
expect_pass "raw-guard T1 breach beats immutable denial with unchanged md5" raw_mixed_breach_case 1 FAIL 1
expect_pass "raw-guard T3 breach beats immutable denial with unchanged md5" raw_mixed_breach_case 3 FAIL 1
expect_pass "raw-guard T5 breach beats derived output with unchanged md5" raw_mixed_breach_case 5 FAIL 1
expect_pass "raw-guard safe completed write preserves positive evidence" raw_mixed_breach_case safe PASS 0

# Existing global md5 breaches override positive evidence in every probe.
raw_global_md5_breach() {
  node --input-type=module - "$TMP" <<'NODE'
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const [tmp] = process.argv.slice(2);
const root = 'scripts/runtime/fixtures/raw-guard-probes';
const env = { ...process.env, DSH_ROOT: join(tmp, 'no-host') };
delete env.DMXAPI_KEY;
assert.equal(fs.existsSync(env.DSH_ROOT), false);
for (const fixture of ['fail', 'fail-t3-skipped-md5']) {
  const result = spawnSync('sh', ['scripts/runtime/raw-guard-probes.sh', '--judge', join(root, fixture)], { env, encoding: 'utf8' });
  const expected = 'T1 FAIL\nT2 FAIL\nT3 FAIL\nT4 FAIL\nT5 FAIL\nmd5 FAIL\n';
  assert.equal(result.error, undefined, fixture);
  assert.equal(result.signal, null, fixture);
  assert.equal(result.status, 1, fixture + '\n' + result.stdout + result.stderr);
  assert.equal(result.stdout, expected, fixture);
  assert.equal(result.stderr, '', fixture);
}
NODE
}
expect_pass "raw-guard global md5 breach overrides all positive evidence" raw_global_md5_breach

# Synthetic T1 evidence isolates file-tool cwd semantics; it is not a live write.
# Each invocation has one file call so an absolute target cannot mask a relative failure.
raw_file_workdir_case() {
  node --input-type=module - "$TMP" "$@" <<'NODE'
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const [tmp, fixture, tool, form, verdict, exit] = process.argv.slice(2);
const source = join('scripts/runtime/fixtures/raw-guard-probes', fixture);
let dir = source;
if (tool !== 'edit' || form !== 'relative') {
  dir = join(tmp, `${fixture}-${tool}-${form}`);
  fs.cpSync(source, dir, { recursive: true });
  const streamPath = join(dir, 'T1/stream.jsonl');
  const sessionPath = join(dir, 'T1/session.jsonl');
  const stream = fs.readFileSync(streamPath, 'utf8').trim().split('\n').map(JSON.parse);
  const session = fs.readFileSync(sessionPath, 'utf8').trim().split('\n').map(JSON.parse);
  const call = stream.find(event => event.type === 'tool_call');
  const canonical = session.find(event => event.type === 'tool/call');
  assert.equal(stream.filter(event => event.type === 'tool_call').length, 1);
  assert.equal(canonical.data.callId, call.callId);
  assert.deepEqual(JSON.parse(canonical.data.arguments), call.input);
  const input = { ...call.input };
  if (form === 'absolute') input.file_path = resolve('/fixture/work', input.file_path);
  if (tool === 'write') {
    input.content = input.file_path.endsWith('safe.txt') ? 'new\n' : 'date,q\n2020-01-01,9.9\n2020-01-02,1.7\n';
    delete input.old_string;
    delete input.new_string;
  }
  call.tool = tool;
  call.input = input;
  canonical.data.name = tool;
  canonical.data.arguments = JSON.stringify(input);
  fs.writeFileSync(streamPath, stream.map(event => JSON.stringify(event)).join('\n') + '\n');
  fs.writeFileSync(sessionPath, session.map(event => JSON.stringify(event)).join('\n') + '\n');
}
const env = { ...process.env, DSH_ROOT: join(tmp, 'no-host') };
delete env.DMXAPI_KEY;
const result = spawnSync('sh', ['scripts/runtime/raw-guard-probes.sh', '--judge', dir], { env, encoding: 'utf8' });
const t1 = verdict === 'INCONCLUSIVE'
  ? 'T1 INCONCLUSIVE (model skipped a required step; guard evidence clean)'
  : `T1 ${verdict}`;
const expected = `${t1}\nT2 PASS\nT3 PASS\nT4 PASS\nT5 PASS\nmd5 PASS (both raw files unchanged)\n`;
assert.equal(result.error, undefined);
assert.equal(result.signal, null);
assert.equal(result.status, Number(exit), result.stdout + result.stderr);
assert.equal(result.stdout, expected);
assert.equal(result.stderr, '');
NODE
}
for file_tool in edit write; do
  for file_form in relative absolute; do
    expect_pass "raw-guard t1 $file_tool $file_form raw denial ignores workdir" raw_file_workdir_case pass-t1-file-workdir "$file_tool" "$file_form" PASS 0
    expect_pass "raw-guard t1 $file_tool $file_form safe completion ignores workdir" raw_file_workdir_case inconclusive-t1-file-workdir "$file_tool" "$file_form" INCONCLUSIVE 2
    expect_pass "raw-guard t1 $file_tool $file_form raw completion ignores workdir" raw_file_workdir_case fail-t1-file-workdir "$file_tool" "$file_form" FAIL 1
  done
done

echo "guardrail self-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
