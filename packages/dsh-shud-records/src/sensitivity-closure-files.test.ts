import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createSensitivityClosureLoaders, serializeRunMetrics } from "./index.ts";
import { digest, snapshotTree } from "./run-metrics-test-harness.ts";
import {
  evaluateSensitivity,
  sensitivityEvidence,
  type SensitivityEvidence,
} from "./sensitivity-closure-test-harness.ts";

let root: string;
let cwd: string;
let input: SensitivityEvidence;
let planPath: string;
let metricsPath: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sensitivity-closure-")));
  cwd = join(root, "workspace");
  input = sensitivityEvidence();
  mkdirSync(join(cwd, "analyses"), { recursive: true });
  planPath = join(cwd, "analyses", `${input.plan.analysis_plan_id}.json`);
  writeFileSync(planPath, JSON.stringify(input.plan) + "\n");
  for (const record of input.records) {
    const directory = join(cwd, "runs", record.run_id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "metrics.json"), serializeRunMetrics(input.metrics));
  }
  metricsPath = join(cwd, "runs", input.records[0].run_id, "metrics.json");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function unchanged() {
  const before = snapshotTree(root);
  const result = evaluateSensitivity(input, createSensitivityClosureLoaders(cwd));
  expect(snapshotTree(root)).toEqual(before);
  return result;
}

test.each(["physical", "alias", "physical-parent"] as const)(
  "readonly readers use %s cwd and leave bytes, mtimes and inventory unchanged",
  (kind) => {
    if (kind !== "physical") {
      const alias = join(root, "alias");
      mkdirSync(join(cwd, "child"));
      symlinkSync(kind === "alias" ? cwd : join(cwd, "child"), alias);
      cwd = kind === "alias" ? alias : `${alias}/..`;
    }
    const result = unchanged();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected filesystem closure");
    expect(result.selected.map((entry) => entry.run_id)).toEqual([
      "RUN-20261108T093000-0001",
      "RUN-20261108T093000-0002",
      "RUN-20261108T093000-0003",
      "RUN-20261108T093000-0004",
    ]);
    expect(result.selected[0].metrics).toEqual(input.metrics);
  },
);

test.each(["missing", "malformed", "schema", "identity", "task", "symlink", "directory"] as const)(
  "plan %s fails clause zero without repairs",
  (kind) => {
    if (kind === "malformed") writeFileSync(planPath, "{ private-sensitivity-plan");
    if (kind === "schema") writeFileSync(planPath, JSON.stringify({ ...input.plan, mode: "bad" }));
    if (kind === "identity")
      writeFileSync(
        planPath,
        JSON.stringify({
          ...input.plan,
          analysis_plan_id: "PLAN-20261108T093000-ffff",
        }),
      );
    if (kind === "task")
      writeFileSync(
        planPath,
        JSON.stringify({
          ...input.plan,
          task_id: "TASK-20261108T093000-ffff",
        }),
      );
    if (kind === "missing" || kind === "symlink" || kind === "directory") {
      rmSync(planPath);
      if (kind === "directory") mkdirSync(planPath);
      if (kind === "symlink") {
        const outside = join(root, "outside-plan.json");
        writeFileSync(outside, JSON.stringify(input.plan));
        symlinkSync(outside, planPath);
      }
    }
    const result = unchanged();
    expect(result).toMatchObject({
      ok: false,
      failures: [{ clause: 0, analysis_plan_id: input.plan.analysis_plan_id }],
    });
    expect(JSON.stringify(result)).not.toContain("private-sensitivity");
  },
);

test.each(["missing", "symlink", "file"] as const)(
  "unsafe or absent analyses root %s is never created or followed",
  (kind) => {
    const path = join(cwd, "analyses");
    const outside = join(root, "outside-analyses");
    renameSync(path, outside);
    if (kind === "symlink") symlinkSync(outside, path);
    if (kind === "file") writeFileSync(path, "not a directory");
    expect(unchanged()).toMatchObject({ ok: false, failures: [{ clause: 0 }] });
  },
);

test.each(["runs", "run"] as const)("%s path rejects missing, file and symlink roots", (kind) => {
  // Separate fixtures keep every unsafe-root check independent of prior evaluation/freeze.
  const path = kind === "runs" ? join(cwd, "runs") : join(cwd, "runs", input.records[0].run_id);
  const outside = join(root, "outside-runs");
  renameSync(path, outside);
  const beforeMissing = snapshotTree(root);
  expect(evaluateSensitivity(input, createSensitivityClosureLoaders(cwd))).toMatchObject({
    ok: false,
    failures: [{ clause: 5 }],
  });
  expect(snapshotTree(root)).toEqual(beforeMissing);
  writeFileSync(path, "not a directory");
  expect(unchanged()).toMatchObject({ ok: false, failures: [{ clause: 5 }] });
  rmSync(path);
  symlinkSync(outside, path);
  expect(unchanged()).toMatchObject({ ok: false, failures: [{ clause: 5 }] });
});

test.each([
  "missing",
  "tampered",
  "malformed",
  "schema",
  "unavailable",
  "symlink",
  "directory",
] as const)("metrics %s fails clause five with the selected job identity", (kind) => {
  if (kind === "tampered") {
    writeFileSync(
      metricsPath,
      serializeRunMetrics(input.metrics).replace('"peak_flow_m3d":30', '"peak_flow_m3d":31'),
    );
  }
  if (kind === "malformed" || kind === "schema" || kind === "unavailable") {
    let bytes = "{private-sensitivity-metrics";
    if (kind === "schema") bytes = JSON.stringify({ ...input.metrics, outlets: "invalid" });
    if (kind === "unavailable") {
      const unavailable = structuredClone(input.metrics);
      unavailable.status = "unavailable";
      unavailable.reason = "missing_inputs";
      for (const block of [
        unavailable.flow,
        unavailable.water_balance,
        unavailable.numerical_health,
      ]) {
        for (const key of Object.keys(block.reasons)) {
          Object.assign(block, { [key]: null });
          Object.assign(block.reasons, {
            [key]: key === "max_solver_dt" ? "not_observable_in_pinned_shud" : "missing_inputs",
          });
        }
      }
      unavailable.verdicts = {
        water_balance_residual: "not_available",
        cvode_failures: "not_available",
        negative_state_count: "not_available",
      };
      bytes = serializeRunMetrics(unavailable);
    }
    writeFileSync(metricsPath, bytes);
    input.records[0].artifacts.metrics_summary!.sha256 = digest(bytes);
  }
  if (kind === "missing" || kind === "symlink" || kind === "directory") {
    rmSync(metricsPath);
    if (kind === "directory") mkdirSync(metricsPath);
    if (kind === "symlink") {
      const outside = join(root, "outside-metrics.json");
      writeFileSync(outside, serializeRunMetrics(input.metrics));
      symlinkSync(outside, metricsPath);
    }
  }
  const result = unchanged();
  expect(result).toMatchObject({
    ok: false,
    failures: [{ clause: 5, job_id: "JOB-20261108T093000-0001" }],
  });
  expect(JSON.stringify(result)).not.toContain("private-sensitivity");
});

test("an unlinked plan is neither loaded nor discovered", () => {
  input.card.linked_analyses = [];
  const readers = createSensitivityClosureLoaders(cwd);
  let reads = 0;
  const before = snapshotTree(root);
  const result = evaluateSensitivity(input, {
    ...readers,
    readAnalysisPlan(id) {
      reads += 1;
      return readers.readAnalysisPlan(id);
    },
  });
  expect(result).toMatchObject({ ok: false, failures: [{ clause: 0 }] });
  expect(reads).toBe(0);
  expect(snapshotTree(root)).toEqual(before);
});

test("absent workspaces and invalid branded ids never create directories", () => {
  cwd = join(root, "missing-workspace");
  const readers = createSensitivityClosureLoaders(cwd);
  const before = snapshotTree(root);
  expect(unchanged()).toMatchObject({ ok: false, failures: [{ clause: 0 }] });
  expect(() => readers.readAnalysisPlan("../private-sensitivity-plan" as never)).toThrow();
  expect(() =>
    readers.readRunMetrics("../private-sensitivity-run" as never, "a".repeat(64)),
  ).toThrow();
  expect(snapshotTree(root)).toEqual(before);
});

test.each(["plan", "metrics"] as const)(
  "writerless %s FIFO rejects within a killed-and-reaped bound",
  (kind) => {
    const child = () =>
      spawnSync(
        process.execPath,
        [
          "--experimental-transform-types",
          "--input-type=module",
          "-e",
          `// Eval has no module-relative base; its module URL is supplied by the parent at runtime.
     const {evaluateClosure, createSensitivityClosureLoaders} = await import(process.argv[1]);
     const input = JSON.parse(process.argv[3]);
     console.log(JSON.stringify(evaluateClosure(input.card, input.runJobs, input.records,
       input.draft, createSensitivityClosureLoaders(process.argv[2]))));`,
          new URL("./index.ts", import.meta.url).href,
          cwd,
          JSON.stringify(input),
        ],
        { encoding: "utf8", timeout: 3000, killSignal: "SIGKILL" },
      );
    const control = child();
    expect(control.error, control.stderr).toBeUndefined();
    expect(control.status, control.stderr).toBe(0);
    expect(JSON.parse(control.stdout)).toMatchObject({ ok: true });
    const path = kind === "plan" ? planPath : metricsPath;
    rmSync(path);
    execFileSync("mkfifo", [path]);
    const before = snapshotTree(root);
    const result = child();
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.signal).toBeNull();
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      failures: [{ clause: kind === "plan" ? 0 : 5 }],
    });
    expect(snapshotTree(root)).toEqual(before);
  },
  10000,
);
