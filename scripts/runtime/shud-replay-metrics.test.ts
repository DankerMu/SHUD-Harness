import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  completeMetrics,
  digest,
} from "../../packages/dsh-shud-records/src/run-metrics-test-harness.ts";
import {
  bindReplayMetrics,
  makeReplayFixture,
  refreshReplayRunArtifacts,
  replayRunMetrics,
} from "./replay/test-harness.ts";
import { assertReplayEvidence } from "./shud-replay-evidence.ts";
import { collectReplayFiles } from "./shud-replay-snapshot.ts";
import { captureReportMetrics } from "./shud-web-driver.ts";

let workspace: string;
beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "replay-metrics-")));
});
afterEach(() => rmSync(workspace, { recursive: true, force: true }));

function capturedReplay() {
  const fixture = makeReplayFixture();
  const metrics = replayRunMetrics();
  metrics.flow.peak_flow_m3d = 123456.789;
  const bytes = `\n ${JSON.stringify(metrics, null, 2)}\t\n`;
  for (const { record } of fixture.runs) {
    record.artifacts.metrics_summary = { path: "metrics.json", sha256: digest(bytes) };
    record.numerical_health.water_balance_residual = null;
    fixture.files[`runs/${record.run_id}/metrics.json`] = bytes;
  }
  for (const [relative, value] of Object.entries(fixture.files)) {
    const path = join(workspace, relative);
    mkdirSync(dirname(path), { recursive: true });
    // Retained raw bytes (the prepared cfg.para receipt) are written back as those bytes.
    const captured = value as { bytes_base64?: unknown };
    writeFileSync(
      path,
      typeof value === "string"
        ? value
        : typeof captured.bytes_base64 === "string"
          ? Buffer.from(captured.bytes_base64, "base64")
          : JSON.stringify(value),
    );
  }
  Object.assign(fixture.files, collectReplayFiles(workspace));
  refreshReplayRunArtifacts(fixture);
  const markdownPath = `reports/${fixture.report.report_id}.md`;
  writeFileSync(join(workspace, markdownPath), String(fixture.files[markdownPath]));
  return { fixture, bytes, markdownPath };
}

test("replay collector retains each original metric byte stream for the oracle's pure projection", () => {
  const { fixture, bytes, markdownPath } = capturedReplay();
  for (const { record } of fixture.runs) {
    expect(fixture.files[`runs/${record.run_id}/metrics.json`]).toEqual({
      bytes_base64: Buffer.from(bytes).toString("base64"),
      sha256: digest(bytes),
      size_bytes: Buffer.byteLength(bytes),
    });
  }
  expect(digest(bytes)).not.toBe(digest(bytes.trim()));
  expect(String(fixture.files[markdownPath]).match(/\| 123456\.789 \|/gu)).toHaveLength(2);
  expect(fixture.files[markdownPath]).toContain(digest(bytes));
  expect(assertReplayEvidence(fixture.snapshot).status).toBe("PASS");
});

test.each([0, 1])(
  "replay oracle rejects recollected run %s digest mismatch and names metrics.json",
  (index) => {
    const { fixture, bytes } = capturedReplay();
    const path = `runs/${fixture.runs[index].record.run_id}/metrics.json`;
    writeFileSync(join(workspace, path), `${bytes} `);
    Object.assign(fixture.files, collectReplayFiles(workspace));
    expect(() => assertReplayEvidence(fixture.snapshot)).toThrow(path);
  },
);

test("replay oracle accepts keliya runs with a missing-variable residual and bound summaries", () => {
  const fixture = makeReplayFixture();
  for (const { record } of fixture.runs) {
    expect(record.artifacts.metrics_summary).not.toBeNull();
    expect(record.numerical_health.water_balance_residual).toBeNull();
  }
  expect(assertReplayEvidence(fixture.snapshot).status).toBe("PASS");
});

test.each([
  [
    "a null metrics summary",
    /metrics_summary/u,
    (fixture: ReturnType<typeof makeReplayFixture>, index: number) => {
      const { record } = fixture.runs[index];
      record.artifacts.metrics_summary = null;
      delete fixture.files[`runs/${record.run_id}/metrics.json`];
    },
  ],
  [
    "a non-null residual",
    /water_balance_residual/u,
    (fixture: ReturnType<typeof makeReplayFixture>, index: number) =>
      bindReplayMetrics(fixture.files, fixture.runs[index].record, completeMetrics()),
  ],
  [
    "a residual reason that is not a missing variable",
    /missing_variable/u,
    (fixture: ReturnType<typeof makeReplayFixture>, index: number) =>
      bindReplayMetrics(
        fixture.files,
        fixture.runs[index].record,
        replayRunMetrics("nonfinite:eleygw"),
      ),
  ],
  [
    "an observed max_solver_dt",
    /max_solver_dt/u,
    (fixture: ReturnType<typeof makeReplayFixture>, index: number) => {
      fixture.runs[index].record.numerical_health.max_solver_dt = 30;
    },
  ],
] as const)("replay oracle rejects %s on either keliya run", (_kind, criterion, mutate) => {
  for (const index of [0, 1]) {
    const fixture = makeReplayFixture();
    mutate(fixture, index);
    refreshReplayRunArtifacts(fixture);
    expect(() => assertReplayEvidence(fixture.snapshot)).toThrow(criterion);
  }
});

test.each([0, 1])(
  "replay oracle rejects run %s metrics bytes that do not match the summary digest",
  (index) => {
    const fixture = makeReplayFixture();
    const path = `runs/${fixture.runs[index].record.run_id}/metrics.json`;
    fixture.files[path] = captureReportMetrics(
      Buffer.from(`${JSON.stringify(replayRunMetrics())} `),
    );
    expect(() => assertReplayEvidence(fixture.snapshot)).toThrow(`Metrics digest ${path}`);
  },
);

test.each(["old sentence", "missing run segment"] as const)(
  "replay oracle rejects %s with otherwise valid metric evidence",
  (kind) => {
    const fixture = makeReplayFixture();
    expect(assertReplayEvidence(fixture.snapshot).status).toBe("PASS");
    const path = `reports/${fixture.report.report_id}.md`;
    const markdown = String(fixture.files[path]);
    fixture.files[path] =
      kind === "old sentence"
        ? markdown.replace("验证判定见 §3", "本里程碑无指标 artifact；验证判定见 §3")
        : markdown.replace(/^\| RUN-[^\n]+\n/gmu, (line) =>
            line.includes("not_available") ? "" : line,
          );
    expect(() => assertReplayEvidence(fixture.snapshot)).toThrow(/Markdown/iu);
  },
);
