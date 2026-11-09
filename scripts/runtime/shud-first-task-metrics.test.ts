import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
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
});

test.each(["old sentence", "missing run segment"] as const)(
  "first-task oracle rejects %s with otherwise valid null-metric evidence",
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
