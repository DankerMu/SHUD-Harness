import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { EvidenceReport, RunRecord } from "@shud-harness/dsh-shud-core";
import { serializeRunMetrics } from "./index.ts";
import { makeEvidenceReport } from "./report-render-test-harness.ts";
import { makeRenderingFixture } from "./report-workspace-test-harness.ts";
import { completeMetrics, digest } from "./run-metrics-test-harness.ts";
import { makeRunJob, makeRunRecord } from "./task-lifecycle-test-harness.ts";

const PLAN_ID = "PLAN-20261108T100000-7a2b";
export const job = (n: number) => `JOB-20261108T100000-000${n}`;
export const run = (n: number) => `RUN-20261108T100000-000${n}`;

// Literal issue/spec wording; never instantiated by the code under test.
export const COVERAGE =
  "仅在 ccw 单流域、90 天窗口、相对 baseline 测试了 GEOL_KSATH×0.5, GEOL_KSATH×2, LC_ROUGH×2；未覆盖其它参数、取值与窗口";
export const PARAMETER_RANGE = "参数范围为 agent 建议值，未经 PI 确认";
export const MAX_SOLVER_DT =
  "max_solver_dt 在钉版 SHUD 中不可观测（PrintFinalStats 未被调用），各运行该项恒为 null，不作判定";
export const RUN6_WARN = `运行 ${run(6)} 的 water_balance_residual 判定为 warn，值或原因为 0.02`;
export const PSET3_FAILED = `参数集 PSET-3 的运行 ${run(4)} 失败（exit_code: 19，exit_class: cvode），该 cell 不参与相对 baseline 的比较`;
export const AUTHORED_LIMITATION = "Authored sensitivity limitation.";

/** Succeeded effective runs: [run number, peak flow, peak day, runoff, residual, verdict]. */
const SUCCEEDED = [
  [1, 185185.18349999998, 40, 0, 0.004, "pass"],
  [5, 123456.789, 43, 52.5, 0.0008, "pass"],
  [6, 210000.5, null, 1.5e-7, 0.02, "warn"],
] as const;

function metricsBytes([, peak, day, runoff, residual, verdict]: (typeof SUCCEEDED)[number]) {
  const metrics = completeMetrics();
  return serializeRunMetrics({
    ...metrics,
    flow: {
      peak_flow_m3d: peak,
      peak_day: day,
      total_runoff_m3: runoff,
      reasons: {
        peak_flow_m3d: null,
        peak_day: day === null ? "no_rising_limb" : null,
        total_runoff_m3: null,
      },
    },
    water_balance: { ...metrics.water_balance, residual },
    numerical_health: {
      ...metrics.numerical_health,
      water_balance_residual: residual,
      cvode_failures: 0,
      negative_state_count: 0,
    },
    verdicts: {
      water_balance_residual: verdict,
      cvode_failures: "pass",
      negative_state_count: "pass",
    },
  });
}

const reasons = (value: string | null) =>
  `"metric_reasons":{"peak_flow_m3d":${value},"peak_day":${value},"total_runoff_m3":${value},"water_balance_residual":${value}}`;

/**
 * Hand-authored companion: 4 psets, PSET-3's effective run failed (cvode), PSET-2's first
 * attempt (JOB-0002) is a superseded failed RunRecord and JOB-0003 a superseded job without
 * a RunRecord. Hand calculation: (123456.789 - 185185.18349999998) / 185185.18349999998 * 100
 * = -33.33333333333333; runoff baseline 0 gives zero_baseline; RUN-0006 peak_day is null.
 */
function summaryBytes(metricsSha: readonly string[]): string {
  return [
    `{"method_version":"1","analysis_plan_id":"${PLAN_ID}","plan_sha256":"${"c".repeat(64)}",`,
    `"task_id":"TASK-20261027T080005-1234","project":"ccw","end_days":90,"rows":[`,
    `{"parameter_set_id":"PSET-1","label":"baseline","baseline":true,"key":null,"multiplier":null,`,
    `"job_id":"${job(1)}","run_id":"${run(1)}","status":"succeeded","exit_code":0,"exit_class":"ok",`,
    `"peak_flow_m3d":185185.18349999998,"peak_day":40,"total_runoff_m3":0,"water_balance_residual":0.004,`,
    `"water_balance_residual_verdict":"pass",${reasons("null")},`,
    `"delta_peak_flow_pct":null,"delta_peak_day":null,"delta_total_runoff_pct":null,`,
    `"delta_reasons":{"delta_peak_flow_pct":"baseline_row","delta_peak_day":"baseline_row","delta_total_runoff_pct":"baseline_row"}},`,
    `{"parameter_set_id":"PSET-2","label":"half|KSATH","baseline":false,"key":"GEOL_KSATH","multiplier":0.5,`,
    `"job_id":"${job(5)}","run_id":"${run(5)}","status":"succeeded","exit_code":0,"exit_class":"ok",`,
    `"peak_flow_m3d":123456.789,"peak_day":43,"total_runoff_m3":52.5,"water_balance_residual":0.0008,`,
    `"water_balance_residual_verdict":"pass",${reasons("null")},`,
    `"delta_peak_flow_pct":-33.33333333333333,"delta_peak_day":3,"delta_total_runoff_pct":null,`,
    `"delta_reasons":{"delta_peak_flow_pct":null,"delta_peak_day":null,"delta_total_runoff_pct":"zero_baseline"}},`,
    `{"parameter_set_id":"PSET-3","label":null,"baseline":false,"key":"GEOL_KSATH","multiplier":2,`,
    `"job_id":"${job(4)}","run_id":"${run(4)}","status":"failed","exit_code":19,"exit_class":"cvode",`,
    `"peak_flow_m3d":null,"peak_day":null,"total_runoff_m3":null,"water_balance_residual":null,`,
    `"water_balance_residual_verdict":null,${reasons('"run_failed"')},`,
    `"delta_peak_flow_pct":null,"delta_peak_day":null,"delta_total_runoff_pct":null,`,
    `"delta_reasons":{"delta_peak_flow_pct":"run_failed","delta_peak_day":"run_failed","delta_total_runoff_pct":"run_failed"}},`,
    `{"parameter_set_id":"PSET-4","label":null,"baseline":false,"key":"LC_ROUGH","multiplier":2,`,
    `"job_id":"${job(6)}","run_id":"${run(6)}","status":"succeeded","exit_code":0,"exit_class":"ok",`,
    `"peak_flow_m3d":210000.5,"peak_day":null,"total_runoff_m3":1.5e-7,"water_balance_residual":0.02,`,
    `"water_balance_residual_verdict":"warn","metric_reasons":{"peak_flow_m3d":null,"peak_day":"no_rising_limb","total_runoff_m3":null,"water_balance_residual":null},`,
    `"delta_peak_flow_pct":13.400271031942475,"delta_peak_day":null,"delta_total_runoff_pct":null,`,
    `"delta_reasons":{"delta_peak_flow_pct":null,"delta_peak_day":"metric_null","delta_total_runoff_pct":"zero_baseline"}}],`,
    `"superseded_runs":[{"parameter_set_id":"PSET-2","job_id":"${job(2)}","run_id":"${run(2)}","terminal_state":"collected","exit_class":"cvode"},`,
    `{"parameter_set_id":"PSET-4","job_id":"${job(3)}","run_id":"${run(3)}","terminal_state":"cancelled","exit_class":null}],`,
    `"inputs":[{"run_id":"${run(1)}","metrics_sha256":"${metricsSha[0]}"},`,
    `{"run_id":"${run(5)}","metrics_sha256":"${metricsSha[1]}"},`,
    `{"run_id":"${run(6)}","metrics_sha256":"${metricsSha[2]}"}]}\n`,
  ].join("");
}

export interface SensitivityWorkspace {
  root: string;
  cwd: string;
  report: EvidenceReport;
  runs: RunRecord[];
  summaryRelative: string;
  summaryPath: string;
  summaryBytes: string;
  publishReport(report: EvidenceReport): void;
}

/** Linked runs follow linked_jobs (job_id) order: 0001, 0002, 0004, 0005, 0006. */
export function makeSensitivityWorkspace(): SensitivityWorkspace {
  const root = mkdtempSync(join(tmpdir(), "report-sensitivity-"));
  const cwd = join(root, "workspace");
  const publish = (relative: string, bytes: string) => {
    mkdirSync(dirname(join(cwd, relative)), { recursive: true });
    writeFileSync(join(cwd, relative), bytes);
  };
  const fixture = makeRenderingFixture();
  const stack = fixture.stacks[1];
  const data = fixture.data[0];
  const shas: string[] = [];
  for (const entry of SUCCEEDED) {
    const bytes = metricsBytes(entry);
    shas.push(digest(bytes));
    publish(`runs/${run(entry[0])}/metrics.json`, bytes);
  }
  const record = (n: number, pset: string, failed: boolean, sha?: string) =>
    makeRunRecord(makeRunJob(job(n)), {
      task_id: fixture.report.task_id,
      analysis_plan_id: PLAN_ID,
      parameter_set_id: pset,
      stack_id: stack.stack_id,
      data_id: data.data_id,
      status: failed ? "failed" : "succeeded",
      exit_code: failed ? 19 : 0,
      exit_class: failed ? "cvode" : "ok",
      artifacts: {
        stdout: "stdout.log",
        stderr: "stderr.log",
        shud_output: "output",
        files: [{ path: "output/ccw.rivqdown.dat", size_bytes: 64 }],
        metrics_summary: sha === undefined ? null : { path: "metrics.json", sha256: sha },
      },
    });
  const runs = [
    record(1, "PSET-1", false, shas[0]),
    record(2, "PSET-2", true),
    record(4, "PSET-3", true),
    record(5, "PSET-2", false, shas[1]),
    record(6, "PSET-4", false, shas[2]),
  ];
  for (const value of runs) {
    publish(`runs/${value.run_id}/run-record.json`, `${JSON.stringify(value, null, 2)}\n`);
  }
  publish(`stacks/${stack.stack_id}.json`, `${JSON.stringify(stack, null, 2)}\n`);
  publish(`provenance/${data.data_id}.json`, `${JSON.stringify(data, null, 2)}\n`);
  const bytes = summaryBytes(shas);
  const summaryRelative = `reports/${fixture.report.report_id}.sensitivity.json`;
  publish(summaryRelative, bytes);
  const report = makeEvidenceReport({
    summary: "Four parameter sets were run relative to one baseline.",
    observations: ["Section 5 lists stored per-run metrics and relative deltas."],
    limitations: [
      AUTHORED_LIMITATION,
      COVERAGE,
      PARAMETER_RANGE,
      MAX_SOLVER_DT,
      RUN6_WARN,
      PSET3_FAILED,
    ],
    pi_questions: ["Review the stored sensitivity facts?"],
    linked_runs: runs.map((value) => value.run_id),
    stack_ids: [stack.stack_id],
    data_ids: [data.data_id],
    llm_response_models: ["fixture-model"],
    analysis_ids: [PLAN_ID],
    sensitivity_summary: { path: summaryRelative, sha256: digest(bytes) },
  } as Partial<EvidenceReport>);
  const publishReport = (value: EvidenceReport) =>
    publish(`reports/${value.report_id}.json`, `${JSON.stringify(value, null, 2)}\n`);
  publishReport(report);
  return {
    root,
    cwd,
    report,
    runs,
    summaryRelative,
    summaryPath: join(cwd, summaryRelative),
    summaryBytes: bytes,
    publishReport,
  };
}
