import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";
import ts from "typescript";
import { afterEach, beforeEach, expect, test } from "vitest";
import { snapshotTree } from "../../packages/dsh-shud-records/src/report-code-change-test-harness.ts";
import { FIXED_PLAN } from "./shud-sensitivity-plan.ts";
import {
  runSensitivity,
  runSensitivityCli,
  sensitivityPrompt,
  type SensitivityRun,
  type SensitivityStages,
} from "./shud-sensitivity.ts";
import { sensitivitySummary } from "./shud-sensitivity-summary.ts";
import { makeEvaluateFixture, run } from "./sensitivity-evaluate/test-harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "shud-sensitivity.sh");
const ROOT_ID = "session-sensitivity-671";

let scratch: string;
let solver: string;
let marker: string;
beforeEach(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "shud-sensitivity-driver-")));
  solver = join(scratch, "shud");
  marker = join(scratch, "solver-started");
  fs.writeFileSync(solver, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
});
afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** In-process run capturing both streams; every home it creates is removed afterwards. */
async function captured(start: () => Promise<number>) {
  const chunks: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const sink = (chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  };
  process.stdout.write = sink;
  process.stderr.write = sink;
  let code: number;
  try {
    code = await start();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  return { code, output: chunks.join("") };
}

/** A canonical-shape coordinator log holding only its header, so stopped-host discovery reads it. */
function writeRootLog(home: string): string {
  const path = join(home, "sessions/project", ROOT_ID, "session.v4.jsonl.zstd");
  fs.mkdirSync(dirname(path), { recursive: true });
  const header = { type: "session", version: 4, id: ROOT_ID, agentPreset: "coordinator" };
  fs.writeFileSync(path, zstdCompressSync(`${JSON.stringify(header)}\n`));
  return path;
}

/**
 * Injected stages recording their order; `stop` and `repeat` stay the production stages unless
 * overridden. The drive stage opens a constructed session with a fake host and approval stream.
 */
function stages(order: string[], overrides: Partial<SensitivityStages> = {}) {
  const homes: string[] = [];
  const workspace = join(scratch, "workspace");
  const base: Partial<SensitivityStages> = {
    prepare(run: SensitivityRun) {
      order.push("prepare");
      homes.push(run.home);
      fs.mkdirSync(workspace, { recursive: true });
      run.workspace = workspace;
      return Promise.resolve();
    },
    install() {
      order.push("install");
      return Promise.resolve();
    },
    drive(run: SensitivityRun) {
      order.push("drive");
      writeRootLog(run.home);
      run.rootId = ROOT_ID;
      run.approvals = {
        close() {
          order.push("approvals.close");
          return Promise.resolve();
        },
      };
      const host = {
        exited: false,
        stop() {
          order.push("host.stop");
          host.exited = true;
          return Promise.resolve();
        },
      };
      run.host = host;
      return Promise.resolve();
    },
    evaluate(run: SensitivityRun) {
      order.push(fs.existsSync(run.repeatRecord) ? "evaluate" : "evaluate-without-repeat-record");
      return Promise.resolve(1);
    },
    summary() {
      order.push("summary");
      return Promise.resolve();
    },
  };
  return { stages: { ...base, ...overrides }, homes, workspace };
}
const config = () => ({ workspace: join(scratch, "workspace"), shudBin: solver, dshBin: solver });
function repeatRecord(home: string): unknown {
  return JSON.parse(fs.readFileSync(join(home, "sensitivity/repeat.json"), "utf8"));
}

test("stages run prepare, install, drive, stop (approvals closed, host exited), repeat, evaluate, summary", async () => {
  const order: string[] = [];
  const s = stages(order, {
    repeat(run: SensitivityRun, reason: string | undefined) {
      order.push(`repeat ${reason ?? "after a clean stop"}`);
      fs.writeFileSync(run.repeatRecord, "{}\n");
      return Promise.resolve();
    },
    evaluate() {
      order.push("evaluate");
      return Promise.resolve(0);
    },
  });
  const { code, output } = await captured(() => runSensitivity(config(), s.stages));
  expect(code).toBe(0);
  expect(order).toEqual([
    "prepare",
    "install",
    "drive",
    "approvals.close",
    "host.stop",
    "repeat after a clean stop",
    "evaluate",
    "summary",
  ]);
  const [home] = s.homes;
  expect(fs.statSync(home).mode & 0o777).toBe(0o700);
  expect(fs.statSync(join(home, "sensitivity")).isDirectory()).toBe(true);
  expect(output).toMatch(/Allow once[^\n]*engineering evidence/u);
  expect(output).not.toMatch(
    /accepted by PI|PI (?:has )?accepted|PI acceptance (?:passed|granted)/iu,
  );
  fs.rmSync(home, { recursive: true, force: true });
});

test.each([1, 2])(
  "evaluator exit %i is the script exit and prints every retained path",
  async (exit) => {
    const order: string[] = [];
    const s = stages(order, {
      evaluate() {
        order.push("evaluate");
        return Promise.resolve(exit);
      },
    });
    const { code, output } = await captured(() => runSensitivity(config(), s.stages));
    expect(code).toBe(exit);
    expect(order).not.toContain("summary");
    const [home] = s.homes;
    for (const path of [
      s.workspace,
      home,
      join(home, "sessions/project", ROOT_ID, "session.v4.jsonl.zstd"),
      join(home, "sensitivity/preparation.json"),
      join(home, "sensitivity/repeat.json"),
    ])
      expect(output).toContain(path);
    fs.rmSync(home, { recursive: true, force: true });
  },
);

test.each(["prepare", "install"] as const)(
  "a %s failure exits 1 without a host, repeat or evaluator",
  async (failing) => {
    const order: string[] = [];
    const s = stages(order, {
      [failing]: (run: SensitivityRun) => {
        order.push(failing);
        if (failing === "prepare") s.homes.push(run.home);
        return Promise.reject(new Error(`${failing} refused`));
      },
    });
    const { code, output } = await captured(() => runSensitivity(config(), s.stages));
    expect(code).toBe(1);
    expect(order).toEqual(failing === "prepare" ? ["prepare"] : ["prepare", "install"]);
    expect(output).toContain(`${failing} refused`);
    expect(output).toContain(s.homes[0]);
    fs.rmSync(s.homes[0], { recursive: true, force: true });
  },
);

test("no created session exits 1 after stop without repeat or evaluator", async () => {
  const order: string[] = [];
  const s = stages(order, {
    drive() {
      order.push("drive");
      return Promise.reject(new Error("session/create refused"));
    },
  });
  const { code, output } = await captured(() => runSensitivity(config(), s.stages));
  expect(code).toBe(1);
  expect(order).toEqual(["prepare", "install", "drive"]);
  expect(fs.existsSync(join(s.homes[0], "sensitivity/repeat.json"))).toBe(false);
  expect(output).toContain("session/create refused");
  fs.rmSync(s.homes[0], { recursive: true, force: true });
});

test("a drive failure still stops, writes a repeat record and evaluates", async () => {
  const order: string[] = [];
  const s = stages(order);
  const drive = s.stages.drive!;
  s.stages.drive = async (run: SensitivityRun) => {
    await drive(run);
    throw new Error("Sensitivity batch deadline");
  };
  const { code, output } = await captured(() => runSensitivity(config(), s.stages));
  expect(code).toBe(1);
  expect(order).toEqual([
    "prepare",
    "install",
    "drive",
    "approvals.close",
    "host.stop",
    "evaluate",
  ]);
  expect(output).toContain("Sensitivity batch deadline");
  // The empty workspace has no sensitivity card: the baseline lookup throw becomes the reason.
  expect(repeatRecord(s.homes[0])).toEqual({
    status: "not_executed",
    reason: expect.stringMatching(/sensitivity TaskCards/u) as unknown,
  });
  expect(fs.existsSync(marker)).toBe(false);
  fs.rmSync(s.homes[0], { recursive: true, force: true });
});

test("a stop or cleanup error yields a not_executed repeat naming it and starts no solver", async () => {
  const order: string[] = [];
  const s = stages(order);
  const drive = s.stages.drive!;
  s.stages.drive = async (run: SensitivityRun) => {
    await drive(run);
    run.host = {
      exited: false,
      stop() {
        order.push("host.stop");
        return Promise.reject(new Error("still alive"));
      },
    };
  };
  const { code, output } = await captured(() => runSensitivity(config(), s.stages));
  expect(code).toBe(1);
  expect(order).toEqual([
    "prepare",
    "install",
    "drive",
    "approvals.close",
    "host.stop",
    "evaluate",
  ]);
  const record = repeatRecord(s.homes[0]) as { status: string; reason: string };
  expect(record.status).toBe("not_executed");
  expect(record.reason).toMatch(/^Web host shutdown unproved: still alive; /u);
  for (const error of record.reason.split("; "))
    expect(output).toContain(`stop/cleanup error: ${error}`);
  expect(fs.existsSync(marker)).toBe(false);
  fs.rmSync(s.homes[0], { recursive: true, force: true });
});

test("SIGTERM during the wait aborts the drive and still runs stop", async () => {
  const order: string[] = [];
  const s = stages(order);
  const drive = s.stages.drive!;
  s.stages.drive = async (run: SensitivityRun) => {
    await drive(run);
    const aborted = new Promise((resolve) => run.abort.addEventListener("abort", resolve));
    process.kill(process.pid, "SIGTERM");
    await aborted;
    run.abort.throwIfAborted();
  };
  const saved = { SHUD_BIN: process.env.SHUD_BIN, DSH_BIN: process.env.DSH_BIN };
  process.env.SHUD_BIN = solver;
  process.env.DSH_BIN = solver;
  try {
    const { code, output } = await captured(() =>
      runSensitivityCli([join(scratch, "workspace")], s.stages),
    );
    expect(code).toBe(1);
    expect(order).toEqual([
      "prepare",
      "install",
      "drive",
      "approvals.close",
      "host.stop",
      "evaluate",
    ]);
    expect(output).toMatch(/interrupted/u);
  } finally {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    fs.rmSync(s.homes[0], { recursive: true, force: true });
  }
});

test("the prompt names the native ccw realpath and only the fixed plan", () => {
  const workspace = join(scratch, "Workspace 7");
  fs.mkdirSync(join(workspace, "input/ccw"), { recursive: true });
  const input = fs.realpathSync.native(join(workspace, "input/ccw"));
  const prompt = sensitivityPrompt(workspace);
  expect(prompt).toContain(JSON.stringify(input));
  const rest = prompt.replace(JSON.stringify(input), "");
  expect(rest).toContain("end_days: 90");
  expect(rest).toContain("threads: 1");
  const sets = ["baseline (no change)", "GEOL_KSATH×0.5", "GEOL_KSATH×2", "LC_ROUGH×2"];
  const positions = sets.map((set) => rest.indexOf(set));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  expect(new Set(rest.match(/\d+(?:\.\d+)?/gu))).toEqual(new Set(["90", "1", "0.5", "2"]));
  const calib = fs.readFileSync(resolve(HERE, "../../SHUD/input/ccw/ccw.cfg.calib"), "utf8");
  for (const line of calib.split(/\r?\n/u).filter((entry) => entry.trim())) {
    const [key, value] = line.trim().split(/\s+/u);
    const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    expect(rest).not.toMatch(new RegExp(`${escape(key)}\\s*[:=\\s]\\s*${escape(value)}`, "u"));
  }
  expect(FIXED_PLAN.parameter_sets.slice(1)).toEqual(sets.slice(1));
});

/** Static (load-time) import edges; a whole-clause `import type` is erased and not an edge. */
function staticImports(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
  const specifiers: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly)
      specifiers.push((statement.moduleSpecifier as ts.StringLiteral).text);
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && !statement.isTypeOnly)
      specifiers.push((statement.moduleSpecifier as ts.StringLiteral).text);
  }
  return specifiers;
}

test("the driver's static import graph never reaches packages/*/lib build output", () => {
  const entries = [
    "shud-sensitivity.ts",
    "shud-sensitivity-plan.ts",
    "shud-sensitivity-prepare.ts",
    "shud-sensitivity-repeat.ts",
  ].map((name) => join(HERE, name));
  const seen = new Set<string>();
  const offending: string[] = [];
  const pending = [...entries];
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of staticImports(file)) {
      if (specifier.startsWith("@shud-harness/")) offending.push(`${file} -> ${specifier}`);
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(file), specifier);
      if (/\/packages\/[^/]+\/lib\//u.test(target)) offending.push(`${file} -> ${specifier}`);
      else pending.push(target);
    }
  }
  expect(seen.size).toBeGreaterThan(entries.length);
  expect(offending).toEqual([]);
  for (const lazy of [
    "shud-sensitivity-evaluate.ts",
    "shud-sensitivity-criteria-numeric.ts",
    "shud-sensitivity-summary.ts",
    "shud-first-task-approval.ts",
  ])
    expect(seen.has(join(HERE, lazy))).toBe(false);
});

test("the summary lists the batch identities, the repeat digest and the accepted report", async () => {
  const f = await makeEvaluateFixture();
  try {
    const summary = sensitivitySummary(f.workspace, f.repeatPath);
    const expected = [
      `task_id ${f.card.task_id}`,
      `analysis_plan_id ${f.plan.analysis_plan_id}`,
      ...f.plan.parameter_sets.map((set, index) => `${set.parameter_set_id} -> ${run(index + 1)}`),
      `stack_id ${f.records[0].stack_id}`,
      `repeat rivqdown sha256 ${String(f.repeat.rivqdown_sha256)}`,
      `report_id ${f.report.report_id}: accepted`,
    ];
    for (const line of expected) expect(summary).toContain(`shud:sensitivity: ${line}\n`);
    expect(summary).not.toMatch(
      /accepted by PI|PI (?:has )?accepted|PI acceptance (?:passed|granted)/iu,
    );
  } finally {
    f.h.dispose();
  }
});

const PREFLIGHT_CASES = [
  ["missing workspace argument", "workspace", "argument"],
  ["blank workspace argument", "workspace", "blank-argument"],
  ["missing DMXAPI_KEY", "DMXAPI_KEY", "missing"],
  ["blank DMXAPI_KEY", "DMXAPI_KEY", "blank"],
  ["missing SHUD_BIN", "SHUD_BIN", "missing"],
  ["relative SHUD_BIN", "SHUD_BIN", "relative"],
  ["nonexistent SHUD_BIN", "SHUD_BIN", "nonexistent"],
  ["nonexecutable SHUD_BIN", "SHUD_BIN", "nonexecutable"],
  ["directory SHUD_BIN", "SHUD_BIN", "directory"],
  ["symlink SHUD_BIN", "SHUD_BIN", "symlink"],
  ["missing SHUD/input/ccw", "SHUD/input/ccw", "source"],
] as const;

test.each(PREFLIGHT_CASES)(
  "%s exits non-zero before any build, install or session",
  (_label, prerequisite, invalid) => {
    const cwd = join(scratch, "cwd");
    const home = join(scratch, "dsh-home");
    const temporary = join(scratch, "tmp");
    for (const directory of [cwd, home, temporary]) fs.mkdirSync(directory);
    const workspace = join(scratch, "workspace");
    const ordinary = join(scratch, "ordinary");
    fs.writeFileSync(ordinary, "not a solver\n", { mode: 0o644 });
    fs.symlinkSync(solver, join(scratch, "shud-link"));
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: scratch,
      TMPDIR: temporary,
      DSH_HOME: home,
      DMXAPI_KEY: "constructed-preflight-only",
      SHUD_BIN: solver,
    };
    let args: string[] = [workspace];
    if (invalid === "argument") args = [];
    else if (invalid === "blank-argument") args = [" \t "];
    else if (invalid === "missing") delete env[prerequisite];
    else if (invalid === "blank") env[prerequisite] = " \t ";
    else if (invalid === "relative") env[prerequisite] = "shud";
    else if (invalid === "nonexistent") env[prerequisite] = join(scratch, "absent");
    else if (invalid === "nonexecutable") env[prerequisite] = ordinary;
    else if (invalid === "directory") env[prerequisite] = cwd;
    else if (invalid === "symlink") env[prerequisite] = join(scratch, "shud-link");
    let entry = SCRIPT;
    if (invalid === "source") {
      entry = join(scratch, "isolated/scripts/runtime/shud-sensitivity.sh");
      fs.mkdirSync(dirname(entry), { recursive: true });
      fs.copyFileSync(SCRIPT, entry);
    }
    const before = snapshotTree(scratch);
    const result = spawnSync("sh", [entry, ...args], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toMatch(new RegExp(prerequisite.replaceAll("/", "\\/"), "iu"));
    expect(output).not.toContain("constructed-preflight-only");
    expect(snapshotTree(scratch)).toEqual(before);
  },
);

test("package.json registers the entry between shud:restart and shud:tiny", () => {
  const manifest = JSON.parse(fs.readFileSync(resolve(HERE, "../../package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const names = Object.keys(manifest.scripts);
  expect(manifest.scripts["shud:sensitivity"]).toBe("sh scripts/runtime/shud-sensitivity.sh");
  expect(names.indexOf("shud:sensitivity")).toBe(names.indexOf("shud:restart") + 1);
  expect(names.indexOf("shud:tiny")).toBe(names.indexOf("shud:sensitivity") + 1);
});
