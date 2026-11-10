import * as fs from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { RunIdSchema } from "../../packages/dsh-shud-core/src/schemas/index.ts";
import { requireFact, text } from "./shud-restart-evidence.ts";
import { collectReplayLogs, discoverOwnedSessions } from "./shud-replay-snapshot.ts";
import type { StoredLog } from "./shud-session-log.ts";
import {
  SensitivityPreparationRecordSchema,
  type SensitivityPreparationRecord,
} from "./shud-sensitivity-prepare.ts";
import { governanceCriteria } from "./shud-sensitivity-criteria-governance.ts";
import {
  loadSensitivityBatch,
  message,
  schemaParse,
  workspaceCriteria,
  type PlanOutcome,
} from "./shud-sensitivity-criteria-workspace.ts";
import { canonicalLog, load } from "./shud-web-driver.ts";

export type { PlanOutcome } from "./shud-sensitivity-criteria-workspace.ts";

const ROOT = fs.realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
const SHA256 = z.string().regex(/^[0-9a-f]{64}$/u);

/**
 * Batch-external baseline repeat result (written by the 7.1c driver). Thread variables keep the
 * raw environment strings so `"01"` stays visible; a solver killed by a signal has a null exit
 * code and a missing rivqdown output a null digest, which criterion 7 then rejects.
 */
export const SensitivityRepeatRecordSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("executed"),
    exit_code: z.number().int().nullable(),
    input_sha256: z.record(z.string().min(1), SHA256),
    omp_num_threads: z.string(),
    shud_rhs_threads: z.string(),
    rivqdown_sha256: SHA256.nullable(),
    run_id: z.string().min(1),
    baseline_run_id: RunIdSchema,
  }),
  z.strictObject({ status: z.literal("not_executed"), reason: z.string().min(1) }),
]);
type SensitivityRepeatRecord = z.infer<typeof SensitivityRepeatRecordSchema>;

/** The four evaluator inputs after validation; nothing here is model text. */
export interface SensitivityEvaluationInput {
  /** Physical workspace directory. */
  workspace: string;
  sessionLog: string;
  /** Root coordinator log first, then every catalogued or discovered owned child. */
  logs: StoredLog[];
  preparation: SensitivityPreparationRecord;
  repeat: SensitivityRepeatRecord;
  /** Harness root holding SHUD/input/ccw, the three submodules and data/raw. */
  root: string;
}

export interface CriterionResult {
  criterion: number;
  ok: boolean;
  evidence: string[];
}

const NAMES = ["workspace", "session log", "preparation record", "repeat-run record"] as const;

async function named<T>(name: string, read: () => T | Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw new Error(`${name}: ${message(error)}`, { cause: error });
  }
}

function physicalWorkspace(path: string): string {
  const workspace = fs.realpathSync(resolve(path));
  requireFact(fs.statSync(workspace).isDirectory(), `not a directory: ${path}`);
  fs.readdirSync(workspace);
  return workspace;
}

/**
 * Scope is the given root log (it must be the canonical generation for its id) plus children
 * found through `subagent/catalog`, unioned with owned children found on disk, without a host.
 */
async function sessionScope(path: string): Promise<StoredLog[]> {
  const given = resolve(path);
  const directory = dirname(given);
  const sessions = dirname(dirname(directory));
  requireFact(
    /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/u.test(basename(given)) &&
      basename(sessions) === "sessions",
    `not of the canonical <home>/sessions/<dir>/<id>/session.v4.jsonl.zstd shape: ${path}`,
  );
  const home = fs.realpathSync(dirname(sessions));
  const id = basename(directory);
  const canonical = canonicalLog(home, id);
  requireFact(
    fs.realpathSync(canonical) === fs.realpathSync(given),
    `canonical log is ${canonical}, not ${path}`,
  );
  const { root, children } = await collectReplayLogs(home, id);
  const scope = new Map([root, ...children].map((log) => [text(log.header.id), log]));
  for (const child of discoverOwnedSessions(home, id))
    if (!scope.has(text(child.header.id))) scope.set(text(child.header.id), child);
  return [...scope.values()];
}

async function loadInputs(argv: string[], root: string): Promise<SensitivityEvaluationInput> {
  requireFact(
    argv.length <= 4,
    "usage: shud-sensitivity-evaluate.ts " + NAMES.map((n) => `<${n}>`).join(" "),
  );
  NAMES.forEach((name, index) => requireFact(argv[index]?.trim(), `Missing ${name} argument`));
  const workspace = await named(NAMES[0], () => physicalWorkspace(argv[0]));
  const logs = await named(NAMES[1], () => sessionScope(argv[1]));
  const preparation = await named(NAMES[2], () => {
    const record = schemaParse(SensitivityPreparationRecordSchema, load(resolve(argv[2])));
    requireFact(
      record.workspace === workspace,
      `workspace ${record.workspace} is not ${workspace}`,
    );
    return record;
  });
  const repeat = await named(NAMES[3], () =>
    schemaParse(SensitivityRepeatRecordSchema, load(resolve(argv[3]))),
  );
  return {
    workspace,
    sessionLog: resolve(argv[1]),
    logs,
    preparation,
    repeat,
    root: fs.realpathSync(root),
  };
}

/** Criteria 4-7 and 13 belong to the second #670 slice. */
const LATER = new Set([4, 5, 6, 7, 13]);

async function evaluateSensitivityCriteria(input: SensitivityEvaluationInput) {
  const batch = loadSensitivityBatch(input.workspace);
  const checks = new Map([...workspaceCriteria(input, batch), ...governanceCriteria(input, batch)]);
  const results: CriterionResult[] = [];
  for (let criterion = 1; criterion <= 13; criterion++) {
    if (LATER.has(criterion)) {
      results.push({ criterion, ok: false, evidence: ["implemented in 7.1b-2"] });
      continue;
    }
    try {
      const check = checks.get(criterion);
      requireFact(check, `criterion ${criterion} has no check`);
      const evidence = await check();
      results.push({ criterion, ok: evidence.length === 0, evidence });
    } catch (error) {
      results.push({ criterion, ok: false, evidence: [message(error)] });
    }
  }
  return { results, plan: batch.outcome };
}

/**
 * 0 when all 13 hold; 2 (INCONCLUSIVE) only when criterion 1 failed solely because the one
 * linked plan deviates from the fixed plan and every criterion other than 1 and 13 holds; else 1.
 */
export function classifySensitivityExit(
  results: readonly CriterionResult[],
  plan: PlanOutcome,
): 0 | 1 | 2 {
  requireFact(
    results.length === 13 && results.every((result, index) => result.criterion === index + 1),
    "Exit classification needs the fixed 13-entry criterion array",
  );
  if (results.every((result) => result.ok)) return 0;
  const deviationOnly =
    plan.kind === "non_equivalent" &&
    !results[0].ok &&
    results.every((result) => result.ok || result.criterion === 1 || result.criterion === 13);
  return deviationOnly ? 2 : 1;
}

/** `<workspace> <session-log> <preparation-record> <repeat-record>` → exit 0/1/2 (stderr names each failure). */
export async function runSensitivityEvaluateCli(
  argv: string[],
  options: { root?: string } = {},
): Promise<number> {
  const say = (line: string) => process.stderr.write(`shud:sensitivity: ${line}\n`);
  const paths = (workspace = argv[0], log = argv[1]) => {
    if (workspace) say(`workspace ${resolve(workspace)}`);
    if (log) say(`session log ${resolve(log)}`);
  };
  let input: SensitivityEvaluationInput;
  try {
    input = await loadInputs(argv, options.root ?? ROOT);
  } catch (error) {
    say(message(error));
    paths();
    return 1;
  }
  const { results, plan } = await evaluateSensitivityCriteria(input);
  const code = classifySensitivityExit(results, plan);
  for (const result of results)
    if (!result.ok) say(`criterion ${result.criterion}: ${result.evidence.join("; ")}`);
  if (code === 0) {
    process.stdout.write("shud:sensitivity: all 13 criteria hold\n");
    return 0;
  }
  if (code === 2 && plan.kind === "non_equivalent")
    say(`INCONCLUSIVE: rerun; the model plan deviates: ${plan.deviations.join("; ")}`);
  paths(input.workspace, input.sessionLog);
  return code;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runSensitivityEvaluateCli(process.argv.slice(2));
}
