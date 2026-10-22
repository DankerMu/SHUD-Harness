import { describe, expect, test } from "vitest";
import {
  ArtifactManifestSchema,
  ArtifactSchema,
  DataProvenanceSchema,
  ErrorRecordSchema,
  IdempotencyRecordSchema,
  LockRecordSchema,
  StackLockSchema,
  TaskCardSchema,
} from "./index.ts";
import {
  classifyRunExit,
  COLLECT_RETRY_INTERVAL_MS,
  generateRunIdentifiers,
  JobRecordIdSchema,
  KILL_GRACE_PERIOD_MS,
  MAX_COLLECT_ATTEMPTS,
  MAX_NOTIFY_ATTEMPTS,
  NOTIFY_RETRY_INTERVAL_MS,
  RunIdSchema,
  RunJobSchema,
  RunRecordSchema,
} from "../index.ts";

const STACK_ID = "STACK-11111111-1111-4111-8111-111111111111";
const DATA_ID = "DATA-22222222-2222-4222-8222-222222222222";
const MANIFEST_ID = "MANIFEST-33333333-3333-4333-8333-333333333333";
const SUCCESSOR_MANIFEST_ID = "MANIFEST-44444444-4444-4444-8444-444444444444";

describe("RunRecord contract", () => {
  test.each([
    [0, "ok", "succeeded"],
    [10, "nan", "failed"],
    [12, "file_io", "failed"],
    [13, "input", "failed"],
    [19, "cvode", "failed"],
    [20, "consistency", "failed"],
    [3, "other", "failed"],
    [-1, "other", "failed"],
  ] as const)("classifies exit %s as %s with status %s", (code, exitClass, status) => {
    expect(classifyRunExit(code)).toBe(exitClass);
    expect(classifyRunExit(code, "cancelled")).toBe(exitClass);
    const record = { ...validRunRecord(), exit_code: code, exit_class: exitClass, status };
    expect(RunRecordSchema.parse(record).exit_class).toBe(exitClass);
  });

  test.each(["cancelled", "lost"] as const)("requires explicit null outcome %s", (outcome) => {
    expect(classifyRunExit(null, outcome)).toBe(outcome);
    const record = { ...validRunRecord(), exit_code: null, exit_class: outcome, status: "failed" };
    expect(RunRecordSchema.safeParse(record).success).toBe(true);
  });

  test("classifier refuses absent null evidence and nonintegral exit codes", () => {
    expect(() => {
      Reflect.apply(classifyRunExit, undefined, [null]);
    }).toThrow();
    for (const code of [1.5, NaN, Infinity]) expect(() => classifyRunExit(code)).toThrow();
  });

  test.each([
    [0, "other", "failed", "exit_class"],
    [10, "ok", "succeeded", "exit_class"],
    [3, "cancelled", "failed", "exit_class"],
    [null, "ok", "succeeded", "exit_class"],
    [null, "other", "failed", "exit_class"],
    [0, "ok", "failed", "status"],
    [10, "nan", "succeeded", "status"],
    [null, "lost", "succeeded", "status"],
    [null, "cancelled", "succeeded", "status"],
  ] as const)("rejects contradictory exit triple %s/%s/%s", (code, exitClass, status, field) => {
    const record = { ...validRunRecord(), exit_code: code, exit_class: exitClass, status };
    const result = RunRecordSchema.safeParse(record);
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain(field);
  });

  test.each([
    "",
    "/outside.dat",
    "../outside.dat",
    "nested/../../outside.dat",
    "C:\\outside.dat",
    "\\\\server\\share\\file.dat",
    "nested\\..\\outside.dat",
  ])("rejects unsafe artifact path %s", (path) => {
    const record = validRunRecord();
    record.artifacts.files = [{ path, size_bytes: 0 }];
    const result = RunRecordSchema.safeParse(record);
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("artifacts.files.0.path");
  });

  test.each([
    ["nested/flow.dat", 0],
    ["nested/flow.dat", 1024],
    ["./flow.dat", 0],
    ["nested/model..dat", 1024],
  ] as const)("accepts relative path %s with %s bytes", (path, size) => {
    const record = validRunRecord();
    record.artifacts.files = [{ path, size_bytes: size }];
    expect(RunRecordSchema.safeParse(record).success).toBe(true);
  });

  test.each([-1, 0.5, null, undefined])("rejects invalid artifact byte size %s", (size) => {
    const record = validRunRecord();
    const files = [{ path: "flow.dat", size_bytes: size }];
    const artifacts = { ...record.artifacts, files };
    const result = RunRecordSchema.safeParse({ ...record, artifacts });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("artifacts.files.0.size_bytes");
  });

  test.each([
    ["response_model", ""],
    ["response_model", undefined],
    ["response_model_source", undefined],
    ["response_model_source", "guessed"],
  ])("rejects invalid model provenance %s=%s", (field, value) => {
    const record = validRunRecord();
    const llm = { ...record.llm, [field]: value };
    const result = RunRecordSchema.safeParse({ ...record, llm });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain(`llm.${field}`);
  });

  test("accepts configured provenance, branded ids and explicit nullable measurements", () => {
    const record = {
      ...validRunRecord(),
      ...generateRunIdentifiers(),
      llm: { response_model: "deepseek-flash-guan", response_model_source: "configured" },
    };
    expect(RunRecordSchema.parse(record)).toEqual(record);
  });

  test.each([
    ["numerical_health", "cvode_failures", -1],
    ["numerical_health", "cvode_failures", 0.5],
    ["numerical_health", "negative_state_count", -1],
    ["numerical_health", "negative_state_count", 0.5],
    ["numerical_health", "max_solver_dt", -1],
    ["resources", "wall_seconds", -1],
    ["resources", "peak_memory_mb", -1],
  ] as const)("rejects invalid measurement %s.%s=%s", (group, field, value) => {
    const record = validRunRecord();
    const candidate = { ...record, [group]: { ...record[group], [field]: value } };
    const result = RunRecordSchema.safeParse(candidate);
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain(`${group}.${field}`);
  });

  test.each([0, 0.5])("accepts measured fractions and zero boundaries %s", (value) => {
    const numerical_health = {
      water_balance_residual: -0.125,
      cvode_failures: 0,
      negative_state_count: 0,
      max_solver_dt: value,
    };
    const resources = { wall_seconds: value, peak_memory_mb: value };
    const candidate = { ...validRunRecord(), numerical_health, resources };
    expect(RunRecordSchema.parse(candidate)).toEqual(candidate);
  });

  test.each([
    ["job_id", "JOB-0001"],
    ["job_id", "shud-0123456789abcdef"],
    ["run_id", "RUN-20261022T031500-A1B2"],
    ["command", "shud ccw"],
    ["numerical_health", null],
  ])("rejects invalid record field %s", (field, value) => {
    const result = RunRecordSchema.safeParse({ ...validRunRecord(), [field]: value });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain(field);
  });

  test("requires every root and nested field, including nullable fields", () => {
    const record = validRunRecord();
    for (const key of Object.keys(record) as Array<keyof typeof record>) {
      expect(RunRecordSchema.safeParse(removeKey(record, key)).success, key).toBe(false);
    }
    for (const group of ["artifacts", "numerical_health", "resources", "llm"] as const) {
      for (const key of Object.keys(record[group])) {
        const reduced = Object.fromEntries(
          Object.entries(record[group]).filter(([k]) => k !== key),
        );
        const result = RunRecordSchema.safeParse({ ...record, [group]: reduced });
        expect(result.success).toBe(false);
        expect(issuePaths(result)).toContain(`${group}.${key}`);
      }
    }
  });

  test("rejects unprescribed credential bags at every object level", () => {
    const record = validRunRecord();
    expect(RunRecordSchema.safeParse({ ...record, credentials: {} }).success).toBe(false);
    for (const group of ["artifacts", "numerical_health", "resources", "llm"] as const) {
      const candidate = { ...record, [group]: { ...record[group], credentials: {} } };
      expect(RunRecordSchema.safeParse(candidate).success).toBe(false);
    }
    const files = [{ path: "flow.dat", size_bytes: 0, headers: {} }];
    const artifacts = { ...record.artifacts, files };
    expect(RunRecordSchema.safeParse({ ...record, artifacts }).success).toBe(false);
  });
});

describe("RunJob contract", () => {
  test("paired identifiers use UTC seconds and one lowercase random suffix", () => {
    const ids = generateRunIdentifiers(new Date("2026-10-22T11:15:00.987+08:00"));
    expect(ids.job_id).toMatch(/^JOB-20261022T031500-[0-9a-f]{4}$/u);
    expect(ids.run_id).toBe(`RUN-${ids.job_id.slice(4)}`);
    expect(JobRecordIdSchema.parse(ids.job_id)).toBe(ids.job_id);
    expect(RunIdSchema.parse(ids.run_id)).toBe(ids.run_id);
    expect(generateRunIdentifiers().run_id).toMatch(/^RUN-\d{8}T\d{6}-[0-9a-f]{4}$/u);
  });

  test("retry limits and timer units match the run contract", () => {
    expect(MAX_NOTIFY_ATTEMPTS).toBe(3);
    expect(MAX_COLLECT_ATTEMPTS).toBe(3);
    expect(NOTIFY_RETRY_INTERVAL_MS).toBe(10_000);
    expect(COLLECT_RETRY_INTERVAL_MS).toBe(10_000);
    expect(KILL_GRACE_PERIOD_MS).toBe(10_000);
  });

  test("submitted records preserve nullable references and process identity", () => {
    expect(RunJobSchema.parse(validRunJob())).toEqual(validRunJob());
    expect(
      RunJobSchema.parse({
        ...validRunJob(),
        ...generateRunIdentifiers(new Date("2026-10-22T03:15:00Z")),
      }).status,
    ).toBe("submitted");
  });

  test.each(["created", "submitted", "running", "succeeded", "failed", "cancelled", "collected"])(
    "accepts the M2 state %s with process identity recorded",
    (status) => {
      expect(
        RunJobSchema.safeParse({
          ...validRunJob(),
          status,
          pid: 1234,
          pid_started_at: "2026-10-22T03:15:01Z",
        }).success,
      ).toBe(true);
    },
  );

  test.each([
    ["job_id", "JOB-0001"],
    ["job_id", "shud-0123456789abcdef"],
    ["job_id", "JOB-20261022T031500-A1B2"],
    ["job_id", "RUN-20261022T031500-a1b2"],
    ["run_id", "RUN-20261022T031500-A1B2"],
    ["run_id", "RUN-0001"],
    ["run_id", "JOB-20261022T031500-a1b2"],
  ])("rejects malformed %s: %s", (field, value) => {
    const result = RunJobSchema.safeParse({ ...validRunJob(), [field]: value });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain(field);
  });

  test.each(["pid", "pid_started_at"])("running requires %s", (field) => {
    const result = RunJobSchema.safeParse({
      ...validRunJob(),
      status: "running",
      pid: 1234,
      pid_started_at: "2026-10-22T03:15:01Z",
      [field]: null,
    });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain(field);
  });

  test.each([
    ["status", "timed_out"],
    ["command", "shud ccw"],
    ["input_dir", "input/ccw"],
    ["run_dir", "runs/example"],
    ["label", "two\nlines"],
    ["end_days", 0],
    ["input_bytes", -1],
    ["exit_code", 0.5],
    ["submitted_at", "2026-10-22T03:15:00+08:00"],
    ["llm", { response_model: "", response_model_source: "response" }],
    ["notify", { status: "pending", attempts: -1, at: null, detail: null }],
  ])("rejects invalid %s", (field, value) => {
    expect(RunJobSchema.safeParse({ ...validRunJob(), [field]: value }).success).toBe(false);
  });

  test("rejects cwd and unknown nested fields instead of stripping them", () => {
    expect(RunJobSchema.safeParse({ ...validRunJob(), cwd: "/tmp" }).success).toBe(false);
    for (const field of ["llm", "notify"] as const) {
      const job = validRunJob();
      expect(
        RunJobSchema.safeParse({ ...job, [field]: { ...job[field], extra: true } }).success,
      ).toBe(false);
    }
  });

  test("all RunJob fields are required even when nullable", () => {
    const job = validRunJob();
    for (const key of Object.keys(job) as Array<keyof typeof job>) {
      const result = RunJobSchema.safeParse(removeKey(job, key));
      expect(result.success, key).toBe(false);
      expect(issuePaths(result), key).toContain(key);
    }
  });
});

describe("core Zod schemas", () => {
  test("TaskCard accepts a valid stored object and rejects missing required fields", () => {
    const parsed = TaskCardSchema.safeParse(validTaskCard());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.status).toBe("created");
      expect(parsed.data.runtime_phase).toBeNull();
    }

    const missingTitle = TaskCardSchema.safeParse(removeKey(validTaskCard(), "title"));
    expect(missingTitle.success).toBe(false);
    expect(issuePaths(missingTitle)).toContain("title");
  });

  test("TaskCard rejects status values outside the coarse state machine", () => {
    const invalid = TaskCardSchema.safeParse({
      ...validTaskCard(),
      status: "revised",
    });

    expect(invalid.success).toBe(false);
    expect(issuePaths(invalid)).toContain("status");
  });

  test("Artifact defaults llm_generated to false and preserves an explicit true marker", () => {
    const parsed = ArtifactSchema.safeParse(validArtifact());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.llm_generated).toBe(false);
    }

    const llmGenerated = ArtifactSchema.safeParse({
      ...validArtifact(),
      llm_generated: true,
    });
    expect(llmGenerated.success).toBe(true);
    if (llmGenerated.success) {
      expect(llmGenerated.data.llm_generated).toBe(true);
    }

    const explicitlyNotLlmGenerated = ArtifactSchema.safeParse({
      ...validArtifact(),
      llm_generated: false,
    });
    expect(explicitlyNotLlmGenerated.success).toBe(true);
    if (explicitlyNotLlmGenerated.success) {
      expect(explicitlyNotLlmGenerated.data.llm_generated).toBe(false);
    }
  });

  test("Artifact remains strict and rejects missing, non-boolean, and unknown fields", () => {
    const missingPath = ArtifactSchema.safeParse(removeKey(validArtifact(), "path"));
    expect(missingPath.success).toBe(false);
    expect(issuePaths(missingPath)).toContain("path");

    const unknownField = ArtifactSchema.safeParse({
      ...validArtifact(),
      legacy_evidence_flag: true,
    });
    expect(unknownField.success).toBe(false);

    const nonBooleanMarker = ArtifactSchema.safeParse({
      ...validArtifact(),
      llm_generated: "false",
    });
    expect(nonBooleanMarker.success).toBe(false);
    expect(issuePaths(nonBooleanMarker)).toContain("llm_generated");
  });

  test("StackLock accepts the three-repository shape and nullable R package lock", () => {
    const parsed = StackLockSchema.safeParse(validStackLock());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.keys(parsed.data.repos)).toEqual(["SHUD", "rSHUD", "AutoSHUD"]);
      expect(parsed.data.runtime.r_packages_lock).toEqual({
        path: "renv.lock",
        sha256: "sha256:renv-lock",
      });
      expect(parsed.data.llm.base_url).toBe("https://models.example/v1");
    }

    const withoutRPackagesLock = StackLockSchema.safeParse({
      ...validStackLock(),
      runtime: {
        ...validStackLock().runtime,
        r_packages_lock: null,
      },
    });
    expect(withoutRPackagesLock.success).toBe(true);
  });

  test("StackLock requires llm.base_url and every canonical repository", () => {
    const withoutBaseUrl = StackLockSchema.safeParse({
      ...validStackLock(),
      llm: removeKey(validStackLock().llm, "base_url"),
    });
    expect(withoutBaseUrl.success).toBe(false);
    expect(issuePaths(withoutBaseUrl)).toContain("llm.base_url");
  });

  test("StackLock requires a boolean dirty flag on every repository revision", () => {
    for (const name of ["SHUD", "rSHUD", "AutoSHUD"] as const) {
      const lock = validStackLock();
      const withoutDirty = StackLockSchema.safeParse({
        ...lock,
        repos: { ...lock.repos, [name]: removeKey(lock.repos[name], "dirty") },
      });
      expect(withoutDirty.success).toBe(false);
      expect(issuePaths(withoutDirty)).toContain(`repos.${name}.dirty`);
    }

    const lock = validStackLock();
    const stringDirty = StackLockSchema.safeParse({
      ...lock,
      repos: { ...lock.repos, SHUD: { ...lock.repos.SHUD, dirty: "false" } },
    });
    expect(stringDirty.success).toBe(false);
    expect(issuePaths(stringDirty)).toContain("repos.SHUD.dirty");

    const extraField = StackLockSchema.safeParse({
      ...lock,
      repos: { ...lock.repos, rSHUD: { ...lock.repos.rSHUD, remote: "origin" } },
    });
    expect(extraField.success).toBe(false);

    const dirtyTrue = StackLockSchema.safeParse({
      ...lock,
      repos: { ...lock.repos, AutoSHUD: { ...lock.repos.AutoSHUD, dirty: true } },
    });
    expect(dirtyTrue.success).toBe(true);
  });

  test("StackLock rejects the legacy runtime.r_packages_lock string", () => {
    const legacyRPackagesLock = StackLockSchema.safeParse({
      ...validStackLock(),
      runtime: {
        ...validStackLock().runtime,
        r_packages_lock: "renv.lock",
      },
    });

    expect(legacyRPackagesLock.success).toBe(false);
    expect(issuePaths(legacyRPackagesLock)).toContain("runtime.r_packages_lock");
  });

  test("StackLock rejects deprecated or unknown fields at every strict boundary", () => {
    const runtimeContainer = StackLockSchema.safeParse({
      ...validStackLock(),
      runtime: {
        ...validStackLock().runtime,
        container: "docker",
      },
    });
    expect(runtimeContainer.success).toBe(false);

    const limits = StackLockSchema.safeParse({
      ...validStackLock(),
      limits: { max_wall_minutes: 30 },
    });
    expect(limits.success).toBe(false);

    const policyVersion = StackLockSchema.safeParse({
      ...validStackLock(),
      policy_version: "legacy",
    });
    expect(policyVersion.success).toBe(false);

    const degraded = StackLockSchema.safeParse({
      ...validStackLock(),
      degraded: ["renv_lock_missing"],
    });
    expect(degraded.success).toBe(false);
  });

  test("StackLock rejects ids outside STACK-<uuid>", () => {
    const invalid = StackLockSchema.safeParse({
      ...validStackLock(),
      stack_id: "STACK-0001",
    });

    expect(invalid.success).toBe(false);
    expect(issuePaths(invalid)).toContain("stack_id");
  });

  test("DataProvenance accepts the canonical object window and hashed sources", () => {
    const parsed = DataProvenanceSchema.safeParse(validDataProvenance());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.basin).toBe("cache_creek");
      expect(parsed.data.event_window).toEqual({
        start: "2008-01-01",
        end: "2008-02-28",
      });
      expect(parsed.data.sources.observations[0]).toEqual({
        variable: "discharge",
        station: "USGS-11451100",
        path: "data/raw/ccw/obs_q.csv",
        sha256: "sha256:observations",
      });
    }
  });

  test("DataProvenance rejects the deprecated event window array and missing basin", () => {
    const arrayWindow = DataProvenanceSchema.safeParse({
      ...validDataProvenance(),
      event_window: ["2008-01-01", "2008-02-28"],
    });
    expect(arrayWindow.success).toBe(false);
    expect(issuePaths(arrayWindow)).toContain("event_window");

    const missingBasin = DataProvenanceSchema.safeParse(removeKey(validDataProvenance(), "basin"));
    expect(missingBasin.success).toBe(false);
    expect(issuePaths(missingBasin)).toContain("basin");
  });

  test("DataProvenance rejects unhashed sources and incomplete observations", () => {
    const sourceWithoutHash = DataProvenanceSchema.safeParse({
      ...validDataProvenance(),
      sources: {
        ...validDataProvenance().sources,
        forcing: {
          path: "data/raw/ccw/forcing/",
        },
      },
    });
    expect(sourceWithoutHash.success).toBe(false);
    expect(issuePaths(sourceWithoutHash)).toContain("sources.forcing.sha256");

    const observationWithoutStation = DataProvenanceSchema.safeParse({
      ...validDataProvenance(),
      sources: {
        ...validDataProvenance().sources,
        observations: [removeKey(validDataProvenance().sources.observations[0], "station")],
      },
    });
    expect(observationWithoutStation.success).toBe(false);
    expect(issuePaths(observationWithoutStation)).toContain("sources.observations.0.station");
  });

  test("DataProvenance enforces DATA-<uuid> and strict nested records", () => {
    const invalidId = DataProvenanceSchema.safeParse({
      ...validDataProvenance(),
      data_id: "DATA-0001",
    });
    expect(invalidId.success).toBe(false);
    expect(issuePaths(invalidId)).toContain("data_id");

    const unexpectedSourceField = DataProvenanceSchema.safeParse({
      ...validDataProvenance(),
      sources: {
        ...validDataProvenance().sources,
        terrain: {
          ...validDataProvenance().sources.terrain,
          checksum: "legacy",
        },
      },
    });
    expect(unexpectedSourceField.success).toBe(false);
  });

  test("ArtifactManifest preserves omitted, true, and false Artifact LLM markers", () => {
    const parsed = ArtifactManifestSchema.safeParse({
      ...validArtifactManifest(),
      artifacts: [
        validArtifact(),
        { ...validArtifact(), artifact_id: "ART-0002", llm_generated: true },
        { ...validArtifact(), artifact_id: "ART-0003", llm_generated: false },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.manifest_id).toBe(MANIFEST_ID);
      expect(parsed.data.superseded_by).toBe(SUCCESSOR_MANIFEST_ID);
      expect(parsed.data.artifacts[0]?.llm_generated).toBe(false);
      expect(parsed.data.artifacts[1]?.llm_generated).toBe(true);
      expect(parsed.data.artifacts[2]?.llm_generated).toBe(false);
    }
  });

  test("ArtifactManifest accepts omission of every optional reference and hash field", () => {
    const parsed = ArtifactManifestSchema.safeParse(
      removeKeys(validArtifactManifest(), [
        "run_id",
        "report_id",
        "superseded_by",
        "manifest_sha256",
      ]),
    );

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.run_id).toBeUndefined();
      expect(parsed.data.report_id).toBeUndefined();
      expect(parsed.data.superseded_by).toBeUndefined();
      expect(parsed.data.manifest_sha256).toBeUndefined();
      expect(parsed.data.artifacts[0]?.llm_generated).toBe(false);
    }
  });

  test("ArtifactManifest requires generator and full Artifact entries", () => {
    const missingGenerator = ArtifactManifestSchema.safeParse(
      removeKey(validArtifactManifest(), "generator"),
    );
    expect(missingGenerator.success).toBe(false);
    expect(issuePaths(missingGenerator)).toContain("generator");

    const compactArtifact = ArtifactManifestSchema.safeParse({
      ...validArtifactManifest(),
      artifacts: [
        {
          artifact_id: "ART-0001",
          type: "report_markdown",
          path: "reports/TASK-0001_report.md",
        },
      ],
    });
    expect(compactArtifact.success).toBe(false);
    expect(issuePaths(compactArtifact)).toContain("artifacts.0.task_id");
  });

  test("ArtifactManifest enforces MANIFEST-<uuid> references and strict fields", () => {
    const invalidId = ArtifactManifestSchema.safeParse({
      ...validArtifactManifest(),
      manifest_id: "MANIFEST-0001",
    });
    expect(invalidId.success).toBe(false);
    expect(issuePaths(invalidId)).toContain("manifest_id");

    const invalidSuccessor = ArtifactManifestSchema.safeParse({
      ...validArtifactManifest(),
      superseded_by: "MANIFEST-next",
    });
    expect(invalidSuccessor.success).toBe(false);
    expect(issuePaths(invalidSuccessor)).toContain("superseded_by");

    const unknownField = ArtifactManifestSchema.safeParse({
      ...validArtifactManifest(),
      artifact_ids: ["ART-0001"],
    });
    expect(unknownField.success).toBe(false);
  });

  test("ErrorRecord accepts remediation and rejects invalid next_action", () => {
    const parsed = ErrorRecordSchema.safeParse(validErrorRecord());
    expect(parsed.success).toBe(true);

    const withoutRef = ErrorRecordSchema.safeParse({
      ...validErrorRecord(),
      remediation: {
        next_action: "fix_and_retry",
        hint: "Retry after fixing the workspace path.",
      },
    });
    expect(withoutRef.success).toBe(true);

    const invalid = ErrorRecordSchema.safeParse({
      ...validErrorRecord(),
      remediation: {
        next_action: "try_anyway",
        hint: "Remove the unsupported tool.",
        ref: "docs/02_ARCHITECTURE/Control_Kernel.md#5-stop-conditions-与策略门校验约定",
      },
    });
    expect(invalid.success).toBe(false);
    expect(issuePaths(invalid)).toContain("remediation.next_action");
  });

  test("IdempotencyRecord accepts request_digest and rejects missing required fields", () => {
    const parsed = IdempotencyRecordSchema.safeParse(validIdempotencyRecord());
    expect(parsed.success).toBe(true);

    const missingDigest = IdempotencyRecordSchema.safeParse(
      removeKey(validIdempotencyRecord(), "request_digest"),
    );
    expect(missingDigest.success).toBe(false);
    expect(issuePaths(missingDigest)).toContain("request_digest");

    const invalidStatus = IdempotencyRecordSchema.safeParse({
      ...validIdempotencyRecord(),
      status: "running",
    });
    expect(invalidStatus.success).toBe(false);
    expect(issuePaths(invalidStatus)).toContain("status");
  });

  test("LockRecord accepts a valid object and rejects missing required fields", () => {
    const parsed = LockRecordSchema.safeParse(validLockRecord());
    expect(parsed.success).toBe(true);

    const missingHolder = LockRecordSchema.safeParse(removeKey(validLockRecord(), "holder"));
    expect(missingHolder.success).toBe(false);
    expect(issuePaths(missingHolder)).toContain("holder");

    const invalidStatus = LockRecordSchema.safeParse({
      ...validLockRecord(),
      status: "open",
    });
    expect(invalidStatus.success).toBe(false);
    expect(issuePaths(invalidStatus)).toContain("status");
  });
});

function validTaskCard() {
  return {
    task_id: "TASK-0001",
    type: "engineering",
    status: "created",
    runtime_phase: null,
    title: "Add optional event diagnostics",
    question_or_goal: "Add event_flux output without breaking old rSHUD readers",
    created_by: "alice",
    current_owner: "alice",
    reviewer: "pi_name",
    inference_budget: {
      mode: "normal",
      advisory_usd: 1,
      advisory_model_calls: 12,
      reviewer_enabled: false,
    },
    linked_jobs: [],
    linked_reports: [],
    created_at: "2026-04-25T10:00:00Z",
    updated_at: "2026-04-25T10:00:00Z",
  };
}

function validArtifact() {
  return {
    artifact_id: "ART-0001",
    task_id: "TASK-0001",
    type: "report_markdown",
    path: "reports/TASK-0001_report.md",
    media_type: "text/markdown",
    created_at: "2026-04-25T10:00:00Z",
    created_by: "agent",
    evidence_usable: false,
    retention_class: "debug",
    source_refs: [],
    redaction_status: "not_needed",
  };
}

function validStackLock() {
  return {
    stack_id: STACK_ID,
    repos: {
      SHUD: {
        commit: "9b55b0cb9b55b0cb9b55b0cb9b55b0cb9b55b0cb",
        branch: "master",
        dirty: false,
      },
      rSHUD: {
        commit: "d162db3d162db3d162db3d162db3d162db3d162d",
        branch: "master",
        dirty: false,
      },
      AutoSHUD: {
        commit: "1cbec6f1cbec6f1cbec6f1cbec6f1cbec6f1cbe",
        branch: "master",
        dirty: false,
      },
    },
    runtime: {
      os: "Darwin 24.6.0",
      r_version: "4.4.1",
      r_packages_lock: {
        path: "renv.lock",
        sha256: "sha256:renv-lock",
      },
      python_version: "3.12.4",
      sundials_version: "6.0.0",
      gcc_version: "14.1.0",
      gdal_version: "3.9.0",
    },
    harness: {
      version: "0.8.0",
      cli_version: "unknown",
      prompt_pack: "promptpack-unset",
      skills_version: "skills-unset",
    },
    llm: {
      provider: "openai_compatible",
      model_id: "glm-5.2",
      base_url: "https://models.example/v1",
      params_digest: "sha256:params",
      prompt_pack_digest: "sha256:prompt-pack",
    },
    fingerprint: "sha256:stack-fingerprint",
    created_at: "2026-07-23T12:00:00Z",
  };
}

function validDataProvenance() {
  return {
    data_id: DATA_ID,
    basin: "cache_creek",
    event_window: {
      start: "2008-01-01",
      end: "2008-02-28",
    },
    sources: {
      terrain: {
        path: "data/raw/ccw/dem.tif",
        sha256: "sha256:terrain",
      },
      mesh: {
        path: "repos/SHUD/input/ccw/ccw.sp.mesh",
        sha256: "sha256:mesh",
      },
      forcing: {
        path: "data/raw/ccw/forcing/",
        sha256: "sha256:forcing",
      },
      observations: [
        {
          variable: "discharge",
          station: "USGS-11451100",
          path: "data/raw/ccw/obs_q.csv",
          sha256: "sha256:observations",
        },
      ],
    },
    preprocess: {
      script: "scripts/prep_ccw.R",
      params: {
        interpolation: "IDW",
        resolution: "200m",
      },
      output_sha256: "sha256:preprocess-output",
    },
    uncertainty_notes: "降水空间插值可能低估高海拔降水量",
  };
}

function validArtifactManifest() {
  return {
    manifest_id: MANIFEST_ID,
    task_id: "TASK-0001",
    run_id: "RUN-0001",
    report_id: "REPORT-0001",
    superseded_by: SUCCESSOR_MANIFEST_ID,
    artifacts: [validArtifact()],
    generated_at: "2026-07-23T12:00:00Z",
    generator: "shud-harness",
    manifest_sha256: "sha256:manifest",
  };
}

function validErrorRecord() {
  return {
    error_id: "ERR-0001",
    category: "permission_error",
    severity: "error",
    task_id: "TASK-0001",
    message: "Policy gate denied bash.",
    user_message: "This command writes to a protected path.",
    evidence_refs: [],
    retryable: false,
    recommended_next_actions: ["Use a governed workspace path."],
    remediation: {
      next_action: "adjust_scope",
      hint: "Use a governed workspace path instead of data/raw.",
      ref: "docs/02_ARCHITECTURE/Control_Kernel.md#5-stop-conditions-与策略门校验约定",
    },
    created_at: "2026-04-25T10:00:00Z",
  };
}

function validIdempotencyRecord() {
  return {
    key: "task:TASK-0001:create",
    scope: "task",
    request_digest: "sha256:abc123",
    status: "completed",
    result_ref: "TASK-0001",
    created_at: "2026-04-25T10:00:00Z",
    updated_at: "2026-04-25T10:01:00Z",
  };
}

function validLockRecord() {
  return {
    lock_id: "LOCK-0001",
    scope: "task",
    target_id: "TASK-0001",
    holder: "worker-1",
    acquired_at: "2026-04-25T10:00:00Z",
    expires_at: "2026-04-25T10:01:00Z",
    status: "held",
    reason: "task snapshot write",
  };
}

function validRunJob() {
  return {
    job_id: "JOB-20261022T031500-a1b2",
    run_id: "RUN-20261022T031500-a1b2",
    task_id: null,
    stack_id: null,
    data_id: null,
    backend: "local_job",
    status: "submitted",
    project: "ccw",
    label: null,
    input_dir: "/models/input/ccw",
    run_dir: "/workspace/runs/RUN-20261022T031500-a1b2",
    command: ["/usr/local/bin/shud", "ccw"],
    end_days: null,
    owner_session: null,
    dsh_job_id: null,
    dsh_job_ids: [],
    pid: null,
    pid_started_at: null,
    input_bytes: 1024,
    submitted_at: "2026-10-22T03:15:00Z",
    started_at: null,
    finished_at: null,
    cancel_requested_at: null,
    exit_code: null,
    llm: { response_model: "deepseek-chat", response_model_source: "response" },
    notify: { status: "pending", attempts: 0, at: null, detail: null },
  };
}

function removeKey<T extends Record<string, unknown>, K extends keyof T>(
  object: T,
  key: K,
): Omit<T, K> {
  const clone = { ...object };
  delete clone[key];
  return clone;
}

function removeKeys<T extends Record<string, unknown>, K extends keyof T>(
  object: T,
  keys: readonly K[],
): Omit<T, K> {
  const clone = { ...object };
  for (const key of keys) {
    delete clone[key];
  }
  return clone;
}

function issuePaths(
  result:
    | {
        success: true;
      }
    | {
        success: false;
        error: { issues: Array<{ path: PropertyKey[] }> };
      },
): string[] {
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join("."));
}

function validRunRecord() {
  return {
    run_id: "RUN-20261022T031500-a1b2",
    job_id: "JOB-20261022T031500-a1b2",
    task_id: null,
    stack_id: null,
    data_id: null,
    status: "succeeded",
    command: ["/usr/local/bin/shud", "ccw"],
    exit_code: 0,
    exit_class: "ok",
    artifacts: {
      stdout: "/runs/example/stdout.log",
      stderr: "/runs/example/stderr.log",
      shud_output: "/runs/example/output/ccw.out",
      files: [{ path: "flow.dat", size_bytes: 0 }],
    },
    numerical_health: {
      water_balance_residual: null,
      cvode_failures: null,
      negative_state_count: null,
      max_solver_dt: null,
    },
    resources: { wall_seconds: null, peak_memory_mb: null },
    llm: { response_model: "deepseek-chat", response_model_source: "response" },
    collected_at: "2026-10-22T03:16:00Z",
  };
}
