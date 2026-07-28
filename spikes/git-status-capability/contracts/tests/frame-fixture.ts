import { createHash } from "node:crypto";

const shaA = "01".repeat(32);
const shaB = "ab".repeat(32);
const oidA = "01".repeat(20);
const oidB = "ab".repeat(20);

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

function entry(path: string, objectId = oidA) {
  return {
    path, stage: 0, mode: "100644", object_id: objectId,
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

export function materialFrame(split = false): Record<string, any> {
  const local = entry(split ? "b.txt" : "a.txt", oidB);
  const shared = entry("a.txt", oidA);
  const effective = split ? [shared, local] : [local];
  const index = {
    state: "parsed", format_version: split ? 4 : 2, byte_length: 256, digest: shaA, entry_count: effective.length,
    entries: [local], effective_entries: effective,
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
    exclude_state: frame.exclude_state, attribute_state: frame.attribute_state, nested_state: frame.nested_state
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
