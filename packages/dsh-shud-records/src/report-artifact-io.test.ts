import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { validateReport } from "./index.ts";
import { installUnsafe } from "./test-harness.ts";
import { snapshotTree, type CodeChangeWorkspace } from "./report-code-change-test-harness.ts";
import { realFs, SECRET } from "./report-validation-test-harness.ts";
import { makeCodeChangeValidationWorkspace } from "./report-validation/test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    fstatSync: vi.fn(actual.fstatSync),
    lstatSync: vi.fn(actual.lstatSync),
    readSync: vi.fn(actual.readSync),
    closeSync: vi.fn(actual.closeSync),
  };
});
let workspace: CodeChangeWorkspace;
beforeEach(() => {
  vi.mocked(fs.openSync).mockReset().mockImplementation(realFs.openSync);
  vi.mocked(fs.fstatSync).mockReset().mockImplementation(realFs.fstatSync);
  vi.mocked(fs.lstatSync).mockReset().mockImplementation(realFs.lstatSync);
  vi.mocked(fs.readSync).mockReset().mockImplementation(realFs.readSync);
  vi.mocked(fs.closeSync).mockReset().mockImplementation(realFs.closeSync);
  workspace = makeCodeChangeValidationWorkspace();
});
afterEach(() => realFs.rmSync(workspace.root, { recursive: true, force: true }));

for (const index of [0, 1] as const) {
  test.each([
    "open",
    "fstat",
    "identity",
    "read",
    "close",
    "read-and-close",
    "ancestor-identity",
    "target-identity",
    "post-read-identity",
  ] as const)(
    `artifact ${index} %s failure closes its owned descriptor once and returns controlled item 15`,
    (fault) => {
      const record = workspace.verifications[1];
      const path = join(realFs.realpathSync.native(workspace.cwd), record.artifact_refs[index]);
      let owned: number | undefined;
      let closes = 0;
      let opened = false;
      let readCompleted = false;
      vi.mocked(fs.openSync).mockImplementation((...args) => {
        if (String(args[0]) === path) {
          expect(args[1]).toBe(
            fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
          );
          if (fault === "open") throw new Error(`PRIVATE_NATIVE_CAUSE ${SECRET}`);
          owned = realFs.openSync(...args);
          opened = true;
          return owned;
        }
        return realFs.openSync(...args);
      });
      vi.mocked(fs.fstatSync).mockImplementation((...args) => {
        const stat = realFs.fstatSync(...args);
        if (opened && args[0] === owned && fault === "fstat")
          throw new Error(`PRIVATE_NATIVE_CAUSE ${SECRET}`);
        if (opened && args[0] === owned && fault === "identity")
          return Object.assign(stat, { ino: Number(stat.ino) + 1 });
        return stat;
      });
      vi.mocked(fs.lstatSync).mockImplementation((...args) => {
        const stat = realFs.lstatSync(...args);
        if (
          stat &&
          opened &&
          ((fault === "ancestor-identity" && String(args[0]) === dirname(path)) ||
            (fault === "target-identity" && String(args[0]) === path) ||
            (fault === "post-read-identity" && readCompleted && String(args[0]) === path))
        ) {
          return Object.assign(stat, { ino: Number(stat.ino) + 1 });
        }
        return stat;
      });
      vi.mocked(fs.readSync).mockImplementation((...args) => {
        if (opened && args[0] === owned && (fault === "read" || fault === "read-and-close"))
          throw new Error(`PRIVATE_NATIVE_CAUSE ${SECRET}`);
        const count = realFs.readSync(...args);
        if (opened && args[0] === owned) readCompleted = true;
        return count;
      });
      vi.mocked(fs.closeSync).mockImplementation((fd) => {
        if (opened && fd === owned) {
          opened = false;
          closes++;
          realFs.closeSync(fd);
          if (fault === "close" || fault === "read-and-close")
            throw new Error(`PRIVATE_NATIVE_CAUSE ${SECRET}`);
          return;
        }
        realFs.closeSync(fd);
      });
      const before = snapshotTree(workspace.root);
      const result = validateReport(workspace.cwd, workspace.report.report_id);
      expect(result.checks).toHaveLength(15);
      expect(result.checks[14]).toMatchObject({
        pass: false,
        vacuous: false,
        details: [
          {
            code: "verification_artifact_invalid",
            vc_id: record.vc_id,
            artifact_index: index,
            path: record.artifact_refs[index],
            stage:
              fault === "read-and-close" ? "read" : fault.endsWith("identity") ? "identity" : fault,
          },
        ],
      });
      if (fault === "read-and-close")
        expect(result.checks[14].details[0]).toMatchObject({ cleanup_failed: true });
      expect(closes).toBe(fault === "open" ? 0 : 1);
      if (owned !== undefined) expect(() => realFs.fstatSync(owned)).toThrow();
      expect(snapshotTree(workspace.root)).toEqual(before);
      expect(JSON.stringify(result)).not.toContain("PRIVATE_NATIVE_CAUSE");
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(JSON.stringify(result)).not.toContain(workspace.cwd);
    },
  );
}

test.each(["symlink", "fifo"] as const)(
  "replacement by %s between inspection and open never follows or blocks",
  (kind) => {
    const record = workspace.verifications[1];
    const path = join(realFs.realpathSync.native(workspace.cwd), record.artifact_refs[1]);
    const outside = join(workspace.root, "replaced-artifact");
    let replacement: unknown;
    let owned: number | undefined;
    let closes = 0;
    vi.mocked(fs.openSync).mockImplementation((...args) => {
      if (String(args[0]) === path) {
        realFs.renameSync(path, outside);
        installUnsafe(path, kind, outside);
        replacement = snapshotTree(workspace.root);
        owned = realFs.openSync(...args);
        return owned;
      }
      return realFs.openSync(...args);
    });
    vi.mocked(fs.closeSync).mockImplementation((fd) => {
      if (fd === owned) closes++;
      realFs.closeSync(fd);
    });
    const result = validateReport(workspace.cwd, workspace.report.report_id);
    expect(result.checks[14]).toMatchObject({
      pass: false,
      details: [
        { vc_id: record.vc_id, artifact_index: 1, stage: kind === "symlink" ? "open" : "identity" },
      ],
    });
    expect(replacement).toBeDefined();
    expect(snapshotTree(workspace.root)).toEqual(replacement);
    expect(closes).toBe(kind === "symlink" ? 0 : 1);
  },
);

test("persistent close failure is reported once without claiming descriptor release", () => {
  const record = workspace.verifications[1];
  const path = join(realFs.realpathSync.native(workspace.cwd), record.artifact_refs[1]);
  let owned: number | undefined;
  let attempts = 0;
  vi.mocked(fs.openSync).mockImplementation((...args) => {
    const fd = realFs.openSync(...args);
    if (String(args[0]) === path) owned = fd;
    return fd;
  });
  vi.mocked(fs.closeSync).mockImplementation((fd) => {
    if (fd === owned) {
      attempts++;
      throw new Error("PRIVATE_CLOSE_FAILURE");
    }
    realFs.closeSync(fd);
  });
  try {
    const before = snapshotTree(workspace.root);
    const result = validateReport(workspace.cwd, workspace.report.report_id);
    expect(result.checks[14]).toMatchObject({
      pass: false,
      details: [{ vc_id: record.vc_id, artifact_index: 1, stage: "close" }],
    });
    expect(attempts).toBe(1);
    expect(owned).toBeDefined();
    if (owned !== undefined) expect(realFs.fstatSync(owned).isFile()).toBe(true);
    expect(snapshotTree(workspace.root)).toEqual(before);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_CLOSE_FAILURE");
  } finally {
    // Test-owned recovery is not a production retry after an indeterminate close.
    if (owned !== undefined) realFs.closeSync(owned);
  }
});
