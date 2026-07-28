export type ObserverOutcome =
  | { kind: "clean" }
  | { kind: "dirty" }
  | { kind: "rejected"; code: string };

export type CatalogRow = {
  id: string;
  macos_expected: ObserverOutcome;
  linux_expected: ObserverOutcome;
  producing_boundary: ProducingBoundary;
};

export type ProducingBoundary = "observer" | "launcher" | "tripwire";

export const PRODUCING_BOUNDARIES = Object.freeze(["observer", "launcher", "tripwire"] as const);

export const CONTROL_ASSERTION_IDS = Object.freeze([
  "oracle", "ambient_path", "subprocess", "network", "protected_write", "protection", "cleanup"
] as const);

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

export function producingBoundaryFor(id: string): ProducingBoundary {
  if (/^PRT-01[0-2]$/.test(id)) return "tripwire";
  if ([
    "CAP-005", "CAP-006", "CAP-008", "CAP-009", "CAP-016", "CAP-017",
    "LIF-003", "LIF-004", "LIF-005", "LIF-007"
  ].includes(id) || /^PRT-00[1-9]$/.test(id)) return "launcher";
  return "observer";
}

export const CATALOG_V1: readonly CatalogRow[] = Object.freeze(CATALOG_IDS.map((id) => ({
  id,
  macos_expected: expectedOutcome(id),
  linux_expected: expectedOutcome(id),
  producing_boundary: producingBoundaryFor(id)
})));

const CATALOG_NEGATIVE_RELATIONSHIP_MATERIAL = Object.freeze<Record<string, string>>({
  "CAP-005": "scheduled-input-v1", "CAP-006": "scheduled-input-v1", "CAP-008": "scheduled-input-v1",
  "CAP-009": "scheduled-input-v1", "CAP-016": "canonical-frame-wire-v1", "CAP-017": "canonical-frame-wire-v1",
  "PRT-001": "scheduled-input-v1", "PRT-002": "scheduled-input-v1", "PRT-003": "scheduled-input-v1",
  "PRT-004": "scheduled-input-v1", "PRT-005": "scheduled-input-v1", "PRT-006": "scheduled-input-v1",
  "PRT-007": "scheduled-input-v1", "PRT-008": "scheduled-input-v1", "PRT-009": "scheduled-input-v1",
  "PRT-010": "scheduled-input-v1", "PRT-011": "scheduled-input-v1", "PRT-012": "scheduled-input-v1",
  "LIF-003": "scheduled-input-v1", "LIF-004": "scheduled-input-v1", "LIF-005": "scheduled-input-v1",
  "LIF-007": "scheduled-input-v1"
});

export const CATALOG_NEGATIVE_RELATIONSHIPS_V1 = Object.freeze(Object.fromEntries(
  Object.entries(CATALOG_NEGATIVE_RELATIONSHIP_MATERIAL).map(([rowId, suppliedMaterialKind]) => [rowId, Object.freeze({
    identity: `shud.catalog-negative.${rowId}.v1`, supplied_material_kind: suppliedMaterialKind
  })])
));

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

export const FRAME_EVIDENCE_ENCODING = "shud.git-status-capability.canonical-frame-json.v1";

export const FRAME_EVIDENCE_FIELD_ORDER = Object.freeze([
  "schema_version", "catalog_version", "row_id", "observation_id", "checkout_capability_identity",
  "git_state_generation_digest", "body_length", "body_digest", "checksum", "index", "head_tree",
  "effective_config", "exclude_state", "attribute_state", "nested_state", "limit_stimulus"
]);

export const DECISION_ROW_SEGMENTS = Object.freeze([
  "platform", "row_id", "expected_kind", "expected_code", "observed_kind", "observed_code", "row_verdict",
  "observation_id", "generation_payload_digest", "frame_digest", "producing_boundary",
  "active_control_bitset", "passed_control_bitset", "protection_set_equal", "cleanup_verdict", "declared_limit", "boundary_class",
  "determinism_proof", "failure_cause"
]);

export const DECISION_LIMIT_TOKENS = Object.freeze([
  "none", "frame_bytes", "index_bytes", "index_entries", "path_bytes", "path_depth", "nested_repositories",
  "traversal_entries", "hashed_bytes", "wall_time_ms", "cpu_time_ms", "threads", "memory_bytes", "output_bytes"
]);

export const SCHEMA_DESCRIPTORS = Object.freeze({
  frame: {
    schema_version: "shud.git-status-capability.frame.v1",
    required_fields: [
      "schema_version", "catalog_version", "row_id", "observation_id", "checkout_capability_identity",
      "git_state_generation_digest", "body_length", "body_digest", "checksum", "index", "head_tree",
      "effective_config", "exclude_state", "attribute_state", "nested_state"
    ],
    optional_fields: ["limit_stimulus"],
    field_types: {
      schema_version: "literal", catalog_version: "integer:1", row_id: "catalog-row-id", observation_id: "sha256",
      checkout_capability_identity: "sha256", git_state_generation_digest: "sha256", body_length: "uint64",
      body_digest: "sha256", checksum: "sha256", index: "strict:index-frame-v1-parsed-or-byte-material-without-observer-answer",
      head_tree: "strict:head-tree-v1-with-baseline-entries", effective_config: "strict:effective-config-v1-with-content-digest",
      exclude_state: "strict:path-source-state-v1-with-base64-content-byte-length-and-digest",
      attribute_state: "strict:path-source-state-v1-with-base64-content-byte-length-and-digest",
      nested_state: "sorted-array:strict:nested-state-v1-with-state-specific-audit-material",
      limit_stimulus: "optional:strict:catalog-exact-plus-one-deterministic-material-recipe"
    },
    additional_properties: false
  },
  row_evidence: {
    schema_version: "shud.git-status-capability.row-evidence.v1",
    required_fields: [
      "schema_version", "platform", "row_id", "observation_id", "checkout_capability_identity",
      "git_state_generation_digest", "frame_digest", "frame_binding", "expected_outcome", "observer_outcome", "producing_boundary",
      "actual_producing_boundary", "row_verdict", "oracle_digest", "control_assertions", "protection_set_equal", "cleanup", "resource_record",
      "actual_resource_record",
      "source_input_record_sha256"
    ],
    optional_fields: ["first_cause", "secondary_errors", "determinism_proof", "failure_cause"],
    field_types: {
      schema_version: "literal", platform: "enum:macos|linux", row_id: "catalog-row-id", observation_id: "sha256",
      checkout_capability_identity: "sha256", git_state_generation_digest: "sha256", frame_digest: "sha256",
      frame_binding: "strict:{scheduled:{row_id,observation_id,checkout_capability_identity,git_state_generation_digest,input_length,input_digest,material:canonical-frame-wire-v1:{version=1,header_length=128,body_length,extension_length},frame_reference:{encoding:literal:shud.git-status-capability.canonical-frame-json.v1,frame:strict-frame-v1}},supplied:{row_id,observation_id,checkout_capability_identity,git_state_generation_digest,input_length,input_digest,material:strict-supplied-input-proof-v1}};wire=magic:SHUDCAP1|version:u8@8|flags-zero:u8@9|header-length:u16be@10|total-length:u64be@12|body-length:u32be@20|extension-length:u64be@24|body-sha256@32|extension-sha256@64|frame-sha256@96;header=128;frame-sha256=sha256(header[0:96]||body||extension);total=header+body+extension;no-trailing-bytes;length-limit-classified-before-structure;scheduled=strict-canonical;supplied=actual-wire-proof;CAP-010-payload-byte-mutation|CAP-011-truncate-one|CAP-012-surplus-frame|LIM-001-one-legal-8MiB-wire|LIM-002-wire-plus-one-byte",
      expected_outcome: "frozen-platform-slot-outcome", observer_outcome: "observer-outcome", producing_boundary: "frozen-row-enum:observer|launcher|tripwire",
      actual_producing_boundary: "actual-enum:observer|launcher|tripwire;pass=expected;fail=causality-bound-to-outcome-control-or-resource",
      row_verdict: "iff:expected=observed-and-all-required-active-controls-pass", oracle_digest: "sha256",
      control_assertions: "strict:{oracle,ambient_path,subprocess,network,protected_write,protection,cleanup}:{active:literal:true,verdict:pass|fail}",
      protection_set_equal: "boolean;iff-control-protection-pass",
      cleanup: "strict:{verdict:pass|fail,descriptors_restored:boolean,processes_reaped:boolean};LIF-006|007=causal-cleanup-failure-with-control-pass;otherwise-verdict=control-cleanup",
      resource_record: "strict:catalog-expected-boundary:{below|exact|exceeded,observer-limit|none,within_limits=(boundary!=exceeded)}",
      actual_resource_record: "strict:actual-boundary;LIM=content-addressed-stimulus-and-measurement;technical-failure=causality-bound;below-none-has-no-proof", source_input_record_sha256: "sha256",
      first_cause: "optional:nonempty-string;LIF-002|006=FRAME_VERSION_UNSUPPORTED;LIF-007=CLEANUP_FAILED", secondary_errors: "optional:string[];LIF-002|007=[];LIF-006=[CLEANUP_FAILED]",
      determinism_proof: "iff-row-DET-001..004:strict:{variation_axis,axis_material,axis_digest,first,second,comparison};two-distinct-receipts;strict-structured-per-invocation-input-and-output;production-recomputed-normalized-row-output-and-nonrecursive-formal-d8-projection;outer-axis-material-and-digest-derived-only-from-per-receipt-axis-binding;stable-input-equal-after-excluding-only-declared-axis;DET-001=exact-full-input-repeat;DET-002=side-bound-fixture-creation-order;DET-003=side-bound-fixture-root;DET-004=side-bound-permitted-volatile-material",
      failure_cause: "iff-row-verdict-fail:shared-canonical-closed-union:outcome-mismatch-v1(observer-only)|control-failure-v1(producer-specific-control)|resource-exceeded-v1(complete-stimulus-and-measurement)|lifecycle-fault-v1(exact-LIF-002|006|007-mutation-errors-cleanup)|catalog-negative-mismatch-v1(frozen-launcher-or-tripwire-negative-row,alternate-frozen-code,exact-boundary,content-addressed-supplied-state-and-per-row-relationship-recipe);content-addressed-receipt-bound-to-platform-row-slot-and-actual-supplied-input"
    },
    additional_properties: false
  },
  platform_bundle: {
    schema_version: "shud.git-status-capability.platform-bundle.v1",
    required_fields: [
      "schema_version", "platform", "run_status", "source_commit", "source_input_record_sha256", "catalog_digest",
      "toolchain", "target", "dependency_graph_digest", "direct_feature_digest", "call_ledger_digest", "sbom_digest",
      "license_inventory_digest", "rows", "protection_set", "raw_command_manifest"
    ],
    optional_fields: ["first_cause", "all_failure_codes"],
    field_types: {
      schema_version: "literal", platform: "enum:macos|linux", run_status: "enum:valid_complete|invalid",
      source_commit: "git-object-id", source_input_record_sha256: "sha256", catalog_digest: "sha256",
      toolchain: "strict:{rustc_vv,cargo_version,git_version,target_triple}", target: "platform-target",
      dependency_graph_digest: "sha256", direct_feature_digest: "sha256", call_ledger_digest: "sha256",
      sbom_digest: "sha256", license_inventory_digest: "sha256",
      rows: "array:row-evidence;valid_complete=174-exact;top-level-observation,scheduled-generation,actual-supplied-input-identities=unique-per-platform-slot;DET-paired-receipt-identities=8-globally-unique;same-row-nested-observation-repeat-only-exception",
      protection_set: "array:strict:{identity,pre_digest,post_digest,event_digest};identity-unique;pre_digest=post_digest;valid_complete=nonempty",
      raw_command_manifest: "array:command-receipt;valid_complete=nonempty", first_cause: "invalid-only:nonempty-string",
      all_failure_codes: "invalid-only:sorted-unique-string[]"
    },
    additional_properties: false
  },
  final_bundle: {
    schema_version: "shud.git-status-capability.final-bundle.v1",
    required_fields: [
      "schema_version", "source_input_record_sha256", "macos_bundle_sha256", "linux_bundle_sha256",
      "repository_gates", "raw_evidence_digest", "decision_projection_digest", "run_status"
    ],
    optional_fields: ["terminal_decision", "first_cause", "all_failure_codes"],
    field_types: {
      schema_version: "literal", source_input_record_sha256: "sha256", macos_bundle_sha256: "sha256",
      linux_bundle_sha256: "sha256;valid_complete:distinct-from-macos", repository_gates: "nonempty-map:gate-receipt", raw_evidence_digest: "sha256",
      decision_projection_digest: "sha256", run_status: "enum:valid_complete|invalid", terminal_decision: "iff-valid_complete:accepted|rejected",
      first_cause: "optional:nonempty-string", all_failure_codes: "optional:string[]"
    },
    additional_properties: false
  },
  decision: {
    schema_version: "shud.git-status-capability.decision.v1",
    required_fields: [
      "schema_version", "catalog_version", "catalog_digest", "base_sha",
      "fixture_identity", "oracle_identity", "frame_identity", "runner_identity", "validator_identity", "tripwire_identity",
      "source_input_record_sha256", "lockfile_digest", "lockfile_completeness_verdict",
      "direct_feature_digest", "direct_feature_completeness_verdict",
      "macos_target_graph_digest", "macos_target_graph_completeness_verdict",
      "linux_target_graph_digest", "linux_target_graph_completeness_verdict",
      "call_ledger_digest", "call_ledger_completeness_verdict", "sbom_digest", "sbom_completeness_verdict",
      "license_inventory_digest", "license_inventory_completeness_verdict",
      "macos_target_identity", "macos_toolchain_identity", "linux_target_identity", "linux_toolchain_identity",
      "platforms", "rows", "gates", "run_status"
    ],
    optional_fields: ["terminal_decision", "first_cause", "all_failure_codes"],
    field_types: {
      schema_version: "literal", catalog_version: "integer:1", catalog_digest: "sha256", base_sha: "git-object-id",
      fixture_identity: "sha256", oracle_identity: "sha256", frame_identity: "sha256", runner_identity: "sha256",
      validator_identity: "sha256", tripwire_identity: "sha256", source_input_record_sha256: "sha256",
      lockfile_digest: "sha256", lockfile_completeness_verdict: "literal:pass",
      direct_feature_digest: "sha256", direct_feature_completeness_verdict: "literal:pass",
      macos_target_graph_digest: "sha256", macos_target_graph_completeness_verdict: "literal:pass",
      linux_target_graph_digest: "sha256", linux_target_graph_completeness_verdict: "literal:pass",
      call_ledger_digest: "sha256", call_ledger_completeness_verdict: "literal:pass",
      sbom_digest: "sha256", sbom_completeness_verdict: "literal:pass",
      license_inventory_digest: "sha256", license_inventory_completeness_verdict: "literal:pass",
      macos_target_identity: "literal:aarch64-apple-darwin", macos_toolchain_identity: "sha256",
      linux_target_identity: "literal:x86_64-unknown-linux-gnu", linux_toolchain_identity: "sha256",
      platforms: "exact:[macos,linux]",
      rows: "array:strict-d8-row-scalar-v1:nul-segments:[platform(m|l),row_id,expected_kind(c|d|r),expected_code,observed_kind(c|d|r),observed_code,row_verdict(p|f),observation_id,generation_payload_digest,actual_supplied_input_digest,actual_producing_boundary(o|l|t),active_control_bitset(7f=all-required-active),passed_control_bitset(00..7f),protection_set_equal(1|0),cleanup_verdict(p|f),actual_declared_limit(0..13),actual_boundary_class(b|e|x),determinism_proof(0=non-DET|1..4=validated-paired-DET-proof),failure_cause(empty-if-pass|canonical-base64url-shared-causal-projection-if-fail)];failure-cause=observer-only-generic-mismatch|producer-specific-control|complete-resource-proof|exact-LIF-mutation-errors-cleanup|frozen-catalog-negative-code-mismatch-with-content-addressed-supplied-state-and-per-row-relationship;pass=actual-boundaries-equal-catalog-expected;fail=causality-bound;control-bit-order=oracle|ambient_path|subprocess|network|protected_write|protection|cleanup;valid_complete=348-exact;catalog-slot,top-level-observation,generation/payload,actual-supplied-input-identities=globally-unique;DET nested same-slot repeat-only-exception",
      gates: "nonempty-array:strict-repository-command-receipt:{id,argv,version,exit_verdict,summary_digest,source_input_record_sha256};id-unique;source-record-equal",
      run_status: "enum:valid_complete|invalid", terminal_decision: "iff-valid_complete:accepted-iff-all-row-verdicts-pass|rejected-iff-any-row-verdict-fails",
      first_cause: "rejected-or-invalid:nonempty-string", all_failure_codes: "rejected-or-invalid:sorted-unique-string[]"
    },
    additional_properties: false
  },
  source_input_record: {
    schema_version: "shud.git-status-capability.source-input-record.v1",
    required_fields: [
      "schema_version", "source_sha", "source_input_digest", "manifest_digest", "entry_count", "admitted_paths",
      "primary_encoder", "witness_encoder", "command_receipt"
    ],
    optional_fields: [],
    field_types: {
      schema_version: "literal", source_sha: "git-object-id", source_input_digest: "sha256", manifest_digest: "sha256",
      entry_count: "positive-safe-integer", admitted_paths: "sorted-array:strict:{path,git_mode}",
      primary_encoder: "strict:{identity,result}", witness_encoder: "strict:{identity,result};identity-distinct;result-equal",
      command_receipt: "strict:PLATFORM-SOURCE-INPUT-create-argv-version-exit-receipt"
    },
    additional_properties: false
  }
} as const);

export const SOURCE_INPUT_DIGEST_V1 = Object.freeze({
  domain_prefix: "SHUD-HARNESS\0GIT-STATUS-CAPABILITY\0SOURCE-INPUT-DIGEST\0V1\0",
  entry_order: "raw_repository_relative_utf8_bytes",
  integer_encoding: "unsigned_big_endian",
  allowed_git_modes: ["100644", "100755"],
  frame_fields: [
    "u32_entry_count", "u32_path_byte_length", "path_utf8_bytes", "u32_git_mode_octal",
    "u64_content_byte_length", "raw_git_blob_bytes"
  ],
  source_sha_hashed: false,
  live_literal_allowed: false,
  synthetic_literal_path: "spikes/git-status-capability/contracts/goldens/source-input-v1.synthetic.sha256"
} as const);

export const SOURCE_MANIFEST_DIGEST_V1 = Object.freeze({
  domain_prefix: "SHUD-HARNESS\0GIT-STATUS-CAPABILITY\0SOURCE-MANIFEST-DIGEST\0V1\n",
  entry_order: "raw_repository_relative_utf8_bytes",
  entry_frame: "git_mode_ascii,NUL,path_utf8_bytes,LF",
  terminal_lf: true
} as const);

export const TARGET_GRAPH_EXPECTATIONS = Object.freeze({
  "aarch64-apple-darwin": {
    packages: 115,
    edges: 342,
    predicates: 25,
    graph_digest: "b93ceb0faa116f32ce9da94de32cf295900a1240900cc352ae555719a6cc6a82"
  },
  "x86_64-unknown-linux-gnu": {
    packages: 117,
    edges: 343,
    predicates: 23,
    graph_digest: "6bf62b2ab2dd76a15a8ade65a7ef4d3b0f9b8438bf2d956423ed38520e2100db"
  }
} as const);
