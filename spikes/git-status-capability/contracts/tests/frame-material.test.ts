import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck } from "../lib/checker";
import * as schemaModule from "../lib/schema";
import { materialFrame, resealFrame } from "./frame-fixture";

const shaA = "01".repeat(32);

function inlineBytes(text: string) {
  const bytes = Buffer.from(text, "utf8");
  return {
    kind: "inline-bytes-v1", byte_length: bytes.length,
    digest: createHash("sha256").update(bytes).digest("hex"), content_base64: bytes.toString("base64")
  };
}

function materialIndex(primaryText: string, sharedText?: string) {
  return {
    state: "material", primary: inlineBytes(primaryText),
    shared_index: sharedText === undefined ? { state: "absent" } : { state: "present", material: inlineBytes(sharedText) }
  };
}

function pathMaterial(path: string) {
  const bytes = Buffer.from(path, "utf8");
  return {
    kind: "path-material-v1", byte_length: bytes.length, digest: createHash("sha256").update(bytes).digest("hex"),
    content_base64: bytes.toString("base64")
  };
}

const limitStimuli = [
  { row_id: "LIM-006", recipe: { kind: "index-entry-series-v1", count: 50_001, path_prefix: "limit-index-", object_id: "01".repeat(20) } },
  { row_id: "LIM-012", recipe: { kind: "nested-repository-series-v1", count: 17, path_prefix: "limit-nested-", object_id: "01".repeat(20) } },
  { row_id: "LIM-014", recipe: { kind: "tree-entry-series-v1", count: 200_001, path_prefix: "limit-tree-", mode: "100644", object_id: "01".repeat(20) } },
  { row_id: "LIM-008", recipe: pathMaterial("x".repeat(513)) },
  { row_id: "LIM-010", recipe: pathMaterial(Array.from({ length: 17 }, () => "x").join("/")) },
  { row_id: "LIM-016", recipe: {
    kind: "repeat-byte-v1", byte: 0, byte_length: 256 * 1024 * 1024 + 1,
    digest: "da6ce8755151acd05195db67ebce3ee0fb5f4012e71e821cc5750f3304eaf41e"
  } }
] as const;

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
    const nested = structuredClone(split.index.entries.find((entry: any) => entry.path === "nested"));
    split.index.entries = [replacementB, addedD, nested];
    split.index.shared_index.entries = [sharedA, sharedB, sharedC];
    split.index.shared_index.deleted_paths = ["c.txt"];
    split.index.shared_index.replaced_paths = ["b.txt"];
    split.index.effective_entries = [sharedA, replacementB, addedD, nested];
    split.index.entry_count = 4;
    expect(await publicSchema(resealFrame(split))).toEqual({ exit: 0 });
    for (const [rowId, index] of [
      ["IDX-007", materialIndex("DIRC\0link\0shared-index-name")],
      ["IDX-008", materialIndex("DIRC\0link\0shared-index-name", "corrupt shared bytes")],
      ["IDX-009", materialIndex("not a git index")],
      ["IDX-010", materialIndex("DIRC\0\0\0")]
    ] as const) {
      const stimulus = materialFrame();
      stimulus.row_id = rowId;
      stimulus.index = index;
      stimulus.nested_state = [];
      expect(await publicSchema(resealFrame(stimulus))).toEqual({ exit: 0 });
    }
  });

  test("public schema admits only deterministic catalog exact+1 material recipes", async () => {
    for (const { row_id, recipe } of limitStimuli) {
      const frame = materialFrame();
      frame.row_id = row_id;
      frame.limit_stimulus = structuredClone(recipe);
      expect(await publicSchema(resealFrame(frame)), recipe.kind).toEqual({ exit: 0 });
    }
    for (const { row_id, recipe } of limitStimuli) {
      const frame = materialFrame();
      frame.row_id = row_id;
      frame.limit_stimulus = structuredClone(recipe);
      if ("count" in frame.limit_stimulus) frame.limit_stimulus.count += 1;
      else if (frame.limit_stimulus.kind === "path-material-v1") {
        const path = Buffer.from(frame.limit_stimulus.content_base64, "base64").toString("utf8");
        frame.limit_stimulus = pathMaterial(path.includes("/") ? `${path}/x` : `${path}x`);
      } else frame.limit_stimulus.byte_length += 1;
      expect(await publicSchema(resealFrame(frame)), `${recipe.kind}+2`).toEqual({ exit: 2, code: "CONTRACT_SCHEMA_INVALID" });
    }
    const wrongRow = materialFrame();
    wrongRow.limit_stimulus = structuredClone(limitStimuli[0].recipe);
    expect(await publicSchema(resealFrame(wrongRow))).toEqual({ exit: 2, code: "CONTRACT_SCHEMA_INVALID" });
  });

  test("raw index material binds actual bytes and rejects producer answers or material drift", async () => {
    const frame = materialFrame();
    frame.row_id = "IDX-009";
    frame.index = materialIndex("not a git index");
    frame.nested_state = [];
    expect(await publicSchema(resealFrame(frame))).toEqual({ exit: 0 });
    const exactIndexBytes = materialFrame();
    exactIndexBytes.row_id = "IDX-011";
    exactIndexBytes.index = {
      state: "material",
      primary: {
        kind: "repeat-byte-v1", byte: 0, byte_length: 6 * 1024 * 1024 + 1,
        digest: "8996de63e472cbfe218412fd3512ad6d908f83119f02c439fbc16446d6d9e5db"
      },
      shared_index: { state: "absent" }
    };
    exactIndexBytes.nested_state = [];
    expect(await publicSchema(resealFrame(exactIndexBytes))).toEqual({ exit: 0 });
    exactIndexBytes.index.primary.byte_length += 1;
    expect(await publicSchema(resealFrame(exactIndexBytes))).toEqual({ exit: 2, code: "CONTRACT_SCHEMA_INVALID" });
    for (const mutate of [
      (value: any) => { value.index.primary.byte_length += 1; },
      (value: any) => { value.index.primary.digest = shaA; },
      (value: any) => { value.index.rejection_code = "INDEX_MALFORMED"; },
      (value: any) => { value.index = { state: "rejected", byte_length: 12, digest: shaA, rejection_code: "INDEX_MALFORMED" }; }
    ]) {
      const changed = structuredClone(frame); mutate(changed);
      expect(await publicSchema(resealFrame(changed))).toEqual({ exit: 2, code: "CONTRACT_SCHEMA_INVALID" });
    }
  });

  test("public schema accepts exact initialized, deinitialized, absent, direct, and recursive nested material", async () => {
    const initialized = materialFrame();
    expect(await publicSchema(initialized)).toEqual({ exit: 0 });
    const deinitialized = materialFrame();
    deinitialized.nested_state[0].checkout_state = "deinitialized";
    deinitialized.nested_state[0].audit = {
      state: "deinitialized", parent_identity: shaA, basename: "nested", directory_identity: "ab".repeat(32)
    };
    expect(await publicSchema(resealFrame(deinitialized))).toEqual({ exit: 0 });
    const absent = materialFrame();
    absent.nested_state[0].checkout_state = "absent";
    absent.nested_state[0].audit = { state: "absent", parent_identity: shaA, basename: "nested" };
    expect(await publicSchema(resealFrame(absent))).toEqual({ exit: 0 });
    for (const stateFrame of [deinitialized, absent]) {
      const missingParent = structuredClone(stateFrame);
      missingParent.index.entries = missingParent.index.entries.filter((item: any) => item.path !== "nested");
      missingParent.index.effective_entries = structuredClone(missingParent.index.entries);
      missingParent.index.entry_count = missingParent.index.effective_entries.length;
      expect(await publicSchema(resealFrame(missingParent))).toEqual({ exit: 2, code: "CONTRACT_SCHEMA_INVALID" });
    }
  });

  test("nested material is bound to the immediate parent effective index", async () => {
    const recursive = materialFrame();
    const parent = recursive.nested_state[0];
    parent.audit.index.entries = [structuredClone(recursive.index.entries.find((item: any) => item.path === "nested"))];
    parent.audit.index.entries[0].path = "child";
    parent.audit.index.entries[0].object_id = "cd".repeat(20);
    parent.audit.index.effective_entries = structuredClone(parent.audit.index.entries);
    parent.audit.index.entry_count = 1;
    recursive.nested_state.push({
      path: "nested/child", relation: "recursive",
      gitlink: { path: "nested/child", stage: 0, mode: "160000", object_id: "cd".repeat(20) },
      checkout_state: "absent", audit: { state: "absent", parent_identity: shaA, basename: "child" }
    });
    expect(await publicSchema(resealFrame(recursive))).toEqual({ exit: 0 });

    const cases: Array<[string, (frame: any) => void]> = [
      ["missing-root-parent", (frame) => { frame.index.entries = frame.index.entries.filter((item: any) => item.path !== "nested"); frame.index.effective_entries = structuredClone(frame.index.entries); frame.index.entry_count = frame.index.effective_entries.length; }],
      ["parent-stage", (frame) => { for (const list of [frame.index.entries, frame.index.effective_entries]) { const item = list.find((entry: any) => entry.path === "nested"); item.stage = 1; item.stat = null; } }],
      ["parent-mode", (frame) => { for (const list of [frame.index.entries, frame.index.effective_entries]) list.find((entry: any) => entry.path === "nested").mode = "100644"; }],
      ["parent-oid", (frame) => { for (const list of [frame.index.entries, frame.index.effective_entries]) list.find((entry: any) => entry.path === "nested").object_id = "ef".repeat(20); }],
      ["recursive-gap", (frame) => { frame.nested_state.shift(); }],
      ["recursive-relative-path", (frame) => { frame.nested_state[0].audit.index.effective_entries[0].path = "other"; frame.nested_state[0].audit.index.entries[0].path = "other"; }]
    ];
    for (const [name, mutate] of cases) {
      const changed = structuredClone(recursive); mutate(changed);
      expect(await publicSchema(resealFrame(changed)), name).toEqual({ exit: 2, code: "CONTRACT_SCHEMA_INVALID" });
    }
  });

  test("LF, U+2028, and U+2029 remain valid nested path bytes when the parent gitlink matches", async () => {
    for (const path of ["nested\nline", "nested\u2028line", "nested\u2029line"]) {
      const frame = materialFrame();
      const parent = frame.index.entries.find((item: any) => item.path === "nested");
      parent.path = path;
      frame.index.entries.sort((left: any, right: any) => Buffer.from(left.path).compare(Buffer.from(right.path)));
      frame.index.effective_entries = structuredClone(frame.index.entries);
      frame.nested_state[0].path = path;
      frame.nested_state[0].gitlink.path = path;
      expect(await publicSchema(resealFrame(frame)), JSON.stringify(path)).toEqual({ exit: 0 });
    }
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
      ["nested-count-overflow", (frame) => { frame.nested_state.push(...Array.from({ length: 16 }, () => structuredClone(frame.nested_state[0]))); }]
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
    const stimulus = materialFrame();
    stimulus.row_id = "IDX-007";
    stimulus.index = materialIndex("DIRC\0link\0shared-index-name");
    stimulus.nested_state = [];
    const stimulusInputs = (derive as (frame: unknown) => any)(resealFrame(stimulus));
    expect(stimulusInputs.baseline).toBeNull();
    expect(stimulusInputs.staged).toBeNull();
    expect(stimulusInputs.index).toEqual(materialIndex("DIRC\0link\0shared-index-name"));
    expect(JSON.stringify(stimulusInputs.index)).not.toContain("rejection_code");
    const bounded = materialFrame();
    bounded.row_id = limitStimuli[0].row_id;
    bounded.limit_stimulus = structuredClone(limitStimuli[0].recipe);
    const boundedInputs = (derive as (frame: unknown) => any)(resealFrame(bounded));
    expect(boundedInputs.limit_stimulus).toEqual(limitStimuli[0].recipe);
    expect(JSON.stringify(boundedInputs.limit_stimulus)).not.toContain("rejection_code");
  });
});
