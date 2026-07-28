import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJsonBytes, sealFrame } from "../lib/canonical-frame";
import { encodeDecisionRowProjection } from "../lib/decision";
import { encodeDecisionRowProjectionCore } from "../lib/row-projection";
import { CATALOG_V1, DECISION_ROW_SEGMENTS, INGESTION_LIMITS, OBSERVER_LIMITS, REJECTION_CODES } from "../lib/frozen";
import { validateDeterminismProof } from "../lib/determinism-proof";
import { validateDecision, validateFrame, validatePlatformBundle, validateRowEvidence, validateSourceInputRecord } from "../lib/schema";
import { canonicalWireFrameBytes } from "../lib/wire-frame";

const shaA = "01".repeat(32);
const generic = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/valid/generic.json"), "utf8"));

const LIMITS = [
  ["frame_bytes", "bytes", OBSERVER_LIMITS.frame_bytes],
  ["index_bytes", "bytes", OBSERVER_LIMITS.index_bytes],
  ["index_entries", "count", OBSERVER_LIMITS.index_entries],
  ["path_bytes", "bytes", OBSERVER_LIMITS.path_bytes],
  ["path_depth", "segments", OBSERVER_LIMITS.path_depth],
  ["nested_repositories", "count", OBSERVER_LIMITS.nested_repositories],
  ["traversal_entries", "count", OBSERVER_LIMITS.traversal_entries],
  ["hashed_bytes", "bytes", OBSERVER_LIMITS.hashed_bytes],
  ["wall_time_ms", "milliseconds", OBSERVER_LIMITS.wall_time_ms],
  ["cpu_time_ms", "milliseconds", OBSERVER_LIMITS.cpu_time_ms],
  ["threads", "count", OBSERVER_LIMITS.threads],
  ["memory_bytes", "bytes", OBSERVER_LIMITS.memory_bytes],
  ["output_bytes", "bytes", OBSERVER_LIMITS.output_bytes]
] as const;

function digest(value: unknown): string {
  const bytes = value instanceof Uint8Array ? value : canonicalJsonBytes(value);
  return createHash("sha256").update(bytes).digest("hex");
}

function measuredResource(row: any, limit: string, unit: string, value: number): any {
  const recipe = { kind: "literal-counter-v1", limit, unit, value };
  const recipeDigest = digest(recipe);
  const locatorCore = {
    kind: LIMITS.findIndex(([candidate]) => candidate === limit) < 8 ? "supplied-frame-locator-v1" : "launcher-receipt-v1",
    row_id: row.row_id,
    observation_id: row.observation_id,
    supplied_input_digest: row.frame_digest,
    recipe_digest: recipeDigest,
    source: LIMITS.findIndex(([candidate]) => candidate === limit) < 8 ? "canonical-supplied-frame" : "launcher-counter"
  };
  const locator = { ...locatorCore, receipt_digest: digest(locatorCore) };
  return {
    boundary_class: value > (OBSERVER_LIMITS as any)[limit] ? "exceeded" : value === (OBSERVER_LIMITS as any)[limit] ? "exact" : "below",
    declared_limit: limit,
    within_limits: value <= (OBSERVER_LIMITS as any)[limit],
    stimulus: {
      schema_version: "shud.git-status-capability.limit-stimulus.v1",
      recipe,
      recipe_digest: recipeDigest,
      locator
    },
    measurement: {
      schema_version: "shud.git-status-capability.limit-measurement.v1",
      limit,
      unit,
      value,
      stimulus_receipt_digest: locator.receipt_digest
    }
  };
}

function unsupportedVersion(row: any): void {
  const scheduled = row.frame_binding.scheduled;
  const bytes = canonicalWireFrameBytes(scheduled.frame_reference.frame, scheduled.input_length);
  bytes[8] = 2;
  row.frame_binding.supplied.input_length = scheduled.input_length;
  row.frame_binding.supplied.input_digest = digest(bytes);
  row.frame_binding.supplied.material = { kind: "set-wire-version-v1", offset: 8, from: 1, to: 2 };
  row.frame_digest = row.frame_binding.supplied.input_digest;
}

function normalizedRow(rowId: string, platform = "macos"): any {
  const bundle = platform === "macos" ? generic.platform_bundle : generic.linux_platform_bundle;
  const row = structuredClone(bundle.rows.find((candidate: any) => candidate.row_id === rowId));
  row.actual_producing_boundary = row.producing_boundary;
  const match = /^LIM-(\d{3})$/.exec(rowId);
  if (match) {
    const ordinal = Number(match[1]);
    const [limit, unit, ceiling] = LIMITS[Math.floor((ordinal - 1) / 2)]!;
    row.actual_resource_record = measuredResource(row, limit, unit, ceiling + (ordinal % 2 === 0 ? 1 : 0));
  } else {
    row.actual_resource_record = structuredClone(row.resource_record);
  }
  if (rowId === "LIF-002" || rowId === "LIF-006") unsupportedVersion(row);
  if (row.determinism_proof) {
    for (const receipt of [row.determinism_proof.first, row.determinism_proof.second]) {
      receipt.input.supplied_input_digest = row.frame_digest;
      receipt.output.actual_producing_boundary = row.actual_producing_boundary;
      receipt.output.actual_resource_record = structuredClone(row.actual_resource_record);
      receipt.normalized_row_output_digest = digest(receipt.output);
      receipt.decision_projection_digest = createHash("sha256")
        .update(encodeDecisionRowProjectionCore(row, rowId.at(-1)!))
        .digest("hex");
    }
  }
  return row;
}

function protectionRoles(row: any): any[] {
  const fixed = [
    ["canonical-superproject", "superproject", "directory"],
    ["canonical-contract-file", "superproject/spikes/git-status-capability/contracts/contract-v1.json", "regular-file"],
    ["published-shud", "published/SHUD", "directory"],
    ["published-rshud", "published/rSHUD", "directory"],
    ["published-autoshud", "published/AutoSHUD", "directory"],
    ["published-zero", "published/zero", "directory"],
    ["current-disposable", "disposable", "directory"]
  ].map(([role, path, objectType]) => ({
    role,
    object_type: objectType,
    subject: {
      kind: "fixed-role-v1", name: role,
      authority_identity: role === "current-disposable"
        ? row.checkout_capability_identity
        : digest({ schema_version: "shud.git-status-capability.fixed-protected-authority.v1", platform: row.platform, role })
    },
    ingresses: [
      { kind: "canonical-v1", name: `protected/${path}` },
      { kind: "physical-alias-v1", name: `aliases/physical/${role}` },
      { kind: "symlink-alias-v1", name: `aliases/symlink/${role}` }
    ]
  }));
  const frame = row.frame_binding.scheduled.frame_reference.frame;
  const nested = frame.nested_state.map((state: any) => {
    const role = `nested-${state.checkout_state}-${digest({ path: state.path, checkout_state: state.checkout_state })}`;
    const absent = state.checkout_state === "absent";
    const subject = absent
      ? { kind: "absent-nested-v1", path: state.path, parent_identity: state.audit.parent_identity, basename: state.audit.basename }
      : { kind: "nested-checkout-v1", path: state.path, checkout_state: state.checkout_state,
          directory_identity: state.audit.directory_identity };
    const ingresses = [
      { kind: "canonical-v1", name: absent ? `protected/disposable/${state.path.split("/").slice(0, -1).join("/") || "root"}` : `protected/disposable/${state.path}` },
      { kind: "physical-alias-v1", name: `aliases/physical/${role}` },
      { kind: "symlink-alias-v1", name: `aliases/symlink/${role}` }
    ];
    if (absent) ingresses.push({ kind: "absent-basename-v1", name: `protected/disposable/${state.path}` });
    return { role, object_type: absent ? "absent-parent" : "directory", subject, ingresses };
  });
  return [...fixed, ...nested];
}

function protectionReceipt(row: any, platform: "macos" | "linux", _memberPath?: string): any {
  const slot = {
    platform, row_id: row.row_id, observation_id: row.observation_id, supplied_input_digest: row.frame_digest
  };
  const profileMaterial = {
    schema_version: "shud.git-status-capability.protection-profile.v1", ...slot, roles: protectionRoles(row)
  };
  const profileDigest = digest(profileMaterial);
  const inventory = profileMaterial.roles.map((role: any, sequence: number) => {
    const subjectDigest = digest(role.subject);
    const identityMaterial = {
      schema_version: "shud.git-status-capability.protected-identity.v1", profile_digest: profileDigest,
      role: role.role, object_type: role.object_type, subject_digest: subjectDigest
    };
    const identityDigest = digest(identityMaterial);
    const ingressRecords = role.ingresses.map((ingress: any) => {
      const ingressMaterial = {
        schema_version: "shud.git-status-capability.protected-ingress.v1", profile_digest: profileDigest,
        identity_digest: identityDigest, role: role.role, kind: ingress.kind, name: ingress.name
      };
      return { ingress_material: ingressMaterial, ingress_digest: digest(ingressMaterial) };
    });
    const ingressDigests = ingressRecords.map((record: any) => record.ingress_digest);
    const text = role.object_type === "absent-parent"
      ? `absent:${role.subject.parent_identity}:${role.subject.basename}\n`
      : `${role.object_type === "regular-file" ? "regular" : "directory"}:${role.role}:${subjectDigest}\n`;
    const content = {
      encoding: role.object_type === "absent-parent" ? "absent-parent-manifest-v1"
        : role.object_type === "regular-file" ? "utf8-v1" : "directory-manifest-v1", text
    };
    const measurement = {
      schema_version: "shud.git-status-capability.protected-measurement.v1", profile_digest: profileDigest,
      identity_digest: identityDigest, ingress_digests: ingressDigests, content,
      metadata: { object_type: role.object_type, git_mode: role.object_type === "regular-file" ? "100644" : "040000",
        byte_length: Buffer.byteLength(text) }
    };
    const measurementDigest = digest(measurement);
    const eventMaterial = {
      schema_version: "shud.git-status-capability.protection-event.v1", profile_digest: profileDigest,
      identity_digest: identityDigest, ingress_digests: ingressDigests, pre_digest: measurementDigest,
      post_digest: measurementDigest, sequence, kind: "verified-unchanged-v1"
    };
    return {
      identity_material: identityMaterial, identity_digest: identityDigest, ingress_records: ingressRecords,
      pre_measurement: measurement, pre_digest: measurementDigest,
      post_measurement: structuredClone(measurement), post_digest: measurementDigest,
      event_material: eventMaterial, event_digest: digest(eventMaterial)
    };
  });
  const core = { ...slot, profile_material: profileMaterial, profile_digest: profileDigest, inventory };
  return { ...core, receipt_digest: digest(core) };
}

function normalizedBundle(platform = "macos"): any {
  const source = platform === "macos" ? generic.platform_bundle : generic.linux_platform_bundle;
  const bundle = structuredClone(source);
  bundle.rows = source.rows.map((row: any) => normalizedRow(row.row_id, platform));
  bundle.protection_set = bundle.rows.map((row: any) => protectionReceipt(row, platform as "macos" | "linux"));
  return bundle;
}

function rowWithAbsentNested(rowId = "BAS-001", platform: "macos" | "linux" = "macos"): any {
  const row = normalizedRow(rowId, platform);
  const oldFrameDigest = row.frame_digest;
  const oldGeneration = row.git_state_generation_digest;
  const frame = row.frame_binding.scheduled.frame_reference.frame;
  frame.nested_state[0].checkout_state = "absent";
  frame.nested_state[0].audit = {
    state: "absent", parent_identity: shaA, basename: frame.nested_state[0].path.split("/").at(-1)
  };
  sealFrame(frame);
  const newGeneration = frame.git_state_generation_digest;
  const newLength = 128 + canonicalJsonBytes(frame).length;
  const newFrameDigest = digest(canonicalWireFrameBytes(frame, newLength));
  const replace = (value: any): any => {
    if (value === oldFrameDigest) return newFrameDigest;
    if (value === oldGeneration) return newGeneration;
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object") {
      for (const key of Object.keys(value)) value[key] = replace(value[key]);
    }
    return value;
  };
  replace(row);
  row.frame_binding.scheduled.input_length = newLength;
  row.frame_binding.scheduled.material.body_length = canonicalJsonBytes(frame).length;
  row.frame_binding.supplied.input_length = newLength;
  for (const resource of [row.resource_record, row.actual_resource_record]) {
    if (!resource.stimulus) continue;
    resource.stimulus.locator.supplied_input_digest = newFrameDigest;
    const { receipt_digest: _old, ...locatorCore } = resource.stimulus.locator;
    resource.stimulus.locator.receipt_digest = digest(locatorCore);
    resource.measurement.stimulus_receipt_digest = resource.stimulus.locator.receipt_digest;
  }
  return row;
}

function reorder(value: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(value).reverse());
}

function catalogRelationship(row: any): any {
  const suppliedMaterialDigest = digest(row.frame_binding.supplied.material);
  const core = {
    schema_version: "shud.git-status-capability.catalog-negative-relationship.v1",
    row_id: row.row_id,
    identity: `shud.catalog-negative.${row.row_id}.v1`,
    supplied_material_kind: row.frame_binding.supplied.material.kind,
    supplied_material_digest: suppliedMaterialDigest
  };
  return { ...core, recipe_digest: digest(core) };
}

function causalReceipt(row: any, kind: "outcome-mismatch-v1" | "control-failure-v1" | "resource-exceeded-v1" | "lifecycle-fault-v1" | "catalog-negative-mismatch-v1" | "launcher-fault-v1", controlId?: string): any {
  const base: Record<string, any> = {
    schema_version: "shud.git-status-capability.row-failure-receipt.v1",
    platform: row.platform,
    producer: row.actual_producing_boundary,
    row_id: row.row_id,
    observation_id: row.observation_id,
    supplied_input_digest: row.frame_digest
  };
  if (kind === "outcome-mismatch-v1") base.observed_outcome = structuredClone(row.observer_outcome);
  if (kind === "control-failure-v1") {
    base.control_id = controlId;
    base.control_verdict = "fail";
  }
  if (kind === "resource-exceeded-v1") {
    base.observed_outcome = structuredClone(row.observer_outcome);
    base.resource = structuredClone(row.actual_resource_record);
  }
  if (kind === "lifecycle-fault-v1") {
    base.supplied_mutation = structuredClone(row.frame_binding.supplied.material);
    base.first_cause = row.first_cause;
    base.secondary_errors = structuredClone(row.secondary_errors);
    base.cleanup = structuredClone(row.cleanup);
  }
  if (kind === "launcher-fault-v1") {
    base.observed_outcome = structuredClone(row.observer_outcome);
    base.first_cause = row.first_cause;
    base.secondary_errors = structuredClone(row.secondary_errors);
    base.cleanup = structuredClone(row.cleanup);
  }
  if (kind === "catalog-negative-mismatch-v1") {
    base.frozen_expected_code = row.expected_outcome.code;
    base.frozen_boundary = row.producing_boundary;
    base.actual_code = row.observer_outcome.code;
    base.actual_boundary = row.actual_producing_boundary;
    base.supplied_state = {
      material: structuredClone(row.frame_binding.supplied.material),
      material_digest: digest(row.frame_binding.supplied.material)
    };
    base.relationship_recipe = catalogRelationship(row);
  }
  return { kind, receipt: { ...base, receipt_digest: digest(base) } };
}

function resignCause(cause: any): any {
  const changed = structuredClone(cause);
  const { receipt_digest: _discarded, ...receipt } = changed.receipt;
  changed.receipt = { ...receipt, receipt_digest: digest(receipt) };
  return changed;
}

function resignProtection(receipt: any): any {
  const changed = structuredClone(receipt);
  const { receipt_digest: _discarded, ...core } = changed;
  return { ...core, receipt_digest: digest(core) };
}

function resignProtectionMember(member: any): any {
  const changed = structuredClone(member);
  changed.identity_digest = digest(changed.identity_material);
  for (const ingress of changed.ingress_records) {
    ingress.ingress_material.identity_digest = changed.identity_digest;
    ingress.ingress_digest = digest(ingress.ingress_material);
  }
  const ingressDigests = changed.ingress_records.map((ingress: any) => ingress.ingress_digest);
  for (const phase of ["pre", "post"] as const) {
    changed[`${phase}_measurement`].identity_digest = changed.identity_digest;
    changed[`${phase}_measurement`].ingress_digests = ingressDigests;
    changed[`${phase}_digest`] = digest(changed[`${phase}_measurement`]);
  }
  changed.event_material.identity_digest = changed.identity_digest;
  changed.event_material.ingress_digests = ingressDigests;
  changed.event_material.pre_digest = changed.pre_digest;
  changed.event_material.post_digest = changed.post_digest;
  changed.event_digest = digest(changed.event_material);
  return changed;
}

function rejectedDecisionFor(row: any, cause = row.failure_cause): any {
  const decision = structuredClone(generic.decision);
  const index = decision.rows.findIndex((scalar: string) => {
    const candidate = scalar.split("\0");
    return candidate[0] === (row.platform === "macos" ? "m" : "l") && candidate[1] === row.row_id;
  });
  const fields = decision.rows[index].split("\0");
  const kindToken = ({ clean: "c", dirty: "d", rejected: "r" } as any)[row.observer_outcome.kind];
  const producerToken = ({ observer: "o", launcher: "l", tripwire: "t" } as any)[row.actual_producing_boundary];
  let passedBits = 0;
  for (let controlIndex = 0; controlIndex < Object.keys(row.control_assertions).length; controlIndex += 1) {
    const id = ["oracle", "ambient_path", "subprocess", "network", "protected_write", "protection", "cleanup"][controlIndex]!;
    if (row.control_assertions[id].verdict === "pass") passedBits |= 1 << controlIndex;
  }
  fields[4] = kindToken;
  fields[5] = row.observer_outcome.code ?? "";
  fields[6] = "f";
  fields[7] = row.observation_id;
  fields[8] = row.git_state_generation_digest;
  fields[9] = row.frame_digest;
  fields[10] = producerToken;
  fields[12] = passedBits.toString(16).padStart(2, "0");
  fields[13] = row.protection_set_equal ? "1" : "0";
  fields[14] = row.cleanup.verdict === "pass" ? "p" : "f";
  fields[15] = String(row.actual_resource_record.declared_limit === "none" ? 0 :
    LIMITS.findIndex(([limit]) => limit === row.actual_resource_record.declared_limit) + 1);
  fields[16] = ({ below: "b", exact: "e", exceeded: "x" } as any)[row.actual_resource_record.boundary_class];
  fields[18] = (FAILURE_CAUSE_TAGS as Record<string, string>)[cause?.kind] ?? cause?.kind ?? "";
  decision.rows[index] = fields.join("\0");
  decision.terminal_decision = "rejected";
  decision.first_cause = "ROW_VERDICT_FAILED";
  decision.all_failure_codes = ["ROW_VERDICT_FAILED"];
  return decision;
}

function causalParity(row: any, cause = row.failure_cause): [boolean, boolean] {
  const raw = structuredClone(row);
  raw.failure_cause = cause;
  return [validateRowEvidence(raw), validateDecision(rejectedDecisionFor(row, cause))];
}

async function publicValidation(kind: string, value: any, padTo?: number): Promise<{ exit: number; code?: string }> {
  const directory = await mkdtemp(join(tmpdir(), "shud-round3-public-"));
  try {
    const serialized = Buffer.from(JSON.stringify(value));
    const bytes = padTo === undefined ? serialized : Buffer.concat([serialized, Buffer.alloc(padTo - serialized.length, 0x20)]);
    const input = join(directory, `${kind}.json`);
    await writeFile(input, bytes);
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../check.ts"), "--input", input, "--kind", kind], {
      stdout: "pipe", stderr: "pipe"
    });
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { exit, code: stderr ? JSON.parse(stderr).code : undefined };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function outcomeFailure(rowId: string, producer: "observer" | "launcher" | "tripwire", observed: any): any {
  const row = normalizedRow(rowId);
  row.observer_outcome = observed;
  row.actual_producing_boundary = producer;
  row.row_verdict = "fail";
  row.failure_cause = causalReceipt(row, "outcome-mismatch-v1");
  return row;
}

function resourceFailure(rowId: string, limit: string, unit: string, code: string): any {
  const row = normalizedRow(rowId);
  row.observer_outcome = { kind: "rejected", code };
  row.actual_producing_boundary = "launcher";
  row.actual_resource_record = measuredResource(row, limit, unit, (OBSERVER_LIMITS as any)[limit] + 1);
  row.row_verdict = "fail";
  row.failure_cause = causalReceipt(row, "resource-exceeded-v1");
  return row;
}

function lifecycleFailure(rowId: "LIF-002" | "LIF-006" | "LIF-007"): any {
  const row = normalizedRow(rowId);
  row.observer_outcome = { kind: row.expected_outcome.kind === "dirty" ? "clean" : "dirty" };
  row.row_verdict = "fail";
  row.failure_cause = causalReceipt(row, "lifecycle-fault-v1");
  return row;
}

function catalogNegativeFailure(rowId: string, platform: "macos" | "linux", actualCode: string): any {
  const row = normalizedRow(rowId, platform);
  row.observer_outcome = { kind: "rejected", code: actualCode };
  row.row_verdict = "fail";
  row.failure_cause = causalReceipt(row, "catalog-negative-mismatch-v1");
  return row;
}

const CATALOG_NEGATIVE_ROWS = [
  "CAP-005", "CAP-006", "CAP-008", "CAP-009", "CAP-016", "CAP-017",
  "PRT-001", "PRT-002", "PRT-003", "PRT-004", "PRT-005", "PRT-006", "PRT-007", "PRT-008", "PRT-009",
  "PRT-010", "PRT-011", "PRT-012", "LIF-003", "LIF-004", "LIF-005", "LIF-007"
] as const;

const FAILURE_CAUSE_TAGS = {
  "outcome-mismatch-v1": "o",
  "control-failure-v1": "c",
  "resource-exceeded-v1": "r",
  "lifecycle-fault-v1": "l",
  "catalog-negative-mismatch-v1": "n",
  "launcher-fault-v1": "u"
} as const;

function longestAlternateRejection(expectedCode?: string): string {
  return [...REJECTION_CODES].filter((code) => code !== expectedCode)
    .sort((left, right) => Buffer.byteLength(right) - Buffer.byteLength(left) || left.localeCompare(right))[0]!;
}

function refreshDeterminismFailureProof(row: any): any {
  if (!row.determinism_proof) return row;
  for (const receipt of [row.determinism_proof.first, row.determinism_proof.second]) {
    receipt.output.observer_outcome = structuredClone(row.observer_outcome);
    receipt.output.row_verdict = row.row_verdict;
    receipt.output.control_assertions = structuredClone(row.control_assertions);
    receipt.output.protection_set_equal = row.protection_set_equal;
    receipt.output.cleanup = structuredClone(row.cleanup);
    receipt.output.actual_producing_boundary = row.actual_producing_boundary;
    receipt.output.actual_resource_record = structuredClone(row.actual_resource_record);
    receipt.normalized_row_output_digest = digest(receipt.output);
    receipt.decision_projection_digest = createHash("sha256")
      .update(encodeDecisionRowProjectionCore(row, row.row_id.at(-1)!))
      .digest("hex");
  }
  return row;
}

function worstFailureRow(rowId: string, platform: "macos" | "linux"): any {
  if (rowId === "PRT-012") {
    const row = normalizedRow(rowId, platform);
    row.control_assertions.protected_write.verdict = "fail";
    row.row_verdict = "fail";
    row.failure_cause = causalReceipt(row, "control-failure-v1", "protected_write");
    return refreshDeterminismFailureProof(row);
  }
  if (CATALOG_NEGATIVE_ROWS.includes(rowId as any)) {
    return refreshDeterminismFailureProof(
      catalogNegativeFailure(rowId, platform, longestAlternateRejection(normalizedRow(rowId, platform).expected_outcome.code))
    );
  }
  const row = normalizedRow(rowId, platform);
  if (rowId === "LIF-002" || rowId === "LIF-006") {
    row.observer_outcome = { kind: "rejected", code: longestAlternateRejection(row.expected_outcome.code) };
    row.row_verdict = "fail";
    row.failure_cause = causalReceipt(row, "lifecycle-fault-v1");
    return refreshDeterminismFailureProof(row);
  }
  const limitMatch = /^LIM-(\d{3})$/.exec(rowId);
  if (limitMatch && Number(limitMatch[1]) % 2 === 0) {
    row.observer_outcome = structuredClone(row.expected_outcome);
    row.actual_producing_boundary = "launcher";
    row.row_verdict = "fail";
    row.failure_cause = causalReceipt(row, "resource-exceeded-v1");
    return refreshDeterminismFailureProof(row);
  }
  row.observer_outcome = { kind: "rejected", code: longestAlternateRejection(row.expected_outcome.code) };
  row.actual_producing_boundary = "observer";
  row.row_verdict = "fail";
  row.failure_cause = causalReceipt(row, "outcome-mismatch-v1");
  return refreshDeterminismFailureProof(row);
}

describe("Round 2 canonical proof binding", () => {
  test("D8 exposes the exact canonical 19-segment vocabulary", () => {
    expect(DECISION_ROW_SEGMENTS).toEqual([
      "platform", "row_id", "expected_kind", "expected_code", "observed_kind", "observed_code", "row_verdict",
      "observation_id", "generation_payload_digest", "actual_supplied_input_digest", "actual_producing_boundary",
      "active_control_bitset", "passed_control_bitset", "protection_set_equal", "cleanup_verdict", "declared_limit",
      "boundary_class", "determinism_proof", "failure_cause"
    ]);
  });

  test("every raw-valid frozen platform slot has exactly its canonical D8 projection", () => {
    for (const platform of ["macos", "linux"] as const) {
      const bundle = normalizedBundle(platform);
      for (const row of bundle.rows) {
        expect(validateRowEvidence(row), `${platform}/${row.row_id}:raw`).toBe(true);
        const encoded = encodeDecisionRowProjection(row);
        const expected = generic.decision.rows.find((scalar: string) => {
          const fields = scalar.split("\0");
          return fields[0] === (platform === "macos" ? "m" : "l") && fields[1] === row.row_id;
        });
        expect(encoded, `${platform}/${row.row_id}:D8`).toBe(expected);
      }
    }
  });
  test("all 13 LIM exact/+1 pairs bind the declared boundary to a replayable stimulus and actual measurement", () => {
    for (let ordinal = 1; ordinal <= 26; ordinal += 1) {
      const rowId = `LIM-${String(ordinal).padStart(3, "0")}`;
      const row = normalizedRow(rowId);
      expect(validateRowEvidence(row), rowId).toBe(true);
      const changedMeasurement = structuredClone(row);
      changedMeasurement.actual_resource_record.measurement.value += 1;
      expect(validateRowEvidence(changedMeasurement), `${rowId}:measurement`).toBe(false);
      const changedRecipe = structuredClone(row);
      changedRecipe.actual_resource_record.stimulus.recipe.value += 1;
      expect(validateRowEvidence(changedRecipe), `${rowId}:recipe`).toBe(false);
      const changedLocator = structuredClone(row);
      changedLocator.actual_resource_record.stimulus.locator.supplied_input_digest = shaA;
      expect(validateRowEvidence(changedLocator), `${rowId}:locator-input`).toBe(false);
      const sibling = structuredClone(row);
      const siblingRow = normalizedRow(ordinal === 26 ? "LIM-025" : `LIM-${String(ordinal + 1).padStart(3, "0")}`);
      sibling.actual_resource_record.stimulus.locator = structuredClone(siblingRow.actual_resource_record.stimulus.locator);
      sibling.actual_resource_record.measurement.stimulus_receipt_digest = sibling.actual_resource_record.stimulus.locator.receipt_digest;
      expect(validateRowEvidence(sibling), `${rowId}:sibling-receipt`).toBe(false);
    }
  });

  test("LIF-002 and LIF-006 carry the exact content-addressed unsupported-version wire recipe", () => {
    for (const rowId of ["LIF-002", "LIF-006"]) {
      const row = normalizedRow(rowId);
      expect(validateRowEvidence(row), rowId).toBe(true);
      expect(row.frame_binding.supplied.material).toEqual({ kind: "set-wire-version-v1", offset: 8, from: 1, to: 2 });
      const wrongVersion = structuredClone(row);
      wrongVersion.frame_binding.supplied.material.to = 3;
      expect(validateRowEvidence(wrongVersion), `${rowId}:wrong-version`).toBe(false);
    }
  });

  test("source manifest digest is rederived from the frozen domain-separated terminal-LF preimage", () => {
    const record = structuredClone(generic.source_input_record);
    const prefix = Buffer.from("SHUD-HARNESS\0GIT-STATUS-CAPABILITY\0SOURCE-MANIFEST-DIGEST\0V1\n", "utf8");
    const pieces = [prefix];
    for (const entry of record.admitted_paths) pieces.push(Buffer.from(`${entry.git_mode}\0${entry.path}\n`, "utf8"));
    const expected = createHash("sha256").update(Buffer.concat(pieces)).digest("hex");
    record.manifest_digest = expected;
    record.primary_encoder.result.manifest_digest = expected;
    record.witness_encoder.result.manifest_digest = expected;
    expect(validateSourceInputRecord(record)).toBe(true);
    const forged = structuredClone(record);
    forged.manifest_digest = shaA;
    forged.primary_encoder.result.manifest_digest = shaA;
    forged.witness_encoder.result.manifest_digest = shaA;
    expect(validateSourceInputRecord(forged)).toBe(false);
  });

  test("platform protection identities are unique and every protected item is byte-identical pre/post", () => {
    const bundle = normalizedBundle();
    expect(validatePlatformBundle(bundle)).toBe(true);
    const changed = structuredClone(bundle);
    changed.protection_set[0].inventory[0].post_digest = "cd".repeat(32);
    expect(validatePlatformBundle(changed)).toBe(false);
    const duplicate = structuredClone(bundle);
    duplicate.protection_set.push(structuredClone(duplicate.protection_set[0]));
    expect(validatePlatformBundle(duplicate)).toBe(false);
  });

  test("both platforms require one content-addressed protection receipt for every catalog slot", async () => {
    for (const platform of ["macos", "linux"] as const) {
      const bundle = normalizedBundle(platform);
      expect(validatePlatformBundle(bundle), `${platform}:baseline`).toBe(true);
      const bytes = Buffer.byteLength(JSON.stringify(bundle));
      expect(bytes, `${platform}:raw-capacity`).toBeLessThanOrEqual(INGESTION_LIMITS.platform_bundle.bytes);
      expect(await publicValidation("platform_bundle", bundle, INGESTION_LIMITS.platform_bundle.bytes), `${platform}:exact-bytes`)
        .toEqual({ exit: 0, code: undefined });
      const plusOne = await publicValidation("platform_bundle", bundle, INGESTION_LIMITS.platform_bundle.bytes + 1);
      expect(plusOne, `${platform}:plus-one-byte`).toEqual({ exit: 2, code: "CONTRACT_BYTES_LIMIT" });
      expect(bundle.protection_set).toHaveLength(174);
      expect(new Set(bundle.protection_set.map((receipt: any) => receipt.row_id)).size).toBe(174);
      const mutations = [
        (value: any) => value.protection_set.pop(),
        (value: any) => value.protection_set.push(structuredClone(value.protection_set[0])),
        (value: any) => { value.protection_set[1] = structuredClone(value.protection_set[0]); },
        (value: any) => { value.protection_set[0].observation_id = value.protection_set[1].observation_id; },
        (value: any) => { value.protection_set[0].supplied_input_digest = value.protection_set[1].supplied_input_digest; },
        (value: any) => { value.protection_set[0].inventory.push(structuredClone(value.protection_set[0].inventory[0])); },
        (value: any) => { value.protection_set[0].inventory[0].post_digest = shaA; },
        (value: any) => { value.protection_set[0].inventory = []; },
        (value: any) => {
          const row = value.rows[0];
          value.protection_set[0].inventory = Array.from({ length: 65 }, (_, index) =>
            protectionReceipt(row, platform, `.shud-harness/protected/${row.row_id}-${index}.state`).inventory[0]);
        },
        (value: any) => { value.protection_set[0].platform = platform === "macos" ? "linux" : "macos"; },
        (value: any) => { value.rows[0].protection_set_equal = false; }
      ];
      for (const [index, mutate] of mutations.entries()) {
        const changed = structuredClone(bundle);
        mutate(changed);
        changed.protection_set = changed.protection_set.map((receipt: any) => {
          const core = structuredClone(receipt);
          delete core.receipt_digest;
          return { ...core, receipt_digest: digest(core) };
        });
        expect(validatePlatformBundle(changed), `${platform}:mutation-${index}`).toBe(false);
      }
    }
  }, 30_000);

  test("protection receipts reject copied or self-claimed material even after the outer receipt is re-signed", () => {
    const bundle = normalizedBundle();
    expect(validatePlatformBundle(bundle), "baseline").toBe(true);

    const copied = structuredClone(bundle);
    copied.protection_set[1].inventory = structuredClone(copied.protection_set[0].inventory);
    copied.protection_set[1] = resignProtection(copied.protection_set[1]);
    expect(validatePlatformBundle(copied), "cross-slot material copy").toBe(false);

    const arbitrary = structuredClone(bundle);
    arbitrary.protection_set[0].inventory[0].identity_digest = shaA;
    arbitrary.protection_set[0].inventory[0].ingress_records[0].ingress_digest = shaA;
    arbitrary.protection_set[0].inventory[0].pre_digest = shaA;
    arbitrary.protection_set[0].inventory[0].post_digest = shaA;
    arbitrary.protection_set[0].inventory[0].event_digest = shaA;
    arbitrary.protection_set[0] = resignProtection(arbitrary.protection_set[0]);
    expect(validatePlatformBundle(arbitrary), "digest-only replacement").toBe(false);

    const reusedEvent = structuredClone(bundle);
    reusedEvent.protection_set[1].inventory[0].event_material =
      structuredClone(reusedEvent.protection_set[0].inventory[0].event_material);
    reusedEvent.protection_set[1].inventory[0].event_digest = reusedEvent.protection_set[0].inventory[0].event_digest;
    reusedEvent.protection_set[1] = resignProtection(reusedEvent.protection_set[1]);
    expect(validatePlatformBundle(reusedEvent), "event reuse").toBe(false);

    const materialMutation = structuredClone(bundle);
    materialMutation.protection_set[0].inventory[0].pre_measurement.content.text += "mutated";
    materialMutation.protection_set[0] = resignProtection(materialMutation.protection_set[0]);
    expect(validatePlatformBundle(materialMutation), "material byte mutation").toBe(false);

    const wrongPlatform = structuredClone(bundle);
    wrongPlatform.protection_set[0] = protectionReceipt(bundle.rows[0], "linux");
    expect(validatePlatformBundle(wrongPlatform), "fully re-signed inner platform").toBe(false);

    const wrongInput = structuredClone(bundle);
    const wrongInputRow = structuredClone(bundle.rows[0]);
    wrongInputRow.frame_digest = shaA;
    wrongInput.protection_set[0] = protectionReceipt(wrongInputRow, "macos");
    expect(validatePlatformBundle(wrongInput), "fully re-signed inner supplied input").toBe(false);
  });

  test("every invocation requires the derived complete protection role and ingress set", () => {
    const bundle = normalizedBundle();
    expect(validatePlatformBundle(bundle), "complete profile baseline").toBe(true);
    const receipt = bundle.protection_set[0];
    expect(receipt.inventory.length).toBe(8);

    const cases: Array<[string, (value: any) => void]> = [
      ["missing mandatory base role", (value) => { value.protection_set[0].inventory.shift(); }],
      ["missing initialized nested member", (value) => {
        value.protection_set[0].inventory = value.protection_set[0].inventory.filter(
          (member: any) => !member.identity_material.role.startsWith("nested-")
        );
      }],
      ["missing physical alias ingress", (value) => {
        value.protection_set[0].inventory[0].ingress_records = value.protection_set[0].inventory[0].ingress_records.filter(
          (record: any) => record.ingress_material.kind !== "physical-alias-v1"
        );
        value.protection_set[0].inventory[0] = resignProtectionMember(value.protection_set[0].inventory[0]);
      }],
      ["missing symlink alias ingress", (value) => {
        value.protection_set[0].inventory[0].ingress_records = value.protection_set[0].inventory[0].ingress_records.filter(
          (record: any) => record.ingress_material.kind !== "symlink-alias-v1"
        );
        value.protection_set[0].inventory[0] = resignProtectionMember(value.protection_set[0].inventory[0]);
      }],
      ["directory measured as regular file", (value) => {
        const member = value.protection_set[0].inventory[0];
        member.identity_material.object_type = "regular-file";
        member.pre_measurement.metadata.object_type = "regular-file";
        member.pre_measurement.metadata.git_mode = "100644";
        member.post_measurement = structuredClone(member.pre_measurement);
        value.protection_set[0].inventory[0] = resignProtectionMember(member);
      }],
      ["single synthetic member", (value) => { value.protection_set[0].inventory = [value.protection_set[0].inventory[0]]; }]
    ];
    for (const [label, mutate] of cases) {
      const changed = structuredClone(bundle);
      mutate(changed);
      changed.protection_set[0] = resignProtection(changed.protection_set[0]);
      expect(validatePlatformBundle(changed), label).toBe(false);
    }

    const absentBundle = normalizedBundle();
    absentBundle.rows[0] = rowWithAbsentNested();
    expect(validateRowEvidence(absentBundle.rows[0]), "absent row").toBe(true);
    absentBundle.protection_set[0] = protectionReceipt(absentBundle.rows[0], "macos");
    expect(validatePlatformBundle(absentBundle), "absent complete profile").toBe(true);
    const absentMember = absentBundle.protection_set[0].inventory.find(
      (member: any) => member.identity_material.object_type === "absent-parent"
    );
    absentMember.ingress_records = absentMember.ingress_records.filter(
      (record: any) => record.ingress_material.kind !== "absent-basename-v1"
    );
    const index = absentBundle.protection_set[0].inventory.indexOf(absentMember);
    absentBundle.protection_set[0].inventory[index] = resignProtectionMember(absentMember);
    absentBundle.protection_set[0] = resignProtection(absentBundle.protection_set[0]);
    expect(validatePlatformBundle(absentBundle), "missing absent basename ingress").toBe(false);
  });

  test("initialized nested audit indexes obey the same row-specific material rules as the root index", () => {
    const frame = structuredClone(normalizedRow("BAS-001").frame_binding.scheduled.frame_reference.frame);
    frame.nested_state[0].audit.index = {
      state: "material",
      primary: { kind: "repeat-byte-v1", byte: 0, byte_length: OBSERVER_LIMITS.index_bytes + 1,
        digest: "8996de63e472cbfe218412fd3512ad6d908f83119f02c439fbc16446d6d9e5db" },
      shared_index: { state: "absent" }
    };
    sealFrame(frame);
    expect(validateFrame(frame)).toBe(false);
  });

  test("every negative raw-index row freezes one root target and rejects moved, copied, duplicate, or wrong-path material", () => {
    const parsedFrame = normalizedRow("BAS-001").frame_binding.scheduled.frame_reference.frame;
    const parsedRoot = structuredClone(parsedFrame.index);
    const nestedTemplate = structuredClone(parsedFrame.nested_state[0]);
    for (const rowId of ["IDX-007", "IDX-008", "IDX-009", "IDX-010", "IDX-011", "IDX-020", "LIM-003", "LIM-004"]) {
      const row = normalizedRow(rowId);
      const frame = row.frame_binding.scheduled.frame_reference.frame;
      expect(frame.index.state, `${rowId}:root-target`).toBe("material");
      expect(validateFrame(frame), `${rowId}:baseline`).toBe(true);

      const moved = structuredClone(frame);
      moved.nested_state = [structuredClone(nestedTemplate)];
      moved.nested_state[0].audit.index = structuredClone(moved.index);
      moved.index = structuredClone(parsedRoot);
      sealFrame(moved);
      expect(validateFrame(moved), `${rowId}:moved`).toBe(false);

      const duplicate = structuredClone(frame);
      duplicate.nested_state = [structuredClone(nestedTemplate)];
      duplicate.nested_state[0].audit.index = structuredClone(duplicate.index);
      sealFrame(duplicate);
      expect(validateFrame(duplicate), `${rowId}:duplicate`).toBe(false);

      const wrongPath = structuredClone(frame);
      wrongPath.nested_state = [structuredClone(nestedTemplate)];
      wrongPath.nested_state[0].path = "other";
      wrongPath.nested_state[0].gitlink.path = "other";
      wrongPath.nested_state[0].audit.index = structuredClone(wrongPath.index);
      sealFrame(wrongPath);
      expect(validateFrame(wrongPath), `${rowId}:wrong-path`).toBe(false);
    }
  });

  test("CAP-013/014 repair only the illegal path and reject unrelated scheduled-frame drift", () => {
    for (const rowId of ["CAP-013", "CAP-014"]) {
      const row = normalizedRow(rowId);
      expect(validateRowEvidence(row), rowId).toBe(true);
      const drifted = structuredClone(row);
      const supplied = drifted.frame_binding.supplied;
      const frame = supplied.material.frame_reference.frame;
      frame.head_tree.object_id = "ab".repeat(20);
      sealFrame(frame);
      const bytes = canonicalWireFrameBytes(frame, supplied.input_length);
      supplied.git_state_generation_digest = frame.git_state_generation_digest;
      supplied.input_digest = digest(bytes);
      drifted.frame_digest = supplied.input_digest;
      expect(validateRowEvidence(drifted), `${rowId}:unrelated-drift`).toBe(false);
    }
  });

  test("DET object property order is semantic while values and array order remain significant", () => {
    const row = normalizedRow("DET-002");
    row.determinism_proof.first.output = reorder(row.determinism_proof.first.output);
    expect(validateDeterminismProof(row)).toBe(true);
    const changedValue = structuredClone(row);
    changedValue.determinism_proof.first.output.cleanup.verdict = "fail";
    expect(validateDeterminismProof(changedValue)).toBe(false);
    const changedArray = normalizedRow("DET-002");
    changedArray.determinism_proof.second.input.axis_binding.sequence.reverse();
    expect(validateDeterminismProof(changedArray)).toBe(false);
  });

  test("actual launcher timeout, tripwire failure, and resource exceed are valid failed semantic rows", () => {
    const timeout = normalizedRow("BAS-001");
    timeout.observer_outcome = { kind: "rejected", code: "TIMEOUT" };
    timeout.actual_producing_boundary = "launcher";
    timeout.actual_resource_record = measuredResource(timeout, "wall_time_ms", "milliseconds", OBSERVER_LIMITS.wall_time_ms + 1);
    timeout.row_verdict = "fail";
    timeout.failure_cause = causalReceipt(timeout, "resource-exceeded-v1");
    expect(validateRowEvidence(timeout)).toBe(true);

    const tripwire = normalizedRow("BAS-002");
    tripwire.actual_producing_boundary = "tripwire";
    tripwire.control_assertions.protected_write.verdict = "fail";
    tripwire.row_verdict = "fail";
    tripwire.failure_cause = causalReceipt(tripwire, "control-failure-v1", "protected_write");
    expect(validateRowEvidence(tripwire)).toBe(true);

    const memory = normalizedRow("BAS-003");
    memory.observer_outcome = { kind: "rejected", code: "LIMIT_MEMORY" };
    memory.actual_producing_boundary = "launcher";
    memory.actual_resource_record = measuredResource(memory, "memory_bytes", "bytes", OBSERVER_LIMITS.memory_bytes + 1);
    memory.row_verdict = "fail";
    memory.failure_cause = causalReceipt(memory, "resource-exceeded-v1");
    expect(validateRowEvidence(memory)).toBe(true);

    const bundle = normalizedBundle();
    bundle.rows[0] = timeout;
    expect(validatePlatformBundle(bundle)).toBe(true);

    const decision = structuredClone(generic.decision);
    const index = decision.rows.findIndex((scalar: string) => scalar.split("\0")[0] === "m" && scalar.split("\0")[1] === "BAS-001");
    decision.rows[index] = encodeDecisionRowProjection(timeout);
    decision.terminal_decision = "rejected";
    decision.first_cause = "ROW_VERDICT_FAILED";
    decision.all_failure_codes = ["ROW_VERDICT_FAILED"];
    expect(validateDecision(decision)).toBe(true);
  });

  test("non-LIM rows separate catalog expectations from five below/exact launcher measurements and +1 failures", async () => {
    const cases = [
      ["wall_time_ms", "milliseconds", "TIMEOUT"],
      ["cpu_time_ms", "milliseconds", "LIMIT_CPU_TIME"],
      ["threads", "count", "LIMIT_THREADS"],
      ["memory_bytes", "bytes", "LIMIT_MEMORY"],
      ["output_bytes", "bytes", "LIMIT_OUTPUT_BYTES"]
    ] as const;
    for (const [limit, unit, code] of cases) {
      for (const [boundary, value] of [["below", OBSERVER_LIMITS[limit] - 1], ["exact", OBSERVER_LIMITS[limit]]] as const) {
        const pass = normalizedRow("BAS-001");
        pass.actual_resource_record = measuredResource(pass, limit, unit, value);
        expect(pass.resource_record).toEqual({ boundary_class: "below", declared_limit: "none", within_limits: true });
        expect(validateRowEvidence(pass), `${limit}:${boundary}:raw`).toBe(true);
        expect(await publicValidation("row_evidence", pass), `${limit}:${boundary}:public-row`).toEqual({ exit: 0, code: undefined });
        const passBundle = normalizedBundle();
        passBundle.rows[0] = pass;
        expect(validatePlatformBundle(passBundle), `${limit}:${boundary}:platform`).toBe(true);
        expect(await publicValidation("platform_bundle", passBundle), `${limit}:${boundary}:public-platform`).toEqual({ exit: 0, code: undefined });
        const projected = structuredClone(generic.decision);
        const index = projected.rows.findIndex((scalar: string) => scalar.split("\0")[0] === "m" && scalar.split("\0")[1] === "BAS-001");
        projected.rows[index] = encodeDecisionRowProjection(pass);
        expect(validateDecision(projected), `${limit}:${boundary}:d8`).toBe(true);
        expect(await publicValidation("decision", projected), `${limit}:${boundary}:public-d8`).toEqual({ exit: 0, code: undefined });
      }

      const fail = resourceFailure("BAS-001", limit, unit, code);
      expect(validateRowEvidence(fail), `${limit}:raw-plus-one`).toBe(true);
      expect(await publicValidation("row_evidence", fail), `${limit}:public-row-plus-one`).toEqual({ exit: 0, code: undefined });
      const failBundle = normalizedBundle();
      failBundle.rows[0] = fail;
      expect(validatePlatformBundle(failBundle), `${limit}:platform-plus-one`).toBe(true);
      expect(await publicValidation("platform_bundle", failBundle), `${limit}:public-platform-plus-one`).toEqual({ exit: 0, code: undefined });
      const failedDecision = rejectedDecisionFor(fail);
      expect(validateDecision(failedDecision), `${limit}:d8-plus-one`).toBe(true);
      expect(await publicValidation("decision", failedDecision), `${limit}:public-d8-plus-one`).toEqual({ exit: 0, code: undefined });
    }
  }, 30_000);

  test("specialized PRT and LIF rows select launcher causality from the actual boundary and outcome", async () => {
    for (const rowId of ["BAS-001", "PRT-010", "LIF-002"] as const) {
      for (const code of ["SIGNALLED_TERM", "SIGNALLED_KILL", "TIMEOUT", "CLEANUP_FAILED"] as const) {
        const row = normalizedRow(rowId);
        row.observer_outcome = { kind: "rejected", code };
        row.actual_producing_boundary = "launcher";
        row.row_verdict = "fail";
        row.first_cause = code;
        row.secondary_errors = [];
        row.cleanup = code === "CLEANUP_FAILED"
          ? { verdict: "fail", descriptors_restored: false, processes_reaped: true }
          : { verdict: "pass", descriptors_restored: true, processes_reaped: true };
        row.control_assertions.cleanup.verdict = "pass";
        row.failure_cause = causalReceipt(row, "launcher-fault-v1");
        expect(validateRowEvidence(row), `${rowId}/${code}:raw`).toBe(true);
        expect(await publicValidation("row_evidence", row), `${rowId}/${code}:public-row`).toEqual({ exit: 0, code: undefined });
        const bundle = normalizedBundle();
        bundle.rows[bundle.rows.findIndex((candidate: any) => candidate.row_id === rowId)] = row;
        expect(validatePlatformBundle(bundle), `${rowId}/${code}:platform`).toBe(true);
        const decision = rejectedDecisionFor(row);
        expect(validateDecision(decision), `${rowId}/${code}:D8`).toBe(true);
        expect(await publicValidation("decision", decision), `${rowId}/${code}:public-D8`).toEqual({ exit: 0, code: undefined });
      }
    }
  }, 30_000);

  test("all six causal receipt kinds bind platform in their common canonical preimage", () => {
    const control = normalizedRow("BAS-002");
    control.actual_producing_boundary = "tripwire";
    control.control_assertions.protected_write.verdict = "fail";
    control.row_verdict = "fail";
    control.failure_cause = causalReceipt(control, "control-failure-v1", "protected_write");
    const launcher = normalizedRow("BAS-001");
    launcher.observer_outcome = { kind: "rejected", code: "SIGNALLED_TERM" };
    launcher.actual_producing_boundary = "launcher";
    launcher.row_verdict = "fail";
    launcher.first_cause = "SIGNALLED_TERM";
    launcher.secondary_errors = [];
    launcher.failure_cause = causalReceipt(launcher, "launcher-fault-v1");
    const rows = [
      outcomeFailure("BAS-004", "observer", { kind: "clean" }), control,
      resourceFailure("BAS-003", "memory_bytes", "bytes", "LIMIT_MEMORY"),
      lifecycleFailure("LIF-002"), catalogNegativeFailure("CAP-005", "macos", "PLATFORM_UNSUPPORTED"), launcher
    ];
    for (const row of rows) {
      row.failure_cause.receipt.platform = row.platform;
      row.failure_cause = resignCause(row.failure_cause);
      expect(validateRowEvidence(row), `${row.failure_cause.kind}:baseline`).toBe(true);
      for (const mutate of [
        (cause: any) => { delete cause.receipt.platform; },
        (cause: any) => { cause.receipt.platform = row.platform === "macos" ? "linux" : "macos"; }
      ]) {
        const changed = structuredClone(row);
        mutate(changed.failure_cause);
        changed.failure_cause = resignCause(changed.failure_cause);
        expect(validateRowEvidence(changed), `${row.failure_cause.kind}:platform-binding`).toBe(false);
      }
      const crossPlatform = structuredClone(row);
      crossPlatform.platform = row.platform === "macos" ? "linux" : "macos";
      expect(validateRowEvidence(crossPlatform), `${row.failure_cause.kind}:cross-platform-reuse`).toBe(false);
    }
  });

  test("normal passes reject hidden cause metadata and launcher outcomes preserve ordered causal settlement", async () => {
    for (const field of ["first_cause", "secondary_errors", "failure_cause"] as const) {
      const pass = normalizedRow("BAS-001");
      if (field === "first_cause") pass.first_cause = "SIGNALLED_TERM";
      else if (field === "secondary_errors") pass.secondary_errors = [];
      else pass.failure_cause = { kind: "launcher-fault-v1" };
      expect(validateRowEvidence(pass), `pass:${field}`).toBe(false);
    }
    const cases = [
      ["SIGNALLED_TERM", "pass", "SIGNALLED_TERM", []],
      ["SIGNALLED_KILL", "pass", "SIGNALLED_KILL", []],
      ["TIMEOUT", "pass", "TIMEOUT", []],
      ["CLEANUP_FAILED", "fail", "CLEANUP_FAILED", []],
      ["SIGNALLED_TERM", "fail", "SIGNALLED_TERM", ["CLEANUP_FAILED"]]
    ] as const;
    for (const [code, cleanup, firstCause, secondary] of cases) {
      const row = normalizedRow("BAS-001");
      row.observer_outcome = { kind: "rejected", code };
      row.actual_producing_boundary = "launcher";
      row.row_verdict = "fail";
      row.first_cause = firstCause;
      row.secondary_errors = [...secondary];
      row.cleanup = cleanup === "pass"
        ? { verdict: "pass", descriptors_restored: true, processes_reaped: true }
        : { verdict: "fail", descriptors_restored: false, processes_reaped: true };
      row.control_assertions.cleanup.verdict = "pass";
      row.failure_cause = causalReceipt(row, "launcher-fault-v1");
      expect(validateRowEvidence(row), `${code}/${cleanup}:raw`).toBe(true);
      expect(await publicValidation("row_evidence", row), `${code}/${cleanup}:public-raw`).toEqual({ exit: 0, code: undefined });
      const bundle = normalizedBundle();
      bundle.rows[0] = row;
      expect(validatePlatformBundle(bundle), `${code}/${cleanup}:platform`).toBe(true);
      const decision = rejectedDecisionFor(row);
      expect(validateDecision(decision), `${code}/${cleanup}:d8`).toBe(true);
      expect(decision.rows.find((scalar: string) => scalar.split("\0")[0] === "m" && scalar.split("\0")[1] === "BAS-001")
        .split("\0")[18], `${code}/${cleanup}:tag`).toBe("u");
      expect(await publicValidation("decision", decision), `${code}/${cleanup}:public-terminal-rejected`).toEqual({ exit: 0, code: undefined });
      const reordered = structuredClone(row);
      reordered.first_cause = "CLEANUP_FAILED";
      reordered.secondary_errors = [firstCause];
      reordered.failure_cause = causalReceipt(reordered, "launcher-fault-v1");
      if (firstCause !== "CLEANUP_FAILED") expect(validateRowEvidence(reordered), `${code}/${cleanup}:precedence`).toBe(false);
      for (const mutate of [
        (cause: any) => { cause.receipt.producer = "observer"; },
        (cause: any) => { cause.receipt.observed_outcome = { kind: "rejected", code: "PLATFORM_UNSUPPORTED" }; },
        (cause: any) => { cause.receipt.supplied_input_digest = shaA; },
        (cause: any) => { delete cause.receipt.cleanup; }
      ]) {
        const changed = structuredClone(row.failure_cause);
        mutate(changed);
        if (changed.receipt.cleanup !== undefined) changed.receipt = resignCause(changed).receipt;
        const invalid = structuredClone(row);
        invalid.failure_cause = changed;
        expect(validateRowEvidence(invalid), `${code}/${cleanup}:receipt-binding`).toBe(false);
      }
    }
  }, 30_000);

  test("the failure-cause union rejects cause-free launcher outcomes and producer/control/resource interchange", () => {
    const launcher = normalizedRow("BAS-004");
    launcher.observer_outcome = { kind: "rejected", code: "TIMEOUT" };
    launcher.actual_producing_boundary = "launcher";
    launcher.row_verdict = "fail";
    expect(validateRowEvidence(launcher), "missing-cause").toBe(false);

    launcher.failure_cause = causalReceipt(launcher, "outcome-mismatch-v1");
    expect(validateRowEvidence(launcher), "bound-launcher-cause").toBe(false);
    const observer = outcomeFailure("BAS-004", "observer", { kind: "clean" });
    expect(validateRowEvidence(observer), "bound-observer-cause").toBe(true);
    const swappedProducer = structuredClone(launcher);
    swappedProducer.failure_cause.receipt.producer = "observer";
    expect(validateRowEvidence(swappedProducer), "producer-swap").toBe(false);

    const tripwire = normalizedRow("BAS-005");
    tripwire.actual_producing_boundary = "tripwire";
    tripwire.control_assertions.protected_write.verdict = "fail";
    tripwire.row_verdict = "fail";
    tripwire.failure_cause = causalReceipt(tripwire, "control-failure-v1", "protection");
    expect(validateRowEvidence(tripwire), "wrong-failed-control").toBe(false);

    const resource = normalizedRow("BAS-006");
    resource.observer_outcome = { kind: "rejected", code: "LIMIT_MEMORY" };
    resource.actual_producing_boundary = "launcher";
    resource.actual_resource_record = measuredResource(resource, "memory_bytes", "bytes", OBSERVER_LIMITS.memory_bytes + 1);
    resource.row_verdict = "fail";
    resource.failure_cause = causalReceipt(resource, "resource-exceeded-v1");
    resource.failure_cause.receipt.stimulus_receipt_digest = shaA;
    expect(validateRowEvidence(resource), "resource-stimulus-swap").toBe(false);

    const artificial = normalizedRow("BAS-001");
    artificial.row_verdict = "fail";
    artificial.failure_cause = causalReceipt(artificial, "outcome-mismatch-v1");
    expect(validateRowEvidence(artificial), "matching-outcome-artificial-fail").toBe(false);

    const directDecision = structuredClone(generic.decision);
    const index = directDecision.rows.findIndex((scalar: string) => scalar.split("\0")[0] === "m" && scalar.split("\0")[1] === "BAS-004");
    directDecision.rows[index] = encodeDecisionRowProjection(observer);
    directDecision.terminal_decision = "rejected";
    directDecision.first_cause = "ROW_VERDICT_FAILED";
    directDecision.all_failure_codes = ["ROW_VERDICT_FAILED"];
    expect(validateDecision(directDecision), "D8 bound cause").toBe(true);
    const missingD8Cause = structuredClone(directDecision);
    missingD8Cause.rows[index] = missingD8Cause.rows[index].split("\0").slice(0, -1).concat("").join("\0");
    expect(validateDecision(missingD8Cause), "D8 missing cause").toBe(false);
  });

  test("generic outcome mismatch is observer-only at the raw seam", () => {
    const launcher = outcomeFailure("BAS-004", "launcher", { kind: "rejected", code: "TIMEOUT" });
    expect(validateRowEvidence(launcher), "launcher mismatch").toBe(false);
    const tripwire = outcomeFailure("BAS-004", "tripwire", { kind: "clean" });
    expect(validateRowEvidence(tripwire), "tripwire mismatch").toBe(false);
    const observer = outcomeFailure("BAS-004", "observer", { kind: "clean" });
    expect(validateRowEvidence(observer), "observer mismatch").toBe(true);
  });

  test("generic outcome mismatch is observer-only at the D8 seam", () => {
    const launcher = outcomeFailure("BAS-004", "launcher", { kind: "rejected", code: "TIMEOUT" });
    expect(validateDecision(rejectedDecisionFor(launcher)), "launcher mismatch").toBe(false);
    const tripwire = outcomeFailure("BAS-004", "tripwire", { kind: "clean" });
    expect(validateDecision(rejectedDecisionFor(tripwire)), "tripwire mismatch").toBe(false);
    const observer = outcomeFailure("BAS-004", "observer", { kind: "clean" });
    expect(validateDecision(rejectedDecisionFor(observer)), "observer mismatch").toBe(true);
  });

  test("raw and D8 accept the same complete projection for every causal kind", () => {
    const outcome = outcomeFailure("BAS-004", "observer", { kind: "clean" });
    const control = normalizedRow("BAS-002");
    control.actual_producing_boundary = "tripwire";
    control.control_assertions.protected_write.verdict = "fail";
    control.row_verdict = "fail";
    control.failure_cause = causalReceipt(control, "control-failure-v1", "protected_write");
    const resource = resourceFailure("BAS-001", "wall_time_ms", "milliseconds", "TIMEOUT");
    const lifecycle = lifecycleFailure("LIF-002");
    expect([outcome, control, resource, lifecycle].map((row) => causalParity(row))).toEqual([
      [true, true], [true, true], [true, true], [true, true]
    ]);
    for (const row of [outcome, control, resource, lifecycle]) {
      expect(Buffer.byteLength(JSON.stringify(rejectedDecisionFor(row)))).toBeLessThanOrEqual(INGESTION_LIMITS.decision.bytes);
    }
  });

  test("resource cause revalidates every signed recipe, locator, measurement, and sibling limit field", () => {
    const row = resourceFailure("BAS-003", "memory_bytes", "bytes", "LIMIT_MEMORY");
    expect(causalParity(row)).toEqual([true, true]);
    const mutations = [
      (cause: any) => { cause.receipt.resource.stimulus.recipe.value += 1; },
      (cause: any) => { cause.receipt.resource.stimulus.locator.supplied_input_digest = shaA; },
      (cause: any) => { cause.receipt.resource.measurement.value += 1; },
      (cause: any) => { cause.receipt.resource.declared_limit = "output_bytes"; },
      (cause: any) => { cause.receipt.resource.stimulus.recipe.unit = "count"; },
      (cause: any) => { cause.receipt.supplied_input_digest = shaA; }
    ];
    for (const mutate of mutations) {
      const cause = structuredClone(row.failure_cause);
      mutate(cause);
      expect(causalParity(row, resignCause(cause))).toEqual([false, true]);
    }
    const sibling = resourceFailure("BAS-003", "output_bytes", "bytes", "LIMIT_OUTPUT_BYTES");
    const siblingCause = structuredClone(sibling.failure_cause);
    siblingCause.receipt.row_id = row.row_id;
    siblingCause.receipt.observation_id = row.observation_id;
    siblingCause.receipt.supplied_input_digest = row.frame_digest;
    expect(causalParity(row, resignCause(siblingCause))).toEqual([false, true]);
  });

  test("lifecycle cause revalidates complete row-specific mutation, ordered errors, and cleanup material", () => {
    for (const rowId of ["LIF-002", "LIF-006", "LIF-007"] as const) {
      const row = lifecycleFailure(rowId);
      expect(causalParity(row), `${rowId}:baseline`).toEqual([true, true]);
      const mutations = [
        (cause: any) => { cause.receipt.supplied_mutation = cause.receipt.supplied_mutation.kind === "scheduled-input-v1"
          ? { kind: "set-wire-version-v1", offset: 8, from: 1, to: 2 } : { kind: "scheduled-input-v1" }; },
        (cause: any) => { cause.receipt.first_cause = cause.receipt.first_cause === "CLEANUP_FAILED"
          ? "FRAME_VERSION_UNSUPPORTED" : "CLEANUP_FAILED"; },
        (cause: any) => { cause.receipt.secondary_errors = ["CLEANUP_FAILED", "FRAME_VERSION_UNSUPPORTED"]; },
        (cause: any) => { cause.receipt.cleanup.descriptors_restored = !cause.receipt.cleanup.descriptors_restored; }
      ];
      for (const mutate of mutations) {
        const cause = structuredClone(row.failure_cause);
        mutate(cause);
        expect(causalParity(row, resignCause(cause)), `${rowId}:mutation`).toEqual([false, true]);
      }
    }
    for (const targetId of ["LIF-002", "LIF-006", "LIF-007"] as const) {
      for (const siblingId of ["LIF-002", "LIF-006", "LIF-007"] as const) {
        if (targetId === siblingId) continue;
        const row = lifecycleFailure(targetId);
        const sibling = lifecycleFailure(siblingId).failure_cause;
        sibling.receipt.row_id = row.row_id;
        sibling.receipt.observation_id = row.observation_id;
        sibling.receipt.supplied_input_digest = row.frame_digest;
        expect(causalParity(row, resignCause(sibling)), `${targetId}<-${siblingId}`).toEqual([false, true]);
      }
    }
  });

  test("producer and cause-kind combinations remain closed at both seams", () => {
    const tripwireMismatch = outcomeFailure("BAS-005", "tripwire", { kind: "clean" });
    expect(causalParity(tripwireMismatch)).toEqual([false, false]);
    const outcome = outcomeFailure("BAS-004", "observer", { kind: "clean" });
    for (const mutate of [
      (cause: any) => { cause.receipt.observed_outcome = { kind: "rejected", code: "TIMEOUT" }; },
      (cause: any) => { cause.receipt.producer = "launcher"; },
      (cause: any) => { cause.receipt.supplied_input_digest = shaA; }
    ]) {
      const cause = structuredClone(outcome.failure_cause);
      mutate(cause);
      expect(causalParity(outcome, resignCause(cause))).toEqual([false, true]);
    }
    const control = normalizedRow("BAS-002");
    control.actual_producing_boundary = "tripwire";
    control.control_assertions.protected_write.verdict = "fail";
    control.row_verdict = "fail";
    control.failure_cause = causalReceipt(control, "control-failure-v1", "protected_write");
    for (const mutate of [
      (cause: any) => { cause.receipt.control_id = "protection"; },
      (cause: any) => { cause.receipt.control_verdict = "pass"; },
      (cause: any) => { cause.receipt.producer = "launcher"; },
      (cause: any) => { cause.receipt.supplied_input_digest = shaA; }
    ]) {
      const cause = structuredClone(control.failure_cause);
      mutate(cause);
      expect(causalParity(control, resignCause(cause))).toEqual([false, true]);
    }
    const resource = resourceFailure("BAS-003", "memory_bytes", "bytes", "LIMIT_MEMORY");
    resource.actual_producing_boundary = "observer";
    resource.failure_cause = causalReceipt(resource, "resource-exceeded-v1");
    expect(causalParity(resource)).toEqual([false, false]);
    const lifecycle = lifecycleFailure("LIF-002");
    lifecycle.actual_producing_boundary = "launcher";
    lifecycle.failure_cause = causalReceipt(lifecycle, "lifecycle-fault-v1");
    expect(causalParity(lifecycle)).toEqual([false, false]);
  });

  test("all frozen launcher/tripwire negative slots accept only a bound catalog-code mismatch", () => {
    const eligible = CATALOG_V1.filter((row) => row.macos_expected.kind === "rejected" &&
      ["launcher", "tripwire"].includes(row.producing_boundary)).map((row) => row.id);
    expect(eligible).toEqual([...CATALOG_NEGATIVE_ROWS]);
    for (const platform of ["macos", "linux"] as const) {
      for (const rowId of CATALOG_NEGATIVE_ROWS) {
        const row = catalogNegativeFailure(rowId, platform, "PLATFORM_UNSUPPORTED");
        expect(causalParity(row), `${platform}/${rowId}`).toEqual([true, true]);
        expect(Buffer.byteLength(JSON.stringify(rejectedDecisionFor(row))), `${platform}/${rowId}:capacity`)
          .toBeLessThanOrEqual(INGESTION_LIMITS.decision.bytes);
        const expectedPass = normalizedRow(rowId, platform);
        expect(validateRowEvidence(expectedPass), `${platform}/${rowId}:expected-pass`).toBe(true);
      }
    }
  });

  test("descriptor, lifecycle, and protection negatives preserve alternate frozen rejection codes", () => {
    const cases = [
      ["CAP-005", "DESCRIPTOR_CLOSED"],
      ["LIF-003", "SIGNALLED_TERM"],
      ["PRT-010", "PROTECTED_METADATA_ATTEMPT"]
    ] as const;
    for (const platform of ["macos", "linux"] as const) {
      for (const [rowId, code] of cases) expect(causalParity(catalogNegativeFailure(rowId, platform, code))).toEqual([true, true]);
    }
  });

  test("catalog negative cause rejects every re-signed slot, code, boundary, supplied-state, and relationship exchange", () => {
    const row = catalogNegativeFailure("CAP-005", "macos", "PLATFORM_UNSUPPORTED");
    expect(causalParity(row)).toEqual([true, true]);
    const mutations = [
      (cause: any) => { cause.receipt.platform = "linux"; },
      (cause: any) => { cause.receipt.row_id = "CAP-006"; },
      (cause: any) => { cause.receipt.frozen_expected_code = "DESCRIPTOR_CLOSED"; },
      (cause: any) => { cause.receipt.frozen_boundary = "tripwire"; },
      (cause: any) => { cause.receipt.actual_code = "DESCRIPTOR_CLOSED"; },
      (cause: any) => { cause.receipt.actual_boundary = "tripwire"; },
      (cause: any) => { cause.receipt.supplied_input_digest = shaA; },
      (cause: any) => { cause.receipt.supplied_state.material = { kind: "canonical-frame-wire-v1" }; },
      (cause: any) => { cause.receipt.supplied_state.material_digest = shaA; },
      (cause: any) => { cause.receipt.relationship_recipe.identity = "shud.catalog-negative.CAP-006.v1"; },
      (cause: any) => { cause.receipt.relationship_recipe.recipe_digest = shaA; }
    ];
    for (const mutate of mutations) {
      const cause = structuredClone(row.failure_cause);
      mutate(cause);
      expect(causalParity(row, resignCause(cause))).toEqual([false, true]);
    }
    const fullyResigned = structuredClone(row.failure_cause);
    fullyResigned.receipt.supplied_state.material.extra = true;
    const materialDigest = digest(fullyResigned.receipt.supplied_state.material);
    fullyResigned.receipt.supplied_state.material_digest = materialDigest;
    const { recipe_digest: _oldRecipeDigest, ...recipe } = fullyResigned.receipt.relationship_recipe;
    recipe.supplied_material_digest = materialDigest;
    fullyResigned.receipt.relationship_recipe = { ...recipe, recipe_digest: digest(recipe) };
    expect(causalParity(row, resignCause(fullyResigned))).toEqual([false, true]);
  });

  test("catalog negative cause cannot hide control, resource, producer, or generic-row drift", () => {
    const failedControl = catalogNegativeFailure("CAP-005", "macos", "PLATFORM_UNSUPPORTED");
    failedControl.control_assertions.network.verdict = "fail";
    failedControl.failure_cause = causalReceipt(failedControl, "catalog-negative-mismatch-v1");
    expect(causalParity(failedControl)).toEqual([false, false]);

    const exceeded = catalogNegativeFailure("LIF-003", "macos", "PLATFORM_UNSUPPORTED");
    exceeded.actual_resource_record = measuredResource(exceeded, "memory_bytes", "bytes", OBSERVER_LIMITS.memory_bytes + 1);
    exceeded.failure_cause = causalReceipt(exceeded, "catalog-negative-mismatch-v1");
    expect(causalParity(exceeded)).toEqual([false, false]);

    const wrongBoundary = catalogNegativeFailure("PRT-010", "macos", "PLATFORM_UNSUPPORTED");
    wrongBoundary.actual_producing_boundary = "launcher";
    wrongBoundary.failure_cause = causalReceipt(wrongBoundary, "catalog-negative-mismatch-v1");
    expect(causalParity(wrongBoundary)).toEqual([false, false]);

    const generic = normalizedRow("BAS-001");
    generic.observer_outcome = { kind: "rejected", code: "PLATFORM_UNSUPPORTED" };
    generic.actual_producing_boundary = "launcher";
    generic.row_verdict = "fail";
    generic.failure_cause = causalReceipt(generic, "catalog-negative-mismatch-v1");
    expect(causalParity(generic)).toEqual([false, false]);
  });

  test("D8 projects exactly one canonical byte per causal kind and never copies raw causal material", () => {
    const outcome = outcomeFailure("BAS-004", "observer", { kind: "clean" });
    const control = normalizedRow("BAS-002");
    control.actual_producing_boundary = "tripwire";
    control.control_assertions.protected_write.verdict = "fail";
    control.row_verdict = "fail";
    control.failure_cause = causalReceipt(control, "control-failure-v1", "protected_write");
    const rows = [
      outcome,
      control,
      resourceFailure("BAS-003", "memory_bytes", "bytes", "LIMIT_MEMORY"),
      lifecycleFailure("LIF-002"),
      catalogNegativeFailure("CAP-005", "macos", "PLATFORM_UNSUPPORTED"),
      catalogNegativeFailure("CAP-016", "macos", "PLATFORM_UNSUPPORTED"),
      catalogNegativeFailure("CAP-017", "linux", "PLATFORM_UNSUPPORTED")
    ];
    for (const row of rows) {
      expect(validateRowEvidence(row), `${row.platform}/${row.row_id}:raw`).toBe(true);
      const decision = rejectedDecisionFor(row);
      const index = decision.rows.findIndex((scalar: string) => {
        const fields = scalar.split("\0");
        return fields[0] === (row.platform === "macos" ? "m" : "l") && fields[1] === row.row_id;
      });
      const tag = decision.rows[index].split("\0")[18];
      expect(validateDecision(decision), `${row.platform}/${row.row_id}:d8-tag`).toBe(true);
      expect(tag, `${row.platform}/${row.row_id}:tag`).toBe((FAILURE_CAUSE_TAGS as Record<string, string>)[row.failure_cause.kind]);
      expect(Buffer.byteLength(tag), `${row.platform}/${row.row_id}:width`).toBe(1);
      expect(tag.includes("{") || tag.includes(row.frame_digest), `${row.platform}/${row.row_id}:opaque-material`).toBe(false);
      const wrongTag = structuredClone(decision);
      const fields = wrongTag.rows[index].split("\0");
      fields[18] = tag === "o" ? "c" : "o";
      wrongTag.rows[index] = fields.join("\0");
      expect(validateDecision(wrongTag), `${row.platform}/${row.row_id}:unique-tag`).toBe(false);
    }
    const passFields = generic.decision.rows[0].split("\0");
    expect(passFields[6]).toBe("p");
    expect(passFields[18]).toBe("");
  });

  test("raw rejects forged causal material while standalone D8 validates only its projected semantics", () => {
    for (const rowId of ["CAP-016", "CAP-017"]) {
      const row = catalogNegativeFailure(rowId, "macos", "PLATFORM_UNSUPPORTED");
      const decision = rejectedDecisionFor(row);
      expect(validateRowEvidence(row), `${rowId}:raw-baseline`).toBe(true);
      expect(validateDecision(decision), `${rowId}:d8-baseline`).toBe(true);
      const forged = structuredClone(row);
      forged.failure_cause.receipt.supplied_state.material.frame_reference.frame = {};
      const materialDigest = digest(forged.failure_cause.receipt.supplied_state.material);
      forged.failure_cause.receipt.supplied_state.material_digest = materialDigest;
      const { recipe_digest: _oldRecipeDigest, ...recipe } = forged.failure_cause.receipt.relationship_recipe;
      recipe.supplied_material_digest = materialDigest;
      forged.failure_cause.receipt.relationship_recipe = { ...recipe, recipe_digest: digest(recipe) };
      forged.failure_cause = resignCause(forged.failure_cause);
      expect(validateRowEvidence(forged), `${rowId}:raw-forgery`).toBe(false);
      expect(validateDecision(decision), `${rowId}:d8-does-not-claim-raw-revalidation`).toBe(true);
    }
  });

  test("all 348 raw-valid worst-length failure projections fit the public decision ingress exact/+1 boundary", async () => {
    const decision = structuredClone(generic.decision);
    decision.rows = decision.rows.map((scalar: string) => {
      const fields = scalar.split("\0");
      const platform = fields[0] === "m" ? "macos" : "linux";
      const row = worstFailureRow(fields[1], platform);
      expect(validateRowEvidence(row), `${platform}/${fields[1]}:raw-eligibility`).toBe(true);
      const projection = encodeDecisionRowProjection(row);
      expect(Buffer.byteLength(projection.split("\0")[18]), `${platform}/${fields[1]}:cause-width`).toBe(1);
      return projection;
    });
    decision.terminal_decision = "rejected";
    decision.first_cause = "ROW_VERDICT_FAILED";
    decision.all_failure_codes = ["ROW_VERDICT_FAILED"];
    expect(validateDecision(decision), "348-slot semantic projection").toBe(true);

    const serialized = Buffer.from(JSON.stringify(decision));
    expect(serialized.byteLength, "348-failure-decision-bytes").toBe(127_648);
    expect(serialized.byteLength).toBeLessThanOrEqual(INGESTION_LIMITS.decision.bytes);
    const exact = Buffer.concat([serialized, Buffer.alloc(INGESTION_LIMITS.decision.bytes - serialized.byteLength, 0x20)]);
    const plusOne = Buffer.concat([exact, Buffer.from(" ")]);
    const directory = await mkdtemp(join(tmpdir(), "shud-d8-capacity-"));
    try {
      const checkPath = join(import.meta.dir, "../check.ts");
      const runPublic = async (bytes: Buffer, name: string): Promise<{ exit: number; stdout: string; stderr: string }> => {
        const input = join(directory, name);
        await writeFile(input, bytes);
        const child = Bun.spawn([process.execPath, checkPath, "--input", input, "--kind", "decision"], {
          stdout: "pipe", stderr: "pipe"
        });
        const [exit, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text()
        ]);
        return { exit, stdout, stderr };
      };
      expect(await runPublic(serialized, "all-failure.json")).toMatchObject({ exit: 0, stderr: "" });
      expect(await runPublic(exact, "decision-exact.json")).toMatchObject({ exit: 0, stderr: "" });
      const rejected = await runPublic(plusOne, "decision-plus-one.json");
      expect(rejected.exit).toBe(2);
      expect(rejected.stdout).toBe("");
      expect(JSON.parse(rejected.stderr).code).toBe("CONTRACT_BYTES_LIMIT");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
