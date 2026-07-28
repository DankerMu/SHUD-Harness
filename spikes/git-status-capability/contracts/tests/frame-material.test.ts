import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck } from "../lib/checker";
import * as schemaModule from "../lib/schema";
import { materialFrame, resealFrame } from "./frame-fixture";

const shaA = "01".repeat(32);

async function publicSchema(frame: Record<string, any>): Promise<{ exit: number; code?: string }> {
  const root = await mkdtemp(join(tmpdir(), "shud-frame-material-"));
  try {
    const input = join(root, "frame.json");
    await writeFile(input, JSON.stringify(frame));
    let stderr = "";
    const exit = await runCheck(["--input", input, "--kind", "schema"], { stdout: () => {}, stderr: (chunk) => stderr += chunk });
    return { exit, code: stderr ? JSON.parse(stderr).code : undefined };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("frame v1 carries consumer-complete Git-state material", () => {
  test("public schema accepts ordinary and split frames with deterministic effective entries", async () => {
    expect(await publicSchema(materialFrame())).toEqual({ exit: 0 });
    expect(await publicSchema(materialFrame(true))).toEqual({ exit: 0 });
    const split = materialFrame(true);
    const template = split.index.effective_entries[0];
    const item = (path: string, objectId: string) => ({ ...structuredClone(template), path, object_id: objectId });
    const sharedA = item("a.txt", "01".repeat(20));
    const sharedB = item("b.txt", "02".repeat(20));
    const sharedC = item("c.txt", "03".repeat(20));
    const replacementB = item("b.txt", "ab".repeat(20));
    const addedD = item("d.txt", "cd".repeat(20));
    split.index.entries = [replacementB, addedD];
    split.index.shared_index.entries = [sharedA, sharedB, sharedC];
    split.index.shared_index.deleted_paths = ["c.txt"];
    split.index.shared_index.replaced_paths = ["b.txt"];
    split.index.effective_entries = [sharedA, replacementB, addedD];
    split.index.entry_count = 3;
    expect(await publicSchema(resealFrame(split))).toEqual({ exit: 0 });
    for (const [rejectionCode, byteLength] of [
      ["INDEX_SHARED_MISSING", 256], ["INDEX_SHARED_CORRUPT", 256], ["INDEX_MALFORMED", 12],
      ["INDEX_TRUNCATED", 11], ["LIMIT_INDEX_BYTES", 6_291_457]
    ] as const) {
      const rejected = materialFrame();
      rejected.index = { state: "rejected", byte_length: byteLength, digest: shaA, rejection_code: rejectionCode };
      expect(await publicSchema(resealFrame(rejected))).toEqual({ exit: 0 });
    }
  });

  test("public schema accepts exact initialized, deinitialized, absent, direct, and recursive nested material", async () => {
    const initialized = materialFrame();
    expect(await publicSchema(initialized)).toEqual({ exit: 0 });
    const deinitialized = materialFrame();
    deinitialized.nested_state[0].relation = "recursive";
    deinitialized.nested_state[0].checkout_state = "deinitialized";
    deinitialized.nested_state[0].audit = {
      state: "deinitialized", parent_identity: shaA, basename: "nested", directory_identity: "ab".repeat(32)
    };
    expect(await publicSchema(resealFrame(deinitialized))).toEqual({ exit: 0 });
    const absent = materialFrame();
    absent.nested_state[0].checkout_state = "absent";
    absent.nested_state[0].audit = { state: "absent", parent_identity: shaA, basename: "nested" };
    expect(await publicSchema(resealFrame(absent))).toEqual({ exit: 0 });
  });

  test("public schema rejects missing, illegal, duplicate, oversized, and inconsistent actual material", async () => {
    const cases: Array<[string, (frame: Record<string, any>) => void]> = [
      ["missing-index-entries", (frame) => { delete frame.index.entries; }],
      ["unknown-index-state", (frame) => { frame.index.state = "future"; }],
      ["escape-path", (frame) => { frame.index.entries[0].path = "../escape"; }],
      ["oversized-path", (frame) => { frame.index.entries[0].path = "x".repeat(513); }],
      ["illegal-stage", (frame) => { frame.index.entries[0].stage = 5; }],
      ["illegal-mode", (frame) => { frame.index.entries[0].mode = "100600"; }],
      ["illegal-stat", (frame) => { frame.index.entries[0].stat.mtime_nanoseconds = 1_000_000_000; }],
      ["duplicate-effective", (frame) => { frame.index.effective_entries.push(structuredClone(frame.index.effective_entries[0])); frame.index.entry_count += 1; }],
      ["missing-shared-fields", (frame) => { frame.index.shared_index = { state: "present", byte_length: 1, digest: shaA, entries: [] }; }],
      ["invalid-replacement-relation", (frame) => { frame.index.shared_index.replaced_paths = ["a.txt"]; }],
      ["effective-relation-drift", (frame) => { frame.index.effective_entries[0] = { ...frame.index.effective_entries[0], object_id: "cd".repeat(20) }; }],
      ["missing-tree-entries", (frame) => { delete frame.head_tree.entries; }],
      ["duplicate-tree-entry", (frame) => { frame.head_tree.entries.push(structuredClone(frame.head_tree.entries[0])); frame.head_tree.entry_count += 1; }],
      ["exclude-content-drift", (frame) => { frame.exclude_state.sources[0].content_base64 += "ZA=="; }],
      ["exclude-state-digest-drift", (frame) => { frame.exclude_state.digest = shaA; }],
      ["duplicate-exclude-path", (frame) => { frame.exclude_state.sources.push(structuredClone(frame.exclude_state.sources[0])); }],
      ["attribute-byte-drift", (frame) => { frame.attribute_state.sources[0].byte_length += 1; }],
      ["config-digest-drift", (frame) => { frame.effective_config.digest = shaA; }],
      ["nested-state-combination", (frame) => { frame.nested_state[0].checkout_state = "absent"; }],
      ["nested-unknown", (frame) => { frame.nested_state[0].audit.future = true; }],
      ["nested-count-overflow", (frame) => {
        frame.nested_state = Array.from({ length: 17 }, (_, index) => {
          const nested = structuredClone(frame.nested_state[0]);
          nested.path = `nested-${String(index).padStart(2, "0")}`;
          nested.gitlink.path = nested.path;
          return nested;
        });
      }]
    ];
    for (const [name, mutate] of cases) {
      const frame = materialFrame(true);
      mutate(frame);
      expect(await publicSchema(resealFrame(frame)), name).toEqual({ exit: 2, code: "CONTRACT_SCHEMA_INVALID" });
    }
    for (const mutate of [
      (frame: Record<string, any>) => { frame.body_length += 1; },
      (frame: Record<string, any>) => { frame.git_state_generation_digest = shaA; },
      (frame: Record<string, any>) => { frame.checksum = shaA; }
    ]) {
      const frame = materialFrame(true); mutate(frame);
      expect(await publicSchema(frame)).toEqual({ exit: 2, code: "CONTRACT_SCHEMA_INVALID" });
    }
  });

  test("a pure consumer derives BAS, STG, and IDX comparison inputs from the frame only", () => {
    const derive = (schemaModule as Record<string, unknown>).deriveFrameComparisonInputs;
    expect(typeof derive).toBe("function");
    const inputs = (derive as (frame: unknown) => any)(materialFrame(true));
    expect(inputs).toEqual({
      baseline: {
        tracked_entries: materialFrame(true).index.effective_entries.filter((item: any) => item.stage === 0),
        head_tree_entries: materialFrame(true).head_tree.entries
      },
      staged: {
        index_entries: materialFrame(true).index.effective_entries,
        head_tree_entries: materialFrame(true).head_tree.entries
      },
      index: {
        state: "parsed",
        format_version: 4,
        primary_entries: materialFrame(true).index.entries,
        shared_entries: materialFrame(true).index.shared_index.entries,
        effective_entries: materialFrame(true).index.effective_entries
      },
      path_policy: {
        effective_config: materialFrame(true).effective_config.entries,
        exclude_sources: materialFrame(true).exclude_state.sources,
        attribute_sources: materialFrame(true).attribute_state.sources
      }
    });
    const rejected = materialFrame();
    rejected.index = { state: "rejected", byte_length: 256, digest: shaA, rejection_code: "INDEX_SHARED_MISSING" };
    const rejectedInputs = (derive as (frame: unknown) => any)(resealFrame(rejected));
    expect(rejectedInputs.baseline).toBeNull();
    expect(rejectedInputs.staged).toBeNull();
    expect(rejectedInputs.index).toEqual({ state: "rejected", rejection_code: "INDEX_SHARED_MISSING", byte_length: 256, digest: shaA });
  });
});
