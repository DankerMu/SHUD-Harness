import {
  AnalysisPlanSchema,
  CALIB_WHITELIST,
  type AnalysisPlan,
} from "@shud-harness/dsh-shud-core";
import { ShudInputError } from "./shud-input-file.ts";
import { readShudTextInput, type ShudInputReadResult, type ShudTable } from "./shud-text-input.ts";

type CalibKey = keyof typeof CALIB_WHITELIST;
type ProductRange = readonly [number, number] | "finite-positive";
type ProductStage = "input" | "calibration" | "product";
type ProductReason =
  "project" | "parameter_sets" | "parse" | "missing" | "duplicate" | "nonfinite" | "bounds";
type ProductDetails = {
  key?: CalibKey;
  keys?: readonly CalibKey[];
  line?: number;
  row_index?: number;
  product?: number;
  range?: ProductRange;
};

/** Controlled diagnostics contain registered keys and numeric facts, never source tokens or causes. */
export class CalibProductError extends Error {
  readonly key?: CalibKey;
  readonly keys?: readonly CalibKey[];
  /** One-based physical calibration line, including skipped lines; distinct from row_index. */
  readonly line?: number;
  readonly row_index?: number;
  readonly product?: number;
  readonly range?: ProductRange;

  constructor(
    readonly stage: ProductStage,
    readonly path: string,
    readonly reason: ProductReason,
    details: ProductDetails = {},
  ) {
    const keys = details.key ?? details.keys?.join(", ");
    const line = details.line === undefined ? "" : `; line ${details.line}`;
    const product =
      details.row_index === undefined
        ? ""
        : `; row ${details.row_index}; product ${details.product}; range ${
            typeof details.range === "string" ? details.range : `[${details.range?.join(", ")}]`
          }`;
    super(
      `Calibration ${stage}: ${path}: ${reason}${keys === undefined ? "" : `; ${keys}`}${line}${product}`,
    );
    this.name = "CalibProductError";
    Object.assign(this, details);
  }
}

function category(inputDir: string, project: string, template: string) {
  const path = template.replace("<project>", () => project);
  const kind = template.slice("<project>.".length);
  switch (kind) {
    case "para.geol":
    case "para.lc":
      return readShudTextInput(inputDir, path, kind);
    case "sp.riv": {
      const observed = readShudTextInput(inputDir, path, kind);
      return { ...observed, data: observed.data.types };
    }
    default:
      throw new ShudInputError("parse", path, "unsupported registered category");
  }
}

/**
 * Read-only product validation before plan creation; returns exactly the same-read input hashes.
 * Core field schemas validate runtime project/parameter-set shapes, keys and multipliers using
 * CALIB_MULTIPLIER_RANGE; full plan refinements remain AnalysisPlanSchema's creation boundary.
 * Each distinct file is read once through the canonical safe SHUD parser/hash reader. Every
 * perturbation uses registered read_transform(x), then baseline, then multiplier, in that order.
 * Product diagnostics use a zero-based row_index within the selected category table, not its
 * INDEX/Index cell or physical line. range is the core inclusive interval or "finite-positive"
 * for river roughness, which has no finite upper bound. Calibration parse failures name all
 * requested registered keys as context, without claiming which unparsed source token failed.
 * File failures retain controlled ShudInputError diagnostics. No files or directories are written.
 */
export function checkCalibProducts(
  inputDir: string,
  project: string,
  parameterSets: AnalysisPlan["parameter_sets"],
): AnalysisPlan["input_digests"] {
  if (!AnalysisPlanSchema.shape.project.safeParse(project).success) {
    throw new CalibProductError("input", "<input>", "project");
  }
  const parsed = AnalysisPlanSchema.shape.parameter_sets.safeParse(parameterSets);
  if (!parsed.success) throw new CalibProductError("input", "<input>", "parameter_sets");
  const requested = new Set<CalibKey>();
  for (const set of parsed.data) {
    for (const key of Object.keys(set.changes)) requested.add(key as CalibKey);
  }
  const keys = [...requested];
  const calibPath = `${project}.cfg.calib`;
  let calib: ShudInputReadResult<"cfg.calib">;
  try {
    calib = readShudTextInput(inputDir, calibPath, "cfg.calib");
  } catch (error) {
    if (error instanceof ShudInputError && error.stage === "parse") {
      throw new CalibProductError("calibration", calibPath, "parse", { keys, line: error.line });
    }
    throw error;
  }
  const baselines = new Map<CalibKey, number>();
  for (const key of keys) {
    const entries = calib.data.filter((entry) => entry.key === key);
    if (entries.length !== 1) {
      throw new CalibProductError(
        "calibration",
        calibPath,
        entries.length === 0 ? "missing" : "duplicate",
        { key },
      );
    }
    const baseline = entries[0].value;
    if (!Number.isFinite(baseline)) {
      throw new CalibProductError("calibration", calibPath, "nonfinite", { key });
    }
    baselines.set(key, baseline);
  }
  const digests: AnalysisPlan["input_digests"] = { [calib.path]: calib.sha256 };
  const tables = new Map<string, ShudTable>();
  for (const set of parsed.data) {
    for (const [rawKey, multiplier] of Object.entries(set.changes)) {
      const key = rawKey as CalibKey;
      const entry = CALIB_WHITELIST[key];
      const path = entry.table.replace("<project>", () => project);
      let table = tables.get(path);
      if (table === undefined) {
        const observed = category(inputDir, project, entry.table);
        table = observed.data;
        tables.set(path, table);
        digests[observed.path] = observed.sha256;
      }
      const column = table.columns.indexOf(entry.column);
      if (column < 0) {
        throw new ShudInputError("parse", path, "missing registered column", {
          column: entry.column,
        });
      }
      const baseline = baselines.get(key)!;
      for (const [row_index, row] of table.rows.entries()) {
        const product = (row[column] / entry.read_transform.divisor) * baseline * multiplier;
        const range = entry.check_range;
        if (
          !Number.isFinite(product) ||
          (range === null ? product <= 0 : product < range[0] || product > range[1])
        ) {
          throw new CalibProductError("product", path, "bounds", {
            key,
            row_index,
            product,
            range: range ?? "finite-positive",
          });
        }
      }
    }
  }
  return digests;
}
