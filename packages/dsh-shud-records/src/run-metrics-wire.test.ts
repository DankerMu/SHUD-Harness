import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readRunMetrics, serializeRunMetrics } from "./index.ts";
import { completeMetrics, digest, snapshotTree } from "./run-metrics-test-harness.ts";

// Literal contract, including a constructed complete budget: not production-generated output.
const canonical = [
  '{"method_version":"1","status":"ok","reason":null,"inputs":[{"path":"stderr.log","sha256":"',
  "a".repeat(64),
  '","size_bytes":12}],"nonfinite_count":0,"outlets":[1,2],',
  '"flow":{"peak_flow_m3d":30,"peak_day":2,"total_runoff_m3":60,"reasons":{"peak_flow_m3d":null,"peak_day":null,"total_runoff_m3":null}},',
  '"water_balance":{"formula_source":"rSHUD wb.all / wb.DS; SHUD snow/interception extension","P":0.1,"Qd":0.03,"AET":0.06,',
  '"delta_s_surf":0.001,"delta_s_us":0.002,"delta_s_gw":0.003,"delta_s_riv":0.001,"delta_s_snow":0.001,"delta_s_ic":0.001,"delta_s":0.009,"residual":0.01,',
  '"reasons":{"P":null,"Qd":null,"AET":null,"delta_s_surf":null,"delta_s_us":null,"delta_s_gw":null,"delta_s_riv":null,"delta_s_snow":null,"delta_s_ic":null,"delta_s":null,"residual":null},',
  '"approximation":"Final output interval average, not instantaneous final state"},',
  '"numerical_health":{"water_balance_residual":0.01,"cvode_failures":2,"negative_state_count":3,"max_solver_dt":null,',
  '"reasons":{"water_balance_residual":null,"cvode_failures":null,"negative_state_count":null,"max_solver_dt":"not_observable_in_pinned_shud"},',
  '"negative_state_count_note":"SHUD 静默钳零，该值为下界"},',
  '"verdicts":{"water_balance_residual":"pass","cvode_failures":"fail","negative_state_count":"warn"}}\n',
].join("");

let parent: string;
let root: string;
beforeEach(() => {
  parent = realpathSync(mkdtempSync(`${tmpdir()}/run-metrics-wire-`));
  root = `${parent}/run`;
  mkdirSync(root);
});
afterEach(() => rmSync(parent, { recursive: true, force: true }));

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, cell]) => [key, reverseKeys(cell)]),
    );
  }
  return value;
}

function change(value: unknown, path: string, replacement: unknown, remove = false): void {
  const keys = path.split(".");
  let object = value as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) object = object[key] as Record<string, unknown>;
  if (remove) delete object[keys.at(-1)!];
  else object[keys.at(-1)!] = replacement;
}

function expectSerializeError(document: unknown): void {
  let caught: unknown;
  try {
    serializeRunMetrics(document as never);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  if (!(caught instanceof Error)) throw new Error("Expected controlled metrics validation failure");
  expect(caught).not.toBeInstanceOf(TypeError);
  expect(caught).not.toBeInstanceOf(SyntaxError);
  expect(caught.message).toMatch(/shape|invalid|validat/iu);
  expect(caught.cause).toBeUndefined();
  expect(inspect(caught, { depth: null, showHidden: true })).not.toContain(
    "private-metrics-payload",
  );
}

function expectReadError(expectedDigest: string, reason: RegExp) {
  let caught: unknown;
  const before = snapshotTree(parent);
  try {
    readRunMetrics(root, expectedDigest);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  if (!(caught instanceof Error)) throw new Error("Expected controlled metrics.json read failure");
  expect(caught.name).not.toBe("Error");
  expect(caught.name).not.toBe("SyntaxError");
  expect(caught.message).toContain("metrics.json");
  expect(caught.message).toMatch(reason);
  expect(caught.cause).toBeUndefined();
  const diagnostic = inspect(caught, { depth: null, showHidden: true });
  expect(diagnostic).not.toContain("private-metrics-payload");
  expect(caught.message).not.toContain(parent);
  expect(snapshotTree(parent)).toEqual(before);
}

test("serializes the entire constructed water budget in exact nested order and one LF", () => {
  expect(serializeRunMetrics(completeMetrics())).toBe(canonical);
  expect(serializeRunMetrics(reverseKeys(completeMetrics()) as never)).toBe(canonical);
});

test("sorts copied inputs by Unicode code point and outlets numerically without mutating any nested field", () => {
  const value = completeMetrics();
  // U+10000 sorts after U+E000 by code point, unlike JavaScript's UTF-16 default sort.
  value.inputs = ["\u{10000}.dat", "z.dat", "\uE000.dat", "A.dat"].map((path) => ({
    path,
    sha256: "b".repeat(64),
    size_bytes: 1,
  }));
  value.outlets = [10, 2, 1];
  const before = structuredClone(value);
  const encoded = serializeRunMetrics(value);
  const parsed = JSON.parse(encoded) as { inputs: { path: string }[]; outlets: number[] };
  expect(parsed.inputs.map(({ path }) => path)).toEqual([
    "A.dat",
    "z.dat",
    "\uE000.dat",
    "\u{10000}.dat",
  ]);
  expect(parsed.outlets).toEqual([1, 2, 10]);
  expect(value).toEqual(before);
  expect(serializeRunMetrics(reverseKeys(value) as never)).toBe(encoded);
});

test("uses shortest-roundtrip numeric spelling, including negative zero", () => {
  const value = completeMetrics();
  value.flow.peak_flow_m3d = 1.2345678901234567;
  value.flow.peak_day = -0;
  value.flow.total_runoff_m3 = 1e-7;
  const encoded = serializeRunMetrics(value);
  expect(encoded).toContain(
    '"peak_flow_m3d":1.2345678901234567,"peak_day":0,"total_runoff_m3":1e-7,',
  );
  expect(encoded.endsWith("\n\n")).toBe(false);
});

test("reads a digest-bound complete document itself, not a second envelope, without writing", () => {
  writeFileSync(`${root}/metrics.json`, canonical, { mode: 0o400 });
  const before = snapshotTree(parent);
  expect(readRunMetrics(root, digest(canonical))).toEqual(completeMetrics());
  expect(serializeRunMetrics(readRunMetrics(root, digest(canonical)))).toBe(canonical);
  expect(snapshotTree(parent)).toEqual(before);
});

test("accepts a genuinely unavailable all-null document with evidence metadata retained", () => {
  const value = completeMetrics();
  change(value, "status", "unavailable");
  change(value, "reason", "missing_variable:rivqdown");
  for (const block of ["flow", "water_balance", "numerical_health"] as const) {
    for (const key of Object.keys(value[block].reasons)) {
      change(value, `${block}.${key}`, null);
      change(value, `${block}.reasons.${key}`, "missing_variable:rivqdown");
    }
  }
  for (const key of Object.keys(value.verdicts)) change(value, `verdicts.${key}`, "not_available");
  const bytes = serializeRunMetrics(value);
  writeFileSync(`${root}/metrics.json`, bytes);
  expect(readRunMetrics(root, digest(bytes))).toEqual(value);
});

const malformed = [
  { name: "wrong method", path: "method_version", value: "future" },
  { name: "unknown status", path: "status", value: "succeeded" },
  { name: "ok with top reason", path: "reason", value: "failure" },
  { name: "unavailable without top reason", path: "status", value: "unavailable" },
  { name: "unknown top field", path: "host", value: "private-metrics-payload" },
  { name: "unknown flow field", path: "flow.extra", value: 1 },
  { name: "unknown water field", path: "water_balance.extra", value: 1 },
  { name: "unknown health field", path: "numerical_health.extra", value: 1 },
  { name: "unknown reason field", path: "flow.reasons.extra", value: "missing" },
  { name: "missing metric", path: "water_balance.delta_s_ic", remove: true },
  { name: "missing reason", path: "flow.reasons.peak_day", remove: true },
  { name: "null without reason", path: "flow.peak_day", value: null },
  { name: "present metric with reason", path: "water_balance.reasons.P", value: "missing" },
  { name: "empty null reason", path: "numerical_health.reasons.max_solver_dt", value: "" },
  { name: "wrong value type", path: "flow.peak_day", value: "2" },
  { name: "wrong verdict", path: "verdicts.cvode_failures", value: "unknown" },
  { name: "unclassified solver step", path: "verdicts.max_solver_dt", value: "not_available" },
  { name: "missing verdict", path: "verdicts.negative_state_count", remove: true },
  { name: "negative nonfinite count", path: "nonfinite_count", value: -1 },
  { name: "fractional nonfinite count", path: "nonfinite_count", value: 0.5 },
  { name: "duplicate outlets", path: "outlets", value: [1, 1] },
  { name: "fractional outlet", path: "outlets", value: [1.5] },
  { name: "unknown input field", path: "inputs.0.content", value: "private-metrics-payload" },
  { name: "absolute input", path: "inputs.0.path", value: "/outside" },
  { name: "escaping input", path: "inputs.0.path", value: "../outside" },
  { name: "backslash input", path: "inputs.0.path", value: "input\\outside" },
  { name: "NUL input", path: "inputs.0.path", value: "input\0outside" },
  { name: "empty input path", path: "inputs.0.path", value: "" },
  { name: "uppercase digest", path: "inputs.0.sha256", value: "A".repeat(64) },
  { name: "short digest", path: "inputs.0.sha256", value: "a".repeat(63) },
  { name: "negative byte length", path: "inputs.0.size_bytes", value: -1 },
  { name: "fractional byte length", path: "inputs.0.size_bytes", value: 1.5 },
  { name: "empty source", path: "water_balance.formula_source", value: "" },
  { name: "empty approximation", path: "water_balance.approximation", value: "" },
  { name: "empty lower-bound note", path: "numerical_health.negative_state_count_note", value: "" },
  {
    name: "verdict inconsistent with observed count",
    path: "verdicts.cvode_failures",
    value: "pass",
  },
];

describe("shared strict shape validation through both public consumers", () => {
  test.each(malformed)("rejects $name", ({ path, value, remove }) => {
    const document = completeMetrics();
    change(document, path, value, remove);
    expectSerializeError(document);
    const bytes = JSON.stringify(document);
    writeFileSync(`${root}/metrics.json`, bytes);
    expectReadError(digest(bytes), /shape|parse|invalid|validat/iu);
  });

  test("rejects duplicate input identities rather than silently deduplicating", () => {
    const document = completeMetrics();
    document.inputs.push({ ...document.inputs[0] });
    expectSerializeError(document);
    const bytes = JSON.stringify(document);
    writeFileSync(`${root}/metrics.json`, bytes);
    expectReadError(digest(bytes), /shape|parse|invalid|validat/iu);
  });

  test.each([
    ["flow.peak_flow_m3d", NaN],
    ["flow.peak_day", Infinity],
    ["flow.total_runoff_m3", -Infinity],
    ["water_balance.delta_s_snow", NaN],
    ["water_balance.residual", Infinity],
    ["numerical_health.cvode_failures", NaN],
    ["numerical_health.negative_state_count", Infinity],
    ["nonfinite_count", Infinity],
    ["outlets.0", NaN],
    ["inputs.0.size_bytes", Infinity],
  ])("rejects nonfinite %s before JSON can implicitly turn it into null", (path, value) => {
    const document = completeMetrics();
    change(document, path, value);
    expectSerializeError(document);
  });

  test("unavailable cannot retain a finite metric or an available verdict", () => {
    const document = completeMetrics();
    change(document, "status", "unavailable");
    change(document, "reason", "missing_variable:rivqdown");
    expectSerializeError(document);
    const bytes = JSON.stringify(document);
    writeFileSync(`${root}/metrics.json`, bytes);
    expectReadError(digest(bytes), /shape|parse|invalid|validat/iu);
  });
});

test("digest mismatch takes precedence over malformed JSON, and matching digest exposes parse failure", () => {
  const bytes = '{"private-metrics-payload":';
  writeFileSync(`${root}/metrics.json`, bytes);
  expectReadError(digest(canonical), /sha256|digest/iu);
  expectReadError(digest(bytes), /parse|JSON/iu);
});

test("rejects a JSON numeric token that decodes to Infinity despite a matching digest", () => {
  const bytes = canonical.replace('"peak_flow_m3d":30', '"peak_flow_m3d":1e999');
  writeFileSync(`${root}/metrics.json`, bytes);
  expectReadError(digest(bytes), /shape|parse|invalid|validat/iu);
});

test("one changed byte cannot be read under the previous artifact digest", () => {
  writeFileSync(
    `${root}/metrics.json`,
    canonical.replace('"peak_flow_m3d":30', '"peak_flow_m3d":31'),
  );
  expectReadError(digest(canonical), /sha256|digest/iu);
});

test.each(["", "a".repeat(63), "A".repeat(64), "g".repeat(64)])(
  "rejects malformed expected digest %j",
  (expected) => {
    writeFileSync(`${root}/metrics.json`, canonical);
    expectReadError(expected, /sha256|digest/iu);
  },
);

test.each(["missing", "symlink", "directory"])(
  "controlled %s metrics.json read preserves every target",
  (kind) => {
    const outside = `${parent}/outside.json`;
    writeFileSync(outside, canonical);
    if (kind === "symlink") symlinkSync(outside, `${root}/metrics.json`);
    if (kind === "directory") mkdirSync(`${root}/metrics.json`);
    expectReadError(digest(canonical), kind === "missing" ? /missing/iu : /unsafe|regular/iu);
  },
);

test("writerless metrics FIFO is rejected within a killed-and-reaped bound", () => {
  const child = () =>
    spawnSync(
      process.execPath,
      [
        "--experimental-transform-types",
        "--input-type=module",
        "-e",
        `// Eval has no module-relative base; the parent supplies the runtime module URL.
     const { readRunMetrics } = await import(process.argv[1]);
     try { console.log(JSON.stringify({ metrics: readRunMetrics(process.argv[2], process.argv[3]) })); }
     catch (error) { console.log(JSON.stringify({ name: error.name, message: error.message, cause: error.cause })); }`,
        new URL("./index.ts", import.meta.url).href,
        root,
        digest(canonical),
      ],
      { encoding: "utf8", timeout: 3000, killSignal: "SIGKILL" },
    );
  writeFileSync(`${root}/metrics.json`, canonical);
  const control = child();
  expect(control.error, control.stderr).toBeUndefined();
  expect(control.status, control.stderr).toBe(0);
  expect(JSON.parse(control.stdout)).toEqual({ metrics: completeMetrics() });
  unlinkSync(`${root}/metrics.json`);
  execFileSync("mkfifo", [`${root}/metrics.json`]);
  const before = snapshotTree(parent);
  const result = child();
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.signal, result.stderr).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  const diagnostic = JSON.parse(result.stdout) as Record<string, unknown>;
  expect(Object.keys(diagnostic).sort()).toEqual(["message", "name"]);
  expect(diagnostic.name).not.toMatch(/^(Error|SyntaxError)$/u);
  expect(diagnostic.message).toMatch(/metrics\.json/u);
  expect(snapshotTree(parent)).toEqual(before);
}, 10000);
