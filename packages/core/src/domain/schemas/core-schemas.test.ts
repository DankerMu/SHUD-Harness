import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import ts from "typescript";
import {
  ArtifactManifestSchema,
  ArtifactSchema,
  DataProvenanceSchema,
  ErrorRecordSchema,
  IdempotencyRecordSchema,
  LockRecordSchema,
  StackLockSchema,
  TaskCardSchema
} from "./index";

const STACK_ID = "STACK-11111111-1111-4111-8111-111111111111";
const DATA_ID = "DATA-22222222-2222-4222-8222-222222222222";
const MANIFEST_ID = "MANIFEST-33333333-3333-4333-8333-333333333333";
const SUCCESSOR_MANIFEST_ID = "MANIFEST-44444444-4444-4444-8444-444444444444";

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
      status: "revised"
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
      llm_generated: true
    });
    expect(llmGenerated.success).toBe(true);
    if (llmGenerated.success) {
      expect(llmGenerated.data.llm_generated).toBe(true);
    }

    const explicitlyNotLlmGenerated = ArtifactSchema.safeParse({
      ...validArtifact(),
      llm_generated: false
    });
    expect(explicitlyNotLlmGenerated.success).toBe(true);
    if (explicitlyNotLlmGenerated.success) {
      expect(explicitlyNotLlmGenerated.data.llm_generated).toBe(false);
    }
  });

  test("public schema barrel preserves Artifact and ArtifactManifest input/output requiredness", () => {
    const barrelPath = join(import.meta.dir, "index.ts");
    const program = ts.createProgram({
      rootNames: [barrelPath],
      options: {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        noEmit: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ES2022
      }
    });
    expect(
      ts.getPreEmitDiagnostics(program).map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
      )
    ).toEqual([]);

    const source = program.getSourceFile(barrelPath);
    expect(source).toBeDefined();
    const checker = program.getTypeChecker();
    const moduleSymbol = source ? checker.getSymbolAtLocation(source) : undefined;
    expect(moduleSymbol).toBeDefined();
    const exportsByName = new Map(
      moduleSymbol
        ? checker.getExportsOfModule(moduleSymbol).map((symbol) => [symbol.getName(), symbol])
        : []
    );

    for (const inputTypeName of ["Artifact", "ArtifactInput"] as const) {
      const inputTypeSymbol = exportsByName.get(inputTypeName);
      expect(inputTypeSymbol).toBeDefined();
      const inputType = inputTypeSymbol
        ? checker.getDeclaredTypeOfSymbol(inputTypeSymbol)
        : undefined;
      const marker = inputType?.getProperty("llm_generated");
      expect(marker).toBeDefined();
      expect(Boolean(marker && (marker.flags & ts.SymbolFlags.Optional))).toBe(true);
    }

    const storedTypeSymbol = exportsByName.get("StoredArtifact");
    expect(storedTypeSymbol).toBeDefined();
    const storedType = storedTypeSymbol
      ? checker.getDeclaredTypeOfSymbol(storedTypeSymbol)
      : undefined;
    const storedMarker = storedType?.getProperty("llm_generated");
    expect(storedMarker).toBeDefined();
    expect(Boolean(storedMarker && (storedMarker.flags & ts.SymbolFlags.Optional))).toBe(false);
    expect(
      storedMarker && source
        ? checker.typeToString(checker.getTypeOfSymbolAtLocation(storedMarker, source))
        : undefined
    ).toBe("boolean");

    for (const manifestTypeName of [
      "ArtifactManifest",
      "ArtifactManifestInput",
      "StoredArtifactManifest"
    ] as const) {
      const manifestTypeSymbol = exportsByName.get(manifestTypeName);
      expect(manifestTypeSymbol).toBeDefined();
      const manifestType = manifestTypeSymbol
        ? checker.getDeclaredTypeOfSymbol(manifestTypeSymbol)
        : undefined;

      for (const requiredField of [
        "manifest_id",
        "task_id",
        "artifacts",
        "generated_at",
        "generator"
      ] as const) {
        const field = manifestType?.getProperty(requiredField);
        expect(field).toBeDefined();
        expect(Boolean(field && (field.flags & ts.SymbolFlags.Optional))).toBe(false);
      }

      for (const optionalField of [
        "run_id",
        "report_id",
        "superseded_by",
        "manifest_sha256"
      ] as const) {
        const field = manifestType?.getProperty(optionalField);
        expect(field).toBeDefined();
        expect(Boolean(field && (field.flags & ts.SymbolFlags.Optional))).toBe(true);
      }
    }
  });

  test("Artifact remains strict and rejects missing, non-boolean, and unknown fields", () => {
    const missingPath = ArtifactSchema.safeParse(removeKey(validArtifact(), "path"));
    expect(missingPath.success).toBe(false);
    expect(issuePaths(missingPath)).toContain("path");

    const unknownField = ArtifactSchema.safeParse({
      ...validArtifact(),
      legacy_evidence_flag: true
    });
    expect(unknownField.success).toBe(false);

    const nonBooleanMarker = ArtifactSchema.safeParse({
      ...validArtifact(),
      llm_generated: "false"
    });
    expect(nonBooleanMarker.success).toBe(false);
    expect(issuePaths(nonBooleanMarker)).toContain("llm_generated");
  });

  test("StackLock accepts the four-repository shape and nullable R package lock", () => {
    const parsed = StackLockSchema.safeParse(validStackLock());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.keys(parsed.data.repos)).toEqual(["SHUD", "rSHUD", "AutoSHUD", "zero"]);
      expect(parsed.data.runtime.r_packages_lock).toEqual({
        path: "renv.lock",
        sha256: "sha256:renv-lock"
      });
      expect(parsed.data.llm.base_url).toBe("https://models.example/v1");
    }

    const withoutRPackagesLock = StackLockSchema.safeParse({
      ...validStackLock(),
      runtime: {
        ...validStackLock().runtime,
        r_packages_lock: null
      }
    });
    expect(withoutRPackagesLock.success).toBe(true);
  });

  test("StackLock requires llm.base_url and every canonical repository", () => {
    const withoutBaseUrl = StackLockSchema.safeParse({
      ...validStackLock(),
      llm: removeKey(validStackLock().llm, "base_url")
    });
    expect(withoutBaseUrl.success).toBe(false);
    expect(issuePaths(withoutBaseUrl)).toContain("llm.base_url");

    const withoutZero = StackLockSchema.safeParse({
      ...validStackLock(),
      repos: removeKey(validStackLock().repos, "zero")
    });
    expect(withoutZero.success).toBe(false);
    expect(issuePaths(withoutZero)).toContain("repos.zero");
  });

  test("StackLock rejects the legacy runtime.r_packages_lock string", () => {
    const legacyRPackagesLock = StackLockSchema.safeParse({
      ...validStackLock(),
      runtime: {
        ...validStackLock().runtime,
        r_packages_lock: "renv.lock"
      }
    });

    expect(legacyRPackagesLock.success).toBe(false);
    expect(issuePaths(legacyRPackagesLock)).toContain("runtime.r_packages_lock");
  });

  test("StackLock rejects deprecated or unknown fields at every strict boundary", () => {
    const runtimeContainer = StackLockSchema.safeParse({
      ...validStackLock(),
      runtime: {
        ...validStackLock().runtime,
        container: "docker"
      }
    });
    expect(runtimeContainer.success).toBe(false);

    const limits = StackLockSchema.safeParse({
      ...validStackLock(),
      limits: { max_wall_minutes: 30 }
    });
    expect(limits.success).toBe(false);

    const policyVersion = StackLockSchema.safeParse({
      ...validStackLock(),
      policy_version: "legacy"
    });
    expect(policyVersion.success).toBe(false);

    const degraded = StackLockSchema.safeParse({
      ...validStackLock(),
      degraded: ["renv_lock_missing"]
    });
    expect(degraded.success).toBe(false);
  });

  test("StackLock rejects ids outside STACK-<uuid>", () => {
    const invalid = StackLockSchema.safeParse({
      ...validStackLock(),
      stack_id: "STACK-0001"
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
        end: "2008-02-28"
      });
      expect(parsed.data.sources.observations[0]).toEqual({
        variable: "discharge",
        station: "USGS-11451100",
        path: "data/raw/ccw/obs_q.csv",
        sha256: "sha256:observations"
      });
    }
  });

  test("DataProvenance rejects the deprecated event window array and missing basin", () => {
    const arrayWindow = DataProvenanceSchema.safeParse({
      ...validDataProvenance(),
      event_window: ["2008-01-01", "2008-02-28"]
    });
    expect(arrayWindow.success).toBe(false);
    expect(issuePaths(arrayWindow)).toContain("event_window");

    const missingBasin = DataProvenanceSchema.safeParse(
      removeKey(validDataProvenance(), "basin")
    );
    expect(missingBasin.success).toBe(false);
    expect(issuePaths(missingBasin)).toContain("basin");
  });

  test("DataProvenance rejects unhashed sources and incomplete observations", () => {
    const sourceWithoutHash = DataProvenanceSchema.safeParse({
      ...validDataProvenance(),
      sources: {
        ...validDataProvenance().sources,
        forcing: {
          path: "data/raw/ccw/forcing/"
        }
      }
    });
    expect(sourceWithoutHash.success).toBe(false);
    expect(issuePaths(sourceWithoutHash)).toContain("sources.forcing.sha256");

    const observationWithoutStation = DataProvenanceSchema.safeParse({
      ...validDataProvenance(),
      sources: {
        ...validDataProvenance().sources,
        observations: [
          removeKey(validDataProvenance().sources.observations[0]!, "station")
        ]
      }
    });
    expect(observationWithoutStation.success).toBe(false);
    expect(issuePaths(observationWithoutStation)).toContain("sources.observations.0.station");
  });

  test("DataProvenance enforces DATA-<uuid> and strict nested records", () => {
    const invalidId = DataProvenanceSchema.safeParse({
      ...validDataProvenance(),
      data_id: "DATA-0001"
    });
    expect(invalidId.success).toBe(false);
    expect(issuePaths(invalidId)).toContain("data_id");

    const unexpectedSourceField = DataProvenanceSchema.safeParse({
      ...validDataProvenance(),
      sources: {
        ...validDataProvenance().sources,
        terrain: {
          ...validDataProvenance().sources.terrain,
          checksum: "legacy"
        }
      }
    });
    expect(unexpectedSourceField.success).toBe(false);
  });

  test("ArtifactManifest preserves omitted, true, and false Artifact LLM markers", () => {
    const parsed = ArtifactManifestSchema.safeParse({
      ...validArtifactManifest(),
      artifacts: [
        validArtifact(),
        { ...validArtifact(), artifact_id: "ART-0002", llm_generated: true },
        { ...validArtifact(), artifact_id: "ART-0003", llm_generated: false }
      ]
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
        "manifest_sha256"
      ])
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
      removeKey(validArtifactManifest(), "generator")
    );
    expect(missingGenerator.success).toBe(false);
    expect(issuePaths(missingGenerator)).toContain("generator");

    const compactArtifact = ArtifactManifestSchema.safeParse({
      ...validArtifactManifest(),
      artifacts: [
        {
          artifact_id: "ART-0001",
          type: "report_markdown",
          path: "reports/TASK-0001_report.md"
        }
      ]
    });
    expect(compactArtifact.success).toBe(false);
    expect(issuePaths(compactArtifact)).toContain("artifacts.0.task_id");
  });

  test("ArtifactManifest enforces MANIFEST-<uuid> references and strict fields", () => {
    const invalidId = ArtifactManifestSchema.safeParse({
      ...validArtifactManifest(),
      manifest_id: "MANIFEST-0001"
    });
    expect(invalidId.success).toBe(false);
    expect(issuePaths(invalidId)).toContain("manifest_id");

    const invalidSuccessor = ArtifactManifestSchema.safeParse({
      ...validArtifactManifest(),
      superseded_by: "MANIFEST-next"
    });
    expect(invalidSuccessor.success).toBe(false);
    expect(issuePaths(invalidSuccessor)).toContain("superseded_by");

    const unknownField = ArtifactManifestSchema.safeParse({
      ...validArtifactManifest(),
      artifact_ids: ["ART-0001"]
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
        hint: "Retry after fixing the workspace path."
      }
    });
    expect(withoutRef.success).toBe(true);

    const invalid = ErrorRecordSchema.safeParse({
      ...validErrorRecord(),
      remediation: {
        next_action: "try_anyway",
        hint: "Remove the unsupported tool.",
        ref: "docs/02_ARCHITECTURE/Control_Kernel.md#5-stop-conditions-与策略门校验约定"
      }
    });
    expect(invalid.success).toBe(false);
    expect(issuePaths(invalid)).toContain("remediation.next_action");
  });

  test("IdempotencyRecord accepts request_digest and rejects missing required fields", () => {
    const parsed = IdempotencyRecordSchema.safeParse(validIdempotencyRecord());
    expect(parsed.success).toBe(true);

    const missingDigest = IdempotencyRecordSchema.safeParse(
      removeKey(validIdempotencyRecord(), "request_digest")
    );
    expect(missingDigest.success).toBe(false);
    expect(issuePaths(missingDigest)).toContain("request_digest");

    const invalidStatus = IdempotencyRecordSchema.safeParse({
      ...validIdempotencyRecord(),
      status: "running"
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
      status: "open"
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
      reviewer_enabled: false
    },
    linked_jobs: [],
    linked_reports: [],
    created_at: "2026-04-25T10:00:00Z",
    updated_at: "2026-04-25T10:00:00Z"
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
    redaction_status: "not_needed"
  };
}

function validStackLock() {
  return {
    stack_id: STACK_ID,
    repos: {
      SHUD: {
        commit: "9b55b0cb9b55b0cb9b55b0cb9b55b0cb9b55b0cb",
        branch: "master",
        dirty: false
      },
      rSHUD: {
        commit: "d162db3d162db3d162db3d162db3d162db3d162d",
        branch: "master",
        dirty: false
      },
      AutoSHUD: {
        commit: "1cbec6f1cbec6f1cbec6f1cbec6f1cbec6f1cbe",
        branch: "master",
        dirty: false
      },
      zero: {
        commit: "13e25c116c62411e6ee8a0ad67a6c53dc7c376c6",
        branch: "main",
        dirty: false
      }
    },
    runtime: {
      os: "Darwin 24.6.0",
      r_version: "4.4.1",
      r_packages_lock: {
        path: "renv.lock",
        sha256: "sha256:renv-lock"
      },
      python_version: "3.12.4",
      sundials_version: "6.0.0",
      gcc_version: "14.1.0",
      gdal_version: "3.9.0"
    },
    harness: {
      version: "0.8.0",
      cli_version: "unknown",
      prompt_pack: "promptpack-unset",
      skills_version: "skills-unset"
    },
    llm: {
      provider: "openai_compatible",
      model_id: "glm-5.2",
      base_url: "https://models.example/v1",
      params_digest: "sha256:params",
      prompt_pack_digest: "sha256:prompt-pack"
    },
    fingerprint: "sha256:stack-fingerprint",
    created_at: "2026-07-23T12:00:00Z"
  };
}

function validDataProvenance() {
  return {
    data_id: DATA_ID,
    basin: "cache_creek",
    event_window: {
      start: "2008-01-01",
      end: "2008-02-28"
    },
    sources: {
      terrain: {
        path: "data/raw/ccw/dem.tif",
        sha256: "sha256:terrain"
      },
      mesh: {
        path: "repos/SHUD/input/ccw/ccw.sp.mesh",
        sha256: "sha256:mesh"
      },
      forcing: {
        path: "data/raw/ccw/forcing/",
        sha256: "sha256:forcing"
      },
      observations: [
        {
          variable: "discharge",
          station: "USGS-11451100",
          path: "data/raw/ccw/obs_q.csv",
          sha256: "sha256:observations"
        }
      ]
    },
    preprocess: {
      script: "scripts/prep_ccw.R",
      params: {
        interpolation: "IDW",
        resolution: "200m"
      },
      output_sha256: "sha256:preprocess-output"
    },
    uncertainty_notes: "降水空间插值可能低估高海拔降水量"
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
    manifest_sha256: "sha256:manifest"
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
      ref: "docs/02_ARCHITECTURE/Control_Kernel.md#5-stop-conditions-与策略门校验约定"
    },
    created_at: "2026-04-25T10:00:00Z"
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
    updated_at: "2026-04-25T10:01:00Z"
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
    reason: "task snapshot write"
  };
}

function removeKey<T extends Record<string, unknown>, K extends keyof T>(
  object: T,
  key: K
): Omit<T, K> {
  const clone = { ...object };
  delete clone[key];
  return clone;
}

function removeKeys<T extends Record<string, unknown>, K extends keyof T>(
  object: T,
  keys: readonly K[]
): Omit<T, K> {
  const clone = { ...object };
  for (const key of keys) {
    delete clone[key];
  }
  return clone;
}

function issuePaths(result: {
  success: true;
} | {
  success: false;
  error: { issues: Array<{ path: Array<string | number> }> };
}): string[] {
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join("."));
}


describe("StackLock repository dirty state", () => {
  test("requires a boolean dirty field for every repository revision", () => {
    const clean = validStackLock();
    expect(StackLockSchema.safeParse(clean).success).toBe(true);
    expect(StackLockSchema.safeParse({
      ...clean,
      repos: {
        ...clean.repos,
        SHUD: { ...clean.repos.SHUD, dirty: true }
      }
    }).success).toBe(true);

    const { dirty: _missing, ...withoutDirty } = clean.repos.SHUD;
    const missing = StackLockSchema.safeParse({
      ...clean,
      repos: { ...clean.repos, SHUD: withoutDirty }
    });
    expect(missing.success).toBe(false);
    expect(issuePaths(missing)).toContain("repos.SHUD.dirty");

    const wrongType = StackLockSchema.safeParse({
      ...clean,
      repos: {
        ...clean.repos,
        zero: { ...clean.repos.zero, dirty: "false" }
      }
    });
    expect(wrongType.success).toBe(false);
    expect(issuePaths(wrongType)).toContain("repos.zero.dirty");
  });
});
