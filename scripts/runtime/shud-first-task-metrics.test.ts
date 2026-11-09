import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { RunRecord } from "../../packages/dsh-shud-core/src/schemas/index.ts";
import {
  completeMetrics,
  digest,
} from "../../packages/dsh-shud-records/src/run-metrics-test-harness.ts";
import { makeFirstTaskFixture } from "./first-task/test-harness.ts";
import { assertFirstTaskEvidence } from "./shud-first-task-evidence.ts";
import { snapshotFirstTaskFiles } from "./shud-first-task.ts";

let workspace: string;
beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "first-task-metrics-")));
});
afterEach(() => rmSync(workspace, { recursive: true, force: true }));

test("first-task collector retains original non-null metric bytes and the oracle projects their bound values", () => {
  const metrics = completeMetrics();
  metrics.flow.peak_flow_m3d = 123456.789;
  const bytes = ` \n${JSON.stringify(metrics, null, 2)}\n\t`;
  const fixture = makeFirstTaskFixture(workspace, bytes);
  const path = `runs/${fixture.record.run_id}/metrics.json`;
  expect(fixture.evidence.files[path]).toEqual({
    bytes_base64: Buffer.from(bytes).toString("base64"),
    sha256: digest(bytes),
    size_bytes: Buffer.byteLength(bytes),
  });
  expect(digest(bytes)).not.toBe(digest(JSON.stringify(metrics)));
  expect(fixture.evidence.files[fixture.markdownPath]).toContain("| 123456.789 |");
  expect(fixture.evidence.files[fixture.markdownPath]).toContain(digest(bytes));
  expect(assertFirstTaskEvidence(fixture.evidence).criteria.canonicalMarkdown).toBe(true);
});

test("first-task oracle rejects recollected metric bytes that no longer match the run digest and names the file", () => {
  const bytes = JSON.stringify(completeMetrics());
  const fixture = makeFirstTaskFixture(workspace, bytes);
  const path = `runs/${fixture.record.run_id}/metrics.json`;
  writeFileSync(join(workspace, path), `${bytes} `);
  fixture.evidence.files = snapshotFirstTaskFiles(workspace);
  expect(() => assertFirstTaskEvidence(fixture.evidence)).toThrow(path);
  expect(() => assertFirstTaskEvidence(fixture.evidence)).toThrow(
    expect.objectContaining({ code: "FIRST_TASK_METRICS_DIGEST" }),
  );
});

test("first-task oracle accepts the ccw run's bound non-null collect-time metrics", () => {
  const fixture = makeFirstTaskFixture(workspace);
  expect(fixture.record.artifacts.metrics_summary).not.toBeNull();
  expect(assertFirstTaskEvidence(fixture.evidence).criteria.runMetrics).toBe(true);
});

const nullHealth = (field: keyof RunRecord["numerical_health"]) => (record: RunRecord) => {
  record.numerical_health[field] = null;
};
test.each([
  ["METRICS_RESIDUAL", "null water_balance_residual", nullHealth("water_balance_residual")],
  ["METRICS_CVODE", "null cvode_failures", nullHealth("cvode_failures")],
  ["METRICS_NEGATIVE", "null negative_state_count", nullHealth("negative_state_count")],
  [
    "METRICS_MAX_SOLVER_DT",
    "an observed max_solver_dt",
    (record: RunRecord) => {
      record.numerical_health.max_solver_dt = 30;
    },
  ],
] as const)(
  "first-task oracle names %s for %s on an otherwise accepted run",
  (criterion, _kind, adjust) => {
    const fixture = makeFirstTaskFixture(workspace, JSON.stringify(completeMetrics()), adjust);
    expect(() => assertFirstTaskEvidence(fixture.evidence)).toThrow(
      expect.objectContaining({ code: `FIRST_TASK_${criterion}` }),
    );
  },
);

test("first-task oracle names METRICS_SUMMARY when the run has no metrics summary", () => {
  const fixture = makeFirstTaskFixture(workspace, null, (record) => {
    record.numerical_health = {
      water_balance_residual: 0.01,
      cvode_failures: 2,
      negative_state_count: 3,
      max_solver_dt: null,
    };
  });
  expect(() => assertFirstTaskEvidence(fixture.evidence)).toThrow(
    expect.objectContaining({ code: "FIRST_TASK_METRICS_SUMMARY" }),
  );
});

test("first-task oracle names METRICS_DIGEST and the file when metrics.json is absent", () => {
  const fixture = makeFirstTaskFixture(workspace);
  const path = `runs/${fixture.record.run_id}/metrics.json`;
  rmSync(join(workspace, path));
  fixture.evidence.files = snapshotFirstTaskFiles(workspace);
  expect(() => assertFirstTaskEvidence(fixture.evidence)).toThrow(path);
  expect(() => assertFirstTaskEvidence(fixture.evidence)).toThrow(
    expect.objectContaining({ code: "FIRST_TASK_METRICS_DIGEST" }),
  );
});

test.each(["old sentence", "missing run segment"] as const)(
  "first-task oracle rejects %s with otherwise valid metric evidence",
  (kind) => {
    const fixture = makeFirstTaskFixture(workspace);
    expect(assertFirstTaskEvidence(fixture.evidence).criteria.canonicalMarkdown).toBe(true);
    const markdown = String(fixture.evidence.files[fixture.markdownPath]);
    fixture.evidence.files[fixture.markdownPath] = markdown.replace(
      /(?<=## 5\. 指标与图表\n\n)[\s\S]*?(?=\n\n## 6\.)/u,
      kind === "old sentence" ? "本里程碑无指标 artifact，见 limitations" : "",
    );
    expect(() => assertFirstTaskEvidence(fixture.evidence)).toThrow("MARKDOWN");
  },
);
