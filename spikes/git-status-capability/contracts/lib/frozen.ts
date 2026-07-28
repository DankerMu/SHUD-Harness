export type ObserverOutcome =
  | { kind: "clean" }
  | { kind: "dirty" }
  | { kind: "rejected"; code: string };

export type CatalogRow = {
  id: string;
  macos_expected: ObserverOutcome;
  linux_expected: ObserverOutcome;
};

export type FloorMapping = {
  floor_id: string;
  row_id: string;
  fixture_owner: string;
  native_owner: string;
  oracle: string;
};

export type Ownership = {
  row_id: string;
  fixture_owner: string;
  native_owner: string;
};

const ranges = [
  ["BAS", 6], ["STG", 12], ["UNT", 9], ["ATR", 5], ["CFG", 21],
  ["IDX", 20], ["LAY", 4], ["NES", 13], ["CAP", 17], ["HLP", 17],
  ["PRT", 12], ["LIM", 26], ["LIF", 8], ["DET", 4]
] as const;

function ids(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(index + 1).padStart(3, "0")}`);
}

export const CATALOG_IDS = Object.freeze(ranges.flatMap(([prefix, count]) => ids(prefix, count)));

const DIRTY_IDS = new Set([
  "BAS-002", "BAS-003", "BAS-004", "BAS-005",
  "STG-001", "STG-002", "STG-003", "STG-004", "STG-005", "STG-006", "STG-007", "STG-008", "STG-012",
  "UNT-001", "UNT-002", "UNT-008", "UNT-009", "ATR-004",
  "CFG-002", "CFG-005", "CFG-008", "CFG-014", "CFG-015", "CFG-017",
  "IDX-002", "IDX-004", "IDX-006", "IDX-013", "IDX-015", "LAY-004",
  "NES-002", "NES-004", "NES-006", "NES-007",
  "HLP-004", "HLP-014", "HLP-015", "HLP-016"
]);

const REJECTIONS = Object.freeze<Record<string, string>>({
  "CFG-018": "CONFIG_BOOLEAN_INVALID",
  "IDX-007": "INDEX_SHARED_MISSING", "IDX-008": "INDEX_SHARED_CORRUPT",
  "IDX-009": "INDEX_MALFORMED", "IDX-010": "INDEX_TRUNCATED", "IDX-011": "LIMIT_INDEX_BYTES",
  "IDX-016": "INDEX_GITLINK_CONFLICT", "IDX-017": "INDEX_GITLINK_CONFLICT", "IDX-018": "INDEX_GITLINK_CONFLICT",
  "IDX-019": "INDEX_STAGE_UNKNOWN", "IDX-020": "INDEX_MALFORMED",
  "NES-008": "NESTED_STATE_CHANGED", "NES-009": "NESTED_STATE_CHANGED", "NES-010": "NESTED_STATE_CHANGED",
  "NES-011": "EXTERNAL_FILTER_REQUIRED", "NES-012": "EXTERNAL_FILTER_REQUIRED", "NES-013": "EXTERNAL_FILTER_REQUIRED",
  "CAP-005": "DESCRIPTOR_MISSING", "CAP-006": "DESCRIPTOR_CLOSED", "CAP-007": "DESCRIPTOR_NOT_DIRECTORY",
  "CAP-008": "DESCRIPTOR_NOT_ALLOWLISTED", "CAP-009": "DESCRIPTOR_ALIAS", "CAP-010": "FRAME_CHECKSUM",
  "CAP-011": "FRAME_TRUNCATED", "CAP-012": "FRAME_SURPLUS", "CAP-013": "PATH_ABSOLUTE",
  "CAP-014": "PATH_ESCAPE", "CAP-015": "REPLAY_FOREIGN_CHECKOUT", "CAP-016": "REPLAY_STALE_GENERATION",
  "CAP-017": "REPLAY_CROSS_ROW",
  "HLP-003": "EXTERNAL_FILTER_REQUIRED", "HLP-008": "EXTERNAL_FILTER_REQUIRED", "HLP-009": "EXTERNAL_FILTER_REQUIRED",
  "HLP-010": "EXTERNAL_FILTER_REQUIRED", "HLP-011": "EXTERNAL_FILTER_REQUIRED", "HLP-012": "EXTERNAL_FILTER_REQUIRED",
  "HLP-013": "EXTERNAL_FILTER_REQUIRED",
  "PRT-001": "PROTECTED_TMPDIR", "PRT-002": "PROTECTED_TMPDIR", "PRT-003": "PROTECTED_TMPDIR",
  "PRT-004": "PROTECTED_TMPDIR", "PRT-005": "PROTECTED_TMPDIR", "PRT-006": "PROTECTED_TMPDIR",
  "PRT-007": "PROTECTED_TMPDIR", "PRT-008": "PROTECTED_TMPDIR", "PRT-009": "PROTECTED_OUTPUT_PATH",
  "PRT-010": "PROTECTED_WRITE_ATTEMPT", "PRT-011": "PROTECTED_METADATA_ATTEMPT", "PRT-012": "PROTECTED_GIT_WRITE_ATTEMPT",
  "LIM-002": "LIMIT_FRAME_BYTES", "LIM-004": "LIMIT_INDEX_BYTES", "LIM-006": "LIMIT_INDEX_ENTRIES",
  "LIM-008": "LIMIT_PATH_BYTES", "LIM-010": "LIMIT_PATH_DEPTH", "LIM-012": "LIMIT_NESTED_REPOSITORIES",
  "LIM-014": "LIMIT_TRAVERSAL_ENTRIES", "LIM-016": "LIMIT_HASHED_BYTES", "LIM-018": "LIMIT_WALL_TIME",
  "LIM-020": "LIMIT_CPU_TIME", "LIM-022": "LIMIT_THREADS", "LIM-024": "LIMIT_MEMORY", "LIM-026": "LIMIT_OUTPUT_BYTES",
  "LIF-002": "FRAME_VERSION_UNSUPPORTED", "LIF-003": "TIMEOUT", "LIF-004": "SIGNALLED_TERM",
  "LIF-005": "SIGNALLED_KILL", "LIF-006": "FRAME_VERSION_UNSUPPORTED", "LIF-007": "CLEANUP_FAILED"
});

export const REJECTION_CODES = Object.freeze([...new Set(Object.values(REJECTIONS)), "PLATFORM_UNSUPPORTED"] .sort());

export function expectedOutcome(id: string): ObserverOutcome {
  const code = REJECTIONS[id];
  if (code) return { kind: "rejected", code };
  return { kind: DIRTY_IDS.has(id) ? "dirty" : "clean" };
}

export const CATALOG_V1: readonly CatalogRow[] = Object.freeze(CATALOG_IDS.map((id) => ({
  id,
  macos_expected: expectedOutcome(id),
  linux_expected: expectedOutcome(id)
})));

const floorRows = [
  "IDX-012", "IDX-013", "IDX-014", "IDX-015", "NES-008", "NES-009", "NES-010", "NES-011", "NES-012", "NES-013",
  "IDX-016", "IDX-017", "IDX-018", "IDX-019", "IDX-020", "HLP-008", "HLP-009", "HLP-010", "HLP-011", "HLP-012",
  "HLP-013", "HLP-014", "HLP-015", "HLP-016", "HLP-017"
];

const floorOracles = [
  "Git clean", "Git dirty", "Git clean", "Git dirty",
  "NESTED_STATE_CHANGED", "NESTED_STATE_CHANGED", "NESTED_STATE_CHANGED",
  "EXTERNAL_FILTER_REQUIRED; marker absent", "EXTERNAL_FILTER_REQUIRED; marker absent", "EXTERNAL_FILTER_REQUIRED; marker absent",
  "INDEX_GITLINK_CONFLICT; status/helper absent", "INDEX_GITLINK_CONFLICT; status/helper absent", "INDEX_GITLINK_CONFLICT; status/helper absent",
  "INDEX_STAGE_UNKNOWN; status absent", "INDEX_MALFORMED; status absent",
  "EXTERNAL_FILTER_REQUIRED; marker absent", "EXTERNAL_FILTER_REQUIRED; marker absent", "EXTERNAL_FILTER_REQUIRED; marker absent",
  "EXTERNAL_FILTER_REQUIRED; marker absent", "EXTERNAL_FILTER_REQUIRED; marker absent", "EXTERNAL_FILTER_REQUIRED; marker absent",
  "Git dirty; marker absent", "Git dirty; marker absent", "Git dirty; marker absent", "Git clean; marker absent"
];

export function ownerFor(id: string): { fixture_owner: string; native_owner: string } {
  if (/^(BAS|STG)-/.test(id) || ["UNT-001", "UNT-002", "UNT-009"].includes(id)) return { fixture_owner: "2.1", native_owner: "4.2" };
  if (/^(ATR|CFG)-/.test(id) || /^UNT-00[3-8]$/.test(id)) return { fixture_owner: "2.2", native_owner: "4.3" };
  if (/^IDX-/.test(id)) return { fixture_owner: "2.3", native_owner: "4.4" };
  if (/^LAY-/.test(id) || /^NES-00[1-9]$/.test(id) || /^NES-010$/.test(id)) return { fixture_owner: "2.3", native_owner: "4.5" };
  if (/^NES-01[1-3]$/.test(id)) return { fixture_owner: "2.3", native_owner: "4.6" };
  if (/^(CAP|HLP|PRT)-/.test(id)) return { fixture_owner: "2.4", native_owner: "4.6" };
  if (/^(LIM|LIF|DET)-/.test(id)) return { fixture_owner: "2.5", native_owner: "4.7" };
  throw new Error(`Unowned catalog row: ${id}`);
}

export const OWNERSHIP_V1: readonly Ownership[] = Object.freeze(CATALOG_IDS.map((row_id) => ({ row_id, ...ownerFor(row_id) })));

export const FLOOR_V1: readonly FloorMapping[] = Object.freeze(floorRows.map((row_id, index) => ({
  floor_id: `F132-${String(index + 1).padStart(2, "0")}`,
  row_id,
  ...ownerFor(row_id),
  oracle: floorOracles[index]!
})));

export const INGESTION_LIMITS = Object.freeze({
  catalog: { bytes: 512 * 1024, depth: 16, nodes: 32_768, items: 4_096 },
  dependency_graph: { bytes: 256 * 1024, depth: 16, nodes: 16_384, items: 4_096 },
  schema: { bytes: 256 * 1024, depth: 32, nodes: 32_768, items: 8_192 },
  source_input_record: { bytes: 64 * 1024, depth: 12, nodes: 2_048, items: 512 },
  row_evidence: { bytes: 512 * 1024, depth: 32, nodes: 65_536, items: 16_384 },
  platform_bundle: { bytes: 8 * 1024 * 1024, depth: 32, nodes: 1_048_576, items: 262_144 },
  final_bundle: { bytes: 20 * 1024 * 1024, depth: 32, nodes: 2_097_152, items: 524_288 },
  decision: { bytes: 128 * 1024, depth: 16, nodes: 8_192, items: 2_048 }
});

export const OBSERVER_LIMITS = Object.freeze({
  frame_bytes: 8 * 1024 * 1024,
  index_bytes: 6 * 1024 * 1024,
  index_entries: 50_000,
  path_bytes: 512,
  path_depth: 16,
  nested_repositories: 16,
  traversal_entries: 200_000,
  hashed_bytes: 256 * 1024 * 1024,
  wall_time_ms: 10_000,
  cpu_time_ms: 5_000,
  threads: 4,
  memory_bytes: 512 * 1024 * 1024,
  output_bytes: 256 * 1024
});

export const TOOLCHAIN = Object.freeze({
  rust: "1.88.0",
  git_oracle: "2.49.0",
  bun: "1.2.19",
  openspec: "1.3.1"
});

export const SCHEMA_DESCRIPTORS = Object.freeze({
  frame: {
    schema_version: "shud.git-status-capability.frame.v1",
    required_fields: [
      "schema_version", "catalog_version", "row_id", "observation_id", "checkout_capability_identity",
      "git_state_generation_digest", "body_length", "body_digest", "checksum", "index", "head_tree",
      "effective_config", "exclude_state", "attribute_state", "nested_state"
    ],
    optional_fields: [],
    additional_properties: false
  },
  row_evidence: {
    schema_version: "shud.git-status-capability.row-evidence.v1",
    required_fields: [
      "schema_version", "platform", "row_id", "expected_outcome", "observer_outcome", "producing_boundary",
      "row_verdict", "oracle_digest", "tripwire_verdicts", "protection_set_equal", "cleanup", "resource_record",
      "source_input_record_sha256"
    ],
    optional_fields: ["first_cause", "secondary_errors"],
    additional_properties: false
  },
  platform_bundle: {
    schema_version: "shud.git-status-capability.platform-bundle.v1",
    required_fields: [
      "schema_version", "platform", "run_status", "source_commit", "source_input_record_sha256", "catalog_digest",
      "toolchain", "target", "dependency_graph_digest", "direct_feature_digest", "call_ledger_digest", "sbom_digest",
      "license_inventory_digest", "rows", "protection_set", "raw_command_manifest"
    ],
    optional_fields: [],
    additional_properties: false
  },
  final_bundle: {
    schema_version: "shud.git-status-capability.final-bundle.v1",
    required_fields: [
      "schema_version", "source_input_record_sha256", "macos_bundle_sha256", "linux_bundle_sha256",
      "repository_gates", "raw_evidence_digest", "decision_projection_digest", "run_status"
    ],
    optional_fields: ["terminal_decision", "first_cause", "all_failure_codes"],
    additional_properties: false
  },
  decision: {
    schema_version: "shud.git-status-capability.decision.v1",
    required_fields: [
      "schema_version", "catalog_version", "catalog_digest", "source_input_record_sha256", "platforms", "rows",
      "gates", "run_status"
    ],
    optional_fields: ["terminal_decision", "first_cause", "all_failure_codes"],
    additional_properties: false
  },
  source_input_record: {
    schema_version: "shud.git-status-capability.source-input-record.v1",
    required_fields: [
      "schema_version", "source_sha", "source_input_digest", "manifest_digest", "entry_count", "admitted_paths",
      "primary_encoder", "witness_encoder", "command_receipt"
    ],
    optional_fields: [],
    additional_properties: false
  }
} as const);

export const TARGET_GRAPH_EXPECTATIONS = Object.freeze({
  "aarch64-apple-darwin": {
    packages: 115,
    edges: 342,
    predicates: 25,
    graph_digest: "2ed2d79ad7c49fd4e9a472afd844f01165e23e619c6df348938b4cffda3ae74e"
  },
  "x86_64-unknown-linux-gnu": {
    packages: 117,
    edges: 343,
    predicates: 23,
    graph_digest: "bcb5d7f1225584561ac029c384fc742730e4666f9f25df714806849567bba0a0"
  }
} as const);
