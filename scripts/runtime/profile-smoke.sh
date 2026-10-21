#!/usr/bin/env sh
# Profile smoke: build, install a temporary web-template profile, then check
# composed configuration and actual plugin import. CI uses the pinned npm dsh host.
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
if [ "${PROFILE_SMOKE_SKIP_BUILD:-0}" != 1 ]; then
  pnpm --dir "$ROOT" run build
fi
. "$ROOT/scripts/runtime/dsh-root.sh"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/shud-profile-smoke.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
export DSH_HOME="$TMP/home" PROFILE_NAME=shud PROFILE_TEMPLATE=web
unset ALL_PROXY
node --input-type=module - "$ROOT" <<'NODE'
import { spawnSync } from "node:child_process";
import { join } from "node:path";
const root = process.argv[2];
function run(label, executable, args, schemaDump = false) {
  const result = spawnSync(executable, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const key = process.env.DMXAPI_KEY;
  if (/DMXAPI_KEY=|sk-[A-Za-z0-9]{20,}/.test(output) || (key && output.includes(key))) {
    throw new Error(`${label}: secret material detected; output suppressed`);
  }
  if (result.error || (result.status !== 0 && !(schemaDump && result.status === 1))) {
    throw new Error(`${label} failed: ${result.error?.message ?? result.stderr.trim()}`);
  }
  return result;
}
try {
  run("profile installation", "sh", [join(root, "scripts/runtime/profile-install.sh")]);
  const bin = process.env.DSH_BIN;
  const dump = run("dump-config", process.execPath, [bin, "--profile", "shud", "--dump-config"]).stdout;
  const schemaResult = run("dump-config-schema", process.execPath, [bin, "--profile", "shud", "--dump-config-schema"], true);
  const schema = JSON.parse(schemaResult.stdout);
  if (schemaResult.status === 1) {
    if (schema["x-cordis"]?.complete !== false) throw new Error("schema exit 1 without incomplete-projection metadata");
    // The pinned Web presets have incomplete schema projections even without SHUD.
    // Keep host diagnostics visible; import failures are still rejected below.
    console.error("profile:smoke: host schema projection incomplete; checking plugin import status");
    process.stderr.write(schemaResult.stderr);
  }
  const chunks = dump.split(/(?=^- id: )/m);
  const failures = [];
  function check(label, condition) { if (!condition) failures.push(label); }
  function row(id) {
    const matches = chunks.filter((chunk) => chunk.startsWith(`- id: ${id}\n`));
    check(`${id}: unique config row`, matches.length === 1);
    return matches[0] ?? "";
  }
  const model = row("agent-default-model");
  const llm = row("llm-deepseek");
  check("model deepseek-flash-guan", /^    model: deepseek-flash-guan$/m.test(model));
  check("DMXAPI baseURL", /^    baseURL: https:\/\/www\.dmxapi\.cn$/m.test(llm));
  check("DMXAPI_KEY environment reference", /^    apiKeyEnv: DMXAPI_KEY$/m.test(llm));
  check("session-log-deepseek disabled", /^  disabled: true$/m.test(row("session-log-deepseek")));
  for (const id of ["plugin-package-inventory-deepseek", "session-telemetry-otel"]) {
    check(`${id} not disabled`, !/^  disabled: true$/m.test(row(id)));
  }
  const guard = row("shud-raw-guard");
  check("raw-guard package specifier", /^  name: ['"]?@shud-harness\/dsh-shud-raw-guard['"]?$/m.test(guard));
  check("raw-guard rawDirs contains data/raw", /^    rawDirs:\n      - data\/raw(?:\n|$)/m.test(guard));
  check("SHUD bundle provenance", dump.includes("patched by @shud-harness/dsh-profile-shud"));
  const entries = schema["x-cordis"]?.entries;
  check("profile plugin imports have no error status", Array.isArray(entries) && !entries.some((entry) => entry.status === "error"));
  const guards = Array.isArray(entries) ? entries.filter((entry) => entry.id === "shud-raw-guard") : [];
  check("shud-raw-guard: unique schema entry", guards.length === 1);
  check(`shud-raw-guard import status ${guards[0]?.status ?? "missing"}`, guards.length === 1 && ["absent", "schema"].includes(guards[0].status));
  if (failures.length) throw new Error(failures.join("; "));
} catch (error) {
  console.error(`profile:smoke: ${error.message}`);
  process.exitCode = 1;
}
NODE
printf 'profile:smoke: OK (dsh %s, model deepseek-flash-guan via DMXAPI, raw-guard mounted, session-log-deepseek disabled)\n' "$DSH_VERSION_LABEL"
