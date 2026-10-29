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
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createServer } from "node:net";
import { parseDocument } from "yaml";
const root = process.argv[2];
async function run(label, executable, args, schemaDump = false, env = process.env, acceptFailure = false, limits = {}) {
  // Self-contained so the isolated cleanup regressions execute this exact implementation.
  const child = spawn(executable, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const stdout = [], stderr = [];
  let captured = 0, failure, spawnError, closed = false;
  let finish, markClosed;
  const finished = new Promise((resolve) => { finish = resolve; });
  const closing = new Promise((resolve) => { markClosed = resolve; });
  const fail = (reason) => { failure ??= reason; finish(); };
  const capture = (chunks) => (chunk) => {
    captured += chunk.length;
    if (captured > (limits.maxBytes ?? 16 * 1024 * 1024)) {
      fail("output limit");
    } else if (!failure) {
      chunks.push(chunk);
    }
  };
  child.stdout.on("data", capture(stdout));
  child.stderr.on("data", capture(stderr));
  child.once("error", (error) => {
    spawnError = error;
    fail(`spawn ${error.code ?? "error"}`);
  });
  child.once("close", () => { closed = true; markClosed(); finish(); });
  const timeout = setTimeout(() => fail("timeout"), limits.timeoutMs ?? 60_000);
  const interrupts = new Map();
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const interrupt = () => fail(`interrupted by ${name}`);
    interrupts.set(name, interrupt);
    process.on(name, interrupt);
  }
  function groupAlive() {
    if (!child.pid) return false;
    try { process.kill(-child.pid, 0); return true; }
    catch (error) {
      if (error.code === "ESRCH") return false;
      throw new Error(`${label}: cannot inspect child process group; output suppressed`);
    }
  }
  function signal(name) {
    if (!child.pid) return;
    try { process.kill(-child.pid, name); }
    catch (error) {
      if (error.code !== "ESRCH") {
        throw new Error(`${label}: cannot terminate child process group; output suppressed`);
      }
    }
  }
  async function waitForGroup(milliseconds) {
    const deadline = Date.now() + milliseconds;
    while (groupAlive() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return !groupAlive();
  }
  try {
    await finished;
  } finally {
    clearTimeout(timeout);
    try {
      if (groupAlive()) {
        signal("SIGTERM");
        if (!(await waitForGroup(1000))) {
          signal("SIGKILL");
          if (!(await waitForGroup(1000))) failure ??= "child process group did not terminate";
        }
      }
      let closeTimer;
      await Promise.race([
        closing,
        new Promise((resolve) => { closeTimer = setTimeout(resolve, 500); }),
      ]);
      clearTimeout(closeTimer);
      if (!closed) failure ??= "child streams did not close";
    } finally {
      child.stdout.destroy();
      child.stderr.destroy();
      for (const [name, interrupt] of interrupts) process.removeListener(name, interrupt);
    }
  }
  const result = {
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    status: child.exitCode,
    signal: child.signalCode,
    error: spawnError,
  };
  const output = `${result.stdout}\n${result.stderr}`;
  const key = env.DMXAPI_KEY;
  if (/DMXAPI_KEY=|sk-[A-Za-z0-9]{20,}/.test(output) || (key && output.includes(key))) {
    throw new Error(`${label}: secret material detected; output suppressed`);
  }
  if (failure) throw new Error(`${label} failed (${failure}); output suppressed`);
  if (!acceptFailure && result.status !== 0 && !(schemaDump && result.status === 1)) {
    throw new Error(`${label} failed (exit ${result.status ?? "none"}, ${result.signal ?? "command error"}); output suppressed`);
  }
  return result;
}
const failures = [];
function check(label, condition) { if (!condition) failures.push(label); }
const installerPath = join(root, "scripts/runtime/profile-install.sh");
const home = process.env.DSH_HOME;
const scratch = join(home, "..");
const bundleManifest = JSON.parse(readFileSync(join(root, "profile/shud/package.json"), "utf8"));
const bundleRows = patchRows(readFileSync(join(root, "profile/shud/cordis.patch.yml"), "utf8"), "canonical bundle");
const captureConfig = {
  stackRepos: Object.fromEntries(["SHUD", "rSHUD", "AutoSHUD"].map((name) => [name, join(root, name)])),
  hostVersion: bundleManifest.peerDependencies["@deepseek-ai/dsh"],
  llm: {
    base_url: bundleRows.find((row) => row.id === "llm-deepseek").config.baseURL,
    request_alias: bundleRows.find((row) => row.id === "agent-default-model").config.model,
  },
};
function desiredJobs(name, binary, sundials = process.env.SUNDIALS_ROOT) {
  return {
    shudBin: binary, stateDir: join(home, "profiles", name, "shud-jobs"),
    ...captureConfig, ...(sundials === undefined ? {} : { sundialsRoot: sundials }),
  };
}
function captureRowErrors(rows) {
  const config = rows.find((row) => row.id === "shud-jobs")?.config;
  const llm = rows.find((row) => row.id === "llm-deepseek")?.config;
  const model = rows.find((row) => row.id === "agent-default-model")?.config;
  const errors = [];
  if (!config?.llm?.base_url || config.llm.base_url !== llm?.baseURL) errors.push("shud-jobs.llm.base_url does not match llm-deepseek.baseURL");
  if (!config?.llm?.request_alias || config.llm.request_alias !== model?.model) errors.push("shud-jobs.llm.request_alias does not match agent-default-model.model");
  return errors;
}
const shudBin = join(scratch, "shud executable");
const alternateBin = join(scratch, "shud # quote' colon: back\\slash");
for (const path of [shudBin, alternateBin]) {
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
}
process.env.SHUD_BIN = shudBin;
async function install(label, name, binary, template = "web", acceptFailure = false, environment = {}) {
  const env = { ...process.env, ...environment, PROFILE_NAME: name, PROFILE_TEMPLATE: template };
  if (env.SUNDIALS_ROOT === undefined) delete env.SUNDIALS_ROOT;
  if (binary === undefined) delete env.SHUD_BIN;
  else env.SHUD_BIN = binary;
  return await run(label, "sh", [installerPath], false, env, acceptFailure);
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
  const document = parseDocument(source, { prettyErrors: false, merge: false, schema: "core" });
  if (document.errors.length) {
    throw new Error(`${label}: invalid YAML (${document.errors[0].code}); source suppressed`);
  }
  const value = document.toJS();
  check(`${label}: patch is a sequence`, Array.isArray(value));
  return Array.isArray(value) ? value : [];
}
function checkJobsPatch(name, binary, label, sundials = process.env.SUNDIALS_ROOT) {
  const paths = profilePaths(name);
  check(`${label}: patch exists`, existsSync(paths.patch));
  if (!existsSync(paths.patch)) return;
  const rows = patchRows(readFileSync(paths.patch, "utf8"), label);
  const jobs = rows.filter((row) => row?.id === "shud-jobs");
  check(`${label}: unique semantic jobs item`, jobs.length === 1);
  check(`${label}: configured shudBin`, jobs[0]?.config?.shudBin === binary);
  check(`${label}: configured stateDir`, jobs[0]?.config?.stateDir === join(paths.directory, "shud-jobs"));
  check(`${label}: exact capture configuration`, isDeepStrictEqual(jobs[0]?.config, desiredJobs(name, binary, sundials)));
}
async function preservedInstall(name, binary, label) {
  const paths = profilePaths(name);
  const before = [hash(paths.manifest), hash(paths.patch)];
  const beforeStat = existsSync(paths.patch) ? lstatSync(paths.patch) : null;
  await install(label, name, binary);
  check(`${label}: package hash unchanged`, hash(paths.manifest) === before[0]);
  check(`${label}: patch hash unchanged`, hash(paths.patch) === before[1]);
  const afterStat = existsSync(paths.patch) ? lstatSync(paths.patch) : null;
  check(`${label}: unchanged patch was not rewritten`,
    beforeStat === null ? afterStat === null : beforeStat.ino === afterStat?.ino && beforeStat.mtimeMs === afterStat?.mtimeMs);
}
async function rejectedBinary(name, binary, label) {
  const paths = profilePaths(name);
  const existed = existsSync(paths.directory);
  const before = [hash(paths.manifest), hash(paths.patch)];
  const result = await install(label, name, binary, "web", true);
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
function checkToolsSchema(schema, label) {
  const tools = (schema["x-cordis"]?.entries ?? []).filter((entry) => entry.id === "shud-tools");
  check(`${label}: unique shud-tools schema entry`, tools.length === 1);
  check(`${label}: shud-tools import status ${tools[0]?.status ?? "missing"}`,
    tools.length === 1 && ["absent", "schema"].includes(tools[0].status));
}
async function checkCapturePreflight() {
  const isolated = join(scratch, "isolated-harness");
  for (const directory of ["scripts/runtime", "profile/shud", "node_modules", "SHUD", "rSHUD", "AutoSHUD"]) {
    mkdirSync(join(isolated, directory), { recursive: true });
  }
  for (const file of [
    "scripts/runtime/profile-install.sh", "scripts/runtime/profile-patch.ts", "scripts/runtime/dsh-root.sh",
    "profile/shud/package.json", "profile/shud/cordis.patch.yml", "package.json",
  ]) copyFileSync(join(root, file), join(isolated, file));
  symlinkSync(realpathSync(join(root, "node_modules/yaml")), join(isolated, "node_modules/yaml"));
  const isolatedHome = join(scratch, "isolated-home");
  const env = { ...process.env, DSH_HOME: isolatedHome, SHUD_BIN: shudBin,
    DSH_ROOT: join(scratch, "intentionally-no-host") };
  delete env.SUNDIALS_ROOT;
  const patcher = join(isolated, "scripts/runtime/profile-patch.ts");
  const installer = join(isolated, "scripts/runtime/profile-install.sh");
  const checkPath = join(isolatedHome, "profiles", "precheck", "cordis.patch.yml");
  const state = join(dirname(checkPath), "shud-jobs");
  await run("copied installer precheck accepts empty repository directories", process.execPath,
    [patcher, "--check", checkPath, shudBin, state], false, env);
  check("successful precheck does not create profile", !existsSync(dirname(checkPath)));
  const fileRoot = join(scratch, "sundials-file");
  writeFileSync(fileRoot, "not a directory\n");
  const invalidRoots = [
    ["empty", ""], ["relative", "relative/sundials"], ["missing", join(scratch, "missing-sundials")],
    ["file", fileRoot],
  ];
  async function reject(label, key, environment, existing) {
    const name = `${label}-${existing ? "existing" : "new"}`;
    const directory = join(isolatedHome, "profiles", name);
    const patch = join(directory, "cordis.patch.yml");
    const manifest = join(directory, "package.json");
    if (existing) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(patch, "# raw bytes\r\n- id: shud-raw-guard\r\n  config: {rawDirs: ['/srv/private/raw']}\r\n", { mode: 0o640 });
      writeFileSync(manifest, '{"private":true}\n');
    }
    const before = [hash(patch), hash(manifest)];
    const stat = existing ? lstatSync(patch) : undefined;
    const result = await run(label, "sh", [installer], false,
      { ...environment, PROFILE_NAME: name }, true);
    check(`${name}: rejected before installer effects`, result.status !== 0);
    check(`${name}: exact source diagnostic`, `${result.stdout}\n${result.stderr}`.includes(key));
    check(`${name}: profile creation unchanged`, existsSync(directory) === existing);
    check(`${name}: raw and manifest bytes preserved`, hash(patch) === before[0] && hash(manifest) === before[1]);
    if (stat) {
      const after = lstatSync(patch);
      check(`${name}: mode/inode/mtime preserved`,
        after.mode === stat.mode && after.ino === stat.ino && after.mtimeMs === stat.mtimeMs);
    }
  }
  for (const [kind, value] of invalidRoots) {
    for (const existing of [false, true]) {
      await reject(`invalid-sundials-${kind}`, "SUNDIALS_ROOT", { ...env, SUNDIALS_ROOT: value }, existing);
    }
  }
  for (const name of ["SHUD", "rSHUD", "AutoSHUD"]) {
    const directory = join(isolated, name);
    renameSync(directory, `${directory}.held`);
    try {
      for (const existing of [false, true]) await reject(`missing-repo-${name}`, name, env, existing);
    } finally {
      renameSync(`${directory}.held`, directory);
    }
  }
}

async function checkInvalidBoot(bin, profile) {
  const overlay = join(scratch, "missing-shud-bin.patch.yml");
  const installed = patchRows(readFileSync(profile.patch, "utf8"), "invalid boot installed config")
    .find((row) => row.id === "shud-jobs")?.config;
  check("invalid boot uses full installed capture config", isDeepStrictEqual(installed, desiredJobs("shud", shudBin)));
  writeFileSync(overlay, JSON.stringify([
    { id: "shud-jobs", config: { ...installed, shudBin: "" } },
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
async function checkRunnerCleanup(kind) {
  const prefix = join(scratch, `runner-${kind}`);
  const fixture = `${prefix}.sh`;
  writeFileSync(fixture, `#!/bin/sh
set -eu
sleep 60 &
child=$!
printf '%s\\n' "$$" > "$PROFILE_SMOKE_RUNNER_PREFIX.shell"
printf '%s\\n' "$child" > "$PROFILE_SMOKE_RUNNER_PREFIX.child"
ps -o lstart=,command= -p "$child" > "$PROFILE_SMOKE_RUNNER_PREFIX.identity"
trap 'wait "$child" || :; exit 0' TERM INT
if [ "$PROFILE_SMOKE_RUNNER_KIND" = overflow ]; then
  while :; do printf 'bounded runner overflow fixture\\n'; done
fi
wait "$child"
`);
  // Execute the actual runner in an isolated group: its synchronous baseline cannot supervise itself.
  const workerSource = `
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const run = ${run.toString()};
const [fixture, prefix, kind] = process.argv.slice(1);
const started = Date.now();
let failed = false, reason = "";
try {
  await run("runner " + kind, "/bin/sh", [fixture], false, {
    ...process.env, PROFILE_SMOKE_RUNNER_PREFIX: prefix, PROFILE_SMOKE_RUNNER_KIND: kind,
  }, false, { timeoutMs: 1000, maxBytes: 4096 });
} catch (error) {
  failed = true;
  reason = error instanceof Error ? error.message : "non-error rejection";
}
writeFileSync(prefix + ".result", JSON.stringify({ failed, reason, elapsed: Date.now() - started }));
`;
  const worker = spawn(process.execPath, ["--input-type=module", "-e", workerSource, fixture, prefix, kind],
    { detached: true, stdio: "ignore", env: process.env });
  const exited = new Promise((resolve) => {
    worker.once("exit", () => resolve(true));
    worker.once("error", () => resolve(false));
  });
  let shellPid;
  let timer;
  try {
    const completed = await Promise.race([
      exited,
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), 5000); }),
    ]);
    clearTimeout(timer);
    const pidFile = `${prefix}.child`;
    const ready = existsSync(pidFile) && existsSync(`${prefix}.identity`) && existsSync(`${prefix}.shell`);
    check(`runner ${kind}: descendant identity captured`, ready);
    if (ready) {
      shellPid = Number(readFileSync(`${prefix}.shell`, "utf8").trim());
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      const identity = readFileSync(`${prefix}.identity`, "utf8").trim();
      check(`runner ${kind}: valid descendant identity`, Number.isSafeInteger(pid) && pid > 1 && identity.length > 0);
      if (Number.isSafeInteger(pid) && pid > 1) {
        const current = spawnSync("ps", ["-o", "lstart=,command=", "-p", String(pid)], { encoding: "utf8" });
        const observed = current.stdout?.trim() ?? "";
        check(`runner ${kind}: descendant gone before fallback cleanup`, observed === "");
        check(`runner ${kind}: PID identity did not change`, observed === "" || observed === identity);
      }
    }
    const result = existsSync(`${prefix}.result`) ? JSON.parse(readFileSync(`${prefix}.result`, "utf8")) : null;
    check(`runner ${kind}: bounded failure`, completed && result?.failed === true && result.elapsed < 4500);
    check(`runner ${kind}: limit-specific diagnostic`,
      typeof result?.reason === "string" && /ETIMEDOUT|ENOBUFS|timeout|output limit/i.test(result.reason));
  } finally {
    clearTimeout(timer);
    if (shellPid === undefined && existsSync(`${prefix}.shell`)) {
      shellPid = Number(readFileSync(`${prefix}.shell`, "utf8").trim());
    }
    const groups = [worker.pid, shellPid].filter((pid) => Number.isSafeInteger(pid) && pid > 1);
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      for (const pid of new Set(groups)) {
        try { process.kill(-pid, signal); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      if (signal === "SIGTERM") await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
}
try {
  const notExecutable = join(scratch, "not-executable");
  writeFileSync(notExecutable, "not executable\n", { mode: 0o600 });
  const invalidBins = [
    ["missing", undefined], ["empty", ""], ["relative", "relative/shud"], ["nonexistent", join(scratch, "missing")],
    ["non-executable", notExecutable], ["directory", scratch],
  ];
  for (const [kind, binary] of invalidBins) {
    await rejectedBinary(`invalid-${kind}`, binary, `new profile ${kind} SHUD_BIN`);
  }
  await checkCapturePreflight();
  await run("profile installation", "sh", [join(root, "scripts/runtime/profile-install.sh")]);
  const web = profilePaths("shud");
  check("first Web install: exact bundle order", JSON.stringify(
    JSON.parse(readFileSync(web.manifest, "utf8")).dsh.profile.bundles,
  ) === JSON.stringify(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@shud-harness/dsh-profile-shud"]));
  checkJobsPatch("shud", shudBin, "first Web install");
  await preservedInstall("shud", shudBin, "second Web install");
  for (const [kind, binary] of invalidBins) {
    await rejectedBinary("shud", binary, `existing profile ${kind} SHUD_BIN`);
  }
  const bin = process.env.DSH_BIN;
  const dump = (await run("dump-config", process.execPath, [bin, "--profile", "shud", "--dump-config"])).stdout;
  const schemaResult = await run("dump-config-schema", process.execPath, [bin, "--profile", "shud", "--dump-config-schema"], true);
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
  check("shud-tools package specifier", /^  name: ['"]?@shud-harness\/dsh-shud-tools['"]?$/m.test(row("shud-tools")));
  const composedJobs = patchRows(dump, "composed profile").filter((entry) => entry?.id === "shud-jobs");
  check("composed shud-jobs binary", composedJobs[0]?.config?.shudBin === shudBin);
  check("composed shud-jobs state directory", composedJobs[0]?.config?.stateDir === join(web.directory, "shud-jobs"));
  const composedRows = patchRows(dump, "capture cross-row config");
  check("composed jobs full capture configuration", isDeepStrictEqual(composedJobs[0]?.config, desiredJobs("shud", shudBin)));
  const captureErrors = captureRowErrors(composedRows);
  check(`composed llm matches actual provider and model rows: ${captureErrors.join("; ")}`, captureErrors.length === 0);
  for (const [id, field, expected] of [
    ["agent-default-model", "model", "llm.request_alias"],
    ["llm-deepseek", "baseURL", "llm.base_url"],
  ]) {
    const drifted = structuredClone(composedRows);
    drifted.find((row) => row.id === id).config[field] = "deliberate-drift";
    check(`actual cross-row assertion catches ${field}`, captureRowErrors(drifted)
      .some((error) => error.includes(expected) && error.includes(`${id}.${field}`)));
  }
  checkJobsSchema(schema, "Web import");
  checkToolsSchema(schema, "Web import");

  const rawOnly = "# existing deployment bytes\r\n- id: 'shud-raw-guard'\r\n  config: { rawDirs: ['/srv/data_root/raw'] }\r\n# preserve missing final newline";
  writeFileSync(web.patch, rawOnly, { mode: 0o640 });
  chmodSync(web.patch, 0o640);
  await install("raw-only profile migration", "shud", shudBin);
  const migrated = readFileSync(web.patch, "utf8");
  check("raw-only migration: every previous byte retained", migrated.startsWith(rawOnly));
  check("raw-only migration: file mode retained", (lstatSync(web.patch).mode & 0o777) === 0o640);
  checkJobsPatch("shud", shudBin, "raw-only profile migration");
  await preservedInstall("shud", shudBin, "raw-only migration repeated");
  const rawDump = (await run("raw override dump", process.execPath, [bin, "--profile", "shud", "--dump-config"])).stdout;
  const rawRows = patchRows(rawDump, "raw override dump").filter((entry) => entry?.id === "shud-raw-guard");
  check("deployment raw override remains visible", JSON.stringify(rawRows[0]?.config?.rawDirs) === JSON.stringify(["/srv/data_root/raw"]));

  for (const docEnd of [false, true]) {
    const label = `indented root ${docEnd ? "with" : "without"} document end`;
    const original = "# indented deployment\n  - id: shud-raw-guard\n    config: {rawDirs: ['/srv/indented/raw']}\n";
    const trailer = docEnd ? "... # preserve document-end trailer\n" : "";
    writeFileSync(web.patch, original + trailer);
    try {
      const result = await install(label, "shud", shudBin, "web", true);
      check(`${label}: installer accepts valid patch`, result.status === 0);
      const updated = readFileSync(web.patch, "utf8");
      check(`${label}: original prefix unchanged`, updated.startsWith(original));
      if (docEnd) check(`${label}: document-end bytes unchanged`, updated.endsWith(trailer));
      checkJobsPatch("shud", shudBin, label);
      const composed = patchRows((await run(`${label} composition`, process.execPath,
        [bin, "--profile", "shud", "--dump-config"])).stdout, label);
      const raw = composed.find((row) => row.id === "shud-raw-guard");
      const jobs = composed.find((row) => row.id === "shud-jobs");
      check(`${label}: actual raw configuration`, JSON.stringify(raw?.config?.rawDirs) === JSON.stringify(["/srv/indented/raw"]));
      check(`${label}: actual jobs configuration`, jobs?.config?.shudBin === shudBin && jobs?.config?.stateDir === join(web.directory, "shud-jobs"));
      if (result.status === 0) await preservedInstall("shud", shudBin, `${label} repeated`);
    } catch {
      check(`${label}: installer/composition completed`, false);
    } finally {
      writeFileSync(web.patch, migrated);
    }
  }

  for (const directive of [false, true]) {
    const label = `literal merge key ${directive ? "with YAML 1.1" : "without directive"}`;
    const header = directive ? "%YAML 1.1\n---\n" : "";
    const literal = header + `- id: shud-raw-guard\n  config:\n    rawDirs: ['/srv/literal/raw']\n    anchor: &defaults {id: shud-jobs, config: {shudBin: ${JSON.stringify(shudBin)}, stateDir: ${JSON.stringify(join(web.directory, "shud-jobs"))}}}\n- <<: *defaults\n`;
    const trailer = "# preserve literal-key trailer\n";
    writeFileSync(web.patch, literal + "- id: shud-jobs\n  <<: *defaults\n" + trailer);
    try {
      const result = await install(label, "shud", shudBin, "web", true);
      check(`${label}: installer accepts literal key`, result.status === 0);
      const updated = readFileSync(web.patch, "utf8");
      check(`${label}: unrelated literal-key bytes unchanged`, updated.startsWith(literal));
      check(`${label}: trailing bytes unchanged`, updated.endsWith(trailer));
      checkJobsPatch("shud", shudBin, label);
      const composed = patchRows((await run(`${label} actual host composition`, process.execPath,
        [bin, "--profile", "shud", "--dump-config"])).stdout, label);
      const raw = composed.find((row) => row.id === "shud-raw-guard");
      const jobs = composed.filter((row) => row.id === "shud-jobs");
      check(`${label}: host keeps original raw configuration`, JSON.stringify(raw?.config?.rawDirs) === JSON.stringify(["/srv/literal/raw"]));
      check(`${label}: host sees exactly one configured jobs row`, jobs.length === 1 &&
        jobs[0].config?.shudBin === shudBin && jobs[0].config?.stateDir === join(web.directory, "shud-jobs"));
      if (result.status === 0) await preservedInstall("shud", shudBin, `${label} repeated`);
    } catch {
      check(`${label}: installer/composition completed`, false);
    } finally {
      writeFileSync(web.patch, migrated);
    }
  }
  await checkRunnerCleanup("timeout");
  await checkRunnerCleanup("overflow");

  const prefix = "# keep this prefix\r\n- id: shud-raw-guard\r\n  config: {rawDirs: ['/srv/data_root/raw']}\r\n";
  const suffix = "# keep this suffix\r\n- id: agent-default-model\r\n  config: {model: deepseek-flash-guan} # unchanged";
  const oldJob = `- config: {shudBin: ${JSON.stringify(shudBin)}, stateDir: ${JSON.stringify(join(web.directory, "shud-jobs"))}}\r\n  id: 'shud-jobs'\r\n`;
  writeFileSync(web.patch, prefix + oldJob + suffix);
  chmodSync(web.patch, 0o640);
  await install("M2 install gains capture configuration", "shud", shudBin);
  const upgraded = readFileSync(web.patch, "utf8");
  check("M2 upgrade: prefix byte-identical", upgraded.startsWith(prefix));
  check("M2 upgrade: suffix byte-identical", upgraded.endsWith(suffix));
  check("M2 upgrade: mode preserved", (lstatSync(web.patch).mode & 0o777) === 0o640);
  checkJobsPatch("shud", shudBin, "M2 capture upgrade");
  await preservedInstall("shud", shudBin, "M2 capture upgrade repeated");
  const sundials = join(scratch, "sundials fixture");
  mkdirSync(sundials);
  await install("SUNDIALS set", "shud", shudBin, "web", false, { SUNDIALS_ROOT: sundials });
  checkJobsPatch("shud", shudBin, "SUNDIALS set", sundials);
  const withSundials = readFileSync(web.patch, "utf8");
  check("SUNDIALS set: unrelated bytes", withSundials.startsWith(prefix) && withSundials.endsWith(suffix));
  const sundialsStat = lstatSync(web.patch);
  await install("SUNDIALS repeat", "shud", shudBin, "web", false, { SUNDIALS_ROOT: sundials });
  check("SUNDIALS repeat: bytes/inode/mtime", readFileSync(web.patch, "utf8") === withSundials &&
    lstatSync(web.patch).ino === sundialsStat.ino && lstatSync(web.patch).mtimeMs === sundialsStat.mtimeMs);
  await install("SUNDIALS unset", "shud", shudBin, "web", false, { SUNDIALS_ROOT: undefined });
  const unsetRows = patchRows(readFileSync(web.patch, "utf8"), "SUNDIALS unset");
  check("SUNDIALS unset removes key", !Object.hasOwn(unsetRows.find((row) => row.id === "shud-jobs").config, "sundialsRoot"));
  const expectedUnset = desiredJobs("shud", shudBin);
  delete expectedUnset.sundialsRoot;
  check("SUNDIALS unset preserves all other capture keys",
    isDeepStrictEqual(unsetRows.find((row) => row.id === "shud-jobs").config, expectedUnset));
  check("SUNDIALS unset preserves unrelated bytes", readFileSync(web.patch, "utf8").startsWith(prefix) && readFileSync(web.patch, "utf8").endsWith(suffix));
  check("SUNDIALS changes preserve mode", (lstatSync(web.patch).mode & 0o777) === 0o640);
  writeFileSync(web.patch, prefix + oldJob + suffix);
  await install("alternate binary preserves unrelated bytes", "shud", alternateBin);
  const updated = readFileSync(web.patch, "utf8");
  check("alternate binary: prefix byte-identical", updated.startsWith(prefix));
  check("alternate binary: suffix byte-identical", updated.endsWith(suffix));
  checkJobsPatch("shud", alternateBin, "alternate binary");
  await preservedInstall("shud", alternateBin, "alternate binary repeated");

  const nested = "- id: agent-default-model\n  config:\n    note: |-\n      - id: shud-jobs\n# literal nested lookalike remains\n";
  writeFileSync(web.patch, nested);
  await install("nested jobs lookalike is not a target", "shud", shudBin);
  check("nested lookalike bytes preserved", readFileSync(web.patch, "utf8").startsWith(nested));
  checkJobsPatch("shud", shudBin, "nested jobs lookalike");
  await preservedInstall("shud", shudBin, "nested lookalike repeated");

  const flowPrefix = "[{id: shud-raw-guard, config: {rawDirs: ['/srv/data_root/raw']}}, ";
  const flowSuffix = ", {id: agent-default-model, config: {model: deepseek-flash-guan}}]";
  writeFileSync(web.patch, flowPrefix + "{config: {shudBin: /old}, id: \"shud-jobs\"}" + flowSuffix);
  await install("flow sequence jobs update", "shud", alternateBin);
  const flowUpdated = readFileSync(web.patch, "utf8");
  check("flow update prefix unchanged", flowUpdated.startsWith(flowPrefix));
  check("flow update suffix unchanged", flowUpdated.endsWith(flowSuffix));
  checkJobsPatch("shud", alternateBin, "flow sequence update");
  await preservedInstall("shud", alternateBin, "flow sequence repeated");

  const flowInsertPrefix = "[{id: shud-raw-guard, config: {rawDirs: ['/srv/data_root/raw']}}";
  const flowInsertSuffix = "] # preserve flow trailer\r\n";
  writeFileSync(web.patch, flowInsertPrefix + flowInsertSuffix);
  await install("flow sequence jobs insertion", "shud", shudBin);
  const flowInserted = readFileSync(web.patch, "utf8");
  check("flow insertion prefix unchanged", flowInserted.startsWith(flowInsertPrefix));
  check("flow insertion trailer unchanged", flowInserted.endsWith(flowInsertSuffix));
  checkJobsPatch("shud", shudBin, "flow sequence insertion");
  await preservedInstall("shud", shudBin, "flow insertion repeated");

  const sharedDesired = `- &shared ${JSON.stringify({ id: "shud-jobs", config: desiredJobs("shud", shudBin) })}\n- id: other\n  config: *shared\n`;
  writeFileSync(web.patch, sharedDesired);
  await preservedInstall("shud", shudBin, "shared target already desired");
  checkJobsPatch("shud", shudBin, "shared target already desired");
  const sharedHash = hash(web.patch);
  const sharedStat = lstatSync(web.patch);
  const changedShared = await install("shared target changed binary", "shud", alternateBin, "web", true);
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
    const result = await install(label, "shud", shudBin, "web", true);
    check(`${label}: installer rejects ambiguous patch`, result.status !== 0);
    check(`${label}: patch bytes unchanged`, hash(web.patch) === before);
    check(`${label}: diagnostic omits source content`, !`${result.stdout}\n${result.stderr}`.includes("DO_NOT_ECHO_USER_PATCH"));
    const diagnostic = `${result.stdout}\n${result.stderr}`;
    const location = diagnostic.indexOf(`${web.patch}:`);
    check(`${label}: diagnostic identifies file and line`,
      location >= 0 && /^[1-9][0-9]*:/.test(diagnostic.slice(location + web.patch.length + 1)));
  }
  writeFileSync(web.patch, migrated);

  await install("headless profile installation", "shud-probe", shudBin, "headless");
  const headless = profilePaths("shud-probe");
  const headlessBundles = JSON.parse(readFileSync(headless.manifest, "utf8")).dsh.profile.bundles;
  check("headless profile excludes Web bundle", !headlessBundles.includes("@deepseek-ai/dsh-web-app"));
  check("headless profile ends with SHUD bundle", headlessBundles.at(-1) === "@shud-harness/dsh-profile-shud");
  checkJobsPatch("shud-probe", shudBin, "headless profile");
  const headlessSchema = JSON.parse((await run("headless schema", process.execPath,
    [bin, "--profile", "shud-probe", "--dump-config-schema"], true)).stdout);
  checkJobsSchema(headlessSchema, "headless import");
  checkToolsSchema(headlessSchema, "headless import");
  const headlessGuards = (headlessSchema["x-cordis"]?.entries ?? []).filter((entry) => entry.id === "shud-raw-guard");
  check("headless raw-guard imports", headlessGuards.length === 1 && ["absent", "schema"].includes(headlessGuards[0].status));
  await checkInvalidBoot(bin, web);
  if (failures.length) throw new Error(failures.join("; "));
} catch (error) {
  console.error(`profile:smoke: ${error.message}`);
  process.exitCode = 1;
}
NODE
printf 'profile:smoke: OK (dsh %s, model deepseek-flash-guan via DMXAPI, raw-guard mounted, shud-jobs mounted, shud-tools mounted, session-log-deepseek disabled)\n' "$DSH_VERSION_LABEL"
