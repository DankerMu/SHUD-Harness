import { readShudInputFile, ShudInputError, shudInputPath } from "./shud-input-file.ts";
import { shudTextNumber } from "./shud-text-number.ts";

export type ShudInputKind =
  "sp.mesh" | "sp.att" | "sp.riv" | "para.geol" | "para.lc" | "cfg.para" | "cfg.calib" | "cfg.ic";

export interface ShudTable {
  columns: string[];
  rows: number[][];
}

export interface ShudConfigEntry {
  key: string;
  value: number;
  /** One-based physical source line, including skipped lines. */
  line: number;
}

export interface ShudInputDataMap {
  "sp.mesh": { elements: ShudTable; nodes: ShudTable };
  "sp.att": ShudTable;
  "sp.riv": { reaches: ShudTable; types: ShudTable; geometry: ShudTable | null };
  "para.geol": ShudTable;
  "para.lc": ShudTable;
  "cfg.para": ShudConfigEntry[];
  "cfg.calib": ShudConfigEntry[];
  "cfg.ic": {
    elements: ShudTable;
    rivers: ShudTable;
    lakes: ShudTable | null;
    time_min: number | null;
  };
}

export interface ShudInputReadResult<K extends ShudInputKind> {
  /** Normalized relative POSIX path, never the resolved absolute base. */
  path: string;
  sha256: string;
  size_bytes: number;
  data: ShudInputDataMap[K];
}

const INPUT_KINDS: readonly ShudInputKind[] = [
  "sp.mesh",
  "sp.att",
  "sp.riv",
  "para.geol",
  "para.lc",
  "cfg.para",
  "cfg.calib",
  "cfg.ic",
];

/** Keep kind rejection ahead of path validation for both text entry points. */
function checkInputKind(relativePath: string, kind: ShudInputKind): void {
  const diagnosticPath = typeof relativePath === "string" ? relativePath : "<invalid path>";
  if (!INPUT_KINDS.includes(kind)) {
    throw new ShudInputError("parse", diagnosticPath, "unsupported file kind");
  }
}

export function readShudTextInput<K extends ShudInputKind>(
  baseDir: string,
  relativePath: string,
  kind: K,
): ShudInputReadResult<K> {
  checkInputKind(relativePath, kind);
  const observed = readShudInputFile(baseDir, relativePath);
  const { path } = observed;
  // Parsing after successful closure cannot leak an owned descriptor on malformed input.
  const data = parseShudTextInput(observed.bytes, path, kind);
  return { path, sha256: observed.sha256, size_bytes: observed.size_bytes, data };
}

type TableSpec = {
  section: string;
  columns: readonly string[];
  required?: readonly string[];
  extraColumn?: boolean;
};

// Names and widths come from pinned ccw headers and SHUD TabularData readers.
// Only registered consumer columns are mandatory where historical unused names vary.
const TABLES = {
  meshElements: {
    section: "mesh elements",
    columns: ["ID", "Node1", "Node2", "Node3", "Nabr1", "Nabr2", "Nabr3", "Zmax"],
    required: ["ID", "Node1", "Node2", "Node3"],
  },
  nodes: {
    section: "mesh nodes",
    columns: ["ID", "X", "Y", "AqDepth", "Elevation"],
    required: ["ID", "X", "Y"],
  },
  att: {
    section: "element attributes",
    columns: ["INDEX", "SOIL", "GEOL", "LC", "FORC", "MF", "BC", "SS", "ilake"],
    required: ["INDEX", "GEOL"],
  },
  reaches: {
    section: "river reaches",
    columns: ["Index", "Down", "Type", "Slope", "Length", "BC"],
  },
  types: {
    section: "river types",
    columns: [
      "Index",
      "Depth",
      "BankSlope",
      "Width",
      "Sinuosity",
      "Manning",
      "Cwr",
      "KsatH",
      "BedThick",
    ],
    required: ["Index", "Width", "Manning"],
  },
  geometry: {
    section: "river geometry",
    columns: ["From.x", "From.y", "From.z", "To.x", "To.y", "To.z"],
  },
  geol: {
    section: "geology",
    columns: [
      "INDEX",
      "KsatH(m_d)",
      "KsatV(m_d)",
      "ThetaS(m3_m3)",
      "ThetaR(m3_m3)",
      "vAreaF(m2_m2)",
      "macKsatH(m_d)",
      "Dmac(m)",
    ],
    required: ["INDEX", "KsatH(m_d)", "KsatV(m_d)", "ThetaS(m3_m3)"],
  },
  lc: {
    section: "landcover",
    columns: ["INDEX", "ALBEDO", "VEGFRAC", "ROUGH", "RZD", "SOILDGRD", "IMPAF"],
    required: ["INDEX", "ROUGH", "VEGFRAC"],
    extraColumn: true,
  },
  icElements: {
    section: "initial element states",
    columns: ["Index", "Canopy", "Snow", "Surface", "Unsat", "GW"],
  },
  icRivers: { section: "initial river states", columns: ["Index", "Stage"] },
  lakes: { section: "initial lake states", columns: ["Index", "LakeStage"] },
} satisfies Record<string, TableSpec>;

function fields(line: string): string[] {
  const trimmed = line.replace(/\r$/, "").replace(/^[ \t]+|[ \t]+$/g, "");
  return trimmed.length === 0 ? [] : trimmed.split(/[ \t]+/);
}

class InputTables {
  private readonly lines: string[];
  private readonly path: string;
  private cursor = 0;
  time_min: number | null = null;

  constructor(lines: string[], path: string) {
    this.lines = lines;
    this.path = path;
  }

  private line(section: string): string[] {
    const value = this.lines[this.cursor];
    this.cursor += 1;
    if (value === undefined)
      throw new ShudInputError("parse", this.path, `missing ${section}`, { line: this.cursor });
    return fields(value);
  }

  read(spec: TableSpec, timeHeader = false): ShudTable {
    const dimensions = this.line(`${spec.section} dimensions`);
    // TabularData uses decimal integer dimensions; cell/time numeric syntax is broader.
    const rowCount = /^[+-]?\d+$/.test(dimensions[0] ?? "") ? Number(dimensions[0]) : undefined;
    const columnCount = /^[+-]?\d+$/.test(dimensions[1] ?? "") ? Number(dimensions[1]) : undefined;
    if (
      (dimensions.length !== 2 && !(timeHeader && dimensions.length === 3)) ||
      rowCount === undefined ||
      !Number.isSafeInteger(rowCount) ||
      rowCount < 0 ||
      columnCount === undefined ||
      !Number.isSafeInteger(columnCount) ||
      (columnCount !== spec.columns.length &&
        !(spec.extraColumn && columnCount === spec.columns.length + 1))
    ) {
      throw new ShudInputError("parse", this.path, `invalid ${spec.section} dimensions`, {
        line: this.cursor,
      });
    }
    if (dimensions.length === 3) {
      const time = shudTextNumber(dimensions[2]);
      if (time === undefined)
        throw new ShudInputError("parse", this.path, "invalid initial time", { line: this.cursor });
      this.time_min = time;
    }
    const columns = this.line(`${spec.section} columns`);
    if (columns.length !== columnCount) {
      throw new ShudInputError("parse", this.path, `${spec.section} header width mismatch`, {
        line: this.cursor,
      });
    }
    for (const column of spec.required ?? spec.columns) {
      if (!columns.includes(column)) {
        throw new ShudInputError("parse", this.path, `missing ${spec.section} column`, {
          column,
          line: this.cursor,
        });
      }
    }
    const names = new Set<string>();
    for (const [index, column] of columns.entries()) {
      if (names.has(column)) {
        throw new ShudInputError("parse", this.path, `duplicate ${spec.section} column`, {
          column: spec.columns.includes(column) ? column : `position ${index + 1}`,
          line: this.cursor,
        });
      }
      names.add(column);
    }
    const rows: number[][] = [];
    for (let row = 0; row < rowCount; row += 1) {
      const tokens = this.line(`${spec.section} row`);
      if (tokens.length !== columnCount) {
        throw new ShudInputError("parse", this.path, `${spec.section} row width mismatch`, {
          line: this.cursor,
        });
      }
      const values: number[] = [];
      for (const [index, token] of tokens.entries()) {
        const value = shudTextNumber(token);
        if (value === undefined) {
          const column = columns[index];
          throw new ShudInputError("parse", this.path, `invalid ${spec.section} number`, {
            column: spec.columns.includes(column) ? column : `position ${index + 1}`,
            line: this.cursor,
          });
        }
        values.push(value);
      }
      rows.push(values);
    }
    return { columns, rows };
  }

  hasMore(): boolean {
    for (let index = this.cursor; index < this.lines.length; index += 1) {
      if (!/^[ \t\r]*$/.test(this.lines[index])) return true;
    }
    return false;
  }

  finish(): void {
    if (this.hasMore())
      throw new ShudInputError("parse", this.path, "unexpected trailing table data", {
        line: this.cursor + 1,
      });
  }
}

function configEntries(lines: string[], path: string): ShudConfigEntry[] {
  const entries: ShudConfigEntry[] = [];
  for (const [index, line] of lines.entries()) {
    // Model_Control.cpp / ModelConfigure.cpp inspect the FIRST BYTE before sscanf.
    if (line.length === 0 || line[0] === "#" || line[0] === " " || line[0] === "\0") continue;
    const match = /^[ \t\r\v\f]*([^ \t\r\v\f]+)[ \t\r\v\f]+([^ \t\r\v\f]+)/.exec(line);
    const value = match === null ? undefined : shudTextNumber(match[2]);
    if (match === null || value === undefined) {
      throw new ShudInputError("parse", path, "invalid config value", {
        column: "value",
        line: index + 1,
      });
    }
    entries.push({ key: match[1].toUpperCase(), value, line: index + 1 });
  }
  return entries;
}

/**
 * Pure, byte-oriented SHUD text parsing. Tables retain original columns/row order;
 * config entries retain every effective line with uppercase keys and no allowlist or
 * duplicate merge. Complete numeric tokens preserve signed zero and NaN/Infinity.
 * Missing cells and malformed declarations are errors, rather than C's prefix parsing
 * or stale/uninitialized values. IC time, optional lake tables and writer-produced
 * river geometry are retained explicitly. Cross-file shapes and scientific validity
 * are consumer decisions; no factors, units, sorting or index rebasing are applied.
 */
export function parseShudTextInput<K extends ShudInputKind>(
  bytes: Uint8Array,
  relativePath: string,
  kind: K,
): ShudInputDataMap[K];
export function parseShudTextInput(
  bytes: Uint8Array,
  relativePath: string,
  kind: ShudInputKind,
): ShudInputDataMap[ShudInputKind] {
  checkInputKind(relativePath, kind);
  const path = shudInputPath(relativePath);
  if (!(bytes instanceof Uint8Array))
    throw new ShudInputError("parse", path, "expected input bytes");
  // Latin1 preserves byte-leading semantics and arbitrary comment bytes without UTF-8
  // validation or replacement; numeric syntax and table separators remain ASCII.
  const lines = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .toString("latin1")
    .split("\n");
  if (kind === "cfg.para" || kind === "cfg.calib") return configEntries(lines, path);
  const tables = new InputTables(lines, path);
  let data: ShudInputDataMap[Exclude<ShudInputKind, "cfg.para" | "cfg.calib">];
  switch (kind) {
    case "sp.mesh":
      data = { elements: tables.read(TABLES.meshElements), nodes: tables.read(TABLES.nodes) };
      break;
    case "sp.att":
      data = tables.read(TABLES.att);
      break;
    case "sp.riv":
      data = {
        reaches: tables.read(TABLES.reaches),
        types: tables.read(TABLES.types),
        geometry: tables.hasMore() ? tables.read(TABLES.geometry) : null,
      };
      break;
    case "para.geol":
      data = tables.read(TABLES.geol);
      break;
    case "para.lc":
      data = tables.read(TABLES.lc);
      break;
    case "cfg.ic": {
      const elements = tables.read(TABLES.icElements, true);
      const rivers = tables.read(TABLES.icRivers);
      data = {
        elements,
        rivers,
        lakes: tables.hasMore() ? tables.read(TABLES.lakes) : null,
        time_min: tables.time_min,
      };
      break;
    }
  }
  tables.finish();
  return data;
}
