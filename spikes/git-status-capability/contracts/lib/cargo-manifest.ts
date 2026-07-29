type TomlScalar = string | boolean;
type TomlValue = TomlScalar | string[] | Record<string, TomlValue>;
type TomlTable = Record<string, TomlValue>;

type CatalogDependency = {
  name: string;
  version: string;
  default_features: boolean;
  features: string[];
  source: string;
};

function splitTopLevel(input: string): string[] {
  const output: string[] = [];
  let start = 0;
  let bracketDepth = 0;
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (character === '"' && input[index - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (character === "[") bracketDepth += 1;
    if (character === "]") bracketDepth -= 1;
    if (bracketDepth < 0) throw new TypeError("CARGO_TOML_INVALID");
    if (character === "," && bracketDepth === 0) {
      output.push(input.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quoted || bracketDepth !== 0) throw new TypeError("CARGO_TOML_INVALID");
  output.push(input.slice(start).trim());
  return output;
}
function parseString(input: string): string {
  if (!/^"[^"\\]*"$/.test(input)) throw new TypeError("CARGO_TOML_INVALID");
  return input.slice(1, -1);
}

function parseValue(input: string): TomlValue {
  const trimmed = input.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith('"')) return parseString(trimmed);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const body = trimmed.slice(1, -1).trim();
    if (!body) return [];
    return splitTopLevel(body).map(parseString);
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const body = trimmed.slice(1, -1).trim();
    const result: TomlTable = Object.create(null) as TomlTable;
    if (!body) return result;
    for (const field of splitTopLevel(body)) {
      const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(field);
      if (!match || Object.hasOwn(result, match[1]!)) throw new TypeError("CARGO_TOML_INVALID");
      result[match[1]!] = parseValue(match[2]!);
    }
    return result;
  }
  throw new TypeError("CARGO_TOML_INVALID");
}

function parseCargoToml(input: string): Record<string, TomlTable> {
  if (input.includes("#") || input.includes("\r") || !input.endsWith("\n")) throw new TypeError("CARGO_TOML_INVALID");
  const document: Record<string, TomlTable> = Object.create(null) as Record<string, TomlTable>;
  let table: TomlTable | undefined;
  for (const rawLine of input.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const header = /^\[([A-Za-z0-9_-]+)\]$/.exec(line);
    if (header) {
      if (Object.hasOwn(document, header[1]!)) throw new TypeError("CARGO_TOML_INVALID");
      table = Object.create(null) as TomlTable;
      document[header[1]!] = table;
      continue;
    }
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!table || !assignment || Object.hasOwn(table, assignment[1]!)) throw new TypeError("CARGO_TOML_INVALID");
    table[assignment[1]!] = parseValue(assignment[2]!);
  }
  return document;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function exactStrings(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}

export function validateCargoManifest(input: string, catalogDependencies: unknown): boolean {
  try {
    if (!Array.isArray(catalogDependencies)) return false;
    const document = parseCargoToml(input);
    if (!exactKeys(document, ["package", "dependencies"])) return false;
    const packageTable = document.package!;
    if (!exactKeys(packageTable, ["name", "version", "edition", "rust-version", "publish"]) ||
        packageTable.name !== "shud-git-status-capability-spike" || packageTable.version !== "0.0.0" ||
        packageTable.edition !== "2024" || packageTable["rust-version"] !== "1.88.0" || packageTable.publish !== false) return false;

    const expectedCatalog = catalogDependencies as CatalogDependency[];
    if (!expectedCatalog.every((dependency) => dependency.source === "registry+https://github.com/rust-lang/crates.io-index")) return false;
    const dependencies = document.dependencies!;
    if (!exactKeys(dependencies, expectedCatalog.map((dependency) => dependency.name))) return false;
    for (const expected of expectedCatalog) {
      const actual = dependencies[expected.name];
      const expectedKeys = expected.features.length === 0 ? ["version", "default-features"] : ["version", "default-features", "features"];
      if (typeof actual !== "object" || actual === null || Array.isArray(actual) || !exactKeys(actual, expectedKeys)) return false;
      if (actual.version !== `=${expected.version}` || actual["default-features"] !== expected.default_features) return false;
      if (expected.features.length > 0 && !exactStrings(actual.features, expected.features)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
