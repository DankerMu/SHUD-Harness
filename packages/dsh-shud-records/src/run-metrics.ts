import {
  classifyNumericalHealth,
  isProjectComponent,
  METRICS_METHOD_VERSION,
} from "@shud-harness/dsh-shud-core";
import { readShudDat, type ShudDat } from "./shud-dat.ts";
import { readShudInputFile, ShudInputError } from "./shud-input-file.ts";
import { readShudTextInput, type ShudInputDataMap, type ShudInputKind } from "./shud-text-input.ts";
import {
  catchmentGeometry,
  elementPorosity,
  elementStorage,
  fluxDepth,
  riverStorage,
  storageDeltas,
} from "./run-metrics-water-balance.ts";
import {
  compareMetricPaths,
  FLOW_FIELDS,
  HEALTH_FIELDS,
  MAX_SOLVER_DT_REASON,
  NEGATIVE_STATE_NOTE,
  nullMetricBlock,
  WATER_FIELDS,
  type MetricsInput,
  type RunMetrics,
  type RunMetricsHealth,
} from "./run-metrics-wire.ts";

// Pinned producer tolerance, SHUD_Output_Variables.md §11; not a verdict threshold.
const NEGATIVE_STATE_TOLERANCE = -1e-10;
const STATE_VARIABLES = ["eleygw", "eleysurf", "eleyunsat", "rivystage"] as const;
const SOLVER_SIGNATURE = Buffer.from("SUNDIALS_ERROR:", "ascii");
const PENDING_WATER = "pending_water_balance";

interface ComputedRunMetrics {
  metrics: RunMetrics;
  health: RunMetricsHealth;
}

/** A result, not a thrown/native error: partial successful evidence remains inspectable. */
class MetricsUnavailable implements ComputedRunMetrics {
  readonly kind = "MetricsUnavailable";
  constructor(
    readonly reason: string,
    readonly metrics: RunMetrics,
    readonly health: RunMetricsHealth,
  ) {}
}

function initialMetrics(): RunMetrics {
  return {
    method_version: METRICS_METHOD_VERSION,
    status: "ok",
    reason: null,
    inputs: [],
    nonfinite_count: 0,
    outlets: [],
    flow: nullMetricBlock(FLOW_FIELDS, "empty_variable:rivqdown"),
    water_balance: {
      formula_source: "rSHUD wb.all / wb.DS; SHUD snow/interception extension",
      ...nullMetricBlock(WATER_FIELDS, PENDING_WATER),
      approximation: "Final output interval average, not instantaneous final state",
    },
    numerical_health: {
      ...nullMetricBlock(HEALTH_FIELDS, PENDING_WATER),
      negative_state_count_note: NEGATIVE_STATE_NOTE,
    },
    verdicts: {
      water_balance_residual: "not_available",
      cvode_failures: "not_available",
      negative_state_count: "not_available",
    },
  };
}

function intervalDays(dat: ShudDat): number | null {
  if (dat.rows.length < 2) return null;
  const first = dat.rows[0].t_min;
  const second = dat.rows[1].t_min;
  const difference = second - first;
  if (!Number.isFinite(first) || !Number.isFinite(second) || !Number.isFinite(difference))
    return null;
  for (let i = 2; i < dat.rows.length; i += 1) {
    const time = dat.rows[i].t_min;
    if (!Number.isFinite(time) || time - dat.rows[i - 1].t_min !== difference) return null;
  }
  return difference / 1440;
}

/** Null means unusable outlet identity, not a legitimate item-level null metric. */
function flowMetrics(dat: ShudDat, outlets: readonly number[]): RunMetrics["flow"] | null {
  const positions = new Map<number, number>();
  for (const outlet of outlets) positions.set(outlet, -1);
  for (let i = 0; i < dat.columns.length; i += 1) {
    const id = dat.columns[i];
    const previous = positions.get(id);
    if (previous === undefined) continue;
    if (previous !== -1) return null;
    positions.set(id, i);
  }
  const indices = [...positions.values()];
  if (indices.includes(-1)) return null;
  if (dat.rows.length === 0) return nullMetricBlock(FLOW_FIELDS, "empty_variable:rivqdown");
  const interval = intervalDays(dat);
  let peak = -Infinity;
  let peakTime = Infinity;
  let peakTimeFinite = false;
  let runoff = 0;
  for (const row of dat.rows) {
    let q = 0;
    for (const index of indices) q += row.values[index];
    if (!Number.isFinite(q)) return nullMetricBlock(FLOW_FIELDS, "nonfinite:rivqdown");
    if (q > peak) {
      peak = q;
      peakTime = row.t_min;
      peakTimeFinite = Number.isFinite(row.t_min);
    } else if (q === peak) {
      peakTimeFinite = peakTimeFinite && Number.isFinite(row.t_min);
      if (peakTimeFinite) peakTime = Math.min(peakTime, row.t_min);
    }
    if (interval !== null) runoff += q * interval;
  }
  return {
    peak_flow_m3d: peak,
    peak_day: peakTimeFinite ? peakTime / 1440 : null,
    total_runoff_m3: interval !== null && Number.isFinite(runoff) ? runoff : null,
    reasons: {
      peak_flow_m3d: null,
      peak_day: peakTimeFinite ? null : "nonfinite:rivqdown",
      total_runoff_m3:
        interval === null
          ? "interval_undetermined:rivqdown"
          : Number.isFinite(runoff)
            ? null
            : "nonfinite:rivqdown",
    },
  };
}

function countSolverFailures(bytes: Buffer): number {
  let count = 0;
  for (let start = 0; start < bytes.length;) {
    let matched = 0;
    while (
      matched < SOLVER_SIGNATURE.length &&
      bytes[start + matched] === SOLVER_SIGNATURE[matched]
    ) {
      matched += 1;
    }
    if (matched === SOLVER_SIGNATURE.length) count += 1;
    const newline = bytes.indexOf(10, start);
    if (newline === -1) break;
    start = newline + 1;
  }
  return count;
}

/**
 * Internal shared-water-balance producer. Never exported from the package root or
 * called by collect in this slice; residual and persistence remain deferred.
 * The run root remains the safety base even for nested input/output observations.
 */
export function computeRunMetrics(
  runDir: string,
  project: string,
): ComputedRunMetrics | MetricsUnavailable {
  const metrics = initialMetrics();
  let currentPath = "<project>";
  const observe = (input: MetricsInput) => {
    metrics.inputs.push({ path: input.path, sha256: input.sha256, size_bytes: input.size_bytes });
  };
  const finish = (): ComputedRunMetrics => {
    // Structural unobservability survives both successful and unavailable finalization.
    metrics.numerical_health.max_solver_dt = null;
    metrics.numerical_health.reasons.max_solver_dt = MAX_SOLVER_DT_REASON;
    metrics.inputs.sort((left, right) => compareMetricPaths(left.path, right.path));
    const health: RunMetricsHealth = {
      water_balance_residual: metrics.numerical_health.water_balance_residual,
      cvode_failures: metrics.numerical_health.cvode_failures,
      negative_state_count: metrics.numerical_health.negative_state_count,
      max_solver_dt: metrics.numerical_health.max_solver_dt,
    };
    metrics.verdicts = {
      water_balance_residual: classifyNumericalHealth(
        "water_balance_residual",
        health.water_balance_residual,
      ),
      cvode_failures: classifyNumericalHealth("cvode_failures", health.cvode_failures),
      negative_state_count: classifyNumericalHealth(
        "negative_state_count",
        health.negative_state_count,
      ),
    };
    return { metrics, health };
  };
  const unavailable = (reason: string): MetricsUnavailable => {
    metrics.status = "unavailable";
    metrics.reason = reason;
    metrics.flow = nullMetricBlock(FLOW_FIELDS, reason);
    metrics.water_balance = {
      formula_source: metrics.water_balance.formula_source,
      ...nullMetricBlock(WATER_FIELDS, reason),
      approximation: metrics.water_balance.approximation,
    };
    metrics.numerical_health = {
      ...nullMetricBlock(HEALTH_FIELDS, reason),
      negative_state_count_note: NEGATIVE_STATE_NOTE,
    };
    const result = finish();
    return new MetricsUnavailable(reason, metrics, result.health);
  };
  const readDat = (variable: string): ShudDat => {
    currentPath = `output/${project}.out/${project}.${variable}.dat`;
    const dat = readShudDat(runDir, currentPath);
    observe(dat);
    metrics.nonfinite_count += dat.nonfinite_count;
    return dat;
  };
  const readText = <K extends ShudInputKind>(kind: K): ShudInputDataMap[K] => {
    currentPath = `input/${project}/${project}.${kind}`;
    const input = readShudTextInput(runDir, currentPath, kind);
    observe(input);
    return input.data;
  };
  const readOptional = <T>(read: () => T): T | null => {
    try {
      return read();
    } catch (error) {
      if (error instanceof ShudInputError && error.stage === "missing") return null;
      throw error;
    }
  };
  const setWater = (
    field: "P" | "Qd" | "AET" | "delta_s_surf" | "delta_s_us" | "delta_s_gw" | "delta_s_riv",
    value: number | null,
  ) => {
    if (value !== null && Number.isFinite(value)) {
      metrics.water_balance[field] = value;
      metrics.water_balance.reasons[field] = null;
    }
  };
  try {
    if (typeof project !== "string" || !isProjectComponent(project)) {
      return unavailable("invalid_project");
    }
    currentPath = `input/${project}/${project}.sp.riv`;
    const river = readShudTextInput(runDir, currentPath, "sp.riv");
    observe(river);
    const mesh = readText("sp.mesh");
    const ic = readText("cfg.ic");
    readText("cfg.para");
    const geometry = catchmentGeometry(mesh);
    const indexColumn = river.data.reaches.columns.indexOf("Index");
    const downColumn = river.data.reaches.columns.indexOf("Down");
    const outlets = new Set<number>();
    for (const row of river.data.reaches.rows) {
      if (!(row[downColumn] < 0)) continue;
      const id = row[indexColumn];
      if (!Number.isInteger(id) || outlets.has(id))
        return unavailable(`invalid_outlets:${river.path}`);
      outlets.add(id);
    }
    metrics.outlets = [...outlets].sort((left, right) => left - right);
    if (outlets.size === 0) return unavailable(`empty_outlets:${river.path}`);
    // Release the runoff buffer before processing independent state files.
    {
      const dat = readDat("rivqdown");
      const flow = flowMetrics(dat, metrics.outlets);
      if (flow === null) return unavailable(`invalid_outlet_columns:${currentPath}`);
      metrics.flow = flow;
    }
    const deltas: Record<(typeof STATE_VARIABLES)[number], number[] | null> = {
      eleygw: null,
      eleysurf: null,
      eleyunsat: null,
      rivystage: null,
    };
    const initialColumns = {
      eleygw: "GW",
      eleysurf: "Surface",
      eleyunsat: "Unsat",
      rivystage: "Stage",
    } as const;

    let negativeCount = 0;
    let missing: string | null = null;
    let nonfinite: string | null = null;
    for (const variable of STATE_VARIABLES) {
      try {
        const dat = readDat(variable);
        const initial = variable === "rivystage" ? ic.rivers : ic.elements;
        const count =
          variable === "rivystage" ? river.data.reaches.rows.length : mesh.elements.rows.length;
        if (initial.rows.length === count) {
          deltas[variable] = storageDeltas(dat, initial, initialColumns[variable]);
        }
        if (dat.nonfinite_count > 0) {
          nonfinite ??= variable;
        } else {
          for (const row of dat.rows) {
            for (const value of row.values) {
              if (value < NEGATIVE_STATE_TOLERANCE) negativeCount += 1;
            }
          }
        }
      } catch (error) {
        if (error instanceof ShudInputError && error.stage === "missing") {
          missing ??= variable;
        } else throw error;
      }
    }
    const negativeReason =
      missing !== null
        ? `missing_variable:${missing}`
        : nonfinite !== null
          ? `nonfinite:${nonfinite}`
          : null;
    metrics.numerical_health.negative_state_count = negativeReason === null ? negativeCount : null;
    metrics.numerical_health.reasons.negative_state_count = negativeReason;
    currentPath = "stderr.log";
    try {
      const log = readShudInputFile(runDir, currentPath);
      observe(log);
      metrics.numerical_health.cvode_failures = countSolverFailures(log.bytes);
      metrics.numerical_health.reasons.cvode_failures = null;
    } catch (error) {
      metrics.numerical_health.cvode_failures = null;
      metrics.numerical_health.reasons.cvode_failures =
        error instanceof ShudInputError ? `${error.stage}:stderr.log` : "read:stderr.log";
    }
    // Absence leaves only dependent terms pending; later present inputs must still
    // pass the same safe readers. Existing core/state failure precedence is unchanged.
    const att = readOptional(() => readText("sp.att"));
    const geol = readOptional(() => readText("para.geol"));
    const calib = readOptional(() => readText("cfg.calib"));
    if (geometry !== null) {
      const { area, weights } = geometry;
      if (metrics.flow.total_runoff_m3 !== null) {
        setWater("Qd", metrics.flow.total_runoff_m3 / area);
      }
      setWater("delta_s_surf", elementStorage(deltas.eleysurf, weights));
      setWater("delta_s_riv", riverStorage(deltas.rivystage, river.data, area));
      if (att !== null && geol !== null && calib !== null) {
        const porosity = elementPorosity(att, geol, calib, weights.length);
        if (porosity !== null) {
          setWater("delta_s_us", elementStorage(deltas.eleyunsat, weights, porosity));
          setWater("delta_s_gw", elementStorage(deltas.eleygw, weights, porosity));
        }
      }
    }
    for (const [variable, field] of [
      ["elevprcp", "P"],
      ["eleveta", "AET"],
    ] as const) {
      const dat = readOptional(() => readDat(variable));
      if (dat !== null && geometry !== null) {
        setWater(field, fluxDepth(dat, geometry.weights, intervalDays(dat)));
      }
    }
    return finish();
  } catch (error) {
    const reason =
      error instanceof ShudInputError
        ? error.stage === "missing" &&
          error.path === `output/${project}.out/${project}.rivqdown.dat`
          ? "missing_variable:rivqdown"
          : `${error.stage}:${error.path}`
        : `read:${currentPath}`;
    return unavailable(reason);
  }
}
