import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  codeChangeClosure,
  evaluateClosure,
  readChangePatch,
  readWorkspaceRecord,
  type CodeChangeClosureLoaders,
} from "./index.ts";
import {
  closureEvidence,
  evidenceLoaders,
  freezeEvidence,
  OTHER_CHANGE,
  OTHER_TASK,
  OTHER_VERIFICATION,
  PRIVATE_PAYLOAD,
  type ClosureEvidence,
} from "./code-change-closure-test-harness.ts";

let root: string;
let cwd: string;
let input: ClosureEvidence;
let loaders: CodeChangeClosureLoaders;

function seed(relative: string, bytes: string | Uint8Array): string {
  const path = join(cwd, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

interface SnapshotEntry {
  path: string;
  ino: bigint;
  mode: bigint;
  mtimeNs: bigint;
  bytes: Buffer | null;
  target: string | null;
}

// lstat, not stat: inventory evidence and symlink text without following unsafe targets.
function snapshot(path: string, relative = "."): SnapshotEntry[] {
  const stat = lstatSync(path, { bigint: true });
  const entry: SnapshotEntry = {
    path: relative,
    ino: stat.ino,
    mode: stat.mode,
    mtimeNs: stat.mtimeNs,
    bytes: stat.isFile() ? readFileSync(path) : null,
    target: stat.isSymbolicLink() ? readlinkSync(path) : null,
  };
  return [
    entry,
    ...(stat.isDirectory()
      ? readdirSync(path)
          .sort()
          .flatMap((name) => snapshot(join(path, name), `${relative}/${name}`))
      : []),
  ];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "code-closure-readonly-"));
  cwd = join(root, "workspace");
  mkdirSync(cwd);
  input = closureEvidence();
  seed(`tasks/${input.card.task_id}/task.json`, ` ${JSON.stringify(input.card, null, 2)}\n`);
  seed(`changes/${input.change.change_id}.json`, ` ${JSON.stringify(input.change, null, 2)}\n\n`);
  seed(input.change.patch_path, input.patch);
  seed(
    `verifications/${input.verification.vc_id}.json`,
    ` ${JSON.stringify(input.verification, null, 2)}\n`,
  );
  seed("reports/existing-report.md", "Existing report must remain untouched.\n");
  loaders = {
    ...evidenceLoaders(input).loaders,
    readChange: (id) => readWorkspaceRecord(cwd, "change", id, { readonly: true }),
    readPatch: (id) => readChangePatch(cwd, id, { readonly: true }),
    readVerification: (id) => readWorkspaceRecord(cwd, "verification", id, { readonly: true }),
  };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function evaluateUnchanged() {
  const diskBefore = snapshot(root);
  const inputBefore = structuredClone(input);
  freezeEvidence(input);
  const direct = codeChangeClosure(input.card, loaders);
  const facade = evaluateClosure(input.card, input.runJobs, input.records, input.draft, loaders);
  expect(facade).toStrictEqual(direct);
  expect(snapshot(root)).toStrictEqual(diskBefore);
  expect(input).toStrictEqual(inputBefore);
  expect(inspect(direct, { depth: null })).not.toContain(PRIVATE_PAYLOAD);
  return direct;
}

test("public predicates consume real readonly adapters without changing bytes, mtimes or inventory", () => {
  expect(evaluateUnchanged()).toMatchObject({ ok: true, failures: [] });
});

describe.each(["change", "verification"] as const)("linked %s readonly evidence", (kind) => {
  test.each([
    "malformed",
    "schema",
    "missing",
    "symlink",
    "directory",
    "embedded_id",
    "foreign_task",
  ] as const)("%s fails closed without repairing any file", (failure) => {
    const isChange = kind === "change";
    const id = isChange ? input.change.change_id : input.verification.vc_id;
    const relative = `${isChange ? "changes" : "verifications"}/${id}.json`;
    const path = join(cwd, relative);
    const value = isChange ? input.change : input.verification;
    if (failure === "malformed") writeFileSync(path, `{"payload":"${PRIVATE_PAYLOAD}", broken`);
    if (failure === "schema")
      writeFileSync(path, JSON.stringify({ ...value, created_at: PRIVATE_PAYLOAD }));
    if (failure === "foreign_task")
      writeFileSync(path, JSON.stringify({ ...value, task_id: OTHER_TASK }));
    if (failure === "embedded_id")
      writeFileSync(
        path,
        JSON.stringify({
          ...value,
          ...(isChange
            ? { change_id: OTHER_CHANGE, patch_path: `patches/${OTHER_CHANGE}.patch` }
            : { vc_id: OTHER_VERIFICATION }),
        }),
      );
    if (failure === "missing" || failure === "symlink" || failure === "directory") {
      rmSync(path);
      if (failure === "directory") mkdirSync(path);
      if (failure === "symlink") {
        const outside = join(root, "outside.json");
        writeFileSync(outside, JSON.stringify(value));
        symlinkSync(outside, path);
      }
    }
    const result = evaluateUnchanged();
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ...(isChange ? { change_id: id } : { vc_id: id }),
          reason: expect.stringMatching(/read|schema|identity|foreign|task_mismatch/u) as unknown,
        }),
      ]),
    );
  });
});

test.each([{ reviewer_notes: [] }, { reviewed_by: "" }])(
  "invalid reviewer fields %j remain a file-read failure, not clause three",
  (invalid) => {
    seed(
      `verifications/${input.verification.vc_id}.json`,
      JSON.stringify({ ...input.verification, ...invalid }),
    );
    const result = evaluateUnchanged();
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          vc_id: input.verification.vc_id,
          reason: expect.stringMatching(/read|schema/u) as unknown,
        }),
      ]),
    );
    expect(result.failures).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ clause: 3 })]),
    );
  },
);

test.each(["missing", "digest", "symlink", "directory"] as const)(
  "%s approved patch is a clause-one failure without writes",
  (failure) => {
    const path = join(cwd, input.change.patch_path);
    if (failure === "digest") writeFileSync(path, "abd");
    else {
      rmSync(path);
      if (failure === "directory") mkdirSync(path);
      if (failure === "symlink") {
        const outside = join(root, "outside.patch");
        writeFileSync(outside, input.patch);
        symlinkSync(outside, path);
      }
    }
    const result = evaluateUnchanged();
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clause: 1, change_id: input.change.change_id }),
      ]),
    );
  },
);

test.each(["changes", "patches", "verifications"] as const)(
  "a missing %s root is never created by closure",
  (directory) => {
    rmSync(join(cwd, directory), { recursive: true });
    expect(evaluateUnchanged().ok).toBe(false);
    expect(readdirSync(cwd)).not.toContain(directory);
  },
);

test.each(["changes", "patches", "verifications"] as const)(
  "a symlinked %s root is rejected without following or changing outside evidence",
  (directory) => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "sentinel"), PRIVATE_PAYLOAD);
    rmSync(join(cwd, directory), { recursive: true });
    symlinkSync(outside, join(cwd, directory));
    expect(evaluateUnchanged().ok).toBe(false);
  },
);

test("unlinked qualifying verification files are not discovered", () => {
  input.card.linked_verifications = [];
  const result = evaluateUnchanged();
  expect(result.ok).toBe(false);
  expect(result.failures).toEqual(expect.arrayContaining([expect.objectContaining({ clause: 2 })]));
});

test("a qualifying first pair cannot hide a malformed linked sibling on disk", () => {
  input.card.linked_verifications.push(OTHER_VERIFICATION);
  seed(`verifications/${OTHER_VERIFICATION}.json`, `{"private":"${PRIVATE_PAYLOAD}", broken`);
  const result = evaluateUnchanged();
  expect(result.ok).toBe(false);
  expect(result.failures).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        vc_id: OTHER_VERIFICATION,
        reason: expect.stringMatching(/read|schema/u) as unknown,
      }),
    ]),
  );
});
