import * as fs from "node:fs";
import { join, sep } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { groupCanPerformIo } from "../../packages/dsh-shud-jobs/src/process-identity.ts";
import { inBatchBaseline } from "./shud-sensitivity-criteria-numeric.ts";
import { loadSensitivityBatch } from "./shud-sensitivity-criteria-workspace.ts";
import { SensitivityRepeatRecordSchema } from "./shud-sensitivity-evaluate.ts";
import { runSensitivityRepeat } from "./shud-sensitivity-repeat.ts";
import { fileHashes, hash } from "./sensitivity/test-harness.ts";
import {
  makeEvaluateFixture,
  run,
  treeState,
  type EvaluateFixture,
} from "./sensitivity-evaluate/test-harness.ts";

/** Bytes the fake solver writes as rivqdown; the expected digest is taken from this literal. */
const RIVQDOWN = "fake rivqdown 0 1 2\n";

let f: EvaluateFixture;
let trace: string;
let solver: string;
let stateDir: string;
beforeEach(async () => {
  f = await makeEvaluateFixture();
  const scratch = join(f.home, "..");
  trace = join(scratch, "solver-trace");
  fs.mkdirSync(trace);
  solver = join(scratch, "fake-shud");
  fs.mkdirSync(join(f.home, "sensitivity"));
  stateDir = join(f.home, "profiles/shud/shud-jobs");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(join(stateDir, "active.json"), '{"jobs":[]}\n');
  fs.writeFileSync(join(stateDir, "completed.json"), '{"jobs":["shud-0000000000000001"]}\n');
});
afterEach(() => {
  f.h.dispose();
});

/** A regular executable fake SHUD recording argv, cwd and both thread variables into `trace`. */
function installSolver(body: string): void {
  fs.writeFileSync(
    solver,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$$" > '${trace}/pgid'`,
      `printf '%s\\n' "$0" "$@" > '${trace}/argv'`,
      `pwd -P > '${trace}/cwd'`,
      `printf '%s\\n' "$OMP_NUM_THREADS" "$SHUD_RHS_THREADS" > '${trace}/threads'`,
      body,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}
const WRITES_OUTPUT = [
  "mkdir -p output/ccw.out",
  `printf '${RIVQDOWN.replace("\n", "\\n")}' > output/ccw.out/ccw.rivqdown.dat`,
  "echo solver-stdout",
  "echo solver-stderr >&2",
].join("\n");

function baseline() {
  const found = inBatchBaseline(f.workspace, loadSensitivityBatch(f.workspace));
  if (typeof found === "string") throw new Error(found);
  return { run_id: found.job.run_id, dir: found.dir };
}
function batchState() {
  return {
    workspace: treeState(f.workspace),
    sessions: treeState(join(f.home, "sessions")),
    state: treeState(stateDir),
  };
}

test("the out-of-batch repeat runs a byte-identical baseline copy outside the workspace with one thread", async () => {
  installSolver(`${WRITES_OUTPUT}\nsleep 30 &\nsleep 0.5\nexit 0`);
  const before = batchState();
  const baselineInput = fileHashes(join(f.workspace, "runs", run(1), "input/ccw"), "sha256");
  const record = await runSensitivityRepeat({
    home: f.home,
    shudBin: solver,
    baseline: baseline(),
    threads: 1,
  });

  const repeatDir = join(fs.realpathSync(f.home), "sensitivity/repeat");
  const lines = (name: string) => fs.readFileSync(join(trace, name), "utf8").trimEnd().split("\n");
  expect(lines("argv")).toEqual([solver, "-o", "output/ccw.out", "ccw"]);
  expect(lines("cwd")).toEqual([repeatDir]);
  expect(repeatDir.startsWith(f.workspace + sep)).toBe(false);
  expect(lines("threads")).toEqual(["1", "1"]);
  expect(fs.readFileSync(join(repeatDir, "stdout.log"), "utf8")).toBe("solver-stdout\n");
  expect(fs.readFileSync(join(repeatDir, "stderr.log"), "utf8")).toBe("solver-stderr\n");
  expect(fileHashes(join(repeatDir, "input/ccw"), "sha256")).toEqual(baselineInput);

  expect(SensitivityRepeatRecordSchema.parse(record)).toEqual({
    status: "executed",
    exit_code: 0,
    input_sha256: baselineInput,
    omp_num_threads: "1",
    shud_rhs_threads: "1",
    rivqdown_sha256: hash("sha256", Buffer.from(RIVQDOWN)),
    run_id: `repeat-${run(1)}`,
    baseline_run_id: run(1),
  });
  const written: unknown = JSON.parse(
    fs.readFileSync(join(f.home, "sensitivity/repeat.json"), "utf8"),
  );
  expect(written).toEqual(record);
  // No RunJob, RunRecord, registry entry, session event, card link or report link.
  expect(batchState()).toEqual(before);
  expect(groupCanPerformIo(Number(lines("pgid")[0]))).toBe(false);
});

test("a non-zero solver exit is recorded verbatim with no rivqdown digest", async () => {
  installSolver("exit 3");
  const record = await runSensitivityRepeat({
    home: f.home,
    shudBin: solver,
    baseline: baseline(),
    threads: 1,
  });
  expect(record).toMatchObject({ status: "executed", exit_code: 3, rivqdown_sha256: null });
  expect(groupCanPerformIo(Number(fs.readFileSync(join(trace, "pgid"), "utf8")))).toBe(false);
});

test("a repeat beyond its bound stops the solver group and records a null exit code", async () => {
  installSolver("sleep 30");
  const started = Date.now();
  const record = await runSensitivityRepeat({
    home: f.home,
    shudBin: solver,
    baseline: baseline(),
    threads: 1,
    timeoutMs: 1000,
  });
  expect(Date.now() - started).toBeLessThan(4000);
  expect(record).toMatchObject({ status: "executed", exit_code: null, rivqdown_sha256: null });
  expect(groupCanPerformIo(Number(fs.readFileSync(join(trace, "pgid"), "utf8")))).toBe(false);
});

test("without a unique succeeded in-batch baseline the repeat is not executed and no solver starts", async () => {
  f.writeJson(`runs/${run(1)}/run-job.json`, { ...f.jobs[0], status: "failed" });
  installSolver(WRITES_OUTPUT);
  const found = inBatchBaseline(f.workspace, loadSensitivityBatch(f.workspace));
  expect(found).toBe("0 collected succeeded in-batch baseline runs");
  const record = await runSensitivityRepeat({
    home: f.home,
    shudBin: solver,
    baseline: found as string,
    threads: 1,
  });
  expect(record).toEqual({
    status: "not_executed",
    reason: "0 collected succeeded in-batch baseline runs",
  });
  expect(JSON.parse(fs.readFileSync(join(f.home, "sensitivity/repeat.json"), "utf8"))).toEqual(
    record,
  );
  expect(fs.existsSync(join(trace, "argv"))).toBe(false);
  expect(fs.existsSync(join(f.home, "sensitivity/repeat"))).toBe(false);
});
