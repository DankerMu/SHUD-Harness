import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import type * as NodeFs from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderReport, ReportRenderError, validateReport } from "./index.ts";
import {
  makeMetricReportWorkspace,
  type MetricReportWorkspace,
} from "./report-metrics-test-harness.ts";
import { digest, snapshotTree } from "./run-metrics-test-harness.ts";
import { realFs } from "./report-validation-test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    lstatSync: vi.fn(actual.lstatSync),
    openSync: vi.fn(actual.openSync),
  };
});

let workspace: MetricReportWorkspace;
let source: { path: string; relativePath: string; bytes: string; sha256: string };
beforeEach(() => {
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(realFs.readFileSync);
  vi.mocked(fs.lstatSync).mockReset().mockImplementation(realFs.lstatSync);
  vi.mocked(fs.openSync).mockReset().mockImplementation(realFs.openSync);
  workspace = makeMetricReportWorkspace();
  source = workspace.publishMetrics(0);
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
  realFs.rmSync(workspace.root, { recursive: true, force: true });
});

test.each([
  "missing",
  "digest",
  "json",
  "shape",
  "verdict",
  "link",
  "directory",
  "fifo",
  "read",
] as const)(
  "%s referenced metrics fail rendering and validator projection without changing evidence",
  (kind) => {
    if (["missing", "link", "directory", "fifo"].includes(kind)) realFs.unlinkSync(source.path);
    if (kind === "link") {
      const outside = join(workspace.root, "outside.json");
      realFs.writeFileSync(outside, source.bytes);
      realFs.symlinkSync(outside, source.path);
    }
    if (kind === "directory") realFs.mkdirSync(source.path);
    if (kind === "fifo") execFileSync("mkfifo", [source.path]);
    if (kind === "digest") realFs.appendFileSync(source.path, " ");
    if (kind === "read") {
      vi.mocked(fs.openSync).mockImplementation(() => {
        throw Object.assign(new Error("private metric read error"), { code: "EACCES" });
      });
    }
    if (kind === "json" || kind === "shape" || kind === "verdict") {
      const bytes =
        kind === "json"
          ? "{"
          : kind === "shape"
            ? "{}"
            : source.bytes.replace(
                '"water_balance_residual":"pass"',
                '"water_balance_residual":"fail"',
              );
      realFs.writeFileSync(source.path, bytes);
      workspace.fixture.runs[0].artifacts.metrics_summary = {
        path: "metrics.json",
        sha256: digest(bytes),
      };
      workspace.publishFixture();
    }
    const before = snapshotTree(workspace.root);
    const stage =
      kind === "missing" || kind === "read"
        ? kind
        : ["link", "directory", "fifo"].includes(kind)
          ? "target"
          : "parse";
    let failure: unknown;
    try {
      renderReport(workspace.cwd, workspace.fixture.report.report_id);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ReportRenderError);
    expect(failure).toMatchObject({ stage, path: source.relativePath });
    expect(String(failure)).toContain(source.relativePath);
    expect(String(failure)).not.toContain("private metric read error");
    const validation = validateReport(workspace.cwd, workspace.fixture.report.report_id);
    expect(validation.ok).toBe(false);
    expect(validation.checks).toHaveLength(15);
    expect(validation.checks.find(({ id }) => id === 8)?.details).toContainEqual({
      code: "render_unavailable",
      stage,
    });
    expect(snapshotTree(workspace.root)).toEqual(before);
    if (["missing", "link", "directory", "fifo"].includes(kind)) {
      expect(fs.openSync).not.toHaveBeenCalled();
    }
  },
);

test.each(["runs", "run"] as const)(
  "persistent %s replacement after record validation cannot open valid foreign metrics",
  (target) => {
    const managed = target === "runs" ? join(workspace.cwd, "runs") : dirname(source.path);
    const outside = join(workspace.root, "outside");
    realFs.cpSync(managed, outside, { recursive: true });
    let recordsRead = 0;
    let replaced = false;
    vi.mocked(fs.readFileSync).mockImplementation((...args) => {
      const bytes = realFs.readFileSync(...args);
      if (String(args[0]).endsWith("/run-record.json") && ++recordsRead === 2) {
        realFs.renameSync(managed, `${managed}-held`);
        realFs.symlinkSync(outside, managed);
        replaced = true;
      }
      return bytes;
    });
    expect(() => renderReport(workspace.cwd, workspace.fixture.report.report_id)).toThrow(
      source.relativePath,
    );
    expect(replaced).toBe(true);
    // Both lexical opens through the replaced path and physical outside opens are forbidden.
    expect(fs.openSync).not.toHaveBeenCalled();
    const foreignMetrics = join(
      outside,
      target === "runs" ? `${workspace.fixture.runs[0].run_id}/metrics.json` : "metrics.json",
    );
    expect(realFs.readFileSync(foreignMetrics, "utf8")).toBe(source.bytes);
  },
);

test.each(["runs", "run"] as const)(
  "persistent %s replacement during target inspection is refused before descriptor open",
  (target) => {
    const managed = target === "runs" ? join(workspace.cwd, "runs") : dirname(source.path);
    const outside = join(workspace.root, "outside");
    realFs.cpSync(managed, outside, { recursive: true });
    let replaced = false;
    vi.mocked(fs.lstatSync).mockImplementation((...args) => {
      const stat = realFs.lstatSync(...args);
      if (!replaced && String(args[0]).endsWith("/metrics.json")) {
        realFs.renameSync(managed, `${managed}-held`);
        realFs.symlinkSync(outside, managed);
        replaced = true;
      }
      return stat;
    });
    expect(() => renderReport(workspace.cwd, workspace.fixture.report.report_id)).toThrow(
      source.relativePath,
    );
    expect(replaced).toBe(true);
    expect(fs.openSync).not.toHaveBeenCalled();
  },
);
