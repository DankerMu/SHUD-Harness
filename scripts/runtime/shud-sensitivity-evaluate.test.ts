import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  classifySensitivityExit,
  type CriterionResult,
  type PlanOutcome,
} from "./shud-sensitivity-evaluate.ts";
import {
  SensitivityPreparationRecordSchema,
  type SensitivityPreparationRecord,
} from "./shud-sensitivity-prepare.ts";
import {
  evaluate,
  makeEvaluateFixture,
  treeState,
  type EvaluateFixture,
} from "./sensitivity-evaluate/test-harness.ts";

let f: EvaluateFixture;
beforeEach(async () => {
  f = await makeEvaluateFixture();
});
afterEach(() => {
  fs.chmodSync(f.workspace, 0o755);
  f.h.dispose();
});

type InputCase = [name: string, mutate: (argv: string[]) => string[], item: RegExp];
const INPUT_CASES: InputCase[] = [
  [
    "missing repeat-run argument",
    (argv) => argv.slice(0, 3),
    /Missing repeat-run record argument/u,
  ],
  [
    "nonexistent workspace",
    (argv) => [`${argv[0]}-absent`, ...argv.slice(1)],
    /^shud:sensitivity: workspace: /mu,
  ],
  [
    "unreadable workspace",
    (argv) => (fs.chmodSync(argv[0], 0), argv),
    /^shud:sensitivity: workspace: /mu,
  ],
  [
    "session log of a non-canonical shape",
    (argv) => [argv[0], argv[3], ...argv.slice(2)],
    /^shud:sensitivity: session log: .*canonical/mu,
  ],
  [
    "session log shadowed by a higher-version log",
    (argv) => (fs.copyFileSync(argv[1], join(dirname(argv[1]), "session.v5.jsonl.zstd")), argv),
    /^shud:sensitivity: session log: canonical log is .*session\.v5\.jsonl\.zstd/mu,
  ],
  [
    "schema-invalid preparation record",
    (argv) => (fs.writeFileSync(argv[2], `${JSON.stringify({ workspace: argv[0] })}\n`), argv),
    /^shud:sensitivity: preparation record: /mu,
  ],
  [
    "preparation record of another workspace",
    (argv) => {
      const value = JSON.parse(fs.readFileSync(argv[2], "utf8")) as Record<string, unknown>;
      fs.writeFileSync(argv[2], JSON.stringify({ ...value, workspace: `${argv[0]}-other` }));
      return argv;
    },
    /^shud:sensitivity: preparation record: workspace .*-other is not /mu,
  ],
  [
    "repeat record with a non-string thread environment",
    (argv) => {
      const value = JSON.parse(fs.readFileSync(argv[3], "utf8")) as Record<string, unknown>;
      fs.writeFileSync(argv[3], JSON.stringify({ ...value, omp_num_threads: 1 }));
      return argv;
    },
    /^shud:sensitivity: repeat-run record: .*omp_num_threads/mu,
  ],
];

test.each(INPUT_CASES)(
  "%s exits 1 naming the input before any criterion",
  async (_n, mutate, item) => {
    const result = await evaluate(f, mutate([...f.argv]));
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(item);
    expect(result.criteria.size).toBe(0);
  },
);

test("a not_executed repeat record parses and reaches the criteria", async () => {
  fs.writeFileSync(f.repeatPath, JSON.stringify({ status: "not_executed", reason: "no baseline" }));
  const result = await evaluate(f);
  expect(result.stderr).not.toMatch(/repeat-run record:/u);
  expect(result.criteria.size).toBeGreaterThan(0);
});

test("the preparation writer's record satisfies the shared schema", () => {
  const record = JSON.parse(fs.readFileSync(f.h.record, "utf8")) as SensitivityPreparationRecord;
  expect(SensitivityPreparationRecordSchema.parse(record)).toStrictEqual(record);
  expect(SensitivityPreparationRecordSchema.safeParse({ ...record, extra: 1 }).success).toBe(false);
});

const holding = (...failing: number[]): CriterionResult[] =>
  Array.from({ length: 13 }, (_, index) => ({
    criterion: index + 1,
    ok: !failing.includes(index + 1),
    evidence: failing.includes(index + 1) ? ["synthetic"] : [],
  }));
const EQUIVALENT: PlanOutcome = { kind: "equivalent" };
const DEVIATING: PlanOutcome = { kind: "non_equivalent", deviations: ["PSET-4 LC_ROUGH×0.5"] };
const CLASSES: [string, CriterionResult[], PlanOutcome, number][] = [
  ["all hold", holding(), EQUIVALENT, 0],
  ["non-equivalent plan, everything else holds", holding(1), DEVIATING, 2],
  ["non-equivalent plan and criterion 13 fails", holding(1, 13), DEVIATING, 2],
  ...[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(
    (n): [string, CriterionResult[], PlanOutcome, number] => [
      `non-equivalent plan and criterion ${n} fails`,
      holding(1, n),
      DEVIATING,
      1,
    ],
  ),
  ["missing card or plan", holding(1), { kind: "unavailable", reason: "no card" }, 1],
  ["criterion 13 alone under the fixed plan", holding(13), EQUIVALENT, 1],
  ["criterion 4 alone under the fixed plan", holding(4), EQUIVALENT, 1],
];

test.each(CLASSES)("exit classifier: %s", (_name, results, plan, code) => {
  expect(classifySensitivityExit(results, plan)).toBe(code);
});

test("the classifier rejects an array that is not the fixed 13 entries", () => {
  expect(() => classifySensitivityExit(holding().slice(1), EQUIVALENT)).toThrow(/13/u);
});

test("the best fixture exits 1 offline naming the 7.1b-2 criteria, both paths, and writes nothing", () => {
  const top = dirname(f.h.root);
  const bin = fs.mkdtempSync(join(tmpdir(), "git-only-"));
  const found = (process.env.PATH ?? "")
    .split(delimiter)
    .find((d) => fs.existsSync(join(d, "git")));
  fs.symlinkSync(join(found!, "git"), join(bin, "git"));
  const before = treeState(top);
  const script = fileURLToPath(new URL("./shud-sensitivity-evaluate.ts", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { runSensitivityEvaluateCli } from ${JSON.stringify(`file://${script}`)};` +
        `process.exitCode = await runSensitivityEvaluateCli(process.argv.slice(1), { root: ${JSON.stringify(f.h.root)} });`,
      ...f.argv,
    ],
    { env: { PATH: bin, HOME: process.env.HOME }, encoding: "utf8", timeout: 60_000 },
  );
  expect(result.status, result.stderr).toBe(1);
  const lines = result.stderr.trimEnd().split("\n");
  expect(lines).toEqual([
    ...[4, 5, 6, 7, 13].map((n) => `shud:sensitivity: criterion ${n}: implemented in 7.1b-2`),
    `shud:sensitivity: workspace ${f.workspace}`,
    `shud:sensitivity: session log ${f.logPath}`,
  ]);
  fs.rmSync(bin, { recursive: true });
  expect(treeState(top)).toStrictEqual(before);
});
