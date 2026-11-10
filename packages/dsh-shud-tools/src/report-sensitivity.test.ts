import * as fs from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  COVERAGE,
  MAX_SOLVER_DT,
  PARAMETER_RANGE,
} from "../../dsh-shud-records/src/report-sensitivity-test-harness.ts";
import { readCard } from "./analysis-create/test-harness.ts";
import { treeOrAbsent } from "./task-linked/test-harness.ts";
import {
  DRAFT,
  generated,
  reportHarness,
  reportPath,
  resultValue,
  seedEvidence,
} from "./report-workflow/test-harness.ts";
import {
  seedAcceptanceBatch,
  sensitivityHarness,
  sha256,
  warnMetrics,
  type SensitivityHarness,
} from "./report-sensitivity/test-harness.ts";

let h: SensitivityHarness;
beforeEach(async () => {
  h = await sensitivityHarness();
});
afterEach(async () => {
  await h.dispose();
});

function reportFiles() {
  const root = join(h.cwd, "reports");
  return fs.existsSync(root) ? fs.readdirSync(root).sort() : null;
}

function readSummary(id: string) {
  const bytes = fs.readFileSync(reportPath(h, id, "sensitivity.json"));
  return {
    bytes,
    value: JSON.parse(bytes.toString("utf8")) as {
      analysis_plan_id: string;
      plan_sha256: string;
      rows: Array<{ parameter_set_id: string; run_id: string; status: string }>;
      superseded_runs: Array<{
        parameter_set_id: string;
        job_id: string;
        run_id: string;
        terminal_state: string;
        exit_class: string | null;
      }>;
    },
  };
}

test("sensitivity draft publishes summary, JSON and Markdown with plan links and fixed limitations", async () => {
  const runs = await seedAcceptanceBatch(h);
  const card = readCard(h);
  expect(card.linked_analyses).toEqual([h.plan]);
  const collect = vi.spyOn(h.registry, "collectShud");
  const report = generated(h, await h.generate());
  const id = report.report_id;
  expect(reportFiles()).toEqual([`${id}.json`, `${id}.md`, `${id}.sensitivity.json`]);
  expect(report.analysis_ids).toEqual(card.linked_analyses);
  const summary = readSummary(id);
  expect(report.sensitivity_summary).toEqual({
    path: `reports/${id}.sensitivity.json`,
    sha256: sha256(summary.bytes),
  });
  // The digest identifies the exact non-canonical plan file bytes, not a re-serialization.
  expect(h.planBytes.at(-1)).not.toBe(0x0a);
  expect(summary.value.analysis_plan_id).toBe(h.plan);
  expect(summary.value.plan_sha256).toBe(sha256(h.planBytes));
  expect(summary.value.plan_sha256).not.toBe(
    sha256(JSON.stringify(JSON.parse(h.planBytes.toString("utf8")))),
  );
  expect(report.limitations).toEqual([
    ...DRAFT.limitations,
    COVERAGE,
    PARAMETER_RANGE,
    MAX_SOLVER_DT,
  ]);
  expect(report.linked_runs).toEqual(runs.map(({ job }) => job.run_id));
  expect(summary.value.rows.map((row) => row.run_id)).toEqual(runs.map(({ job }) => job.run_id));
  expect(collect.mock.calls).toEqual(runs.map(({ job }) => [job.job_id, { readonly: true }]));
  expect(readCard(h)).toEqual({
    ...card,
    status: "reporting",
    runtime_phase: null,
    linked_reports: [id],
    updated_at: readCard(h).updated_at,
  });
  const validation = resultValue(await h.invoke("report_validate", { report_id: id }));
  expect(validation).toMatchObject({ report_id: id, status: "reviewed", ok: true });
});

test("a relative session cwd still publishes the sensitivity summary from the plan bytes", async () => {
  await seedAcceptanceBatch(h);
  const previous = process.cwd();
  const header = h.agent.session.header;
  try {
    process.chdir(dirname(h.cwd));
    Object.assign(header, { cwd: basename(h.cwd) });
    const report = generated(h, await h.generate());
    const id = report.report_id;
    expect(reportFiles()).toEqual([`${id}.json`, `${id}.md`, `${id}.sensitivity.json`]);
    expect(report.sensitivity_summary).toEqual({
      path: `reports/${id}.sensitivity.json`,
      sha256: sha256(readSummary(id).bytes),
    });
  } finally {
    process.chdir(previous);
    Object.assign(header, { cwd: h.cwd });
  }
});

test("failed cells and superseded collected runs stay in linked_runs with limitations kinds 1 to 5", async () => {
  // PSET-2 failed (0002) then succeeded (0004); PSET-3's effective run failed with cvode.
  const runs = [
    await h.seedRun("0001", "PSET-1", "succeeded"),
    await h.seedRun("0002", "PSET-2", "failed"),
    await h.seedRun("0003", "PSET-3", "failed"),
    await h.seedRun("0004", "PSET-2", "succeeded"),
    await h.seedRun("0005", "PSET-4", "succeeded", warnMetrics()),
  ];
  h.link(runs);
  const report = generated(h, await h.generate());
  const [, superseded, failedCell, , warned] = runs.map(({ job }) => job.run_id);
  expect(report.limitations).toEqual([
    ...DRAFT.limitations,
    COVERAGE,
    PARAMETER_RANGE,
    MAX_SOLVER_DT,
    `运行 ${warned} 的 water_balance_residual 判定为 warn，值或原因为 0.02`,
    `参数集 PSET-3 的运行 ${failedCell} 失败（exit_code: 19，exit_class: cvode），该 cell 不参与相对 baseline 的比较`,
  ]);
  expect(report.limitations.filter((entry) => entry === MAX_SOLVER_DT)).toHaveLength(1);
  expect(report.limitations.some((entry) => entry.includes(`运行 ${failedCell} 的`))).toBe(false);
  expect(report.linked_runs).toEqual(runs.map(({ job }) => job.run_id));
  const summary = readSummary(report.report_id).value;
  expect(summary.rows.map((row) => [row.parameter_set_id, row.run_id, row.status])).toEqual([
    ["PSET-1", runs[0].job.run_id, "succeeded"],
    ["PSET-2", runs[3].job.run_id, "succeeded"],
    ["PSET-3", failedCell, "failed"],
    ["PSET-4", warned, "succeeded"],
  ]);
  expect(summary.superseded_runs).toEqual([
    {
      parameter_set_id: "PSET-2",
      job_id: runs[1].job.job_id,
      run_id: superseded,
      terminal_state: "collected",
      exit_class: "cvode",
    },
  ]);
  // Every superseded run that has a RunRecord is listed in the report's linked_runs.
  for (const entry of summary.superseded_runs.filter((run) => run.exit_class !== null)) {
    expect(report.linked_runs).toContain(entry.run_id);
  }
});

test.each([
  ["uncollected-failed", "failed"],
  ["exhausted", "collect_exhausted"],
] as const)(
  "an uncollected %s superseded job is summarized but not linked, collected or touched",
  async (kind, terminalState) => {
    const runs = [
      await h.seedRun("0001", "PSET-1", "succeeded"),
      await h.seedRun("0002", "PSET-2", kind),
      await h.seedRun("0003", "PSET-2", "succeeded"),
      await h.seedRun("0004", "PSET-3", "succeeded"),
      await h.seedRun("0005", "PSET-4", "succeeded"),
    ];
    h.link(runs);
    const uncollected = runs[1].job;
    const before = await treeOrAbsent(uncollected.run_dir);
    const collect = vi.spyOn(h.registry, "collectShud");
    const report = generated(h, await h.generate());
    expect(report.linked_runs).toEqual(
      runs.filter((_, index) => index !== 1).map(({ job }) => job.run_id),
    );
    expect(readSummary(report.report_id).value.superseded_runs).toEqual([
      {
        parameter_set_id: "PSET-2",
        job_id: uncollected.job_id,
        run_id: uncollected.run_id,
        terminal_state: terminalState,
        exit_class: null,
      },
    ]);
    for (const [id] of collect.mock.calls) {
      expect([uncollected.job_id, uncollected.run_id]).not.toContain(id);
    }
    expect(await treeOrAbsent(uncollected.run_dir)).toEqual(before);
    expect(fs.existsSync(join(uncollected.run_dir, "run-record.json"))).toBe(false);
    expect(fs.existsSync(join(uncollected.run_dir, "collect-error.json"))).toBe(
      kind === "exhausted",
    );
  },
);

test("science_assist reports keep empty analysis links, no summary companion and no no-metrics text", async () => {
  const science = await reportHarness();
  try {
    await seedEvidence(science);
    const report = generated(science, await science.invoke("report_generate", DRAFT));
    expect(report.analysis_ids).toEqual([]);
    expect(report.sensitivity_summary).toBeNull();
    expect(report.limitations.join("\n")).not.toContain("无指标 artifact");
    expect(fs.readdirSync(join(science.cwd, "reports")).sort()).toEqual([
      `${report.report_id}.json`,
      `${report.report_id}.md`,
    ]);
  } finally {
    await science.dispose();
  }
});
