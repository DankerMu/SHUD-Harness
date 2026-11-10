import * as fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnalysisPlan } from "../../../packages/dsh-shud-core/src/schemas/index.ts";
import {
  SUBMISSION_OUTPUT_INTERVAL,
  applyCalibMultiplier,
  ensureOutputInterval,
  updateEnd,
} from "../../../packages/dsh-shud-jobs/src/shud-cfg-rewrite.ts";
import {
  computeRunMetrics,
  serializeRunMetrics,
} from "../../../packages/dsh-shud-records/src/index.ts";
import { sections } from "../../../packages/dsh-shud-records/src/shud-text-test-harness.ts";
import {
  makeClosedBudgetRun,
  waterBalanceFixture,
  waterBalanceProject,
} from "../../../packages/dsh-shud-records/src/water-balance-test-harness.ts";

/** The pinned ccw source (read-only); CI's test job initialises the SHUD submodule. */
const CCW = fileURLToPath(new URL("../../../SHUD/input/ccw/", import.meta.url));

/**
 * ccw-named source for `computeRunMetrics`: the wb-mini mesh/attributes/rivers/IC/geology
 * (matching the closed-budget outputs), a small land-cover table, and the real ccw cfg.para and
 * cfg.calib bytes (`END 1827`, `NUM_OPENMP 8`, no `DT_YE_IC`, `LC_IMPAF`, `RIV_BSLOPE+`).
 */
export function writeCcwSource(source: string, calib: (text: string) => string): void {
  for (const kind of ["cfg.ic", "para.geol", "sp.att", "sp.mesh", "sp.riv"])
    fs.copyFileSync(
      join(waterBalanceFixture, `input/${waterBalanceProject}/${waterBalanceProject}.${kind}`),
      join(source, `ccw.${kind}`),
    );
  fs.writeFileSync(join(source, "ccw.para.lc"), sections.lc);
  fs.copyFileSync(join(CCW, "ccw.cfg.para"), join(source, "ccw.cfg.para"));
  const text = fs.readFileSync(join(CCW, "ccw.cfg.calib")).toString("latin1");
  fs.writeFileSync(join(source, "ccw.cfg.calib"), Buffer.from(calib(text), "latin1"));
}

/** C `printf("%g")`: six significant digits, exponent form below 1e-4 or from 1e6. */
function printfG(value: number): string {
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  const [mantissa, exponent] = value.toExponential(5).split("e");
  const power = Number(exponent);
  const trim = (digits: string) => (digits.includes(".") ? digits.replace(/\.?0+$/u, "") : digits);
  if (power < -4 || power >= 6)
    return `${trim(mantissa)}e${power < 0 ? "-" : "+"}${String(Math.abs(power)).padStart(2, "0")}`;
  return trim(value.toFixed(5 - power));
}

/** `globalCal::write` order and spelling (SHUD/src/classes/ModelConfigure.cpp:376-440). */
const BAK_LAYOUT = [
  "#Geology Layers",
  ...["KSATH", "KSATV", "KMACSATH", "DMAC", "THETAS", "THETAR", "MACVF"].map((k) => `GEOL_${k}`),
  "#Soil Layers",
  ...["KINF", "KMACSATV", "DINF", "ALPHA", "BETA", "MACHF", "DINF"].map((k) => `SOIL_${k}`),
  "#Land use",
  ...["VEGFRAC", "ALBEDO", "ROUGH", "ISMAX", "DROOT", "SoilDgd", "ImpAF"].map((k) => `LC_${k}`),
  "#River stucture",
  ...["ROUGH", "KH", "DPTH+", "WDTH+", "SINU", "CWR", "BEDTHICK"].map((k) => `RIV_${k}`),
  "#Misc",
  ...["AQ_DEPTH+", "TS_PRCP", "TS_SFCTMP+", "TS_LAI", "TS_MF", "ET_ETP", "ET_IC", "ET_TR"],
  "ET_SOIL",
  "#Frozen",
  ...["submax", "submin", "subday", "surfmax", "surfmin", "surfday"].map((k) => `Fzn_${k}`),
  "#Intial Condition",
  "IC_GW+",
  "IC_RIV+",
];

/**
 * What SHUD writes to `ccw.cfg.calib.bak` after reading `calib`: first-byte skip and
 * `sscanf("%s %lf")` per line, case-insensitive keys with the last line winning, unread keys
 * at 0. `SOIL_DINF` appears twice, `LC_SoilDgd`/`LC_ImpAF` keep mixed case, `RIV_BSLOPE+` is not
 * written.
 */
function shudCalibBak(calib: Buffer): string {
  const values = new Map<string, number>();
  for (const line of calib.toString("latin1").split("\n")) {
    if (line === "" || "# \0".includes(line[0])) continue;
    const [key, value] = line.trim().split(/[\t\v\f\r ]+/u);
    values.set(key.toUpperCase(), Number.parseFloat(value));
  }
  return BAK_LAYOUT.map((key) =>
    key.startsWith("#") ? `${key}\n` : `${key}\t${printfG(values.get(key.toUpperCase()) ?? 0)}\n`,
  ).join("");
}

/** One SHUD output set per fixture, from the records closed-budget writer. */
export function closedBudgetOutputs(directory: string): string {
  makeClosedBudgetRun(directory);
  return join(directory, `output/${waterBalanceProject}.out`);
}

/**
 * A run directory as the registry and SHUD leave it: the input copy rewritten by the registry's
 * own path transforms (END, DT_YE_IC, NUM_OPENMP, calib multiplier), SHUD outputs including the
 * calib `.bak`, empty logs, and the collector's metrics bytes and health.
 */
export async function writeRunDirectory(
  runDir: string,
  input: string,
  plan: AnalysisPlan,
  set: AnalysisPlan["parameter_sets"][number],
  outputs: string,
) {
  const copy = join(runDir, "input/ccw");
  fs.cpSync(input, copy, { recursive: true });
  const parameters = join(copy, "ccw.cfg.para");
  await updateEnd(parameters, plan.end_days);
  const { key, minutes } = SUBMISSION_OUTPUT_INTERVAL;
  await ensureOutputInterval(parameters, key, minutes);
  await ensureOutputInterval(parameters, "NUM_OPENMP", plan.threads);
  for (const [name, multiplier] of Object.entries(set.changes))
    await applyCalibMultiplier(join(copy, "ccw.cfg.calib"), name, multiplier);
  const output = join(runDir, "output/ccw.out");
  fs.mkdirSync(output, { recursive: true });
  for (const name of fs.readdirSync(outputs))
    fs.copyFileSync(join(outputs, name), join(output, name.replace(waterBalanceProject, "ccw")));
  fs.writeFileSync(
    join(output, "ccw.cfg.calib.bak"),
    shudCalibBak(fs.readFileSync(join(copy, "ccw.cfg.calib"))),
  );
  for (const log of ["stdout.log", "stderr.log"]) fs.writeFileSync(join(runDir, log), "");
  const { metrics, health } = computeRunMetrics(runDir, "ccw");
  return { metrics: serializeRunMetrics(metrics), health };
}
