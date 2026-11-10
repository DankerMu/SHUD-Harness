import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadSensitivityBatch } from "./shud-sensitivity-criteria-workspace.ts";
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
  run,
  treeState,
  type EvaluateFixture,
} from "./sensitivity-evaluate/test-harness.ts";

/** Pass-through spies on every process-starting export; the evaluator may only start `git`. */
const SPAWNERS = vi.hoisted(() => [
  "exec",
  "execFile",
  "execFileSync",
  "execSync",
  "fork",
  "spawn",
  "spawnSync",
]);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  const spied = Object.fromEntries(
    SPAWNERS.map((name) => [name, vi.fn(actual[name as keyof typeof actual] as () => unknown)]),
  );
  return { ...actual, ...spied, default: { ...actual, ...spied } };
});
const started = () =>
  SPAWNERS.flatMap((name) =>
    vi.mocked(childProcess[name as "spawn"]).mock.calls.map((call) => `${name} ${String(call[0])}`),
  );
/** Case-insensitive file systems (default APFS) resolve an upper-case spelling of tmpdir. */
const CASE_ALIASES = fs.existsSync(tmpdir().toUpperCase());

let f: EvaluateFixture;
beforeEach(async () => {
  f = await makeEvaluateFixture();
  vi.clearAllMocks();
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

/** The CLI in a fresh node with only `git` on PATH: no dsh host, DMXAPI_KEY or SHUD_BIN. */
function offline() {
  const bin = fs.mkdtempSync(join(tmpdir(), "git-only-"));
  const found = (process.env.PATH ?? "")
    .split(delimiter)
    .find((d) => fs.existsSync(join(d, "git")));
  fs.symlinkSync(join(found!, "git"), join(bin, "git"));
  const script = fileURLToPath(new URL("./shud-sensitivity-evaluate.ts", import.meta.url));
  try {
    return childProcess.spawnSync(
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
  } finally {
    fs.rmSync(bin, { recursive: true });
  }
}

const criterionLines = (stderr: string) =>
  [...stderr.matchAll(/^shud:sensitivity: criterion (\d+): /gmu)].map((m) => Number(m[1]));
const paths = () => [
  `shud:sensitivity: workspace ${f.workspace}`,
  `shud:sensitivity: session log ${f.logPath}`,
];

/** The three recorded groups of the spec plus the end_days deviation that also fails 13. */
type Group = [name: string, setup: () => Promise<void>, code: number, failing: number[]];
const GROUPS: Group[] = [
  ["all criteria hold", () => Promise.resolve(), 0, []],
  [
    "only the plan deviates (LC_ROUGH×0.5)",
    async () => {
      f.h.dispose();
      f = await makeEvaluateFixture({
        changes: [{}, { GEOL_KSATH: 0.5 }, { GEOL_KSATH: 2 }, { LC_ROUGH: 0.5 }],
      });
    },
    2,
    [1],
  ],
  [
    "only the plan deviates (end_days 60), criterion 13 printed",
    async () => {
      f.h.dispose();
      f = await makeEvaluateFixture({ end_days: 60 });
    },
    2,
    [1, 13],
  ],
  [
    "only the repeat rivqdown sha256 differs",
    () => {
      f.repeat.rivqdown_sha256 = "e".repeat(64);
      f.publishRepeat();
      return Promise.resolve();
    },
    1,
    [7],
  ],
];

test.each(GROUPS)("offline recorded fixture: %s", async (_name, setup, code, failing) => {
  await setup();
  const top = dirname(f.h.root);
  const before = treeState(top);
  const result = offline();
  expect(treeState(top)).toStrictEqual(before);
  expect(result.status, result.stderr).toBe(code);
  expect(criterionLines(result.stderr)).toEqual(failing);
  const lines = result.stderr.trimEnd().split("\n");
  if (code === 0) {
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("shud:sensitivity: all 13 criteria hold\n");
  } else expect(lines.slice(-2)).toEqual(paths());
  if (code === 2)
    expect(lines.at(-3)).toMatch(
      /^shud:sensitivity: INCONCLUSIVE: rerun; the model plan deviates: (PSET-4 LC_ROUGH×0\.5 is not in the fixed plan; fixed LC_ROUGH×2 is missing|end_days 60 \(fixed 90\))$/u,
    );
  else expect(result.stderr).not.toMatch(/INCONCLUSIVE/u);
  if (failing.includes(7))
    expect(lines[0]).toMatch(
      new RegExp(
        `^shud:sensitivity: criterion 7: repeat repeat-baseline rivqdown sha256 ${"e".repeat(64)} ` +
          `differs from in-batch baseline ${run(1)} [0-9a-f]{64}$`,
        "u",
      ),
    );
});

test("in process, evaluation starts no child process other than git", async () => {
  const result = await evaluate(f);
  expect(result.code).toBe(0);
  const commands = started();
  expect(commands.length).toBeGreaterThanOrEqual(3);
  for (const command of commands) expect(command).toMatch(/^execFile git$/u);
});

async function expectAliasAccepted(alias: string): Promise<void> {
  const result = await evaluate(f, [alias, ...f.argv.slice(1)]);
  expect(result.stderr).not.toMatch(/preparation record:/u);
  expect(result.code, result.stderr).toBe(0);
}

test("a workspace argument through a symlink alias matches the record and the plan input_dir", async () => {
  const link = join(dirname(f.h.root), "workspace-link");
  fs.symlinkSync(f.workspace, link, "dir");
  await expectAliasAccepted(link);
});

test.runIf(CASE_ALIASES)(
  "a case-alias workspace spelling is no input_dir deviation and matches the record",
  async () => {
    const alias = join(dirname(f.workspace), basename(f.workspace).toUpperCase());
    expect(loadSensitivityBatch(alias).outcome).toStrictEqual({ kind: "equivalent" });
    await expectAliasAccepted(alias);
  },
);
