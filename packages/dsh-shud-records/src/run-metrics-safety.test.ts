import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { inspect } from "node:util";
import { afterEach, beforeEach, expect, test } from "vitest";
import { serializeRunMetrics } from "./index.ts";
import { computeRunMetrics } from "./run-metrics.ts";
import {
  coreInputs,
  datPath,
  digest,
  inputPath,
  makeMetricsRun,
  metricFields,
  project,
  snapshotTree,
  stateVariables,
  writeDat,
} from "./run-metrics-test-harness.ts";

let parent: string;
let root: string;
beforeEach(() => {
  parent = realpathSync(mkdtempSync(`${tmpdir()}/run-metrics-safety-`));
  root = `${parent}/run`;
  makeMetricsRun(root);
});
afterEach(() => rmSync(parent, { recursive: true, force: true }));

function unavailable(path: string, reason?: RegExp, requestedProject = project) {
  const before = snapshotTree(parent);
  const result = computeRunMetrics(root, requestedProject);
  expect(snapshotTree(parent)).toEqual(before);
  expect(result.metrics.status).toBe("unavailable");
  expect(result.metrics.reason).toContain(path);
  if (reason) expect(result.metrics.reason).toMatch(reason);
  if (!("reason" in result)) throw new Error("Expected a controlled unavailable reason");
  expect(result.reason).toContain(path);
  expect(result.health).toEqual({
    water_balance_residual: null,
    cvode_failures: null,
    negative_state_count: null,
    max_solver_dt: null,
  });
  const blocks = [
    result.metrics.flow,
    result.metrics.water_balance,
    result.metrics.numerical_health,
  ];
  for (const [index, block] of blocks.entries()) {
    const fields = Object.values(metricFields)[index];
    expect(Object.keys(block.reasons).sort()).toEqual([...fields].sort());
    for (const key of fields) {
      const why = (block.reasons as Record<string, unknown>)[key];
      expect((block as unknown as Record<string, unknown>)[key]).toBeNull();
      expect(why).toEqual(expect.any(String));
      expect(why).not.toBe("");
    }
  }
  expect(result.metrics.verdicts).toEqual({
    water_balance_residual: "not_available",
    cvode_failures: "not_available",
    negative_state_count: "not_available",
  });
  expect(result).not.toHaveProperty("cause");
  const diagnostic = inspect(result, { depth: null, showHidden: true });
  expect(diagnostic).not.toContain(parent);
  expect(diagnostic).not.toContain("private-run-payload");
  return result.metrics;
}

test.each(coreInputs)("missing required %s is controlled unavailable without any write", (kind) => {
  unlinkSync(`${root}/${inputPath(kind)}`);
  unavailable(inputPath(kind), /missing/u);
});

test("missing rivqdown has the prescribed top-level reason", () => {
  unlinkSync(`${root}/${datPath("rivqdown")}`);
  expect(unavailable("rivqdown").reason).toBe("missing_variable:rivqdown");
});

test("malformed required text gives a sanitized file-specific failure", () => {
  writeFileSync(`${root}/${inputPath("sp.riv")}`, "private-run-payload\n");
  unavailable(inputPath("sp.riv"), /parse/u);
});

test.each(["rivqdown", ...stateVariables])(
  "malformed present %s invalidates every metric",
  (variable) => {
    const relative = datPath(variable);
    const bytes = readFileSync(`${root}/${relative}`);
    writeFileSync(`${root}/${relative}`, bytes.subarray(0, bytes.length - 8));
    unavailable(relative, /parse|align|layout/u);
  },
);

test.each([inputPath("sp.mesh"), datPath("eleygw"), datPath("rivqdown")])(
  "rejects final symlink %s and preserves the outside target",
  (relative) => {
    const outside = `${parent}/outside`;
    writeFileSync(outside, "private-run-payload");
    unlinkSync(`${root}/${relative}`);
    symlinkSync(outside, `${root}/${relative}`);
    const metrics = unavailable(relative, /unsafe/u);
    expect(metrics.inputs.map(({ path }) => path)).not.toContain(relative);
  },
);

test.each(["input", "input/mini", "output", "output/mini.out"])(
  "keeps the run root as safety base when %s is a symlink to real readable data",
  (relative) => {
    const target = `${parent}/relocated`;
    renameSync(`${root}/${relative}`, target);
    symlinkSync(target, `${root}/${relative}`);
    unavailable(relative, /unsafe/u);
  },
);

test.each([inputPath("cfg.ic"), datPath("rivqdown"), datPath("rivystage")])(
  "rejects directory target %s instead of treating it as missing",
  (relative) => {
    unlinkSync(`${root}/${relative}`);
    mkdirSync(`${root}/${relative}`);
    unavailable(relative, /unsafe/u);
  },
);

test.each(["missing", "nonfinite"])(
  "early optional %s cannot hide a later present malformed state file",
  (kind) => {
    if (kind === "missing") unlinkSync(`${root}/${datPath("eleygw")}`);
    else writeDat(root, "eleygw", { columns: [1], rows: [{ t_min: 0, values: [NaN] }] });
    const bad = datPath("rivystage");
    const bytes = readFileSync(`${root}/${bad}`);
    writeFileSync(`${root}/${bad}`, bytes.subarray(0, bytes.length - 8));
    const metrics = unavailable(bad, /parse|align|layout/u);
    expect(metrics.inputs.map(({ path }) => path)).toContain(datPath("rivqdown"));
    expect(metrics.inputs.map(({ path }) => path)).not.toContain(bad);
    expect(metrics.nonfinite_count).toBe(kind === "missing" ? 0 : 1);
    for (const entry of metrics.inputs) {
      const observed = readFileSync(`${root}/${entry.path}`);
      expect(entry).toEqual({
        path: entry.path,
        sha256: digest(observed),
        size_bytes: observed.length,
      });
    }
  },
);

test("optional absence cannot hide a later unsafe present state", () => {
  unlinkSync(`${root}/${datPath("eleygw")}`);
  unlinkSync(`${root}/${datPath("rivystage")}`);
  symlinkSync(`${root}/${datPath("eleysurf")}`, `${root}/${datPath("rivystage")}`);
  unavailable(datPath("rivystage"), /unsafe/u);
});

test.each(["missing", "symlink", "directory"])(
  "%s stderr only makes CVODE count unavailable",
  (kind) => {
    unlinkSync(`${root}/stderr.log`);
    if (kind === "symlink") symlinkSync(`${root}/${inputPath("cfg.para")}`, `${root}/stderr.log`);
    if (kind === "directory") mkdirSync(`${root}/stderr.log`);
    const before = snapshotTree(parent);
    const { metrics, health } = computeRunMetrics(root, project);
    expect(metrics.status).toBe("ok");
    expect(health.cvode_failures).toBeNull();
    expect(metrics.numerical_health.reasons.cvode_failures).toContain("stderr.log");
    expect(metrics.verdicts.cvode_failures).toBe("not_available");
    expect(health.negative_state_count).toBe(0);
    expect(metrics.flow.total_runoff_m3).toBe(60);
    expect(metrics.inputs.map(({ path }) => path)).not.toContain("stderr.log");
    expect(snapshotTree(parent)).toEqual(before);
  },
);

test.each(["", ".", "..", "../outside", "/absolute", "nested/name", "nested\\name", "bad\0name"])(
  "invalid project %j returns controlled unavailable without filesystem changes",
  (invalid) => {
    const before = snapshotTree(parent);
    const result = computeRunMetrics(root, invalid);
    expect(result.metrics.status).toBe("unavailable");
    expect(result.metrics.reason).toMatch(/project/u);
    expect(result).not.toHaveProperty("cause");
    expect(snapshotTree(parent)).toEqual(before);
  },
);

test("early invalid-project unavailability preserves the fixed solver-step reason", () => {
  const metrics = unavailable("project", /^invalid_project$/u, "../outside");
  expect(metrics.reason).toBe("invalid_project");
  expect(metrics.inputs).toEqual([]);
  expect(metrics.numerical_health.reasons.max_solver_dt).toBe("not_observable_in_pinned_shud");
});

test("late malformed state after an optional miss preserves the fixed solver-step reason", () => {
  unlinkSync(`${root}/${datPath("eleygw")}`);
  const relative = datPath("rivystage");
  const bytes = readFileSync(`${root}/${relative}`);
  writeFileSync(`${root}/${relative}`, bytes.subarray(0, bytes.length - 8));
  const metrics = unavailable(relative, /^parse:/u);
  expect(metrics.reason).toBe("parse:output/mini.out/mini.rivystage.dat");
  expect(metrics.inputs.map(({ path }) => path)).toContain(datPath("rivqdown"));
  expect(metrics.numerical_health.reasons.max_solver_dt).toBe("not_observable_in_pinned_shud");
});

test("computations and relocated copies have identical bytes, exact manifests, and no persisted output", () => {
  // These deliberately unreadable, unrelated targets must not be scanned by this slice.
  mkdirSync(`${root}/output/mini.out/mini.eleprcp.dat`);
  symlinkSync(`${parent}/absent`, `${root}/output/mini.out/mini.eleysnow.dat`);
  const before = snapshotTree(root);
  const first = computeRunMetrics(root, project);
  const second = computeRunMetrics(root, project);
  expect(first.metrics.status).toBe("ok");
  expect(serializeRunMetrics(first.metrics)).toBe(serializeRunMetrics(second.metrics));
  expect(snapshotTree(root)).toEqual(before);
  const expectedPaths = [
    ...coreInputs.map(inputPath),
    ...["rivqdown", ...stateVariables].map(datPath),
    "stderr.log",
  ].sort();
  expect(first.metrics.inputs.map(({ path }) => path)).toEqual(expectedPaths);
  for (const entry of first.metrics.inputs) {
    const bytes = readFileSync(`${root}/${entry.path}`);
    expect(entry).toEqual({ path: entry.path, sha256: digest(bytes), size_bytes: bytes.length });
  }
  const relocated = `${parent}/other-absolute-location`;
  cpSync(root, relocated, { recursive: true, verbatimSymlinks: true });
  const relocatedBefore = snapshotTree(relocated);
  const bytes = serializeRunMetrics(computeRunMetrics(relocated, project).metrics);
  expect(bytes).toBe(serializeRunMetrics(first.metrics));
  expect(bytes).not.toContain(parent);
  expect(snapshotTree(root)).toEqual(before);
  expect(snapshotTree(relocated)).toEqual(relocatedBefore);
});

test.each([inputPath("sp.mesh"), datPath("rivystage"), "stderr.log"])(
  "writerless FIFO at %s fails closed within a killed-and-reaped bound",
  (relative) => {
    const child = () =>
      spawnSync(
        process.execPath,
        [
          "--experimental-transform-types",
          "--input-type=module",
          "-e",
          `// Eval has no module-relative base; the parent supplies the runtime module URL.
       const { computeRunMetrics } = await import(process.argv[1]);
       console.log(JSON.stringify(computeRunMetrics(process.argv[2], "mini").metrics));`,
          new URL("./run-metrics.ts", import.meta.url).href,
          root,
        ],
        { encoding: "utf8", timeout: 3000, killSignal: "SIGKILL" },
      );
    const control = child();
    expect(control.error, control.stderr).toBeUndefined();
    expect(control.status, control.stderr).toBe(0);
    expect(JSON.parse(control.stdout)).toMatchObject({
      status: "ok",
      flow: { total_runoff_m3: 60 },
    });
    unlinkSync(`${root}/${relative}`);
    execFileSync("mkfifo", [`${root}/${relative}`]);
    const before = snapshotTree(parent);
    const result = child();
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    const metrics = JSON.parse(result.stdout) as Record<string, unknown>;
    if (relative === "stderr.log") {
      expect(metrics).toMatchObject({ status: "ok", numerical_health: { cvode_failures: null } });
    } else {
      expect(metrics).toMatchObject({ status: "unavailable" });
      expect(metrics.reason).toContain(relative);
    }
    expect(snapshotTree(parent)).toEqual(before);
  },
  10000,
);
