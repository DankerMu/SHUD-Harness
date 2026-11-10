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
import { snapshotReportMetricFacts } from "./shud-report-metrics.ts";

// Independent oracle value from the known-answer-replay spec (PI 2026-11-09, #662 option A).
const MESH_PARSE_REASON = "parse:input/keliya/keliya.sp.mesh";

let workspace: string;
beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "replay-metrics-")));
});
afterEach(() => rmSync(workspace, { recursive: true, force: true }));

function capturedReplay() {
  const fixture = makeReplayFixture();
  // Non-canonical padding proves the oracle hashes and decodes the original captured bytes.
  const bytes = `\n ${JSON.stringify(replayRunMetrics(), null, 2)}\t\n`;
  for (const { record } of fixture.runs) {
    record.artifacts.metrics_summary = { path: "metrics.json", sha256: digest(bytes) };
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
  const markdown = String(fixture.files[markdownPath]);
  expect(markdown.match(/\| unavailable \|/gu)).toHaveLength(2);
  expect(markdown).toContain(`null (${MESH_PARSE_REASON})`);
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

test("replay oracle accepts keliya runs pinned unavailable by the mesh parse reason", () => {
  const fixture = makeReplayFixture();
  const facts = snapshotReportMetricFacts(
    fixture.files,
    fixture.runs.map(({ record }) => record),
  );
  for (const [index, { record }] of fixture.runs.entries()) {
    expect(record.artifacts.metrics_summary).not.toBeNull();
    expect(record.numerical_health).toEqual({
      water_balance_residual: null,
      cvode_failures: null,
      negative_state_count: null,
      max_solver_dt: null,
    });
    expect(facts[index].metrics?.status).toBe("unavailable");
    expect(facts[index].metrics?.reason).toBe(MESH_PARSE_REASON);
  }
  expect(assertReplayEvidence(fixture.snapshot).status).toBe("PASS");
});

type Fixture = ReturnType<typeof makeReplayFixture>;
const observedHealth = {
  water_balance_residual: 0.01,
  cvode_failures: 1,
  negative_state_count: 1,
  max_solver_dt: 30,
} as const;

test.each([
  [
    "a null metrics summary",
    /metrics_summary must be non-null/u,
    (fixture: Fixture, index: number) => {
      const { record } = fixture.runs[index];
      record.artifacts.metrics_summary = null;
      delete fixture.files[`runs/${record.run_id}/metrics.json`];
    },
  ],
  [
    "status ok metrics",
    /Metrics status runs\/RUN-[^/]+\/metrics\.json: must be unavailable/u,
    (fixture: Fixture, index: number) =>
      bindReplayMetrics(fixture.files, fixture.runs[index].record, completeMetrics()),
  ],
  [
    "a different unavailable reason",
    /Metrics reason runs\/RUN-[^/]+\/metrics\.json: must equal parse:input\/keliya\/keliya\.sp\.mesh/u,
    (fixture: Fixture, index: number) =>
      bindReplayMetrics(
        fixture.files,
        fixture.runs[index].record,
        replayRunMetrics("parse:input/keliya/keliya.sp.riv"),
      ),
  ],
  ...Object.entries(observedHealth).map(
    ([field, value]) =>
      [
        `an observed ${field}`,
        new RegExp(`RunRecord RUN-[^:]+: numerical_health\\.${field} must be null`, "u"),
        (fixture: Fixture, index: number) => {
          Object.assign(fixture.runs[index].record.numerical_health, { [field]: value });
        },
      ] as const,
  ),
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
