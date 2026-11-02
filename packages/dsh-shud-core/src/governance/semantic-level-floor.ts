export const SEMANTIC_LEVEL_ORDER = Object.freeze([
  "pure_engineering",
  "io_format",
  "output_semantics",
  "numerical_implementation",
  "parameter_default",
  "physical_equation",
  "model_assumption",
] as const);

export type SemanticLevel = (typeof SEMANTIC_LEVEL_ORDER)[number];

export const SEMANTIC_LEVEL_FLOORS: ReadonlyArray<{
  readonly pattern: string;
  readonly floor: SemanticLevel;
}> = Object.freeze(
  (
    [
      { pattern: "src/ModelData/**", floor: "numerical_implementation" },
      { pattern: "src/classes/**", floor: "numerical_implementation" },
      { pattern: "src/Model/**", floor: "numerical_implementation" },
      { pattern: "src/Equations/**", floor: "physical_equation" },
      { pattern: "input/**/*.para*", floor: "parameter_default" },
      { pattern: "src/**/IO*", floor: "io_format" },
      { pattern: "src/classes/Model_Control.*", floor: "output_semantics" },
      { pattern: "src/Equations/print.hpp", floor: "output_semantics" },
      { pattern: "docs/**", floor: "pure_engineering" },
      { pattern: "scripts/**", floor: "pure_engineering" },
      { pattern: "templates/**", floor: "pure_engineering" },
    ] as const
  ).map((entry) => Object.freeze(entry)),
);

function compileGlob(pattern: string): RegExp {
  const source = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\/|\*\*|\*/g, (wildcard) => {
      if (wildcard === "**/") return "(?:[^/]+/)*";
      if (wildcard === "**") return "[\\s\\S]*";
      return "[^/]*";
    });
  // Unlike $, this end assertion cannot stop before a trailing newline in a path.
  return new RegExp(`^${source}(?![\\s\\S])`);
}

const COMPILED_FLOORS = SEMANTIC_LEVEL_FLOORS.map(({ pattern, floor }) => ({
  matcher: compileGlob(pattern),
  rank: SEMANTIC_LEVEL_ORDER.indexOf(floor),
}));
const DEFAULT_RANK = SEMANTIC_LEVEL_ORDER.indexOf("numerical_implementation");

export function deriveSemanticFloor(paths: readonly string[]): {
  floor: SemanticLevel;
  categories: SemanticLevel[];
} {
  if (paths.length === 0) throw new Error("Cannot derive a semantic floor from empty paths");

  const seen = new Array<boolean>(SEMANTIC_LEVEL_ORDER.length).fill(false);
  for (const path of paths) {
    let matched = false;
    for (const { matcher, rank } of COMPILED_FLOORS) {
      if (matcher.test(path)) {
        seen[rank] = true;
        matched = true;
      }
    }
    if (!matched) seen[DEFAULT_RANK] = true;
  }

  const categories: SemanticLevel[] = [];
  let floor: SemanticLevel = "numerical_implementation";
  let rank = 0;
  for (const level of SEMANTIC_LEVEL_ORDER) {
    if (seen[rank]) {
      categories.push(level);
      floor = level;
    }
    rank += 1;
  }
  return { floor, categories };
}

export function riskForLevel(level: SemanticLevel): "low" | "medium" | "high" {
  if (level === "pure_engineering") return "low";
  if (level === "io_format") return "medium";
  return "high";
}
