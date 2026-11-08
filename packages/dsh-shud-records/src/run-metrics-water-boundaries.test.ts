import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { serializeRunMetrics } from "./index.ts";
import { computeRunMetrics } from "./run-metrics.ts";
import { digest, snapshotTree } from "./run-metrics-test-harness.ts";
import type { RunMetrics } from "./run-metrics-wire.ts";
import { buildShudDat } from "./shud-dat-test-harness.ts";
import {
  sharedWaterFields,
  waterBalanceDatInputs,
  waterBalanceFixture,
  waterBalanceProject,
} from "./water-balance-test-harness.ts";

type SharedField = (typeof sharedWaterFields)[number];
type Series = {
  start_date: number;
  columns: readonly number[];
  rows: readonly { t_min: number; values: readonly number[] }[];
};
const expected = JSON.parse(
  readFileSync(join(waterBalanceFixture, "expected-rshud.json"), "utf8"),
) as Record<SharedField, number>;
const inputPath = (kind: string) => `input/${waterBalanceProject}/${waterBalanceProject}.${kind}`;
const datPath = (variable: string) =>
  `output/${waterBalanceProject}.out/${waterBalanceProject}.${variable}.dat`;
let parent: string;
let root: string;
let baseline: RunMetrics;

beforeEach(() => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), "water-balance-boundary-")));
  root = join(parent, "run");
  cpSync(waterBalanceFixture, root, { recursive: true });
  baseline = computeRunMetrics(root, waterBalanceProject).metrics;
});
afterEach(() => rmSync(parent, { recursive: true, force: true }));

function rewriteDat(variable: string, change: (input: Series) => Series): void {
  const fixture = waterBalanceDatInputs.find(({ path }) => path === datPath(variable));
  if (fixture === undefined) throw new Error(`Unknown canonical fixture variable: ${variable}`);
  writeFileSync(join(root, fixture.path), buildShudDat(change(fixture.input)));
}

function replaceText(kind: string, before: string, after: string): void {
  const path = join(root, inputPath(kind));
  const text = readFileSync(path, "utf8");
  expect(text, `${kind}: mutation must match fixture input`).toContain(before);
  writeFileSync(path, text.replace(before, after));
}

function expectShared(
  metrics: RunMetrics,
  pending: readonly SharedField[] = [],
  scales: Partial<Record<SharedField, number>> = {},
): void {
  expect(metrics.status, metrics.reason ?? "item-level failures preserve the run").toBe("ok");
  for (const field of sharedWaterFields) {
    const actual = metrics.water_balance[field];
    if (pending.includes(field)) {
      expect(actual, field).toBeNull();
      expect(metrics.water_balance.reasons[field], field).toBe("pending_water_balance");
    } else {
      const reference = expected[field] * (scales[field] ?? 1);
      expect(typeof actual, `${field}: numeric shared term`).toBe("number");
      expect(Number.isFinite(actual), `${field}: finite shared term`).toBe(true);
      if (actual === null) throw new Error(`${field}: missing shared term`);
      const error = reference === 0 ? Math.abs(actual) : Math.abs((actual - reference) / reference);
      expect(error, `${field}: frozen reference error`).toBeLessThanOrEqual(
        reference === 0 ? 0 : 1e-12,
      );
      expect(metrics.water_balance.reasons[field], field).toBeNull();
    }
  }
}

function expectFlowHealth(metrics: RunMetrics): void {
  expect(metrics.flow).toEqual(baseline.flow);
  expect(metrics.numerical_health).toEqual(baseline.numerical_health);
}

function setTreeWritable(directory: string, writable: boolean): void {
  chmodSync(directory, writable ? 0o700 : 0o500);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) setTreeWritable(path, writable);
    else chmodSync(path, writable ? 0o600 : 0o400);
  }
}

test("reordered complete flux and storage columns preserve entity-weighted terms", () => {
  for (const variable of ["elevprcp", "eleyunsat"]) {
    rewriteDat(variable, (input) => ({
      ...input,
      columns: [...input.columns].reverse(),
      rows: input.rows.map(({ t_min, values }) => ({ t_min, values: [...values].reverse() })),
    }));
  }
  const { metrics } = computeRunMetrics(root, waterBalanceProject);
  expectShared(metrics);
  expectFlowHealth(metrics);
});

test.each([
  { name: "missing precipitation entity", variable: "elevprcp", columns: [1, 2], field: "P" },
  {
    name: "duplicate unsaturated entity",
    variable: "eleyunsat",
    columns: [1, 1, 3],
    field: "delta_s_us",
  },
  { name: "out-of-range AET entity", variable: "eleveta", columns: [1, 2, 4], field: "AET" },
] as const)("$name leaves only its dependent term pending", ({ variable, columns, field }) => {
  rewriteDat(variable, (input) => ({
    ...input,
    columns,
    rows: input.rows.map(({ t_min, values }) => ({
      t_min,
      values: values.slice(0, columns.length),
    })),
  }));
  const { metrics } = computeRunMetrics(root, waterBalanceProject);
  expectShared(metrics, [field]);
  expectFlowHealth(metrics);
});

test("each flux uses its own interval instead of unchanged cfg DT values", () => {
  for (const [variable, scale] of [
    ["elevprcp", 0.5],
    ["eleveta", 2],
    ["rivqdown", 3],
  ] as const) {
    rewriteDat(variable, (input) => ({
      ...input,
      rows: input.rows.map(({ t_min, values }) => ({ t_min: t_min * scale, values })),
    }));
  }
  const { metrics } = computeRunMetrics(root, waterBalanceProject);
  expectShared(metrics, [], { P: 0.5, AET: 2, Qd: 3 });
  const originalRunoff = baseline.flow.total_runoff_m3;
  if (originalRunoff === null) throw new Error("Canonical fixture must have finite runoff");
  expect(metrics.flow.total_runoff_m3).toBe(originalRunoff * 3);
  expect(metrics.numerical_health).toEqual(baseline.numerical_health);
});

test.each([
  { variable: "elevprcp", field: "P", name: "irregular precipitation intervals" },
  { variable: "eleveta", field: "AET", name: "single AET observation" },
] as const)("$name leaves only that flux pending", ({ variable, field }) => {
  rewriteDat(variable, (input) => ({
    ...input,
    rows:
      variable === "eleveta"
        ? input.rows.slice(0, 1)
        : input.rows.map((row, index) => ({ ...row, t_min: row.t_min + (index === 1 ? 1 : 0) })),
  }));
  const { metrics } = computeRunMetrics(root, waterBalanceProject);
  expectShared(metrics, [field]);
  expectFlowHealth(metrics);
});

test.each(["file missing", "key missing", "key duplicated"])(
  "calibration %s does not default porosity or suppress independent terms",
  (condition) => {
    if (condition === "file missing") unlinkSync(join(root, inputPath("cfg.calib")));
    else
      replaceText(
        "cfg.calib",
        "GEOL_THETAS\t1.6\n",
        condition === "key missing" ? "" : "GEOL_THETAS\t1.6\nGEOL_THETAS\t1.6\n",
      );
    const { metrics } = computeRunMetrics(root, waterBalanceProject);
    expectShared(metrics, ["delta_s_us", "delta_s_gw"]);
    expectFlowHealth(metrics);
  },
);

test.each([
  {
    name: "geology reference",
    kind: "sp.att",
    before: "2\t1\t2\t1\t1\t1\t0\t0\t0",
    after: "2\t1\t9\t1\t1\t1\t0\t0\t0",
    pending: ["delta_s_us", "delta_s_gw"],
  },
  {
    name: "river type reference",
    kind: "sp.riv",
    before: "2\t1\t2\t0.02\t50\t0",
    after: "2\t1\t9\t0.02\t50\t0",
    pending: ["delta_s_riv"],
  },
] as const)(
  "invalid $name leaves only dependent storage pending",
  ({ kind, before, after, pending }) => {
    replaceText(kind, before, after);
    const { metrics } = computeRunMetrics(root, waterBalanceProject);
    expectShared(metrics, pending);
    expectFlowHealth(metrics);
  },
);

test("a parsed but incomplete element IC table cannot create partial storage totals", () => {
  replaceText("cfg.ic", "3\t6\t0\n", "2\t6\t0\n");
  replaceText("cfg.ic", "3\t0.003\t0.004\t0.03\t0.9\t1.5\n", "");
  const { metrics } = computeRunMetrics(root, waterBalanceProject);
  expectShared(metrics, ["delta_s_surf", "delta_s_us", "delta_s_gw"]);
  expectFlowHealth(metrics);
});

test.each(["invalid node reference", "zero catchment area"])(
  "%s leaves shared depths pending without changing flow or health",
  (condition) => {
    if (condition === "invalid node reference") {
      replaceText("sp.mesh", "1\t1\t2\t3\t2\t0\t0\t100", "1\t99\t2\t3\t2\t0\t0\t100");
    } else {
      const path = join(root, inputPath("sp.mesh"));
      const lines = readFileSync(path, "utf8").split("\n");
      // The five authored node rows follow the element block and node header.
      for (let i = 7; i < 12; i += 1) {
        const row = lines[i].split("\t");
        row[1] = "0";
        row[2] = "0";
        lines[i] = row.join("\t");
      }
      writeFileSync(path, lines.join("\n"));
    }
    const { metrics } = computeRunMetrics(root, waterBalanceProject);
    expectShared(metrics, sharedWaterFields);
    expectFlowHealth(metrics);
  },
);

test("a nonfinite state value is counted once across health and storage consumers", () => {
  rewriteDat("eleyunsat", (input) => ({
    ...input,
    rows: input.rows.map((row, index) =>
      index === input.rows.length - 1 ? { ...row, values: [NaN, ...row.values.slice(1)] } : row,
    ),
  }));
  const { metrics } = computeRunMetrics(root, waterBalanceProject);
  expectShared(metrics, ["delta_s_us"]);
  expect(metrics.nonfinite_count).toBe(1);
  expect(metrics.flow).toEqual(baseline.flow);
  expect(metrics.numerical_health.negative_state_count).toBeNull();
  expect(metrics.numerical_health.reasons.negative_state_count).toBe("nonfinite:eleyunsat");
});

test("finite precipitation aggregation overflow is pending without inventing raw nonfinites", () => {
  rewriteDat("elevprcp", (input) => ({
    ...input,
    rows: input.rows.map((row) => ({
      ...row,
      values: [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE],
    })),
  }));
  const { metrics } = computeRunMetrics(root, waterBalanceProject);
  expectShared(metrics, ["P"]);
  expect(metrics.nonfinite_count).toBe(0);
  expectFlowHealth(metrics);
});

test("an unrelated nonoutlet NaN is counted but does not poison outlet Qd", () => {
  rewriteDat("rivqdown", (input) => ({
    ...input,
    rows: input.rows.map((row, index) =>
      index === 0 ? { ...row, values: [row.values[0], NaN] } : row,
    ),
  }));
  const { metrics } = computeRunMetrics(root, waterBalanceProject);
  expectShared(metrics);
  expect(metrics.nonfinite_count).toBe(1);
  expectFlowHealth(metrics);
});

test.each(["unsafe", "malformed"])(
  "missing early attributes cannot hide later present %s geology",
  (condition) => {
    unlinkSync(join(root, inputPath("sp.att")));
    const relative = inputPath("para.geol");
    const path = join(root, relative);
    if (condition === "unsafe") {
      const outside = join(parent, "outside-geology");
      cpSync(path, outside);
      unlinkSync(path);
      symlinkSync(outside, path);
    } else writeFileSync(path, "invalid geology table\n");
    const before = snapshotTree(parent);
    const { metrics } = computeRunMetrics(root, waterBalanceProject);
    expect(metrics.status).toBe("unavailable");
    expect(metrics.reason).toBe(`${condition === "unsafe" ? "unsafe" : "parse"}:${relative}`);
    expect(metrics.inputs.map(({ path: observed }) => observed)).not.toContain(relative);
    expect(metrics.inputs.map(({ path: observed }) => observed)).not.toContain(inputPath("sp.att"));
    expect(snapshotTree(parent)).toEqual(before);
  },
);

test("missing precipitation leaves only P pending and still observes AET", () => {
  unlinkSync(join(root, datPath("elevprcp")));
  const { metrics } = computeRunMetrics(root, waterBalanceProject);
  expectShared(metrics, ["P"]);
  expectFlowHealth(metrics);
  expect(metrics.inputs.map(({ path }) => path)).not.toContain(datPath("elevprcp"));
  expect(metrics.inputs.map(({ path }) => path)).toContain(datPath("eleveta"));
});

test("complete water metrics bind fourteen inputs and remain deterministic and read-only after relocation", () => {
  const relocated = join(parent, "relocated");
  cpSync(root, relocated, { recursive: true });
  try {
    setTreeWritable(root, false);
    setTreeWritable(relocated, false);
    const before = snapshotTree(parent);
    const first = computeRunMetrics(root, waterBalanceProject);
    const second = computeRunMetrics(root, waterBalanceProject);
    const moved = computeRunMetrics(relocated, waterBalanceProject);
    expect(second).toEqual(first);
    expect(moved).toEqual(first);
    expect(serializeRunMetrics(second.metrics)).toEqual(serializeRunMetrics(first.metrics));
    expect(serializeRunMetrics(moved.metrics)).toEqual(serializeRunMetrics(first.metrics));
    expectShared(first.metrics);
    const paths = [
      ...["sp.mesh", "sp.att", "sp.riv", "para.geol", "cfg.para", "cfg.calib", "cfg.ic"].map(
        inputPath,
      ),
      ...["rivqdown", "elevprcp", "eleveta", "eleysurf", "eleyunsat", "eleygw", "rivystage"].map(
        datPath,
      ),
    ].sort();
    expect(first.metrics.inputs).toHaveLength(14);
    expect(first.metrics.inputs).toEqual(
      paths.map((path) => {
        const bytes = readFileSync(join(root, path));
        return { path, sha256: digest(bytes), size_bytes: bytes.length };
      }),
    );
    expect(first.metrics.nonfinite_count).toBe(0);
    for (const field of ["delta_s_snow", "delta_s_ic", "delta_s", "residual"] as const) {
      expect(first.metrics.water_balance[field], field).toBeNull();
      expect(first.metrics.water_balance.reasons[field], field).toBe("pending_water_balance");
    }
    expect(first.health.water_balance_residual).toBeNull();
    expect(first.metrics.numerical_health.reasons.water_balance_residual).toBe(
      "pending_water_balance",
    );
    expect(first.metrics.numerical_health.reasons.cvode_failures).toBe("missing:stderr.log");
    expect(snapshotTree(parent)).toEqual(before);
  } finally {
    setTreeWritable(root, true);
    setTreeWritable(relocated, true);
  }
});
