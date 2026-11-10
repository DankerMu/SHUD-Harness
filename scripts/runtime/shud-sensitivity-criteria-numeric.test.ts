import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  ensureOutputInterval,
  updateEnd,
} from "../../packages/dsh-shud-jobs/src/shud-cfg-rewrite.ts";
import {
  computeRunMetrics,
  serializeRunMetrics,
} from "../../packages/dsh-shud-records/src/index.ts";
import { expectedRunParameters } from "./shud-sensitivity-criteria-numeric.ts";
import { hash } from "./sensitivity/test-harness.ts";
import {
  REPORT,
  evaluate,
  makeEvaluateFixture,
  run,
  treeState,
  type EvaluateFixture,
} from "./sensitivity-evaluate/test-harness.ts";

const CCW = fileURLToPath(new URL("../../SHUD/input/ccw/", import.meta.url));

let f: EvaluateFixture;
beforeEach(async () => {
  f = await makeEvaluateFixture();
});
afterEach(() => f.h.dispose());

const runDir = (n: number) => join(f.workspace, "runs", run(n));
const bak = (n: number) => join(runDir(n), "output/ccw.out/ccw.cfg.calib.bak");
const parameters = (n: number) => join(runDir(n), "input/ccw/ccw.cfg.para");
const edit = (path: string, change: (text: string) => string) =>
  fs.writeFileSync(path, Buffer.from(change(fs.readFileSync(path).toString("latin1")), "latin1"));
const writeRecord = (n: number) => f.writeJson(`runs/${run(n)}/run-record.json`, f.records[n - 1]);
const health = (n: number, field: string, value: number | null) => {
  const record = f.records[n - 1];
  f.records[n - 1] = {
    ...record,
    numerical_health: { ...record.numerical_health, [field]: value },
  };
  writeRecord(n);
};
/** Replace run n's metrics.json and record the new bytes' digest so only the content differs. */
const replaceMetrics = (n: number, bytes: string) => {
  fs.writeFileSync(join(runDir(n), "metrics.json"), bytes);
  const record = f.records[n - 1];
  const metrics_summary = {
    path: "metrics.json" as const,
    sha256: hash("sha256", Buffer.from(bytes)),
  };
  f.records[n - 1] = { ...record, artifacts: { ...record.artifacts, metrics_summary } };
  writeRecord(n);
};
const repeat = (fields: Record<string, unknown>) => {
  Object.assign(f.repeat, fields);
  f.publishRepeat();
};
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const line = (n: number, actual: string, expected: string) =>
  new RegExp(
    `^runs/${run(n)}/input/ccw/ccw\\.cfg\\.para line \\d+: ${actual} \\(expected ${expected}\\)$`,
    "u",
  );

/** Each pattern must match one `; `-separated evidence item; `absent` must match none. */
type Case = [
  name: string,
  criterion: number,
  mutate: () => void,
  detail: RegExp[],
  absent?: RegExp,
];
const COMPARED = /differs from in-batch baseline/u;
const CASES: Case[] = [
  [
    "LC_ROUGH×2 run whose .bak LC_ROUGH is not twice the source",
    4,
    () => edit(bak(4), (text) => text.replace("LC_ROUGH\t2\n", "LC_ROUGH\t1.5\n")),
    [new RegExp(`^${run(4)} LC_ROUGH: expected 2 actual 1\\.5$`, "u")],
  ],
  [
    "GEOL_KSATH×2 run whose .bak still holds the baseline value",
    4,
    () => edit(bak(3), (text) => text.replace("GEOL_KSATH\t2\n", "GEOL_KSATH\t1\n")),
    [new RegExp(`^${run(3)} GEOL_KSATH: expected 2 actual 1$`, "u")],
  ],
  [
    "the second of SHUD's duplicated SOIL_DINF lines differs",
    4,
    () =>
      edit(bak(1), (text) => text.replace(/SOIL_DINF\t1\n(?![\s\S]*SOIL_DINF)/u, "SOIL_DINF\t3\n")),
    [new RegExp(`^${run(1)} SOIL_DINF: expected 1 actual 3$`, "u")],
  ],
  [
    "a mixed-case .bak key (LC_ImpAF) differs from the upper-case source key",
    4,
    () => edit(bak(2), (text) => text.replace("LC_ImpAF\t1\n", "LC_ImpAF\t0.5\n")),
    [new RegExp(`^${run(2)} LC_IMPAF: expected 1 actual 0\\.5$`, "u")],
  ],
  [
    "the perturbed key is absent from the .bak",
    4,
    () => edit(bak(4), (text) => text.replace("LC_ROUGH\t2\n", "")),
    [new RegExp(`^${run(4)} LC_ROUGH: perturbed key not compared`, "u")],
  ],
  [
    "a run without its calib .bak",
    4,
    () => fs.rmSync(bak(2)),
    [new RegExp(`^${run(2)}: .*output/ccw\\.out/ccw\\.cfg\\.calib\\.bak`, "u")],
  ],
  [
    "null water_balance_residual",
    5,
    () => health(2, "water_balance_residual", null),
    [new RegExp(`^${run(2)} numerical_health\\.water_balance_residual is null$`, "u")],
  ],
  [
    "null cvode_failures",
    5,
    () => health(3, "cvode_failures", null),
    [new RegExp(`^${run(3)} numerical_health\\.cvode_failures is null$`, "u")],
  ],
  [
    "null negative_state_count",
    5,
    () => health(4, "negative_state_count", null),
    [new RegExp(`^${run(4)} numerical_health\\.negative_state_count is null$`, "u")],
  ],
  [
    "observed max_solver_dt",
    5,
    () => health(1, "max_solver_dt", 0.5),
    [new RegExp(`^${run(1)} numerical_health\\.max_solver_dt 0\\.5 \\(expected null\\)$`, "u")],
  ],
  [
    "null metrics_summary",
    5,
    () => {
      const record = f.records[0];
      f.records[0] = { ...record, artifacts: { ...record.artifacts, metrics_summary: null } };
      writeRecord(1);
    },
    [new RegExp(`^${run(1)} artifacts\\.metrics_summary is null$`, "u")],
  ],
  [
    "metrics.json status unavailable with a matching digest",
    5,
    () => {
      const copy = join(f.h.evidence, "unavailable");
      fs.cpSync(runDir(2), copy, { recursive: true });
      fs.rmSync(join(copy, "output/ccw.out/ccw.rivqdown.dat"));
      replaceMetrics(2, serializeRunMetrics(computeRunMetrics(copy, "ccw").metrics));
    },
    [new RegExp(`^${run(2)} metrics\\.json status unavailable \\(expected ok\\)$`, "u")],
  ],
  [
    "metrics.json digest differs from the RunRecord",
    5,
    () => fs.appendFileSync(join(runDir(3), "metrics.json"), " "),
    [
      new RegExp(
        `^${run(3)} metrics\\.json sha256 [0-9a-f]{64} \\(RunRecord artifacts\\.metrics_summary\\.sha256 [0-9a-f]{64}\\)$`,
        "u",
      ),
    ],
  ],
  [
    "one byte changed in a metrics.json whose digest the RunRecord follows",
    6,
    () => {
      const text = fs.readFileSync(join(runDir(2), "metrics.json"), "utf8");
      const changed = text.replace(/"nonfinite_count": ?0/u, (m) => m.replace("0", "1"));
      expect(changed).not.toBe(text);
      replaceMetrics(2, changed);
    },
    [new RegExp(`^runs/${run(2)}/metrics\\.json differs from the recomputed metrics$`, "u")],
  ],
  [
    "one byte changed in the report's .sensitivity.json",
    6,
    () =>
      edit(join(f.workspace, `reports/${REPORT}.sensitivity.json`), (text) =>
        text.replace(/\d/u, (digit) => String((Number(digit) + 1) % 10)),
      ),
    [
      new RegExp(
        `^reports/${REPORT}\\.sensitivity\\.json differs from the recomputed summary$`,
        "u",
      ),
    ],
  ],
  [
    "a linked run whose collect-error ledger the jobs reader rejects",
    6,
    () => fs.writeFileSync(join(runDir(3), "collect-error.json"), "{}\n"),
    [/^summary recompute: SHUD collect collect-error ledger: INVALID_FIELDS$/u],
  ],
  [
    "repeat rivqdown differs from the in-batch baseline",
    7,
    () => repeat({ rivqdown_sha256: SHA_B }),
    [
      new RegExp(
        `^repeat repeat-baseline rivqdown sha256 ${SHA_B} differs from in-batch baseline ${run(1)} [0-9a-f]{64}$`,
        "u",
      ),
    ],
  ],
  [
    "repeat input file hash differs (rivqdown then not compared)",
    7,
    () => {
      const input = { ...(f.repeat.input_sha256 as Record<string, string>) };
      input["ccw.cfg.para"] = SHA_C;
      repeat({ input_sha256: input, rivqdown_sha256: SHA_B });
    },
    [
      new RegExp(`repeat repeat-baseline input ccw\\.cfg\\.para: [0-9a-f]{64} -> ${SHA_C}`, "u"),
      /rivqdown not compared/u,
    ],
    COMPARED,
  ],
  [
    "repeat input lacks a baseline copy file",
    7,
    () => {
      const input = { ...(f.repeat.input_sha256 as Record<string, string>) };
      delete input["forcing/nested/x1.csv"];
      repeat({ input_sha256: input });
    },
    [/repeat repeat-baseline input forcing\/nested\/x1\.csv: [0-9a-f]{64} -> absent/u],
  ],
  [
    'OMP_NUM_THREADS "01" (rivqdown then not compared)',
    7,
    () => repeat({ omp_num_threads: "01", rivqdown_sha256: SHA_B }),
    [/repeat repeat-baseline OMP_NUM_THREADS "01" \(expected "1"\)/u, /rivqdown not compared/u],
    COMPARED,
  ],
  [
    'SHUD_RHS_THREADS "2"',
    7,
    () => repeat({ shud_rhs_threads: "2" }),
    [/repeat repeat-baseline SHUD_RHS_THREADS "2" \(expected "1"\)/u, /rivqdown not compared/u],
  ],
  [
    "repeat names another baseline run",
    7,
    () => repeat({ baseline_run_id: run(2) }),
    [new RegExp(`baseline_run_id ${run(2)} \\(in-batch baseline ${run(1)}\\)`, "u")],
  ],
  [
    "solver killed by a signal",
    7,
    () => repeat({ exit_code: null }),
    [/^repeat repeat-baseline exit_code null \(expected 0\)$/u],
  ],
  [
    "solver exit code 1",
    7,
    () => repeat({ exit_code: 1 }),
    [/^repeat repeat-baseline exit_code 1 \(expected 0\)$/u],
  ],
  [
    "repeat without a rivqdown output",
    7,
    () => repeat({ rivqdown_sha256: null }),
    [/^repeat repeat-baseline rivqdown_sha256 null$/u],
  ],
  [
    "repeat not executed",
    7,
    () => {
      f.repeat = { status: "not_executed", reason: "host did not stop" };
      f.publishRepeat();
    },
    [/^repeat run not executed: host did not stop$/u],
  ],
  [
    "an in-batch RunJob with threads 2",
    7,
    () => {
      f.jobs[2] = { ...f.jobs[2], threads: 2 };
      f.writeJson(`runs/${run(3)}/run-job.json`, f.jobs[2]);
    },
    [new RegExp(`^${run(3)} RunJob threads 2 \\(expected 1\\)$`, "u")],
  ],
  [
    "run copy NUM_OPENMP 8",
    13,
    () => edit(parameters(2), (text) => text.replace("NUM_OPENMP\t1\n", "NUM_OPENMP\t8\n")),
    [line(2, String.raw`"NUM_OPENMP\\t8\\n"`, String.raw`"NUM_OPENMP\\t1\\n"`)],
  ],
  [
    "run copy END 91",
    13,
    () => edit(parameters(1), (text) => text.replace("END 90\n", "END 91\n")),
    [line(1, String.raw`"END 91\\n"`, String.raw`"END 90\\n"`)],
  ],
  [
    "an extra changed line in a run copy",
    13,
    () => edit(parameters(3), (text) => text.replace("SCR_INTV\t1440\n", "SCR_INTV\t60\n")),
    [line(3, String.raw`"SCR_INTV\\t60\\n"`, String.raw`"SCR_INTV\\t1440\\n"`)],
  ],
  [
    "a run copy without the appended DT_YE_IC line",
    13,
    () => edit(parameters(4), (text) => text.replace(/DT_YE_IC\t1440\n$/u, "")),
    [line(4, "absent", String.raw`"DT_YE_IC\\t1440\\n"`)],
  ],
];

test.each(CASES)("%s fails criterion %i", async (_name, criterion, mutate, details, absent) => {
  mutate();
  const before = treeState(dirname(f.h.root));
  const result = await evaluate(f);
  expect(treeState(dirname(f.h.root))).toStrictEqual(before);
  expect(result.code, result.stderr).toBe(1);
  const detail = result.criteria.get(criterion);
  expect(detail, result.stderr).toBeDefined();
  const items = detail!.split("; ");
  for (const pattern of details)
    expect(
      items.find((item) => pattern.test(item)),
      `${pattern} in ${detail}`,
    ).toBeDefined();
  if (absent) expect(detail).not.toMatch(absent);
});

test("SHUD's .bak layout passes: duplicated SOIL_DINF, mixed-case keys, RIV_BSLOPE+ absent", async () => {
  const text = fs.readFileSync(bak(1), "latin1");
  expect(text.match(/^SOIL_DINF\t/gmu)).toHaveLength(2);
  expect(text).toMatch(/^LC_ImpAF\t1$/mu);
  expect(text).not.toMatch(/RIV_BSLOPE/u);
  expect(fs.readFileSync(join(f.workspace, "input/ccw/ccw.cfg.calib"), "latin1")).toMatch(
    /^RIV_BSLOPE\+\t0$/mu,
  );
  const result = await evaluate(f);
  expect(result.code, result.stderr).toBe(0);
});

test("a source value beyond six significant digits passes at %g precision", async () => {
  f.h.dispose();
  f = await makeEvaluateFixture({
    calib: (text) => text.replace("GEOL_KSATH\t1\n", "GEOL_KSATH\t0.123456789\n"),
  });
  expect(fs.readFileSync(bak(1), "latin1")).toMatch(/^GEOL_KSATH\t0\.123457$/mu);
  expect(fs.readFileSync(bak(2), "latin1")).toMatch(/^GEOL_KSATH\t0\.0617284$/mu);
  const result = await evaluate(f);
  expect(result.code, result.stderr).toBe(0);
});

test("the composed run-copy cfg.para equals the registry's path transforms on the ccw source", async () => {
  const source = fs.readFileSync(join(CCW, "ccw.cfg.para"));
  const path = join(f.h.evidence, "ccw.cfg.para");
  fs.writeFileSync(path, source);
  await updateEnd(path, 90);
  await ensureOutputInterval(path, "DT_YE_IC", 1440);
  await ensureOutputInterval(path, "NUM_OPENMP", 1);
  const registry = fs.readFileSync(path);
  expect(expectedRunParameters(source)).toStrictEqual(registry);
  // Independent literal: ccw has `END 1827`, `NUM_OPENMP\t8` and no DT_YE_IC line.
  const text = source.toString("latin1");
  expect(text).toMatch(/^END 1827$/mu);
  expect(registry.toString("latin1")).toBe(
    `${text.replace("END 1827\n", "END 90\n").replace("NUM_OPENMP\t8\n", "NUM_OPENMP\t1\n")}DT_YE_IC\t1440\n`,
  );
});
