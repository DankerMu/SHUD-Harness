import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  computeRunMetrics,
  serializeRunMetrics,
  type RunMetrics,
  type RunMetricsHealth,
} from "./index.ts";
import { digest, snapshotTree } from "./run-metrics-test-harness.ts";
import {
  makeClosedBudgetRun,
  setTreeWritable,
  waterBalanceInputPath,
  waterBalanceOutputPath,
  waterBalanceProject,
} from "./water-balance-test-harness.ts";

// Observe the real filesystem boundary, never replace a parser or metric producer.
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    openSync: vi.fn(actual.openSync),
    readSync: vi.fn(actual.readSync),
    closeSync: vi.fn(actual.closeSync),
  };
});
const native = await vi.importActual<typeof fs>("node:fs");
let parent: string;
let root: string;
beforeEach(() => {
  vi.mocked(fs.lstatSync).mockReset().mockImplementation(native.lstatSync);
  vi.mocked(fs.openSync).mockReset().mockImplementation(native.openSync);
  vi.mocked(fs.readSync).mockReset().mockImplementation(native.readSync);
  vi.mocked(fs.closeSync).mockReset().mockImplementation(native.closeSync);
  parent = native.realpathSync(native.mkdtempSync(join(tmpdir(), "water-residual-io-")));
  root = join(parent, "run");
  makeClosedBudgetRun(root);
});
afterEach(() => native.rmSync(parent, { recursive: true, force: true }));

function expectResidualIdentity(result: { metrics: RunMetrics; health: RunMetricsHealth }): void {
  expect(result.health.water_balance_residual).toBe(result.metrics.water_balance.residual);
  expect(result.metrics.numerical_health.water_balance_residual).toBe(
    result.metrics.water_balance.residual,
  );
  expect(result.metrics.numerical_health.reasons.water_balance_residual).toBe(
    result.metrics.water_balance.reasons.residual,
  );
}

test.each(["sp.att", "para.geol", "cfg.calib"])(
  "unsafe %s affects only its dependent terms and is never opened or receipted",
  (kind) => {
    const path = waterBalanceInputPath(kind);
    const target = join(root, path);
    const outside = join(parent, "outside-input");
    native.cpSync(target, outside);
    native.unlinkSync(target);
    native.symlinkSync(outside, target);
    const before = snapshotTree(parent);
    vi.clearAllMocks();
    const result = computeRunMetrics(root, waterBalanceProject);
    const { metrics } = result;
    expect(metrics.status).toBe("ok");
    expect(metrics.reason).toBeNull();
    expect(metrics.water_balance.residual).toBeNull();
    expect(metrics.water_balance.reasons.residual).toBe(`unreadable_input:${path}`);
    expect(metrics.water_balance.delta_s_us).toBeNull();
    expect(metrics.water_balance.delta_s_gw).toBeNull();
    expect(metrics.water_balance.delta_s_snow).toBeGreaterThan(0);
    expect(metrics.water_balance.delta_s_ic).toBeGreaterThan(0);
    expect(metrics.flow.total_runoff_m3).toBe(33);
    expect(metrics.inputs.map(({ path: observed }) => observed)).not.toContain(path);
    const opened = vi.mocked(fs.openSync).mock.calls.map(([file]) => String(file));
    expect(opened).not.toContain(target);
    expect(opened).not.toContain(outside);
    expectResidualIdentity(result);
    expect(snapshotTree(parent)).toEqual(before);
  },
);

test.each(["parse", "read"])("geology %s failure remains item-level", (failure) => {
  const path = waterBalanceInputPath("para.geol");
  const target = join(root, path);
  if (failure === "parse") native.writeFileSync(target, "invalid geology table\n");
  else {
    vi.mocked(fs.openSync).mockImplementation((...args) => {
      if (String(args[0]) === target)
        throw Object.assign(new Error("private geology IO payload"), { code: "EACCES" });
      return native.openSync(...args);
    });
  }
  const before = snapshotTree(parent);
  const result = computeRunMetrics(root, waterBalanceProject);
  expect(result.metrics.status).toBe("ok");
  expect(result.metrics.water_balance.residual).toBeNull();
  expect(result.metrics.water_balance.reasons.residual).toBe(`unreadable_input:${path}`);
  expect(result.metrics.inputs.map(({ path: observed }) => observed)).not.toContain(path);
  expect(result.metrics.flow.total_runoff_m3).toBe(33);
  expectResidualIdentity(result);
  expect(serializeRunMetrics(result.metrics)).not.toContain("private geology IO payload");
  expect(snapshotTree(parent)).toEqual(before);
});

test.each(["parse", "unsafe"])("missing snow cannot hide canopy %s failure", (failure) => {
  native.unlinkSync(join(root, waterBalanceOutputPath("eleysnow")));
  const path = waterBalanceOutputPath("eleyic");
  const target = join(root, path);
  if (failure === "parse") {
    const bytes = native.readFileSync(target);
    native.writeFileSync(target, bytes.subarray(0, bytes.length - 8));
  } else {
    native.unlinkSync(target);
    native.symlinkSync(join(parent, "absent-canopy"), target);
  }
  const before = snapshotTree(parent);
  const result = computeRunMetrics(root, waterBalanceProject);
  expect(result.metrics.status).toBe("unavailable");
  expect(result.metrics.reason).toBe(`${failure}:${path}`);
  expect(result.metrics.water_balance.residual).toBeNull();
  expect(result.metrics.water_balance.reasons.residual).toBe(`${failure}:${path}`);
  expect(result.metrics.flow.total_runoff_m3).toBeNull();
  expect(result.metrics.inputs.map(({ path: observed }) => observed)).not.toContain(path);
  expectResidualIdentity(result);
  expect(snapshotTree(parent)).toEqual(before);
});

test("unweighted registrations never inspect unreadable land-cover or PET decoys", () => {
  const decoys = [waterBalanceInputPath("para.lc"), waterBalanceOutputPath("elevetp")];
  native.unlinkSync(join(root, decoys[1]));
  for (const [index, path] of decoys.entries()) {
    native.symlinkSync(join(parent, `absent-decoy-${index}`), join(root, path));
  }
  const before = snapshotTree(parent);
  vi.clearAllMocks();
  const result = computeRunMetrics(root, waterBalanceProject);
  expect(result.metrics.status).toBe("ok");
  expect(Number.isFinite(result.metrics.water_balance.residual)).toBe(true);
  expect(result.metrics.water_balance.residual).toBeCloseTo(0.01, 12);
  expect(result.metrics.inputs).toHaveLength(16);
  for (const path of decoys) {
    expect(result.metrics.inputs.map(({ path: observed }) => observed)).not.toContain(path);
    expect(vi.mocked(fs.lstatSync).mock.calls.map(([file]) => String(file))).not.toContain(
      join(root, path),
    );
    expect(vi.mocked(fs.openSync).mock.calls.map(([file]) => String(file))).not.toContain(
      join(root, path),
    );
  }
  expectResidualIdentity(result);
  expect(snapshotTree(parent)).toEqual(before);
});

test("complete budget binds sixteen single-read inputs with deterministic read-only relocation", () => {
  const paths = [
    ...["sp.mesh", "sp.att", "sp.riv", "para.geol", "cfg.para", "cfg.calib", "cfg.ic"].map(
      waterBalanceInputPath,
    ),
    ...[
      "rivqdown",
      "elevprcp",
      "eleveta",
      "eleysurf",
      "eleyunsat",
      "eleygw",
      "rivystage",
      "eleysnow",
      "eleyic",
    ].map(waterBalanceOutputPath),
  ].sort();
  const expectedInputs = paths.map((path) => {
    const bytes = native.readFileSync(join(root, path));
    return { path, sha256: digest(bytes), size_bytes: bytes.length };
  });
  const relocated = join(parent, "relocated");
  native.cpSync(root, relocated, { recursive: true });
  const reads = new Map<string, { bytes: number; eof: number }[]>();
  const active = new Map<number, { bytes: number; eof: number }>();
  vi.mocked(fs.openSync).mockImplementation((...args) => {
    const fd = native.openSync(...args);
    const path = relative(root, String(args[0]));
    const observation = { bytes: 0, eof: 0 };
    const previous = reads.get(path) ?? [];
    previous.push(observation);
    reads.set(path, previous);
    active.set(fd, observation);
    return fd;
  });
  vi.mocked(fs.readSync).mockImplementation((...args) => {
    const bytes = native.readSync(...args);
    const observation = active.get(args[0]);
    expect(observation, "every read belongs to an observed descriptor").toBeDefined();
    if (observation !== undefined) {
      observation.bytes += bytes;
      if (bytes === 0) observation.eof += 1;
    }
    return bytes;
  });
  vi.mocked(fs.closeSync).mockImplementation((fd) => {
    native.closeSync(fd);
    active.delete(fd);
  });
  try {
    setTreeWritable(root, false);
    setTreeWritable(relocated, false);
    const before = snapshotTree(parent);
    vi.clearAllMocks();
    const first = computeRunMetrics(root, waterBalanceProject);
    expect(first.metrics.status).toBe("ok");
    expect(Number.isFinite(first.metrics.water_balance.residual)).toBe(true);
    expect(first.metrics.water_balance.residual).toBeCloseTo(0.01, 12);
    expect(first.metrics.inputs).toEqual(expectedInputs);
    expect(first.metrics.inputs).toHaveLength(16);
    expect([...reads.keys()].sort()).toEqual(paths);
    for (const input of expectedInputs) {
      expect(reads.get(input.path), `${input.path}: one complete byte observation`).toEqual([
        { bytes: input.size_bytes, eof: 1 },
      ]);
    }
    expect(fs.openSync).toHaveBeenCalledTimes(16);
    expect(fs.closeSync).toHaveBeenCalledTimes(16);
    expect(active.size).toBe(0);
    expectResidualIdentity(first);
    // Keep the single-observation evidence scoped to the first computation.
    vi.mocked(fs.openSync).mockReset().mockImplementation(native.openSync);
    vi.mocked(fs.readSync).mockReset().mockImplementation(native.readSync);
    vi.mocked(fs.closeSync).mockReset().mockImplementation(native.closeSync);
    const second = computeRunMetrics(root, waterBalanceProject);
    const moved = computeRunMetrics(relocated, waterBalanceProject);
    expect(second).toEqual(first);
    expect(moved).toEqual(first);
    expect(serializeRunMetrics(second.metrics)).toBe(serializeRunMetrics(first.metrics));
    expect(serializeRunMetrics(moved.metrics)).toBe(serializeRunMetrics(first.metrics));
    expect(serializeRunMetrics(first.metrics)).not.toContain(parent);
    expect(snapshotTree(parent)).toEqual(before);
  } finally {
    setTreeWritable(root, true);
    setTreeWritable(relocated, true);
  }
});

test("combined precedence: duplicate calib beats read-unavailable attributes by code point", () => {
  const attPath = waterBalanceInputPath("sp.att");
  const calibPath = waterBalanceInputPath("cfg.calib");
  const calibFile = join(root, calibPath);
  const calib = native.readFileSync(calibFile, "utf8");
  expect(calib).toContain("GEOL_THETAS\t1.6\n");
  native.writeFileSync(
    calibFile,
    calib.replace("GEOL_THETAS\t1.6\n", "GEOL_THETAS\t1.6\nGEOL_THETAS\t1.6\n"),
  );
  const before = snapshotTree(parent);
  let denied = false;
  vi.mocked(fs.openSync).mockImplementation((...args) => {
    if (String(args[0]) === join(root, attPath)) {
      denied = true;
      throw Object.assign(new Error("private attribute IO payload"), { code: "EACCES" });
    }
    return native.openSync(...args);
  });
  const result = computeRunMetrics(root, waterBalanceProject);
  const { metrics } = result;
  expect(denied).toBe(true);
  expect(metrics.status).toBe("ok");
  expect(metrics.reason).toBeNull();
  for (const field of ["delta_s_us", "delta_s_gw", "delta_s", "residual"] as const) {
    expect.soft(metrics.water_balance[field], `${field}: no partial value`).toBeNull();
    expect
      .soft(metrics.water_balance.reasons[field], `${field}: selected cause`)
      .toBe(`unreadable_input:${calibPath}`);
  }
  expect
    .soft(metrics.numerical_health.reasons.water_balance_residual)
    .toBe(`unreadable_input:${calibPath}`);
  expectResidualIdentity(result);
  expect(metrics.verdicts.water_balance_residual).toBe("not_available");
  expect(metrics.nonfinite_count).toBe(0);
  expect(metrics.flow).toMatchObject({ peak_flow_m3d: 16.5, peak_day: 0, total_runoff_m3: 33 });
  expect(Number.isFinite(metrics.water_balance.delta_s_snow)).toBe(true);
  expect(metrics.water_balance.delta_s_snow).toBeCloseTo(0.004, 12);
  expect(metrics.inputs.map(({ path }) => path)).not.toContain(attPath);
  const bytes = native.readFileSync(calibFile);
  expect(metrics.inputs).toContainEqual({
    path: calibPath,
    sha256: digest(bytes),
    size_bytes: bytes.length,
  });
  expect(snapshotTree(parent)).toEqual(before);
});
