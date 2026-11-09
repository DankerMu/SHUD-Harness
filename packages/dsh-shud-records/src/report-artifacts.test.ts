import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { validateReport } from "./index.ts";
import { installUnsafe } from "./test-harness.ts";
import { snapshotTree, type CodeChangeWorkspace } from "./report-code-change-test-harness.ts";
import { CODE_CHANGE_CHECK_SHAPE, SECRET, realFs } from "./report-validation-test-harness.ts";
import {
  ABC_SHA256,
  EMPTY_SHA256,
  makeCodeChangeValidationWorkspace,
} from "./report-validation/test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    readFileSync: vi.fn(actual.readFileSync),
    readSync: vi.fn(actual.readSync),
  };
});
let workspace: CodeChangeWorkspace;
beforeEach(() => {
  vi.mocked(fs.openSync).mockReset().mockImplementation(realFs.openSync);
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(realFs.readFileSync);
  vi.mocked(fs.readSync).mockReset().mockImplementation(realFs.readSync);
  workspace = makeCodeChangeValidationWorkspace();
});
afterEach(() => realFs.rmSync(workspace.root, { recursive: true, force: true }));

function validate(cwd = workspace.cwd) {
  const before = snapshotTree(workspace.root);
  const result = validateReport(cwd, workspace.report.report_id);
  expect(result.checks).toHaveLength(17);
  expect(result.checks.map(({ id }) => id)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
  ]);
  const after = snapshotTree(workspace.root);
  expect(after.length).toBe(before.length);
  for (let index = 0; index < before.length; index++) {
    const { bytes: beforeBytes, ...beforeMetadata } = before[index];
    const { bytes: afterBytes, ...afterMetadata } = after[index];
    // Retain ordered namespace and all metadata; compare file bytes without generic deep traversal.
    expect(afterMetadata).toEqual(beforeMetadata);
    if (beforeBytes === null) expect(afterBytes).toBeNull();
    else expect(afterBytes?.equals(beforeBytes)).toBe(true);
  }
  const diagnostic = JSON.stringify(result);
  expect(diagnostic).not.toContain(SECRET);
  expect(diagnostic).not.toContain(workspace.cwd);
  expect(diagnostic).not.toContain("PRIVATE_ARTIFACT_FAILURE");
  return result;
}

for (const index of [0, 1] as const) {
  test.each([
    "missing",
    "changed",
    "unreadable",
    "directory",
    "fifo",
    "symlink",
    "dangling-link",
  ] as const)(`artifact ${index} rejects %s without mutating any evidence`, (fault) => {
    const record = workspace.verifications[1];
    const relative = record.artifact_refs[index];
    const path = join(realFs.realpathSync.native(workspace.cwd), relative);
    if (fault === "missing") realFs.unlinkSync(path);
    else if (fault === "changed") realFs.writeFileSync(path, "abd");
    else if (fault === "unreadable")
      vi.mocked(fs.openSync).mockImplementation((...args) => {
        if (String(args[0]) === path)
          throw Object.assign(new Error("PRIVATE_ARTIFACT_FAILURE"), { code: "EACCES" });
        return realFs.openSync(...args);
      });
    else {
      const outside = join(workspace.root, "outside-artifact");
      realFs.renameSync(path, outside);
      installUnsafe(path, fault, outside);
    }
    const result = validate();
    expect(result.checks.filter(({ pass }) => !pass).map(({ id }) => id)).toEqual([15]);
    expect(result.checks[14]).toMatchObject({
      pass: false,
      vacuous: false,
      details: [
        {
          code: "verification_artifact_invalid",
          vc_id: record.vc_id,
          artifact_index: index,
          path: relative,
        },
      ],
    });
    if (["missing", "directory", "fifo", "symlink", "dangling-link"].includes(fault)) {
      expect(vi.mocked(fs.openSync).mock.calls.some(([target]) => String(target) === path)).toBe(
        false,
      );
    }
  });
}

for (const depth of [0, 1] as const) {
  test.each(["missing", "file", "fifo", "symlink", "dangling-link"] as const)(
    `artifact ancestor ${depth} rejects %s`,
    (fault) => {
      const record = workspace.verifications[1];
      const relative = record.artifact_refs[1];
      const target = join(workspace.cwd, ...relative.split("/").slice(0, depth + 1));
      const outside = join(workspace.root, "outside-directory");
      realFs.renameSync(target, outside);
      if (fault !== "missing") installUnsafe(target, fault, outside);
      const result = validate();
      expect(result.checks[14].pass).toBe(false);
      expect(result.checks[14].details).toContainEqual(
        expect.objectContaining({
          vc_id: record.vc_id,
          artifact_index: 1,
          path: relative,
          stage: "directory",
        }),
      );
    },
  );
}

test("all referenced VCs and both ordered artifacts retain separate failures", () => {
  for (const record of workspace.verifications) {
    for (const relative of record.artifact_refs)
      realFs.writeFileSync(join(workspace.cwd, relative), "changed");
  }
  const result = validate();
  expect(result.checks[14].details).toEqual(
    workspace.verifications.flatMap((record) =>
      [0, 1].map((index) => ({
        code: "verification_artifact_invalid",
        vc_id: record.vc_id,
        artifact_index: index,
        path: record.artifact_refs[index],
        stage: "hash",
      })),
    ),
  );
});

test.each([
  { name: "empty", bytes: Buffer.alloc(0), sha: EMPTY_SHA256 },
  {
    name: "binary",
    bytes: Buffer.from(Array.from({ length: 256 }, (_, index) => index)),
    sha: "40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880",
  },
  {
    name: "million-a",
    bytes: Buffer.alloc(1_000_000, "a"),
    sha: "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
  },
])(
  "ordinary $name artifacts match independent SHA-256 vectors with bounded reads",
  ({ bytes, sha }) => {
    const record = workspace.verifications[1];
    record.observed.base_sha256 = sha;
    record.observed.candidate_sha256 = sha;
    for (const relative of record.artifact_refs)
      realFs.writeFileSync(join(workspace.cwd, relative), bytes);
    workspace.republish();
    const result = validate();
    expect(result.ok).toBe(true);
    expect(result.checks.map(({ id, vacuous }) => ({ id, vacuous }))).toEqual(
      CODE_CHANGE_CHECK_SHAPE,
    );
    const buffers = vi.mocked(fs.readSync).mock.calls.map((args) => args[1]);
    expect(buffers.length).toBeGreaterThan(0);
    for (const buffer of buffers)
      expect((buffer as Uint8Array).byteLength).toBeLessThanOrEqual(64 * 1024);
  },
);

test.each(["dot", "repeated-separator", "backslash"] as const)(
  "schema-valid %s artifact path retains POSIX meaning",
  (kind) => {
    const record = workspace.verifications[1];
    if (kind === "dot") record.artifact_refs[1] = `./evidence/${record.vc_id}/./candidate.bin`;
    else if (kind === "repeated-separator")
      record.artifact_refs[1] = `evidence//${record.vc_id}//candidate.bin`;
    else {
      record.artifact_refs[1] = "evidence\\literal.bin";
      realFs.writeFileSync(join(workspace.cwd, record.artifact_refs[1]), "abc");
    }
    workspace.republish();
    expect(validate().checks[14]).toEqual({ id: 15, pass: true, vacuous: false, details: [] });
  },
);

test.each(["/", "/.", "/./", "//"])(
  "ordinary-file artifact with directory suffix %s is not normalized into acceptance",
  (suffix) => {
    const record = workspace.verifications[1];
    record.artifact_refs[1] += suffix;
    workspace.republish();
    expect(validate().checks[14]).toMatchObject({
      pass: false,
      details: [
        {
          vc_id: record.vc_id,
          artifact_index: 1,
          path: record.artifact_refs[1],
          stage: "directory",
        },
      ],
    });
  },
);

test.each(["alias", "physical-parent"] as const)(
  "trusted cwd %s aliases are allowed without relaxing artifact ancestors",
  (kind) => {
    const alias = join(workspace.root, "cwd-alias");
    const child = join(workspace.cwd, "child");
    realFs.mkdirSync(child);
    realFs.symlinkSync(kind === "alias" ? workspace.cwd : child, alias);
    const cwd = kind === "alias" ? alias : `${alias}/..`;
    expect(validate(cwd).ok).toBe(true);
  },
);

test("artifact diagnostics redact all secret matches but retain VC, index and normal relative text", () => {
  const record = workspace.verifications[1];
  record.artifact_refs[1] = `evidence/${SECRET}/again-${SECRET}/output.dat`;
  const path = join(workspace.cwd, record.artifact_refs[1]);
  realFs.mkdirSync(dirname(path), { recursive: true });
  realFs.writeFileSync(path, "abd");
  workspace.republish();
  const result = validate();
  expect(result.checks[14].details).toEqual([
    {
      code: "verification_artifact_invalid",
      vc_id: record.vc_id,
      artifact_index: 1,
      path: "evidence/[REDACTED]/again-[REDACTED]/output.dat",
      stage: "hash",
    },
  ]);
  expect(
    result.checks[12].details.every(
      (detail) => detail.code === "secret_detected" && "section" in detail,
    ),
  ).toBe(true);
});

test.each(["stack", "data", "run", "change", "build", "verification", "template"] as const)(
  "unavailable %s does not suppress another VC's artifact check or any result row",
  (kind) => {
    const record = workspace.verifications[1];
    realFs.writeFileSync(join(workspace.cwd, record.artifact_refs[1]), "abd");
    if (kind === "template")
      vi.mocked(fs.readFileSync).mockImplementation((...args) => {
        if (String(args[0]).endsWith("/templates/evidence_report.md"))
          throw new Error("PRIVATE_ARTIFACT_FAILURE");
        return realFs.readFileSync(...args);
      });
    else {
      const relative =
        kind === "stack"
          ? `stacks/${workspace.fixture.stacks[0].stack_id}.json`
          : kind === "data"
            ? `provenance/${workspace.fixture.data[0].data_id}.json`
            : kind === "run"
              ? `runs/${workspace.fixture.runs[0].run_id}/run-record.json`
              : kind === "change"
                ? `changes/${workspace.changes[0].change_id}.json`
                : kind === "verification"
                  ? `verifications/${workspace.verifications[0].vc_id}.json`
                  : `builds/${workspace.builds[0].build_id}/build-record.json`;
      realFs.unlinkSync(join(workspace.cwd, relative));
    }
    const result = validate();
    expect(result.checks[14].details).toContainEqual({
      code: "verification_artifact_invalid",
      vc_id: record.vc_id,
      artifact_index: 1,
      path: record.artifact_refs[1],
      stage: "hash",
    });
    expect(result.checks[13].pass).toBe(false);
    if (kind === "verification")
      expect(result.checks[14].details).toContainEqual(
        expect.objectContaining({
          code: "reference_unavailable",
          kind: "verification",
          id: workspace.verifications[0].vc_id,
        }),
      );
  },
);

test("successful fact reads are reused by artifact checks even if template rendering fails", () => {
  vi.mocked(fs.readFileSync).mockClear();
  vi.mocked(fs.readFileSync).mockImplementation((...args) => {
    if (String(args[0]).endsWith("/templates/evidence_report.md"))
      throw new Error("PRIVATE_ARTIFACT_FAILURE");
    return realFs.readFileSync(...args);
  });
  expect(validate().checks[14].pass).toBe(true);
  const physical = realFs.realpathSync.native(workspace.cwd);
  for (const record of workspace.verifications) {
    const path = join(physical, "verifications", `${record.vc_id}.json`);
    expect(
      vi.mocked(fs.readFileSync).mock.calls.filter(([target]) => String(target) === path),
    ).toHaveLength(1);
  }
});

test("nonempty verification references exercise artifacts even without change references", () => {
  workspace.report.change_ids = [];
  workspace.republish();
  realFs.writeFileSync(join(workspace.cwd, workspace.verifications[1].artifact_refs[1]), "abd");
  const result = validate();
  expect(result.checks[13]).toEqual({ id: 14, pass: true, vacuous: true, details: [] });
  expect(result.checks[14].pass).toBe(false);
});

test("ordered observed hashes are not interchangeable for failed verification", () => {
  const record = workspace.verifications[0];
  expect(record.observed).toMatchObject({
    base_sha256: ABC_SHA256,
    candidate_sha256: EMPTY_SHA256,
  });
  realFs.writeFileSync(join(workspace.cwd, record.artifact_refs[0]), "");
  realFs.writeFileSync(join(workspace.cwd, record.artifact_refs[1]), "abc");
  expect(validate().checks[14].details).toEqual(
    [0, 1].map((index) => ({
      code: "verification_artifact_invalid",
      vc_id: record.vc_id,
      artifact_index: index,
      path: record.artifact_refs[index],
      stage: "hash",
    })),
  );
});

test("redacted path collisions remain attributable by artifact index", () => {
  const record = workspace.verifications[1];
  const secondSecret = ["sk", "anotherabcdefgh12345678"].join("-");
  record.artifact_refs = [`evidence/${SECRET}/output.dat`, `evidence/${secondSecret}/output.dat`];
  for (const relative of record.artifact_refs) {
    const path = join(workspace.cwd, relative);
    realFs.mkdirSync(dirname(path), { recursive: true });
    realFs.writeFileSync(path, "abd");
  }
  workspace.republish();
  const result = validate();
  expect(result.checks[14].details).toEqual(
    [0, 1].map((index) => ({
      code: "verification_artifact_invalid",
      vc_id: record.vc_id,
      artifact_index: index,
      path: "evidence/[REDACTED]/output.dat",
      stage: "hash",
    })),
  );
  expect(JSON.stringify(result)).not.toContain(secondSecret);
});
