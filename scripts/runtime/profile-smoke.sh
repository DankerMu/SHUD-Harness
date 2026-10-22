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
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { parseDocument } from "yaml";
const root = process.argv[2];
function run(label, executable, args, schemaDump = false, env = process.env, acceptFailure = false) {
  const result = spawnSync(executable, args, {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60_000, env,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const key = process.env.DMXAPI_KEY;
  if (/DMXAPI_KEY=|sk-[A-Za-z0-9]{20,}/.test(output) || (key && output.includes(key))) {
    throw new Error(`${label}: secret material detected; output suppressed`);
  }
  if (result.error || (!acceptFailure && result.status !== 0 && !(schemaDump && result.status === 1))) {
    throw new Error(`${label} failed (exit ${result.status ?? "none"}, ${result.error?.code ?? result.signal ?? "command error"}); output suppressed`);
  }
  return result;
}
const failures = [];
function check(label, condition) { if (!condition) failures.push(label); }
const installerPath = join(root, "scripts/runtime/profile-install.sh");
const home = process.env.DSH_HOME;
const scratch = join(home, "..");
const shudBin = join(scratch, "shud executable");
const alternateBin = join(scratch, "shud # quote' colon: back\\slash");
for (const path of [shudBin, alternateBin]) {
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
}
process.env.SHUD_BIN = shudBin;
function install(label, name, binary, template = "web", acceptFailure = false) {
  const env = { ...process.env, PROFILE_NAME: name, PROFILE_TEMPLATE: template };
  if (binary === undefined) delete env.SHUD_BIN;
  else env.SHUD_BIN = binary;
  return run(label, "sh", [installerPath], false, env, acceptFailure);
}
function bytes(path) { return existsSync(path) ? readFileSync(path) : null; }
function hash(path) {
  const content = bytes(path);
  return content === null ? null : createHash("sha256").update(content).digest("hex");
}
function profilePaths(name) {
  const directory = join(home, "profiles", name);
  return { directory, manifest: join(directory, "package.json"), patch: join(directory, "cordis.patch.yml") };
}
function patchRows(source, label) {
  const document = parseDocument(source, { prettyErrors: false });
  if (document.errors.length) {
    throw new Error(`${label}: invalid YAML (${document.errors[0].code}); source suppressed`);
  }
  const value = document.toJS();
  check(`${label}: patch is a sequence`, Array.isArray(value));
  return Array.isArray(value) ? value : [];
}
function checkJobsPatch(name, binary, label) {
  const paths = profilePaths(name);
  check(`${label}: patch exists`, existsSync(paths.patch));
  if (!existsSync(paths.patch)) return;
  const rows = patchRows(readFileSync(paths.patch, "utf8"), label);
  const jobs = rows.filter((row) => row?.id === "shud-jobs");
  check(`${label}: unique semantic jobs item`, jobs.length === 1);
  check(`${label}: configured shudBin`, jobs[0]?.config?.shudBin === binary);
  check(`${label}: configured stateDir`, jobs[0]?.config?.stateDir === join(paths.directory, "shud-jobs"));
}
function preservedInstall(name, binary, label) {
  const paths = profilePaths(name);
  const before = [hash(paths.manifest), hash(paths.patch)];
  const beforeStat = existsSync(paths.patch) ? lstatSync(paths.patch) : null;
  install(label, name, binary);
  check(`${label}: package hash unchanged`, hash(paths.manifest) === before[0]);
  check(`${label}: patch hash unchanged`, hash(paths.patch) === before[1]);
  const afterStat = existsSync(paths.patch) ? lstatSync(paths.patch) : null;
  check(`${label}: unchanged patch was not rewritten`,
    beforeStat === null ? afterStat === null : beforeStat.ino === afterStat?.ino && beforeStat.mtimeMs === afterStat?.mtimeMs);
}
function rejectedBinary(name, binary, label) {
  const paths = profilePaths(name);
  const existed = existsSync(paths.directory);
  const before = [hash(paths.manifest), hash(paths.patch)];
  const result = install(label, name, binary, "web", true);
  check(`${label}: installer rejects invalid binary`, result.status !== 0);
  check(`${label}: SHUD_BIN diagnostic`, /SHUD_BIN/.test(`${result.stdout}\n${result.stderr}`));
  check(`${label}: profile creation unchanged`, existsSync(paths.directory) === existed);
  check(`${label}: package bytes unchanged`, hash(paths.manifest) === before[0]);
  check(`${label}: patch bytes unchanged`, hash(paths.patch) === before[1]);
}
function checkJobsSchema(schema, label) {
  const entries = schema["x-cordis"]?.entries ?? [];
  const jobs = entries.filter((entry) => entry.id === "shud-jobs");
  check(`${label}: unique shud-jobs schema entry`, jobs.length === 1);
  check(`${label}: shud-jobs native projection unsupported`, jobs[0]?.status === "unsupported");
  const diagnostics = (schema["x-cordis"]?.diagnostics ?? []).filter((item) => item.path === jobs[0]?.path);
  check(`${label}: only expected Standard Schema diagnostic`,
    diagnostics.length === 1 && diagnostics[0].message === "Config is not a native Schemastery schema");
}
async function checkInvalidBoot(bin, profile) {
  const overlay = join(scratch, "missing-shud-bin.patch.yml");
  writeFileSync(overlay, JSON.stringify([
    { id: "shud-jobs", config: { stateDir: join(profile.directory, "shud-jobs"), shudBin: "" } },
    // The production Web template stays unchanged; expose dependency waiting in this probe only.
    { id: "tool-jobs", disabled: false },
  ]));
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const child = spawn(process.execPath, [
    bin, "--profile", "shud", "--patch", overlay, "--no-open", "--port", String(port),
  ], { env: process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let bytes = 0;
  let overflow = false;
  let exited = false;
  let startupError;
  const closed = new Promise((resolve) => child.once("close", () => { exited = true; resolve(); }));
  child.once("error", (error) => { startupError = error; });
  const capture = (chunk) => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) overflow = true;
    else output += chunk.toString("utf8");
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  function evidence() {
    const lines = output.split(/\r?\n/);
    const row = lines.findIndex((line) => /^shud-jobs \([^\r\n]+\): \w*Error:/.test(line));
    const detail = [];
    for (let index = row; index >= 0 && index < lines.length; index++) {
      if (index > row && lines[index] && !/^\s/.test(lines[index])) break;
      detail.push(lines[index]);
    }
    return {
      activation: output.includes("did not activate") && row >= 0,
      key: row >= 0 && detail.some((line) => line.includes("shudBin")),
      dependency: /^tool-jobs \([^\r\n]+\): pending \(waiting for service: jobs\)/m.test(output),
    };
  }
  function signal(name) {
    if (!child.pid) return;
    try { process.kill(-child.pid, name); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  async function stop() {
    signal("SIGTERM");
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000))]);
    signal("SIGKILL");
    await closed;
  }
  const interrupt = () => { void stop().finally(() => process.exit(1)); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  process.once("SIGHUP", interrupt);
  try {
    const deadline = Date.now() + 20_000;
    while (!exited && !overflow && Date.now() < deadline) {
      const found = evidence();
      if (found.activation && found.key && found.dependency) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    await stop();
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.removeListener(name, interrupt);
  }
  if (startupError) throw new Error(`negative boot spawn failed (${startupError.code}); output suppressed`);
  const key = process.env.DMXAPI_KEY;
  if (/DMXAPI_KEY=|sk-[A-Za-z0-9]{20,}/.test(output) || (key && output.includes(key))) {
    throw new Error("negative boot: secret material detected; output suppressed");
  }
  const found = evidence();
  check("negative boot: bounded diagnostic output", !overflow);
  check("negative boot: shud-jobs did not activate", found.activation);
  check("negative boot: shud-jobs reported shudBin", found.key);
  check("negative boot: tool-jobs waits for missing jobs service", found.dependency);
}
try {
  const notExecutable = join(scratch, "not-executable");
  writeFileSync(notExecutable, "not executable\n", { mode: 0o600 });
  const invalidBins = [
    ["missing", undefined], ["empty", ""], ["relative", "relative/shud"], ["nonexistent", join(scratch, "missing")],
    ["non-executable", notExecutable], ["directory", scratch],
  ];
  for (const [kind, binary] of invalidBins) {
    rejectedBinary(`invalid-${kind}`, binary, `new profile ${kind} SHUD_BIN`);
  }
  run("profile installation", "sh", [join(root, "scripts/runtime/profile-install.sh")]);
  const web = profilePaths("shud");
  check("first Web install: exact bundle order", JSON.stringify(
    JSON.parse(readFileSync(web.manifest, "utf8")).dsh.profile.bundles,
  ) === JSON.stringify(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@shud-harness/dsh-profile-shud"]));
  checkJobsPatch("shud", shudBin, "first Web install");
  preservedInstall("shud", shudBin, "second Web install");
  for (const [kind, binary] of invalidBins) {
    rejectedBinary("shud", binary, `existing profile ${kind} SHUD_BIN`);
  }
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
  const jobs = row("jobs");
  const shudJobs = row("shud-jobs");
  check("parent jobs disabled", /^  disabled: true$/m.test(jobs));
  check("shud-jobs package specifier", /^  name: ['"]?@shud-harness\/dsh-shud-jobs['"]?$/m.test(shudJobs));
  const composedJobs = patchRows(dump, "composed profile").filter((entry) => entry?.id === "shud-jobs");
  check("composed shud-jobs binary", composedJobs[0]?.config?.shudBin === shudBin);
  check("composed shud-jobs state directory", composedJobs[0]?.config?.stateDir === join(web.directory, "shud-jobs"));
  checkJobsSchema(schema, "Web import");

  const rawOnly = "# existing deployment bytes\r\n- id: 'shud-raw-guard'\r\n  config: { rawDirs: ['/srv/data_root/raw'] }\r\n# preserve missing final newline";
  writeFileSync(web.patch, rawOnly, { mode: 0o640 });
  chmodSync(web.patch, 0o640);
  install("raw-only profile migration", "shud", shudBin);
  const migrated = readFileSync(web.patch, "utf8");
  check("raw-only migration: every previous byte retained", migrated.startsWith(rawOnly));
  check("raw-only migration: file mode retained", (lstatSync(web.patch).mode & 0o777) === 0o640);
  checkJobsPatch("shud", shudBin, "raw-only profile migration");
  preservedInstall("shud", shudBin, "raw-only migration repeated");
  const rawDump = run("raw override dump", process.execPath, [bin, "--profile", "shud", "--dump-config"]).stdout;
  const rawRows = patchRows(rawDump, "raw override dump").filter((entry) => entry?.id === "shud-raw-guard");
  check("deployment raw override remains visible", JSON.stringify(rawRows[0]?.config?.rawDirs) === JSON.stringify(["/srv/data_root/raw"]));

  const prefix = "# keep this prefix\r\n- id: shud-raw-guard\r\n  config: {rawDirs: ['/srv/data_root/raw']}\r\n";
  const suffix = "# keep this suffix\r\n- id: agent-default-model\r\n  config: {model: deepseek-flash-guan} # unchanged";
  const oldJob = `- config: {shudBin: ${JSON.stringify(shudBin)}, stateDir: ${JSON.stringify(join(web.directory, "shud-jobs"))}}\r\n  id: 'shud-jobs'\r\n`;
  writeFileSync(web.patch, prefix + oldJob + suffix);
  install("alternate binary preserves unrelated bytes", "shud", alternateBin);
  const updated = readFileSync(web.patch, "utf8");
  check("alternate binary: prefix byte-identical", updated.startsWith(prefix));
  check("alternate binary: suffix byte-identical", updated.endsWith(suffix));
  checkJobsPatch("shud", alternateBin, "alternate binary");
  preservedInstall("shud", alternateBin, "alternate binary repeated");

  const nested = "- id: agent-default-model\n  config:\n    note: |-\n      - id: shud-jobs\n# literal nested lookalike remains\n";
  writeFileSync(web.patch, nested);
  install("nested jobs lookalike is not a target", "shud", shudBin);
  check("nested lookalike bytes preserved", readFileSync(web.patch, "utf8").startsWith(nested));
  checkJobsPatch("shud", shudBin, "nested jobs lookalike");
  preservedInstall("shud", shudBin, "nested lookalike repeated");

  const flowPrefix = "[{id: shud-raw-guard, config: {rawDirs: ['/srv/data_root/raw']}}, ";
  const flowSuffix = ", {id: agent-default-model, config: {model: deepseek-flash-guan}}]";
  writeFileSync(web.patch, flowPrefix + "{config: {shudBin: /old}, id: \"shud-jobs\"}" + flowSuffix);
  install("flow sequence jobs update", "shud", alternateBin);
  const flowUpdated = readFileSync(web.patch, "utf8");
  check("flow update prefix unchanged", flowUpdated.startsWith(flowPrefix));
  check("flow update suffix unchanged", flowUpdated.endsWith(flowSuffix));
  checkJobsPatch("shud", alternateBin, "flow sequence update");
  preservedInstall("shud", alternateBin, "flow sequence repeated");

  const flowInsertPrefix = "[{id: shud-raw-guard, config: {rawDirs: ['/srv/data_root/raw']}}";
  const flowInsertSuffix = "] # preserve flow trailer\r\n";
  writeFileSync(web.patch, flowInsertPrefix + flowInsertSuffix);
  install("flow sequence jobs insertion", "shud", shudBin);
  const flowInserted = readFileSync(web.patch, "utf8");
  check("flow insertion prefix unchanged", flowInserted.startsWith(flowInsertPrefix));
  check("flow insertion trailer unchanged", flowInserted.endsWith(flowInsertSuffix));
  checkJobsPatch("shud", shudBin, "flow sequence insertion");
  preservedInstall("shud", shudBin, "flow insertion repeated");

  const sharedDesired = `- &shared {id: shud-jobs, config: {shudBin: ${JSON.stringify(shudBin)}, stateDir: ${JSON.stringify(join(web.directory, "shud-jobs"))}}}\n- id: other\n  config: *shared\n`;
  writeFileSync(web.patch, sharedDesired);
  preservedInstall("shud", shudBin, "shared target already desired");
  checkJobsPatch("shud", shudBin, "shared target already desired");
  const sharedHash = hash(web.patch);
  const sharedStat = lstatSync(web.patch);
  const changedShared = install("shared target changed binary", "shud", alternateBin, "web", true);
  check("shared target changed binary: rejected", changedShared.status !== 0);
  check("shared target changed binary: patch hash unchanged", hash(web.patch) === sharedHash);
  const rejectedSharedStat = lstatSync(web.patch);
  check("shared target changed binary: inode and mtime unchanged",
    sharedStat.ino === rejectedSharedStat.ino && sharedStat.mtimeMs === rejectedSharedStat.mtimeMs);
  writeFileSync(web.patch, migrated);

  for (const [label, source] of [
    ["duplicate target", "- id: shud-jobs\n- id: 'shud-jobs'\n"],
    ["invalid YAML", "- id: shud-jobs\n  config: [DO_NOT_ECHO_USER_PATCH\n"],
    ["shared target anchor", "- &shared {id: shud-jobs, config: {shudBin: /old}}\n- id: agent-default-model\n  config: *shared\n"],
  ]) {
    writeFileSync(web.patch, source);
    const before = hash(web.patch);
    const result = install(label, "shud", shudBin, "web", true);
    check(`${label}: installer rejects ambiguous patch`, result.status !== 0);
    check(`${label}: patch bytes unchanged`, hash(web.patch) === before);
    check(`${label}: diagnostic omits source content`, !`${result.stdout}\n${result.stderr}`.includes("DO_NOT_ECHO_USER_PATCH"));
    const diagnostic = `${result.stdout}\n${result.stderr}`;
    const location = diagnostic.indexOf(`${web.patch}:`);
    check(`${label}: diagnostic identifies file and line`,
      location >= 0 && /^[1-9][0-9]*:/.test(diagnostic.slice(location + web.patch.length + 1)));
  }
  writeFileSync(web.patch, migrated);

  install("headless profile installation", "shud-probe", shudBin, "headless");
  const headless = profilePaths("shud-probe");
  const headlessBundles = JSON.parse(readFileSync(headless.manifest, "utf8")).dsh.profile.bundles;
  check("headless profile excludes Web bundle", !headlessBundles.includes("@deepseek-ai/dsh-web-app"));
  check("headless profile ends with SHUD bundle", headlessBundles.at(-1) === "@shud-harness/dsh-profile-shud");
  checkJobsPatch("shud-probe", shudBin, "headless profile");
  const headlessSchema = JSON.parse(run("headless schema", process.execPath,
    [bin, "--profile", "shud-probe", "--dump-config-schema"], true).stdout);
  checkJobsSchema(headlessSchema, "headless import");
  const headlessGuards = (headlessSchema["x-cordis"]?.entries ?? []).filter((entry) => entry.id === "shud-raw-guard");
  check("headless raw-guard imports", headlessGuards.length === 1 && ["absent", "schema"].includes(headlessGuards[0].status));
  await checkInvalidBoot(bin, web);
  if (failures.length) throw new Error(failures.join("; "));
} catch (error) {
  console.error(`profile:smoke: ${error.message}`);
  process.exitCode = 1;
}
NODE
printf 'profile:smoke: OK (dsh %s, model deepseek-flash-guan via DMXAPI, raw-guard mounted, shud-jobs mounted, session-log-deepseek disabled)\n' "$DSH_VERSION_LABEL"
