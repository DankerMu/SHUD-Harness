import { createHash } from "node:crypto";

const shaA = "01".repeat(32);
const shaB = "ab".repeat(32);
const oidA = "01".repeat(20);
const oidB = "ab".repeat(20);
export const frameEvidenceEncoding = "shud.git-status-capability.canonical-frame-json.v1";
export type EvidencePlatform = "macos" | "linux";
const frameEvidenceFields = [
  "schema_version", "catalog_version", "row_id", "observation_id", "checkout_capability_identity",
  "git_state_generation_digest", "body_length", "body_digest", "checksum", "index", "head_tree",
  "effective_config", "exclude_state", "attribute_state", "nested_state", "limit_stimulus"
] as const;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function source(path: string, content: string) {
  const bytes = Buffer.from(content, "utf8");
  return { path, byte_length: bytes.length, digest: createHash("sha256").update(bytes).digest("hex"), content_base64: bytes.toString("base64") };
}

function pathState(sources: ReturnType<typeof source>[]) {
  return { digest: digest(JSON.stringify(sources)), sources };
}

function config(entries: Array<Record<string, string>>) {
  return { digest: digest(JSON.stringify(entries)), entries };
}

function entry(path: string, objectId = oidA, mode = "100644") {
  return {
    path, stage: 0, mode, object_id: objectId,
    stat: {
      ctime_seconds: 1, ctime_nanoseconds: 2, mtime_seconds: 3, mtime_nanoseconds: 4,
      device: 5, inode: 6, uid: 501, gid: 20, size: 6
    },
    flags: { assume_unchanged: false, skip_worktree: false, intent_to_add: false, fsmonitor_valid: false }
  };
}

function emptyIndex() {
  return {
    state: "parsed", format_version: 2, byte_length: 12, digest: shaA, entry_count: 0, entries: [], effective_entries: [],
    extensions: [], shared_index: { state: "absent" }
  };
}

function pathMaterial(path: string) {
  const bytes = Buffer.from(path, "utf8");
  return { kind: "path-material-v1", byte_length: bytes.length, digest: digest(path), content_base64: bytes.toString("base64") };
}

function limitStimulus(rowId: string): Record<string, unknown> | undefined {
  if (rowId === "LIM-006") return { kind: "index-entry-series-v1", count: 50_001, path_prefix: "limit-index-", object_id: oidA };
  if (rowId === "LIM-008") return pathMaterial("x".repeat(513));
  if (rowId === "LIM-010") return pathMaterial(Array.from({ length: 17 }, () => "x").join("/"));
  if (rowId === "LIM-012") return { kind: "nested-repository-series-v1", count: 17, path_prefix: "limit-nested-", object_id: oidA };
  if (rowId === "LIM-014") return { kind: "tree-entry-series-v1", count: 200_001, path_prefix: "limit-tree-", mode: "100644", object_id: oidA };
  if (rowId === "LIM-016") return {
    kind: "repeat-byte-v1", byte: 0, byte_length: 256 * 1024 * 1024 + 1,
    digest: "da6ce8755151acd05195db67ebce3ee0fb5f4012e71e821cc5750f3304eaf41e"
  };
  return undefined;
}

function canonicalEvidenceValue(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalEvidenceValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
    .map((key) => [key, canonicalEvidenceValue(value[key])]));
}

export function canonicalFrameEvidenceBytes(frame: Record<string, any>): Buffer {
  return Buffer.from(JSON.stringify(Object.fromEntries(frameEvidenceFields.filter((field) => Object.hasOwn(frame, field))
    .map((field) => [field, canonicalEvidenceValue(frame[field])]))), "utf8");
}

export function materialFrame(split = false): Record<string, any> {
  const local = entry(split ? "b.txt" : "a.txt", oidB);
  const shared = entry("a.txt", oidA);
  const nestedGitlink = entry("nested", oidB, "160000");
  const entries = [local, nestedGitlink].sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const effective = (split ? [shared, ...entries] : entries).sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const index = {
    state: "parsed", format_version: split ? 4 : 2, byte_length: 256, digest: shaA, entry_count: effective.length,
    entries, effective_entries: effective,
    extensions: split ? [{ signature: "link", byte_length: 64, digest: shaB }] : [],
    shared_index: split ? {
      state: "present", byte_length: 128, digest: shaB, entries: [shared], deleted_paths: [], replaced_paths: []
    } : { state: "absent" }
  };
  const headTreeEntries = [
    { path: "a.txt", mode: "100644", object_id: oidA },
    ...(split ? [{ path: "b.txt", mode: "100644", object_id: oidA }] : [])
  ];
  const emptyConfig = config([]);
  const emptyPathState = pathState([]);
  const body = {
    index,
    head_tree: { state: "present", object_id: oidA, entry_count: headTreeEntries.length, entries: headTreeEntries },
    effective_config: config([{ scope: "local", key: "status.showUntrackedFiles", value: "all", origin: ".git/config" }]),
    exclude_state: pathState([source(".git/info/exclude", "build/\n")]),
    attribute_state: pathState([source(".gitattributes", "*.txt text eol=lf\n")]),
    nested_state: [{
      path: "nested", relation: "direct", gitlink: { path: "nested", stage: 0, mode: "160000", object_id: oidB },
      checkout_state: "initialized",
      audit: {
        state: "initialized", directory_identity: shaB, index: emptyIndex(),
        head_tree: { state: "present", object_id: oidA, entry_count: 0, entries: [] },
        effective_config: emptyConfig, exclude_state: emptyPathState, attribute_state: emptyPathState
      }
    }]
  };
  const bodyBytes = JSON.stringify(body);
  const bodyDigest = digest(bodyBytes);
  const header = {
    schema_version: "shud.git-status-capability.frame.v1", catalog_version: 1, row_id: "BAS-001",
    observation_id: shaA, checkout_capability_identity: shaB, git_state_generation_digest: bodyDigest,
    body_length: Buffer.byteLength(bodyBytes), body_digest: bodyDigest
  };
  return { ...header, checksum: digest(JSON.stringify({ header, body })), ...body };
}

export function resealFrame(frame: Record<string, any>): Record<string, any> {
  const body = {
    index: frame.index, head_tree: frame.head_tree, effective_config: frame.effective_config,
    exclude_state: frame.exclude_state, attribute_state: frame.attribute_state, nested_state: frame.nested_state,
    ...(Object.hasOwn(frame, "limit_stimulus") ? { limit_stimulus: frame.limit_stimulus } : {})
  };
  const bodyBytes = JSON.stringify(body);
  frame.body_length = Buffer.byteLength(bodyBytes);
  frame.body_digest = digest(bodyBytes);
  frame.git_state_generation_digest = frame.body_digest;
  const header = {
    schema_version: frame.schema_version, catalog_version: frame.catalog_version, row_id: frame.row_id,
    observation_id: frame.observation_id, checkout_capability_identity: frame.checkout_capability_identity,
    git_state_generation_digest: frame.git_state_generation_digest, body_length: frame.body_length, body_digest: frame.body_digest
  };
  frame.checksum = digest(JSON.stringify({ header, body }));
  return frame;
}

export function slotObservationId(platform: EvidencePlatform, rowId: string): string {
  return digest(`shud.git-status-capability.observation-slot.v1\0${platform}\0${rowId}`);
}

function slotObjectId(platform: EvidencePlatform, rowId: string, kind: string, path = ""): string {
  return createHash("sha1").update(`shud.git-status-capability.actual-object-slot.v1\0${platform}\0${rowId}\0${kind}\0${path}`).digest("hex");
}

export function frameForEvidenceSlot(
  platform: EvidencePlatform,
  rowId: string,
  observationId: string,
  capabilityIdentity: string
): Record<string, any> {
  const frame = materialFrame();
  frame.row_id = rowId;
  frame.observation_id = observationId;
  frame.checkout_capability_identity = capabilityIdentity;
  frame.head_tree.object_id = slotObjectId(platform, rowId, "tree");
  for (const entry of frame.head_tree.entries) {
    entry.object_id = slotObjectId(platform, rowId, "entry", entry.path);
  }
  const stimulus = limitStimulus(rowId);
  if (stimulus) frame.limit_stimulus = stimulus;
  return resealFrame(frame);
}
