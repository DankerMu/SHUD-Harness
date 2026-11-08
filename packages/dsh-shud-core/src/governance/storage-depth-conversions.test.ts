import { describe, expect, test } from "vitest";
import { STORAGE_DEPTH_CONVERSIONS, StorageDepthConversionsSchema } from "../index.ts";

// Independent O1 expectations audited at SHUD 3aec65755926c478e13ca7d4fea80715e4e90345.
const SOURCE_CASES = [
  {
    group: "snow",
    channel: "output",
    raw: 0.012,
    depth: 0.012,
  },
  {
    group: "snow",
    channel: "ic",
    raw: 0.023,
    depth: 0.023,
  },
  {
    group: "ic",
    channel: "output",
    raw: 0.034,
    depth: 0.034,
  },
  {
    group: "ic",
    channel: "ic",
    raw: 0.045,
    depth: 0.045,
  },
] as const;

function validRegistration() {
  const entry = () => ({
    scale: 1,
    veg_frac_weighted: false,
    shud_source_refs: ["SHUD/src/ModelData/MD_ET.cpp:44"],
  });
  return {
    snow: { output: entry(), ic: entry() },
    ic: { output: entry(), ic: entry() },
  };
}

// Counterfactual schema shape only: these names are not a real VegFrac lookup recipe.
function hypotheticalSource() {
  return {
    file: "hypothetical.para.lc",
    column: "hypothetical_fraction",
    calib_key: "HYPOTHETICAL_FRACTION",
    shud_source_refs: ["SHUD/src/ModelData/MD_ET.cpp:145"],
  };
}

function rejectsAt(input: unknown, path: (string | number)[]) {
  const result = StorageDepthConversionsSchema.safeParse(input);
  expect(result.success).toBe(false);
  expect(result.error?.issues.map((issue) => issue.path)).toContainEqual(path);
}

function rejectsUnknownKey(input: unknown, path: string[]) {
  const result = StorageDepthConversionsSchema.safeParse(input);
  expect(result.success).toBe(false);
  const issue = result.error?.issues.find(
    (candidate) => candidate.code === "unrecognized_keys" && candidate.keys.includes("extra"),
  );
  expect(issue).toBeDefined();
  expect(issue?.path).toEqual(path);
}

const INVALID_REFS = [
  "",
  "SHUD/src/ModelData/MD_ET.cpp",
  "SHUD/src/ModelData/MD_ET.cpp:0",
  "SHUD/src/ModelData/MD_ET.cpp:-1",
  "SHUD/src/ModelData/MD_ET.cpp:1.5",
  "SHUD/src/ModelData/MD_ET.cpp:1e2",
  "SHUD/src/ModelData/MD_ET.cpp:+44",
  "SHUD/src/ModelData/MD_ET.cpp:44suffix",
  "SHUD/src/ModelData/MD_ET.cpp:44\n",
  "SHUD/src/ModelData/MD_ET.cpp:44:45",
  ":44",
  "/SHUD/src/ModelData/MD_ET.cpp:44",
  "rSHUD/src/ModelData/MD_ET.cpp:44",
  "SHUD/src/:44",
  "SHUD/src/../MD_ET.cpp:44",
  "SHUD/src/ModelData/../MD_ET.cpp:44",
  "SHUD/src/./ModelData/MD_ET.cpp:44",
  "SHUD/src//ModelData/MD_ET.cpp:44",
  "SHUD/src/ModelData\\MD_ET.cpp:44",
  " SHUD/src/ModelData/MD_ET.cpp:44",
];

const INVALID_ENTRY_FIELDS = [
  { field: "scale", value: 0 },
  { field: "scale", value: -1 },
  { field: "scale", value: NaN },
  { field: "scale", value: Infinity },
  { field: "scale", value: -Infinity },
  { field: "scale", value: undefined },
  { field: "veg_frac_weighted", value: "false" },
  { field: "veg_frac_weighted", value: 1 },
  { field: "veg_frac_weighted", value: undefined },
  { field: "shud_source_refs", value: [] },
  { field: "shud_source_refs", value: undefined },
];

describe("storage depth conversion registration", () => {
  test("validates exactly four source-pinned element-depth conversions", () => {
    const parsed = StorageDepthConversionsSchema.parse(STORAGE_DEPTH_CONVERSIONS);
    expect(Object.keys(parsed).sort()).toEqual(["ic", "snow"]);
    expect(Object.hasOwn(STORAGE_DEPTH_CONVERSIONS, "veg_frac_source")).toBe(false);
    for (const group of ["snow", "ic"] as const) {
      expect(Object.keys(parsed[group]).sort()).toEqual(["ic", "output"]);
    }
    for (const { group, channel } of SOURCE_CASES) {
      const entry = parsed[group][channel];
      expect(Object.keys(entry).sort()).toEqual(["scale", "shud_source_refs", "veg_frac_weighted"]);
      expect(entry.scale).toBe(1);
      expect(entry.veg_frac_weighted).toBe(false);
    }
  });

  test.each(SOURCE_CASES)(
    "$group.$channel preserves the independently audited depth with VegFrac 0.25",
    ({ group, channel, raw, depth }) => {
      const entry = STORAGE_DEPTH_CONVERSIONS[group][channel];
      const converted = raw * entry.scale * (entry.veg_frac_weighted ? 0.25 : 1);
      expect(converted).toBe(depth);
    },
  );

  test("prevents extension, replacement and deletion of the registration and groups", () => {
    expect(Object.isFrozen(STORAGE_DEPTH_CONVERSIONS)).toBe(true);
    expect(Reflect.set(STORAGE_DEPTH_CONVERSIONS, "veg_frac_source", hypotheticalSource())).toBe(
      false,
    );
    for (const group of ["snow", "ic"] as const) {
      const entries = STORAGE_DEPTH_CONVERSIONS[group];
      expect(Reflect.set(STORAGE_DEPTH_CONVERSIONS, group, {})).toBe(false);
      expect(Reflect.deleteProperty(STORAGE_DEPTH_CONVERSIONS, group)).toBe(false);
      expect(Object.isFrozen(entries)).toBe(true);
      expect(Reflect.set(entries, "extra", {})).toBe(false);
      for (const channel of ["output", "ic"] as const) {
        expect(Reflect.set(entries, channel, {})).toBe(false);
        expect(Reflect.deleteProperty(entries, channel)).toBe(false);
      }
    }
    expect(Object.hasOwn(STORAGE_DEPTH_CONVERSIONS, "veg_frac_source")).toBe(false);
  });

  test.each(SOURCE_CASES)("prevents deep mutation of $group.$channel", ({ group, channel }) => {
    const entry = STORAGE_DEPTH_CONVERSIONS[group][channel];
    const originalRefs = [...entry.shud_source_refs];
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.shud_source_refs)).toBe(true);
    expect(Reflect.set(entry, "scale", 2)).toBe(false);
    expect(Reflect.set(entry, "veg_frac_weighted", true)).toBe(false);
    expect(Reflect.set(entry, "shud_source_refs", [])).toBe(false);
    expect(Reflect.set(entry.shud_source_refs, "0", "invented source")).toBe(false);
    expect(Reflect.set(entry.shud_source_refs, "length", 0)).toBe(false);
    expect(Reflect.deleteProperty(entry.shud_source_refs, "0")).toBe(false);
    expect(entry.scale).toBe(1);
    expect(entry.veg_frac_weighted).toBe(false);
    expect(entry.shud_source_refs).toEqual(originalRefs);
  });
});

for (const { group, channel } of SOURCE_CASES) {
  describe(`${group}.${channel} validation`, () => {
    // Exercise the shared validators exhaustively once; retain every entry's path routing.
    const representative = group === "snow" && channel === "output";
    const invalidFields = representative
      ? INVALID_ENTRY_FIELDS
      : [
          { field: "scale", value: 0 },
          { field: "veg_frac_weighted", value: "false" },
          { field: "shud_source_refs", value: [] },
        ];
    const invalidRefs = representative ? INVALID_REFS : ["SHUD/src/ModelData/MD_ET.cpp:0"];
    test.each(invalidFields)("rejects $field=$value at its exact path", ({ field, value }) => {
      const input = validRegistration();
      Reflect.set(input[group][channel], field, value);
      rejectsAt(input, [group, channel, field]);
    });

    test("rejects a missing entry at its exact path", () => {
      const input = validRegistration();
      Reflect.deleteProperty(input[group], channel);
      rejectsAt(input, [group, channel]);
    });

    test.each(invalidRefs)("rejects malformed source ref %j at its exact index", (ref) => {
      const input = validRegistration();
      input[group][channel].shud_source_refs.push(ref);
      rejectsAt(input, [group, channel, "shud_source_refs", 1]);
    });

    test("rejects unknown entry keys without stripping them", () => {
      const input = validRegistration();
      Reflect.set(input[group][channel], "extra", true);
      rejectsUnknownKey(input, [group, channel]);
    });

    test("requires a defined source when this flag alone is true (schema shape only)", () => {
      const input = validRegistration();
      input[group][channel].veg_frac_weighted = true;
      rejectsAt(input, ["veg_frac_source"]);
      rejectsAt({ ...input, veg_frac_source: undefined }, ["veg_frac_source"]);
      const withSource = { ...input, veg_frac_source: hypotheticalSource() };
      expect(StorageDepthConversionsSchema.parse(withSource)).toStrictEqual(withSource);
    });
  });
}

describe("strict registration and conditional source shape", () => {
  test("accepts finite positive scales without restricting the schema to current coefficients", () => {
    const input = validRegistration();
    input.snow.output.scale = 0.5;
    input.ic.ic.scale = 2;
    expect(StorageDepthConversionsSchema.parse(input)).toStrictEqual(input);
  });

  test("rejects unknown root and group keys", () => {
    rejectsUnknownKey({ ...validRegistration(), extra: true }, []);
    for (const group of ["snow", "ic"] as const) {
      const input = validRegistration();
      Reflect.set(input[group], "extra", true);
      rejectsUnknownKey(input, [group]);
    }
  });

  test.each([undefined, hypotheticalSource()])(
    "forbids an own veg_frac_source property with all flags false, including %j",
    (source) => {
      rejectsAt({ ...validRegistration(), veg_frac_source: source }, ["veg_frac_source"]);
    },
  );

  test.each(["file", "column", "calib_key"])("requires nonempty source %s", (field) => {
    const input = { ...validRegistration(), veg_frac_source: hypotheticalSource() };
    input.snow.output.veg_frac_weighted = true;
    for (const value of ["", undefined, 42]) {
      Reflect.set(input.veg_frac_source, field, value);
      rejectsAt(input, ["veg_frac_source", field]);
    }
  });

  test("requires nonempty source refs and rejects unknown source keys", () => {
    const input = { ...validRegistration(), veg_frac_source: hypotheticalSource() };
    input.snow.output.veg_frac_weighted = true;
    Reflect.set(input.veg_frac_source, "extra", true);
    rejectsUnknownKey(input, ["veg_frac_source"]);
    Reflect.deleteProperty(input.veg_frac_source, "extra");
    for (const value of [[], undefined]) {
      Reflect.set(input.veg_frac_source, "shud_source_refs", value);
      rejectsAt(input, ["veg_frac_source", "shud_source_refs"]);
    }
  });

  test("rejects a malformed conditional source ref at its exact index", () => {
    const input = { ...validRegistration(), veg_frac_source: hypotheticalSource() };
    input.snow.output.veg_frac_weighted = true;
    input.veg_frac_source.shud_source_refs.push("SHUD/src/ModelData/MD_ET.cpp:0");
    rejectsAt(input, ["veg_frac_source", "shud_source_refs", 1]);
  });
});
