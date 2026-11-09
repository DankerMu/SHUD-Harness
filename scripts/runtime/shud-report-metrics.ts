import { createHash } from "node:crypto";
import type { RunRecord } from "../../packages/dsh-shud-core/src/schemas/index.ts";
import type { ReportMetricFacts } from "../../packages/dsh-shud-records/lib/report-inputs.js";
import { decodeRunMetrics } from "../../packages/dsh-shud-records/lib/run-metrics-wire.js";
import { object, requireFact } from "./shud-restart-evidence.ts";

/** Pure snapshot adapter: no workspace access and no second metrics parser. */
export function snapshotReportMetricFacts(
  files: Record<string, unknown>,
  runs: readonly RunRecord[],
): ReportMetricFacts[] {
  return runs.map((run) => {
    const reference = run.artifacts.metrics_summary;
    if (reference === null) return { run_id: run.run_id, source_ref: null, metrics: null };
    const path = `runs/${run.run_id}/metrics.json`;
    try {
      const captured = object(files[path]);
      requireFact(typeof captured.bytes_base64 === "string", `Missing metric bytes ${path}`);
      const bytes = Buffer.from(captured.bytes_base64, "base64");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      requireFact(
        bytes.toString("base64") === captured.bytes_base64 &&
          sha256 === captured.sha256 &&
          bytes.length === captured.size_bytes,
        `Metric byte receipt mismatch ${path}`,
      );
      return {
        run_id: run.run_id,
        source_ref: { path, sha256: reference.sha256 },
        metrics: decodeRunMetrics({ bytes, sha256 }, reference.sha256),
      };
    } catch {
      throw new Error(`Invalid report metrics evidence ${path}`);
    }
  });
}
