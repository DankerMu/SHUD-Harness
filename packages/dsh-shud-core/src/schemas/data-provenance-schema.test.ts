import { expect, test } from "vitest";
import { DataProvenanceSchema } from "../index.ts";

function validDataProvenance() {
  return {
    data_id: "DATA-20261027T081000-7d2e",
    basin: "ccw",
    event_window: { start: null, end: null },
    sources: {
      input_root: "/workspace/input/ccw",
      files: [
        {
          path: "ccw.sp.mesh",
          sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          size_bytes: 1024,
        },
      ],
    },
    preprocess: null,
    uncertainty_notes: null,
  };
}

test("DataProvenance preserves branded input provenance with explicit null metadata", () => {
  const provenance = validDataProvenance();
  expect(DataProvenanceSchema.parse(provenance)).toEqual(provenance);
});

test.each(["input/ccw", "./input/ccw", "../input/ccw"])(
  "DataProvenance rejects relative input_root %j",
  (inputRoot) => {
    const provenance = validDataProvenance();
    provenance.sources.input_root = inputRoot;
    const result = DataProvenanceSchema.safeParse(provenance);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(
        "sources.input_root",
      );
    }
  },
);

test.each([
  "/outside.dat",
  "..",
  "../outside.dat",
  "nested/../outside.dat",
  "nested/..",
  "nested/\0file.dat",
])("DataProvenance rejects unsafe input file path %j", (path) => {
  const provenance = validDataProvenance();
  provenance.sources.files = [{ path, sha256: "digest", size_bytes: 1024 }];
  const result = DataProvenanceSchema.safeParse(provenance);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(
      "sources.files.0.path",
    );
  }
});

test.each([
  "流域/网格.mesh",
  "nested/with space.dat",
  "nested/with\ttab.dat",
  "nested\\file.dat",
  "nested\\..\\file.dat",
  "nested/",
  "./ccw.sp.mesh",
  "nested/model..mesh",
  " ",
])("DataProvenance preserves legal POSIX file path %j", (path) => {
  const provenance = validDataProvenance();
  provenance.sources.files = [{ path, sha256: "digest", size_bytes: 1024 }];
  expect(DataProvenanceSchema.parse(provenance)).toEqual(provenance);
});

test("DataProvenance accepts an empty input file list", () => {
  const provenance = validDataProvenance();
  provenance.sources.files = [];
  expect(DataProvenanceSchema.parse(provenance)).toEqual(provenance);
});

test("DataProvenance preserves a zero-byte input file", () => {
  const provenance = validDataProvenance();
  provenance.sources.files = [{ path: "empty.dat", sha256: "digest", size_bytes: 0 }];
  expect(DataProvenanceSchema.parse(provenance)).toEqual(provenance);
});

test("DataProvenance preserves nonempty event window strings without date parsing", () => {
  const provenance = {
    ...validDataProvenance(),
    event_window: { start: "event-start", end: "event-end" },
  };
  expect(DataProvenanceSchema.parse(provenance)).toEqual(provenance);
});

function expectInvalid(input: unknown, path: string): void {
  const result = DataProvenanceSchema.safeParse(input);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(path);
  }
}

function withoutField(input: object, field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([key]) => key !== field));
}

test.each([
  "DATA-22222222-2222-4222-8222-222222222222",
  "DATA-0001",
  "DATA-20261027T081000-7D2E",
  "STACK-20261027T081000-7d2e",
  "",
  null,
  431,
])("DataProvenance rejects an invalid data identifier %j", (dataId) => {
  expectInvalid({ ...validDataProvenance(), data_id: dataId }, "data_id");
});

test.each(["data_id", "basin", "event_window", "sources", "preprocess", "uncertainty_notes"])(
  "DataProvenance requires root field %s",
  (field) => {
    expectInvalid(withoutField(validDataProvenance(), field), field);
    expectInvalid({ ...validDataProvenance(), [field]: undefined }, field);
  },
);

test.each(["", null, 431])("DataProvenance rejects invalid basin %j", (basin) => {
  expectInvalid({ ...validDataProvenance(), basin }, "basin");
});

test.each([null, [], ["2008-01-01", "2008-02-28"], "window"])(
  "DataProvenance rejects a non-object event window %j",
  (eventWindow) => {
    expectInvalid({ ...validDataProvenance(), event_window: eventWindow }, "event_window");
  },
);

test.each(["start", "end"])("DataProvenance requires nullable window endpoint %s", (field) => {
  const provenance = validDataProvenance();
  expectInvalid(
    { ...provenance, event_window: withoutField(provenance.event_window, field) },
    `event_window.${field}`,
  );
  for (const value of ["", undefined, 431, false]) {
    expectInvalid(
      { ...provenance, event_window: { ...provenance.event_window, [field]: value } },
      `event_window.${field}`,
    );
  }
});

test.each([
  { start: null, end: "event-end" },
  { start: "event-start", end: null },
])("DataProvenance preserves independently nullable window endpoints %j", (eventWindow) => {
  const provenance = { ...validDataProvenance(), event_window: eventWindow };
  expect(DataProvenanceSchema.parse(provenance)).toEqual(provenance);
});

test.each(["preprocess", "uncertainty_notes"])(
  "DataProvenance rejects non-null metadata field %s",
  (field) => {
    for (const value of ["notes", "", {}, [], 431, false]) {
      expectInvalid({ ...validDataProvenance(), [field]: value }, field);
    }
  },
);

test("DataProvenance rejects the removed preprocess params object", () => {
  expectInvalid(
    {
      ...validDataProvenance(),
      preprocess: { script: "prep.R", params: {}, output_sha256: "digest" },
    },
    "preprocess",
  );
});

test.each(["input_root", "files"])("DataProvenance requires sources field %s", (field) => {
  const provenance = validDataProvenance();
  expectInvalid(
    { ...provenance, sources: withoutField(provenance.sources, field) },
    `sources.${field}`,
  );
});

test.each(["", null, 431, undefined])(
  "DataProvenance rejects invalid input_root %j",
  (inputRoot) => {
    const provenance = validDataProvenance();
    expectInvalid(
      { ...provenance, sources: { ...provenance.sources, input_root: inputRoot } },
      "sources.input_root",
    );
  },
);

test.each([null, [], "sources"])("DataProvenance rejects invalid sources %j", (sources) => {
  expectInvalid({ ...validDataProvenance(), sources }, "sources");
});

test.each([null, {}, "files", undefined])("DataProvenance rejects non-array files %j", (files) => {
  const provenance = validDataProvenance();
  expectInvalid({ ...provenance, sources: { ...provenance.sources, files } }, "sources.files");
});

test.each(["path", "sha256", "size_bytes"])("DataProvenance requires file field %s", (field) => {
  const provenance = validDataProvenance();
  const file = { path: "ccw.sp.mesh", sha256: "digest", size_bytes: 1024 };
  expectInvalid(
    {
      ...provenance,
      sources: { ...provenance.sources, files: [withoutField(file, field)] },
    },
    `sources.files.0.${field}`,
  );
});

test.each([
  ["path", ""],
  ["path", null],
  ["path", 431],
  ["path", undefined],
  ["sha256", ""],
  ["sha256", null],
  ["sha256", 431],
  ["sha256", undefined],
  ["size_bytes", -1],
  ["size_bytes", 0.5],
  ["size_bytes", null],
  ["size_bytes", "1024"],
  ["size_bytes", undefined],
  ["size_bytes", NaN],
  ["size_bytes", Infinity],
] as const)("DataProvenance rejects invalid file %s=%j", (field, value) => {
  const provenance = validDataProvenance();
  expectInvalid(
    {
      ...provenance,
      sources: {
        ...provenance.sources,
        files: [{ path: "ccw.sp.mesh", sha256: "digest", size_bytes: 1024, [field]: value }],
      },
    },
    `sources.files.0.${field}`,
  );
});

test.each([null, [], "ccw.sp.mesh"])("DataProvenance rejects a non-object file %j", (file) => {
  const provenance = validDataProvenance();
  expectInvalid(
    { ...provenance, sources: { ...provenance.sources, files: [file] } },
    "sources.files.0",
  );
});

test.each(["terrain", "mesh", "forcing", "observations"])(
  "DataProvenance rejects removed source category %s",
  (field) => {
    const provenance = validDataProvenance();
    expectInvalid({ ...provenance, sources: { ...provenance.sources, [field]: [] } }, "sources");
  },
);

test("DataProvenance rejects unknown fields at every object boundary", () => {
  const provenance = validDataProvenance();
  expectInvalid({ ...provenance, extra: true }, "");
  expectInvalid(
    { ...provenance, event_window: { ...provenance.event_window, extra: true } },
    "event_window",
  );
  expectInvalid({ ...provenance, sources: { ...provenance.sources, extra: true } }, "sources");
  expectInvalid(
    {
      ...provenance,
      sources: {
        ...provenance.sources,
        files: [{ path: "ccw.sp.mesh", sha256: "digest", size_bytes: 1024, extra: true }],
      },
    },
    "sources.files.0",
  );
});

test("DataProvenance preserves file order and duplicates without inventory policy", () => {
  const provenance = validDataProvenance();
  provenance.sources.files = [
    { path: "z.mesh", sha256: "digest", size_bytes: 1024 },
    { path: "a.mesh", sha256: "digest", size_bytes: 0 },
    { path: "a.mesh", sha256: "digest", size_bytes: 0 },
  ];
  expect(DataProvenanceSchema.parse(provenance)).toEqual(provenance);
});
