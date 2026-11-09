import * as fs from "node:fs";
import type * as Crypto from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  createEvidenceReport,
  parseSensitivitySummary,
  readReferencedSensitivitySummary,
  WorkspaceRecordError,
  type EvidenceReportCreationInput,
  type SensitivitySummary,
} from "./index.ts";
import { makeEvidenceReport } from "./report-render-test-harness.ts";
import { digest } from "./run-metrics-test-harness.ts";
import {
  EXPECTED_SUMMARY_BYTES,
  EXPECTED_SUMMARY_SHA256,
} from "./sensitivity-summary-test-harness.ts";
import { installUnsafe } from "./test-harness.ts";

const entropy = vi.hoisted(() => ({ suffixes: [] as string[] }));
vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof Crypto>();
  return {
    ...actual,
    randomBytes(size: number, callback?: (error: Error | null, bytes: Buffer) => void) {
      if (callback) return actual.randomBytes(size, callback);
      const suffix = size === 2 ? entropy.suffixes.shift() : undefined;
      return suffix === undefined ? actual.randomBytes(size) : Buffer.from(suffix, "hex");
    },
  };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    closeSync: vi.fn(actual.closeSync),
    linkSync: vi.fn(actual.linkSync),
    unlinkSync: vi.fn(actual.unlinkSync),
    renameSync: vi.fn(actual.renameSync),
  };
});
const realFs = await vi.importActual<typeof fs>("node:fs");
const firstId = "REPORT-20261109T080000-0001";
const nextId = "REPORT-20261109T080000-0002";
let root: string;
let summary: SensitivitySummary;
let fields: EvidenceReportCreationInput;
let directory: string;
let summaryPath: string;
let jsonPath: string;

beforeEach(() => {
  vi.mocked(fs.openSync).mockReset().mockImplementation(realFs.openSync);
  vi.mocked(fs.writeFileSync).mockReset().mockImplementation(realFs.writeFileSync);
  vi.mocked(fs.fsyncSync).mockReset().mockImplementation(realFs.fsyncSync);
  vi.mocked(fs.closeSync).mockReset().mockImplementation(realFs.closeSync);
  vi.mocked(fs.linkSync).mockReset().mockImplementation(realFs.linkSync);
  vi.mocked(fs.unlinkSync).mockReset().mockImplementation(realFs.unlinkSync);
  vi.mocked(fs.renameSync).mockReset().mockImplementation(realFs.renameSync);
  root = realFs.realpathSync.native(realFs.mkdtempSync(join(tmpdir(), "summary-publication-")));
  directory = join(root, "reports");
  summaryPath = join(directory, `${firstId}.sensitivity.json`);
  jsonPath = join(directory, `${firstId}.json`);
  summary = parseSensitivitySummary(JSON.parse(EXPECTED_SUMMARY_BYTES));
  const { report_id: fixtureId, ...legacyFields } = makeEvidenceReport();
  expect(fixtureId).toMatch(/^REPORT-/u);
  fields = {
    ...legacyFields,
    task_id: summary.task_id,
    analysis_ids: [summary.analysis_plan_id],
    linked_runs: summary.rows.map((row) => row.run_id),
  };
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-09T08:00:00Z"));
  entropy.suffixes = ["0001", "0002"];
});
afterEach(() => {
  vi.useRealTimers();
  realFs.rmSync(root, { recursive: true, force: true });
});

test("exclusive summary publication precedes report JSON and binds exact frozen bytes", () => {
  const order: string[] = [];
  vi.mocked(fs.linkSync).mockImplementation((source, target) => {
    expect(String(target)).toBe(summaryPath);
    expect(realFs.existsSync(jsonPath)).toBe(false);
    realFs.linkSync(source, target);
    order.push("summary");
  });
  vi.mocked(fs.renameSync).mockImplementation((source, target) => {
    expect(String(target)).toBe(jsonPath);
    expect(realFs.readFileSync(summaryPath, "utf8")).toBe(EXPECTED_SUMMARY_BYTES);
    expect(digest(realFs.readFileSync(summaryPath))).toBe(EXPECTED_SUMMARY_SHA256);
    order.push("report");
    realFs.renameSync(source, target);
  });

  const report = createEvidenceReport(root, fields, summary);

  expect(order).toEqual(["summary", "report"]);
  expect(report.report_id).toBe(firstId);
  expect(report.analysis_ids).toEqual(fields.analysis_ids);
  expect(report.sensitivity_summary).toEqual({
    path: `reports/${firstId}.sensitivity.json`,
    sha256: EXPECTED_SUMMARY_SHA256,
  });
  expect(JSON.parse(realFs.readFileSync(jsonPath, "utf8"))).toEqual(report);
  expect(readReferencedSensitivitySummary(root, report)).toEqual(summary);
  expect(realFs.readdirSync(directory).sort()).toEqual([
    `${firstId}.json`,
    `${firstId}.sensitivity.json`,
  ]);
});

test.each(["json", "md", "sensitivity.json"])(
  "sensitivity creation skips a regular %s sibling and rebinds the new id",
  (extension) => {
    realFs.mkdirSync(directory);
    const sibling = join(directory, `${firstId}.${extension}`);
    realFs.writeFileSync(sibling, "prior immutable evidence\n");
    const before = realFs.statSync(sibling, { bigint: true }).mtimeNs;
    const report = createEvidenceReport(root, fields, summary);
    expect(report.report_id).toBe(nextId);
    expect(report.sensitivity_summary).toEqual({
      path: `reports/${nextId}.sensitivity.json`,
      sha256: EXPECTED_SUMMARY_SHA256,
    });
    expect(readReferencedSensitivitySummary(root, report)).toEqual(summary);
    expect(realFs.readFileSync(sibling, "utf8")).toBe("prior immutable evidence\n");
    expect(realFs.statSync(sibling, { bigint: true }).mtimeNs).toBe(before);
  },
);

test.each(["open", "write", "sync", "close", "link"] as const)(
  "summary %s failure is controlled and never publishes report JSON",
  (phase) => {
    const failure = new Error("private-native-publication-payload");
    let fd: number | undefined;
    vi.mocked(fs.openSync).mockImplementation((...args) => {
      if (phase === "open") throw failure;
      fd = realFs.openSync(...args);
      return fd;
    });
    if (phase === "write")
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw failure;
      });
    if (phase === "sync")
      vi.mocked(fs.fsyncSync).mockImplementation(() => {
        throw failure;
      });
    if (phase === "close")
      vi.mocked(fs.closeSync).mockImplementationOnce(() => {
        throw failure;
      });
    if (phase === "link")
      vi.mocked(fs.linkSync).mockImplementation(() => {
        throw failure;
      });
    let caught: unknown;
    try {
      createEvidenceReport(root, fields, summary);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkspaceRecordError);
    expect(caught).toMatchObject({ stage: "write", path: `reports/${firstId}.sensitivity.json` });
    expect(String(caught)).toContain("sensitivity_summary");
    expect(String(caught)).not.toContain("private-native-publication-payload");
    expect(caught).not.toHaveProperty("cause");
    expect(realFs.existsSync(jsonPath)).toBe(false);
    expect(realFs.readdirSync(directory)).toEqual([]);
    expect(fs.renameSync).not.toHaveBeenCalled();
    if (fd !== undefined) expect(() => realFs.fstatSync(fd)).toThrow();
  },
);

test("exclusive link collision preserves the new foreign target and does not retry allocation", () => {
  let mtimeNs: bigint | undefined;
  vi.mocked(fs.linkSync).mockImplementation((source, target) => {
    realFs.writeFileSync(target, "foreign exclusive target\n");
    mtimeNs = realFs.statSync(target, { bigint: true }).mtimeNs;
    realFs.linkSync(source, target);
  });
  expect(() => createEvidenceReport(root, fields, summary)).toThrow(/sensitivity_summary/u);
  expect(realFs.readFileSync(summaryPath, "utf8")).toBe("foreign exclusive target\n");
  expect(realFs.statSync(summaryPath, { bigint: true }).mtimeNs).toBe(mtimeNs);
  expect(realFs.readdirSync(directory)).toEqual([`${firstId}.sensitivity.json`]);
  expect(entropy.suffixes).toEqual(["0002"]);
});

test("a committed summary cleanup failure retains its name but never commits report JSON", () => {
  vi.mocked(fs.unlinkSync).mockImplementation(() => {
    throw new Error("cleanup fault");
  });
  expect(() => createEvidenceReport(root, fields, summary)).toThrow(/sensitivity_summary/u);
  expect(realFs.readFileSync(summaryPath, "utf8")).toBe(EXPECTED_SUMMARY_BYTES);
  expect(realFs.existsSync(jsonPath)).toBe(false);
  expect(fs.renameSync).not.toHaveBeenCalled();
  expect(fs.unlinkSync).toHaveBeenCalledTimes(1);
});

test("JSON failure retains an immutable orphan and the next allocation skips its id", () => {
  let orphanMtime: bigint | undefined;
  vi.mocked(fs.renameSync).mockImplementationOnce(() => {
    orphanMtime = realFs.statSync(summaryPath, { bigint: true }).mtimeNs;
    throw new Error("JSON commit fault");
  });
  expect(() => createEvidenceReport(root, fields, summary)).toThrow(WorkspaceRecordError);
  expect(realFs.readdirSync(directory)).toEqual([`${firstId}.sensitivity.json`]);
  expect(realFs.readFileSync(summaryPath, "utf8")).toBe(EXPECTED_SUMMARY_BYTES);
  expect(realFs.statSync(summaryPath, { bigint: true }).mtimeNs).toBe(orphanMtime);
  entropy.suffixes = ["0001", "0002"];
  const report = createEvidenceReport(root, fields, summary);
  expect(report.report_id).toBe(nextId);
  expect(realFs.readFileSync(summaryPath, "utf8")).toBe(EXPECTED_SUMMARY_BYTES);
  expect(realFs.statSync(summaryPath, { bigint: true }).mtimeNs).toBe(orphanMtime);
  expect(realFs.existsSync(jsonPath)).toBe(false);
  expect(realFs.existsSync(join(directory, `${firstId}.md`))).toBe(false);
});

test.each(["task", "analysis", "run", "wire", "reference", "report"] as const)(
  "invalid %s data is rejected before filesystem publication",
  (kind) => {
    if (kind === "task") fields.task_id = makeEvidenceReport().task_id;
    if (kind === "analysis") fields.analysis_ids = [];
    if (kind === "run") fields.linked_runs = [summary.rows[0].run_id];
    if (kind === "wire") summary.rows[1].delta_peak_day = Infinity;
    if (kind === "reference")
      fields.sensitivity_summary = {
        path: `reports/${firstId}.sensitivity.json`,
        sha256: EXPECTED_SUMMARY_SHA256,
      };
    if (kind === "report") fields.summary = "";
    expect(() => createEvidenceReport(root, fields, summary)).toThrow(WorkspaceRecordError);
    expect(realFs.readdirSync(root)).toEqual([]);
    expect(fs.openSync).not.toHaveBeenCalled();
  },
);

test.each(["symlink", "dangling-link", "fifo", "directory"] as const)(
  "unsafe %s summary siblings fail closed for sensitivity and legacy allocations",
  (kind) => {
    realFs.mkdirSync(directory);
    const outside = join(root, "outside");
    realFs.writeFileSync(outside, "outside evidence\n");
    const before = realFs.statSync(outside, { bigint: true }).mtimeNs;
    installUnsafe(summaryPath, kind, outside);
    expect(() => createEvidenceReport(root, fields, summary)).toThrow(WorkspaceRecordError);
    entropy.suffixes = ["0001", "0002"];
    expect(() => createEvidenceReport(root, makeEvidenceReport())).toThrow(WorkspaceRecordError);
    expect(realFs.readdirSync(directory)).toEqual([`${firstId}.sensitivity.json`]);
    expect(realFs.readFileSync(outside, "utf8")).toBe("outside evidence\n");
    expect(realFs.statSync(outside, { bigint: true }).mtimeNs).toBe(before);
  },
);

test("a symlinked reports root cannot publish into its target", () => {
  const outside = join(root, "outside");
  realFs.mkdirSync(outside);
  realFs.symlinkSync(outside, directory);
  expect(() => createEvidenceReport(root, fields, summary)).toThrow(WorkspaceRecordError);
  expect(realFs.readdirSync(outside)).toEqual([]);
});

test("identical inputs publish identical summary bytes under different report ids and workspaces", () => {
  const first = createEvidenceReport(root, fields, summary);
  const other = join(root, "relocated");
  const second = createEvidenceReport(other, fields, summary);
  expect(first.report_id).not.toBe(second.report_id);
  expect(realFs.readFileSync(join(root, first.sensitivity_summary!.path), "utf8")).toBe(
    EXPECTED_SUMMARY_BYTES,
  );
  expect(realFs.readFileSync(join(other, second.sensitivity_summary!.path), "utf8")).toBe(
    EXPECTED_SUMMARY_BYTES,
  );
  expect(first.sensitivity_summary!.sha256).toBe(second.sensitivity_summary!.sha256);
});

test("an occupied exclusive temporary file remains foreign evidence after open failure", () => {
  let temporary: fs.PathLike | undefined;
  let mtimeNs: bigint | undefined;
  vi.mocked(fs.openSync).mockImplementation((path, flags, mode) => {
    temporary = path;
    realFs.writeFileSync(path, "foreign temporary evidence\n");
    mtimeNs = realFs.statSync(path, { bigint: true }).mtimeNs;
    return realFs.openSync(path, flags, mode);
  });
  expect(() => createEvidenceReport(root, fields, summary)).toThrow(/sensitivity_summary/u);
  expect(temporary).toBeDefined();
  expect(realFs.readFileSync(temporary!, "utf8")).toBe("foreign temporary evidence\n");
  expect(realFs.statSync(temporary!, { bigint: true }).mtimeNs).toBe(mtimeNs);
  expect(realFs.existsSync(jsonPath)).toBe(false);
  expect(realFs.existsSync(summaryPath)).toBe(false);
  expect(fs.unlinkSync).not.toHaveBeenCalled();
});

test("summary publication follows physical alias-parent traversal without populating lexical decoys", () => {
  const physical = join(root, "workspace");
  realFs.mkdirSync(join(physical, "child"), { recursive: true });
  const alias = join(root, "alias");
  realFs.symlinkSync(join(physical, "child"), alias);
  const report = createEvidenceReport(`${alias}/..`, fields, summary);
  expect(realFs.readFileSync(join(physical, report.sensitivity_summary!.path), "utf8")).toBe(
    EXPECTED_SUMMARY_BYTES,
  );
  expect(realFs.existsSync(directory)).toBe(false);
  expect(readReferencedSensitivitySummary(`${alias}/..`, report)).toEqual(summary);
});
