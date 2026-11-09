import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { renderReport, serializeRunMetrics } from "./index.ts";
import { makeRenderingFixture, renderingInputs } from "./report-workspace-test-harness.ts";
import { completeMetrics, digest } from "./run-metrics-test-harness.ts";

test("renderReport shows exact bound metrics and their run source in section 5", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "report-metrics-")));
  try {
    const fixture = makeRenderingFixture();
    const run = fixture.runs[0];
    fixture.report.linked_runs = [run.run_id];

    const metrics = completeMetrics();
    metrics.flow.peak_flow_m3d = 123456.789;
    // Constructed budget: (0.1 - 0.03 - 0.06 - 0.00992) / 0.1 = 0.0008.
    metrics.water_balance.delta_s_gw = 0.00392;
    metrics.water_balance.delta_s = 0.00992;
    metrics.water_balance.residual = 0.0008;
    metrics.numerical_health.water_balance_residual = 0.0008;
    // The canonical writer validates shape and stored verdict agreement before publication.
    const bytes = serializeRunMetrics(metrics);
    const sha256 = digest(bytes);
    run.artifacts.metrics_summary = { path: "metrics.json", sha256 };
    // Section 5 must use the bound artifact, not this distinct RunRecord health value.
    run.numerical_health.water_balance_residual = 0.125;

    for (const input of renderingInputs(fixture)) {
      const path = join(cwd, input.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(input.value, null, 2)}\n`);
    }
    writeFileSync(join(cwd, "runs", run.run_id, "metrics.json"), bytes);

    const markdown = renderReport(cwd, fixture.report.report_id);
    const section5 = markdown.split("## 5. 指标与图表\n")[1]?.split(/^## /m)[0];
    expect(section5).toBeDefined();
    // Literal numeric cells are independent expectations, not read-back or formatted source values.
    expect(section5).toContain("| 123456.789 |");
    expect(section5).toContain("| 0.0008 |");
    expect(section5).not.toContain("| 0.125 |");
    expect(section5).toContain("RUN-20261029T080000-b002");
    expect(section5).toContain("runs/RUN-20261029T080000-b002/metrics.json");
    expect(section5).toContain(sha256);
    expect(section5).not.toContain("本里程碑无指标 artifact，见 limitations");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
