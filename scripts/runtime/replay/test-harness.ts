import { createHash } from "node:crypto";
import {
  BuildRecordSchema,
  ChangeRequestSchema,
  DataProvenanceSchema,
  EvidenceReportSchema,
  StackLockSchema,
  TaskCardSchema,
  VerificationCaseSchema,
  type BuildRecord,
  type ChangeRequest,
  type DataProvenance,
  type EvidenceReport,
  type RunJob,
  type RunRecord,
  type StackLock,
  type TaskCard,
  type VerificationCase,
} from "../../../packages/dsh-shud-core/src/schemas/index.ts";
import {
  buildCase,
  changeCase,
  verificationCase,
} from "../../../packages/dsh-shud-records/src/workspace-files-test-harness.ts";
import {
  reportCase,
  stackCase,
  taskCase,
} from "../../../packages/dsh-shud-records/src/test-harness.ts";
import {
  makeRunJob,
  makeRunRecord,
} from "../../../packages/dsh-shud-records/src/task-lifecycle-test-harness.ts";
import { renderReportDocument } from "../../../packages/dsh-shud-records/src/report-render.ts";
import { completeMetrics } from "../../../packages/dsh-shud-records/src/run-metrics-test-harness.ts";
import {
  FLOW_FIELDS,
  HEALTH_FIELDS,
  MAX_SOLVER_DT_REASON,
  VERDICT_FIELDS,
  WATER_FIELDS,
  nullMetricBlock,
  serializeRunMetrics,
  type RunMetrics,
} from "../../../packages/dsh-shud-records/src/run-metrics-wire.ts";
import { KELIYA_METRICS_UNAVAILABLE_REASON } from "../shud-replay-contract.ts";
import { REPORT_LIMITATION_TEMPLATES } from "../../../packages/dsh-shud-core/src/governance/wording.ts";
import { snapshotReportMetricFacts } from "../shud-report-metrics.ts";
import {
  replayLogs,
  type ReplayCollectionScenario,
  type ReplayDiagnosticFailure,
  type ReplayModelScenario,
} from "./session/test-harness.ts";
import type { ReplayEvidence } from "../shud-replay-evidence.ts";
import { argumentsOf, calls, data, resultFor } from "../shud-evidence-events.ts";
import { captureReportMetrics } from "../shud-web-driver.ts";
import { submittedParameterBytes } from "../../../packages/dsh-shud-jobs/src/shud-cfg-rewrite.ts";
import { object, requireFact } from "../shud-restart-evidence.ts";

const PIN = "9a422e5eb708df7d2f8b4066a3083a031d679a82";
// Published SHA-256 vectors; these are constructed bytes, not scientific input or a patch.
const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const HELLO_SHA256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const workspace = "/fixture/replay workspace";
const home = "/fixture/private-home";
const allowedFiles = [
  "Makefile",
  "src/Model/MD_rhs_core.cpp",
  "src/Model/Macros.hpp",
  "src/Model/f.cpp",
  "src/Model/shud.cpp",
];
const prompt =
  "Complete the code_change replay in this workspace using ../openMP/docs/p1e/p1e_strict_omp_design.md, changing only Makefile, src/Model/MD_rhs_core.cpp, src/Model/f.cpp, src/Model/Macros.hpp, src/Model/shud.cpp, then compare the base and candidate keliya runs at threads: 1 and submit the evidence report.";

const sha256 = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

/**
 * Constructed keliya-shaped collect metrics: the whole computation is unavailable for one
 * top-level reason, every value null, exactly as records finalizes an unavailable run.
 */
export function replayRunMetrics(reason: string = KELIYA_METRICS_UNAVAILABLE_REASON): RunMetrics {
  const metrics: RunMetrics = completeMetrics();
  metrics.status = "unavailable";
  metrics.reason = reason;
  metrics.flow = nullMetricBlock(FLOW_FIELDS, reason);
  metrics.water_balance = {
    formula_source: metrics.water_balance.formula_source,
    ...nullMetricBlock(WATER_FIELDS, reason),
    approximation: metrics.water_balance.approximation,
  };
  metrics.numerical_health = {
    ...nullMetricBlock(HEALTH_FIELDS, reason),
    negative_state_count_note: metrics.numerical_health.negative_state_count_note,
  };
  // Structural unobservability keeps its own reason even in an unavailable document.
  metrics.numerical_health.reasons.max_solver_dt = MAX_SOLVER_DT_REASON;
  for (const field of VERDICT_FIELDS) metrics.verdicts[field] = "not_available";
  return metrics;
}

/** Bind one run to metric bytes the way collect does: summary digest plus copied health values. */
export function bindReplayMetrics(
  files: Record<string, unknown>,
  record: RunRecord,
  metrics: RunMetrics = replayRunMetrics(),
): void {
  // The real serializer validates the constructed shape before any oracle sees it.
  const bytes = serializeRunMetrics(metrics);
  record.artifacts.metrics_summary = { path: "metrics.json", sha256: sha256(bytes) };
  record.numerical_health = {
    water_balance_residual: metrics.numerical_health.water_balance_residual,
    cvode_failures: metrics.numerical_health.cvode_failures,
    negative_state_count: metrics.numerical_health.negative_state_count,
    max_solver_dt: metrics.numerical_health.max_solver_dt,
  };
  files[`runs/${record.run_id}/metrics.json`] = captureReportMetrics(Buffer.from(bytes));
}

export interface ReplayRecords {
  task: TaskCard;
  change: ChangeRequest;
  builds: BuildRecord[];
  runs: {
    build: BuildRecord;
    stack: StackLock;
    data: DataProvenance;
    job: RunJob;
    record: RunRecord;
  }[];
  verification: VerificationCase;
  report: EvidenceReport;
  files: Record<string, unknown>;
}
export interface ReplayFixture extends ReplayRecords {
  snapshot: ReplayEvidence;
}
/** Constructed records at the collector -> pure judge seam, never solver/model output. */
function replayRecords(verificationStatus: "passed" | "failed"): ReplayRecords {
  const change = ChangeRequestSchema.parse({
    ...changeCase.value,
    base_commit: PIN,
    files_changed: [...allowedFiles],
    semantic_level: "numerical_implementation",
    semantic_floor: "numerical_implementation",
    floor_categories: ["pure_engineering", "numerical_implementation"],
    risk: "high",
    status: "approved",
    approval_ref: "call-change-submit",
    approved_at: "2026-11-02T09:00:02Z",
    updated_at: "2026-11-02T09:00:02Z",
    created_by: "coder",
    created_at: "2026-11-02T09:00:01.500Z",
    description: "Constructed replay evidence; no scientific implementation is supplied.",
  });
  const builds = [false, true].map((candidate) => {
    const id = candidate
      ? verificationCase.value.candidate_build_id
      : verificationCase.value.base_build_id;
    return BuildRecordSchema.parse({
      ...buildCase.value,
      build_id: id,
      source_commit: PIN,
      source_branch: "HEAD",
      change_id: candidate ? change.change_id : null,
      patch_sha256: candidate ? change.patch_sha256 : null,
      dirty_paths: candidate ? [...allowedFiles] : [],
      rhs_openmp: candidate,
      make_argv: [
        "make",
        "shud",
        "SUNDIALS_DIR=/opt/sundials",
        ...(candidate ? ["SHUD_ENABLE_OPENMP_RHS=1"] : []),
      ],
      binary_path: `builds/${id}/shud`,
      binary_sha256: candidate ? HELLO_SHA256 : ABC_SHA256,
      stdout_path: `builds/${id}/make.stdout.log`,
      stderr_path: `builds/${id}/make.stderr.log`,
      created_at: candidate ? "2026-11-02T09:00:04Z" : "2026-11-02T09:00:01Z",
      duration_seconds: 0.25,
    });
  });
  const runs = builds.map((build, index) => {
    const suffix = index === 0 ? "d4e5" : "e5f6";
    const runId = `RUN-20261102T090000-${suffix}`;
    const runDir = `${workspace}/runs/${runId}`;
    const dshId = index === 0 ? "shud-0000000000000001" : "shud-0000000000000002";
    const stack = StackLockSchema.parse({
      ...stackCase.value,
      stack_id: `STACK-20261102T090000-${suffix}`,
      build_id: build.build_id,
      repos: {
        ...stackCase.value.repos,
        SHUD: {
          commit: PIN,
          branch: "HEAD",
          dirty: index === 1,
          dirty_paths: build.dirty_paths,
          dirty_paths_truncated: false,
        },
      },
      llm: {
        base_url: "https://example.invalid",
        request_alias: "fixture-model",
        response_model: "fixture-model",
      },
      fingerprint: `sha256:${index === 0 ? ABC_SHA256 : HELLO_SHA256}`,
      created_at: index === 0 ? "2026-11-02T09:00:03Z" : "2026-11-02T09:00:05Z",
    });
    const data = DataProvenanceSchema.parse({
      data_id: `DATA-20261102T090000-${suffix}`,
      basin: "keliya",
      event_window: { start: null, end: null },
      sources: {
        input_root: `${workspace}/input/keliya`,
        files: [{ path: "keliya.mesh", sha256: ABC_SHA256, size_bytes: 3 }],
        external_files: Array.from({ length: 32 }, (_, station) => ({
          path: `/fixture/basin/forcing.trimmed/station-${station + 1}.csv`,
          sha256: ABC_SHA256,
          size_bytes: 3,
        })),
      },
      preprocess: null,
      uncertainty_notes: null,
    });
    const job = makeRunJob(`JOB-20261102T090000-${suffix}`, {
      task_id: change.task_id,
      stack_id: stack.stack_id,
      data_id: data.data_id,
      build_id: build.build_id,
      binary_sha256: build.binary_sha256,
      threads: 1,
      project: "keliya",
      input_dir: `${workspace}/input/keliya`,
      run_dir: runDir,
      command: [`${runDir}/bin/shud`, "-o", "output/keliya.out", "keliya"],
      end_days: null,
      owner_session: index === 0 ? "worker-base" : "worker-candidate",
      dsh_job_id: dshId,
      dsh_job_ids: [dshId],
      submitted_at: stack.created_at,
      started_at: stack.created_at,
      pid_started_at: stack.created_at,
      finished_at: index === 0 ? "2026-11-02T09:00:03.500Z" : "2026-11-02T09:00:05.500Z",
      notify: {
        status: "delivered",
        attempts: 1,
        at: index === 0 ? "2026-11-02T09:00:03.600Z" : "2026-11-02T09:00:05.600Z",
        detail: null,
      },
    });
    const record = makeRunRecord(job, {
      build_id: build.build_id,
      binary_sha256: build.binary_sha256,
      threads: 1,
      command: job.command,
      artifacts: {
        stdout: `${runDir}/stdout.log`,
        stderr: `${runDir}/stderr.log`,
        shud_output: `${runDir}/output/keliya.out`,
        files: [
          {
            path: "keliya.rivqdown.dat",
            size_bytes: verificationStatus === "failed" && index === 1 ? 5 : 3,
          },
        ],
      },
      collected_at: job.finished_at!,
    });
    return { build, stack, data, job, record };
  });
  const verification = VerificationCaseSchema.parse({
    ...verificationCase.value,
    target_code_targets: [...allowedFiles],
    artifact_refs: runs.map(
      ({ job }) => `runs/${job.run_id}/output/keliya.out/keliya.rivqdown.dat`,
    ),
    observed: {
      compared_path: "output/keliya.out/keliya.rivqdown.dat",
      base_sha256: ABC_SHA256,
      candidate_sha256: verificationStatus === "failed" ? HELLO_SHA256 : ABC_SHA256,
    },
    status: verificationStatus,
    failure_reason:
      verificationStatus === "failed"
        ? "Constructed candidate bytes differ from the serial baseline."
        : null,
    compatibility_verdict: verificationStatus === "failed" ? "incompatible" : "compatible",
    created_at: "2026-11-02T09:00:06Z",
  });
  const report = EvidenceReportSchema.parse({
    ...reportCase.value,
    report_id: "REPORT-20261102T090000-0001",
    task_id: change.task_id,
    status: "accepted",
    summary: "Constructed N=1 replay evidence.",
    observations: [
      verificationStatus === "failed"
        ? "The constructed output digests differ."
        : "Both constructed output digests are equal.",
    ],
    limitations: [
      "This is not scientific or PI acceptance.",
      REPORT_LIMITATION_TEMPLATES.max_solver_dt,
    ],
    linked_runs: runs.map(({ job }) => job.run_id),
    stack_ids: runs.map(({ stack }) => stack.stack_id),
    data_ids: runs.map(({ data }) => data.data_id),
    llm_response_models: ["fixture-model"],
    change_ids: [change.change_id],
    verification_ids: [verification.vc_id],
    decision_history: [
      {
        decision_id: "DEC-20261102T090000-0001",
        report_id: "REPORT-20261102T090000-0001",
        approval_ref: "call-report-submit",
        outcome: "accepted",
        comment: null,
        decided_at: "2026-11-02T09:00:07Z",
      },
    ],
    created_at: "2026-11-02T09:00:06.500Z",
    updated_at: "2026-11-02T09:00:07Z",
  });
  const task = TaskCardSchema.parse({
    ...taskCase.value,
    task_id: change.task_id,
    type: "code_change",
    status: "done",
    title: "Constructed keliya replay",
    question_or_goal: prompt,
    source_base_commit: PIN,
    stack_id: runs[0].stack.stack_id,
    data_id: runs[0].data.data_id,
    linked_jobs: runs.map(({ job }) => job.job_id),
    linked_reports: [report.report_id],
    linked_changes: [change.change_id],
    linked_verifications: [verification.vc_id],
    created_at: "2026-11-02T09:00:00Z",
    updated_at: report.updated_at,
  });
  const files: Record<string, unknown> = {
    [`tasks/${task.task_id}/task.json`]: task,
    [`changes/${change.change_id}.json`]: change,
    [change.patch_path]: "abc",
    [`verifications/${verification.vc_id}.json`]: verification,
    [`reports/${report.report_id}.json`]: report,
  };
  for (const { build, stack, data, job, record } of runs) {
    bindReplayMetrics(files, record);
    Object.assign(files, {
      [`builds/${build.build_id}/build-record.json`]: build,
      [build.binary_path]: build.rhs_openmp ? "hello" : "abc",
      [build.stdout_path]: build.rhs_openmp
        ? "c++ -fopenmp -c src/Model/MD_rhs_core.cpp\nc++ -fopenmp -o shud rhs.o\n"
        : "c++ -c src/Model/MD_rhs_core.cpp\nc++ -o shud rhs.o\n",
      [build.stderr_path]: "",
      [`stacks/${stack.stack_id}.json`]: stack,
      [`provenance/${data.data_id}.json`]: data,
      [`runs/${job.run_id}/run-job.json`]: job,
      [`runs/${job.run_id}/run-record.json`]: record,
      [`runs/${job.run_id}/bin/shud`]: build.rhs_openmp ? "hello" : "abc",
      [`runs/${job.run_id}/input/keliya/keliya.mesh`]: "abc",
      [`runs/${job.run_id}/output/keliya.out/keliya.rivqdown.dat`]:
        verificationStatus === "failed" && build.rhs_openmp ? "hello" : "abc",
      [`runs/${job.run_id}/stdout.log`]: "constructed successful run\n",
      [`runs/${job.run_id}/stderr.log`]: "",
      [`runs/${job.run_id}/exit_code`]: "0\n",
    });
  }
  return { task, change, builds, runs, verification, report, files };
}

function renderReplayReport(records: ReplayRecords): void {
  records.files[`reports/${records.report.report_id}.md`] = renderReportDocument(
    records.report,
    records.runs.map(({ stack }) => stack),
    records.runs.map(({ data }) => data),
    records.runs.map(({ record }) => record),
    {
      changes: [records.change],
      verifications: [
        {
          record: records.verification,
          baseBuild: records.builds[0],
          candidateBuild: records.builds[1],
        },
      ],
    },
    snapshotReportMetricFacts(
      records.files,
      records.runs.map(({ record }) => record),
    ),
  ).markdown;
}

/** Keep artifact negatives coherent across stored records, collect results and the report. */
export function refreshReplayRunArtifacts(fixture: ReplayFixture): void {
  for (const { job, record } of fixture.runs)
    fixture.snapshot.files[`runs/${job.run_id}/run-record.json`] = record;
  for (const log of [fixture.snapshot.root, ...fixture.snapshot.children])
    for (const call of calls(log, "shud_collect")) {
      const run = fixture.runs.find(({ job }) => job.run_id === argumentsOf(call).run_id);
      requireFact(run, "Constructed collect call must reference a fixture run");
      const result = resultFor(log, call, "Constructed collect result");
      object(data(result).message).content = [{ type: "text", text: JSON.stringify(run.record) }];
    }
  renderReplayReport(fixture);
}

export function makeReplayFixture(
  verificationStatus: "passed" | "failed" = "passed",
  diagnostics: readonly ReplayDiagnosticFailure[] = [],
  collections: ReplayCollectionScenario = {},
  models: ReplayModelScenario = {},
): ReplayFixture {
  const records = replayRecords(verificationStatus);
  if (models.responseModels)
    for (const [index, run] of records.runs.entries()) {
      const model = models.responseModels[index];
      run.stack.llm.response_model = model;
      run.job.llm.response_model = model;
      run.record.llm.response_model = model;
    }
  if (models.responseModels)
    records.report.llm_response_models = [...new Set(models.responseModels)];
  const sourceCfg = "START\t12053\nEND\t12143\nNUM_OPENMP\t8\n";
  const preparedCfg = "START\t12053\nEND\t12143\nNUM_OPENMP\t1\n";
  const stations = records.runs[0].data.sources.external_files
    .map((file, i) => `${i + 1}\t80\t35\t0\t0\t1000\t${file.path.split("/").at(-1)}\n`)
    .join("");
  const table = `ID\tLon\tLat\tX\tY\tZ\tFilename\n${stations}`;
  const sourceForcing = `32 19510101\n/obsolete/forcing\n${table}`;
  const preparedForcing = `32 19510101\n/fixture/basin/forcing.trimmed\n${table}`;
  const inputFiles = {
    "keliya.cfg.para": preparedCfg,
    "keliya.tsd.forc": preparedForcing,
    "keliya.mesh": "abc",
  };
  // Every submission writes DT_YE_IC into its cfg.para copy; other inputs are copied verbatim.
  const runFiles: Record<string, string> = {
    ...inputFiles,
    "keliya.cfg.para": submittedParameterBytes(Buffer.from(preparedCfg)).toString("latin1"),
  };
  for (const [path, bytes] of Object.entries(inputFiles)) {
    // The collector retains the prepared cfg.para raw bytes so the judge can derive that rewrite.
    records.files[`input/keliya/${path}`] =
      path === "keliya.cfg.para" ? captureReportMetrics(Buffer.from(bytes)) : bytes;
    for (const run of records.runs)
      records.files[`runs/${run.job.run_id}/input/keliya/${path}`] = runFiles[path];
  }
  for (const run of records.runs) {
    run.data.sources.files = Object.entries(runFiles).map(([path, bytes]) => ({
      path,
      sha256: sha256(bytes),
      size_bytes: Buffer.byteLength(bytes),
    }));
    run.job.input_bytes = Object.values(inputFiles).reduce(
      (sum, bytes) => sum + Buffer.byteLength(bytes),
      0,
    );
  }
  records.files["input/keliya/PREPARED.json"] = {
    source: "/fixture/basin/input/keliya",
    files: {
      "keliya.cfg.para": { before_sha256: sha256(sourceCfg), after_sha256: sha256(preparedCfg) },
      "keliya.tsd.forc": {
        before_sha256: sha256(sourceForcing),
        after_sha256: sha256(preparedForcing),
      },
    },
  };
  const preparedBytes = `${JSON.stringify(records.files["input/keliya/PREPARED.json"], null, 2)}\n`;
  for (const run of records.runs) {
    records.files[`runs/${run.job.run_id}/input/keliya/PREPARED.json`] = preparedBytes;
    run.data.sources.files.push({
      path: "PREPARED.json",
      sha256: sha256(preparedBytes),
      size_bytes: Buffer.byteLength(preparedBytes),
    });
    run.job.input_bytes += Buffer.byteLength(preparedBytes);
  }
  // Produce the report artifact through the existing renderer, not a parallel template.
  renderReplayReport(records);
  const preservation = {
    clone: { head: PIN, gitDir: `${workspace}/repos/SHUD/.git` },
    preparedInputSha256: {
      ...Object.fromEntries(
        Object.entries(inputFiles).map(([path, bytes]) => [path, sha256(bytes)]),
      ),
      "PREPARED.json": sha256(preparedBytes),
    },
    repositories: {
      SHUD: {
        head: "1111111111111111111111111111111111111111",
        status: "",
        diffSha256: sha256(""),
      },
      rSHUD: {
        head: "2222222222222222222222222222222222222222",
        status: "",
        diffSha256: sha256(""),
      },
      AutoSHUD: {
        head: "3333333333333333333333333333333333333333",
        status: "",
        diffSha256: sha256(""),
      },
    },
    shudGit: {
      kind: "gitlink",
      bytes: "gitdir: ../.git/modules/SHUD\n",
      absoluteGitDir: "/fixture/harness/.git/modules/SHUD",
      inventory: [
        "HEAD",
        "config",
        "index",
        "objects/pack/pack-fixture.idx",
        "objects/pack/pack-fixture.pack",
      ],
    },
    ccwMd5: { "ccw.cfg.para": "900150983cd24fb0d6963f7d28e17f72" },
    raw: { exists: true, md5: { "retained.bin": "900150983cd24fb0d6963f7d28e17f72" } },
    keliyaSourceSha256: {
      "keliya.cfg.para": sha256(sourceCfg),
      "keliya.tsd.forc": sha256(sourceForcing),
      "keliya.mesh": ABC_SHA256,
    },
    forcingSha256: Object.fromEntries<string>([
      ...records.runs[0].data.sources.external_files.map(
        ({ path, sha256: digest }): [string, string] => [path, digest],
      ),
      ["/fixture/basin/forcing.trimmed/unreferenced-33.csv", HELLO_SHA256],
      ["/fixture/basin/forcing.trimmed/unreferenced-34.csv", HELLO_SHA256],
    ]),
  };
  const logs = replayLogs(records, { workspace, home, prompt }, diagnostics, collections, models);
  const snapshot: ReplayEvidence = {
    workspace,
    home,
    ...logs,
    files: records.files,
    actualStack: {
      commits: {
        SHUD: PIN,
        rSHUD: preservation.repositories.rSHUD.head,
        AutoSHUD: preservation.repositories.AutoSHUD.head,
      },
      llm: { base_url: "https://example.invalid", request_alias: "fixture-model" },
    },
    preservation: { before: preservation, after: structuredClone(preservation) },
  };
  return { snapshot, ...records };
}
