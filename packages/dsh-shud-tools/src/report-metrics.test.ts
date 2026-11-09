import * as fs from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { RunRecord } from "@shud-harness/dsh-shud-core";
import { serializeRunMetrics, type RunMetrics } from "@shud-harness/dsh-shud-records";
import { completeMetrics, digest } from "../../dsh-shud-records/src/run-metrics-test-harness.ts";
import { treeOrAbsent } from "./task-linked/test-harness.ts";
import {
  DRAFT,
  expectReportError,
  generated,
  reportHarness,
  seedCodeChangeEvidence,
  seedEvidence,
} from "./report-workflow/test-harness.ts";

const FIXED =
  "max_solver_dt 在钉版 SHUD 中不可观测（PrintFinalStats 未被调用），各运行该项恒为 null，不作判定";

function installMetrics(runDir: string, run: RunRecord, metrics: RunMetrics) {
  const bytes = serializeRunMetrics(metrics);
  const path = join(runDir, "metrics.json");
  fs.writeFileSync(path, bytes);
  run.artifacts.metrics_summary = { path: "metrics.json", sha256: digest(bytes) };
  fs.writeFileSync(join(runDir, "run-record.json"), JSON.stringify(run));
  return path;
}

function passingMetrics(): RunMetrics {
  const metrics = completeMetrics();
  metrics.numerical_health.cvode_failures = 0;
  metrics.numerical_health.negative_state_count = 0;
  return {
    ...metrics,
    verdicts: {
      water_balance_residual: "pass",
      cvode_failures: "pass",
      negative_state_count: "pass",
    },
  };
}

test.each(["pass", "warn", "negative10", "negative11", "null"] as const)(
  "%s metrics do not block closure and append only their non-pass evidence",
  async (scenario) => {
    const h = await reportHarness();
    try {
      const { job, run } = await seedEvidence(h);
      const metrics = passingMetrics();
      const expected = [...DRAFT.limitations, FIXED];
      if (scenario === "warn") {
        metrics.water_balance.residual = 0.03;
        metrics.numerical_health.water_balance_residual = 0.03;
        metrics.verdicts.water_balance_residual = "warn";
        expected.push(`运行 ${run.run_id} 的 water_balance_residual 判定为 warn，值或原因为 0.03`);
      }
      if (scenario === "negative10" || scenario === "negative11") {
        const value = scenario === "negative10" ? 10 : 11;
        const verdict = scenario === "negative10" ? "warn" : "fail";
        metrics.numerical_health.negative_state_count = value;
        metrics.verdicts.negative_state_count = verdict;
        expected.push(
          `运行 ${run.run_id} 的 negative_state_count 判定为 ${verdict}，值或原因为 ${value}`,
        );
      }
      if (scenario === "null") {
        metrics.numerical_health.cvode_failures = null;
        metrics.numerical_health.reasons.cvode_failures = "unobserved $& <run_id>";
        metrics.verdicts.cvode_failures = "not_available";
        expected.push(
          `运行 ${run.run_id} 的 cvode_failures 判定为 not_available，值或原因为 unobserved $& <run_id>`,
        );
      }
      installMetrics(job.run_dir, run, metrics);
      const report = generated(h, await h.invoke("report_generate", DRAFT));
      expect(report.limitations).toEqual(expected);
    } finally {
      await h.dispose();
    }
  },
);

test("unavailable metrics preserve their stored reason and do not become a closure blocker", async () => {
  const h = await reportHarness();
  try {
    const { job, run } = await seedEvidence(h);
    const metrics = passingMetrics();
    metrics.status = "unavailable";
    metrics.reason = "missing_variable:rivqdown $& <run_id>";
    for (const block of [metrics.flow, metrics.water_balance, metrics.numerical_health]) {
      for (const key of Object.keys(block.reasons)) {
        Object.assign(block, { [key]: null });
        Object.assign(block.reasons, { [key]: "missing_variable:rivqdown" });
      }
    }
    metrics.numerical_health.reasons.max_solver_dt = "not_observable_in_pinned_shud";
    metrics.verdicts = {
      water_balance_residual: "not_available",
      cvode_failures: "not_available",
      negative_state_count: "not_available",
    };
    installMetrics(job.run_dir, run, metrics);
    const report = generated(h, await h.invoke("report_generate", DRAFT));
    expect(report.limitations).toEqual([
      ...DRAFT.limitations,
      FIXED,
      `运行 ${run.run_id} 的指标不可用，原因为 missing_variable:rivqdown $& <run_id>`,
    ]);
  } finally {
    await h.dispose();
  }
});

test("two-run code-change limitations keep linked-run then residual cvode negative order and one fixed entry", async () => {
  const h = await reportHarness();
  try {
    const { runs } = await seedCodeChangeEvidence(h);
    const first = completeMetrics();
    first.water_balance.residual = 0.03;
    first.numerical_health.water_balance_residual = 0.03;
    first.numerical_health.negative_state_count = 11;
    const firstMetrics: RunMetrics = {
      ...first,
      verdicts: {
        water_balance_residual: "warn",
        cvode_failures: "fail",
        negative_state_count: "fail",
      },
    };
    const second = passingMetrics();
    second.numerical_health.negative_state_count = 10;
    second.verdicts.negative_state_count = "warn";
    installMetrics(runs[0].job.run_dir, runs[0].run, firstMetrics);
    installMetrics(runs[1].job.run_dir, runs[1].run, second);
    const report = generated(h, await h.invoke("report_generate", DRAFT));
    expect(report.limitations).toEqual([
      ...DRAFT.limitations,
      FIXED,
      `运行 ${runs[0].run.run_id} 的 water_balance_residual 判定为 warn，值或原因为 0.03`,
      `运行 ${runs[0].run.run_id} 的 cvode_failures 判定为 fail，值或原因为 2`,
      `运行 ${runs[0].run.run_id} 的 negative_state_count 判定为 fail，值或原因为 11`,
      `运行 ${runs[1].run.run_id} 的 negative_state_count 判定为 warn，值或原因为 10`,
    ]);
  } finally {
    await h.dispose();
  }
});

test.each(["missing", "digest", "json", "schema", "symlink"] as const)(
  "%s metrics reject generation before report publication and preserve source evidence",
  async (kind) => {
    const h = await reportHarness();
    try {
      const { job, run } = await seedEvidence(h);
      const path = installMetrics(job.run_dir, run, passingMetrics());
      if (kind === "missing" || kind === "symlink") fs.unlinkSync(path);
      if (kind === "symlink") fs.symlinkSync(join(job.run_dir, "run-record.json"), path);
      if (kind === "digest") fs.appendFileSync(path, " ");
      if (kind === "json" || kind === "schema") {
        const bytes = kind === "json" ? "{" : "{}";
        fs.writeFileSync(path, bytes);
        run.artifacts.metrics_summary = { path: "metrics.json", sha256: digest(bytes) };
        fs.writeFileSync(join(job.run_dir, "run-record.json"), JSON.stringify(run));
      }
      const reports = await treeOrAbsent(join(h.cwd, "reports"));
      const runs = await treeOrAbsent(join(h.cwd, "runs"));
      const message = expectReportError(await h.invoke("report_generate", DRAFT), /metrics\.json/u);
      expect(message).toContain(`runs/${run.run_id}/metrics.json`);
      expect(await treeOrAbsent(join(h.cwd, "reports"))).toEqual(reports);
      expect(await treeOrAbsent(join(h.cwd, "runs"))).toEqual(runs);
    } finally {
      await h.dispose();
    }
  },
);
