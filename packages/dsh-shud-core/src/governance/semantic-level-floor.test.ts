import { describe, expect, test } from "vitest";
import { deriveSemanticFloor, riskForLevel } from "../index.ts";

describe("deriveSemanticFloor", () => {
  test("preserves both matched categories while taking the higher Model_Control floor", () => {
    expect(deriveSemanticFloor(["src/classes/Model_Control.cpp"])).toEqual({
      floor: "numerical_implementation",
      categories: ["output_semantics", "numerical_implementation"],
    });
  });

  test("uses the conservative floor for the model replay including Makefile", () => {
    expect(
      deriveSemanticFloor(["Makefile", "src/Model/MD_rhs_core.cpp", "src/Model/f.cpp"]),
    ).toEqual({
      floor: "numerical_implementation",
      categories: ["numerical_implementation"],
    });
  });

  test.each(["README.md", "Makefile", "src/main.cpp"])(
    "defaults unmatched source path %s to numerical_implementation",
    (path) => {
      expect(deriveSemanticFloor([path])).toEqual({
        floor: "numerical_implementation",
        categories: ["numerical_implementation"],
      });
    },
  );

  test("keeps documentation and scripts at pure_engineering", () => {
    expect(deriveSemanticFloor(["docs/x.md", "scripts/a.sh"])).toEqual({
      floor: "pure_engineering",
      categories: ["pure_engineering"],
    });
  });

  test("keeps templates at pure_engineering", () => {
    expect(deriveSemanticFloor(["templates/run.txt"])).toEqual({
      floor: "pure_engineering",
      categories: ["pure_engineering"],
    });
  });

  test("preserves output semantics beneath the physical equation floor of print.hpp", () => {
    expect(deriveSemanticFloor(["src/Equations/print.hpp"])).toEqual({
      floor: "physical_equation",
      categories: ["output_semantics", "physical_equation"],
    });
  });

  test("preserves the engineering category alongside an unmatched path default", () => {
    expect(deriveSemanticFloor(["docs/x.md", "README.md"])).toEqual({
      floor: "numerical_implementation",
      categories: ["pure_engineering", "numerical_implementation"],
    });
  });

  test("sorts the union of all categories across low and dual-match paths", () => {
    expect(deriveSemanticFloor(["src/classes/Model_Control.cpp", "docs/x.md"])).toEqual({
      floor: "numerical_implementation",
      categories: ["pure_engineering", "output_semantics", "numerical_implementation"],
    });
  });

  test.each(["input/x.para", "input/a/b/x.para", "input/x/x.cfg.para", "input/x.para.bak"])(
    "recognizes parameter defaults at zero or more directory levels: %s",
    (path) => {
      expect(deriveSemanticFloor([path])).toEqual({
        floor: "parameter_default",
        categories: ["parameter_default"],
      });
    },
  );

  test.each(["src/IO.cpp", "src/a/b/IO.cpp"])(
    "recognizes IO files at zero or more directory levels: %s",
    (path) => {
      expect(deriveSemanticFloor([path])).toEqual({
        floor: "io_format",
        categories: ["io_format"],
      });
    },
  );

  test("does not let the IO filename wildcard cross a directory separator", () => {
    expect(deriveSemanticFloor(["src/IOdir/file.cpp"])).toEqual({
      floor: "numerical_implementation",
      categories: ["numerical_implementation"],
    });
  });

  test("requires the literal dot in the Model_Control filename pattern", () => {
    expect(deriveSemanticFloor(["src/classes/Model_ControlXcpp"])).toEqual({
      floor: "numerical_implementation",
      categories: ["numerical_implementation"],
    });
  });

  test("deduplicates categories without mutating readonly observed paths", () => {
    const paths = Object.freeze(["README.md", "docs/x.md", "README.md", "docs/x.md"]);
    expect(deriveSemanticFloor(paths)).toEqual({
      floor: "numerical_implementation",
      categories: ["pure_engineering", "numerical_implementation"],
    });
    expect(paths).toEqual(["README.md", "docs/x.md", "README.md", "docs/x.md"]);
  });

  test("rejects an empty observed path list", () => {
    expect(() => deriveSemanticFloor([])).toThrow();
  });
});

describe("riskForLevel", () => {
  test.each([
    ["pure_engineering", "low"],
    ["io_format", "medium"],
    ["output_semantics", "high"],
    ["numerical_implementation", "high"],
    ["parameter_default", "high"],
    ["physical_equation", "high"],
    ["model_assumption", "high"],
  ] as const)("maps %s to %s risk", (level, risk) => {
    expect(riskForLevel(level)).toBe(risk);
  });
});
