import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { makeEvidenceReport } from "../../dsh-shud-records/src/report-render-test-harness.ts";
import { decideRawAccess, normalizeRawDirs } from "./decide.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});
const native = await vi.importActual<typeof fs>("node:fs");

let cwd: string;
const report = makeEvidenceReport();
beforeEach(() => {
  cwd = native.mkdtempSync(join(tmpdir(), "raw-report-target-"));
  vi.mocked(fs.lstatSync).mockReset().mockImplementation(native.lstatSync);
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(native.readFileSync);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(cwd, { recursive: true, force: true });
});
function decide(name: string, args: unknown, rawDirs: string[]) {
  return decideRawAccess({ name, arguments: args, cwd }, normalizeRawDirs({ rawDirs }));
}
function publish() {
  fs.mkdirSync(join(cwd, "reports"));
  fs.writeFileSync(join(cwd, "reports", `${report.report_id}.json`), JSON.stringify(report));
}

test.each([
  "reports",
  "reports/protected-subtree",
  "reports/orphan.md",
  "tasks",
  `tasks/${report.task_id}/task.json`,
  ".",
])("generation prospective namespace or exact task overlaps %s", (raw) => {
  expect(decide("report_generate", { task_id: report.task_id }, [raw])).toMatchObject({
    kind: "deny",
    code: "raw-immutable",
  });
  expect(fs.readdirSync(cwd)).toEqual([]);
});

test.each([
  "reports",
  `reports/${report.report_id}.json`,
  `reports/${report.report_id}.md`,
  "tasks",
  `tasks/${report.task_id}/task.json`,
])("validation resolves and protects exact %s without creating task directories", (raw) => {
  publish();
  expect(decide("report_validate", { report_id: report.report_id }, [raw])).toMatchObject({
    kind: "deny",
    code: "raw-immutable",
  });
  expect(fs.readdirSync(cwd)).toEqual(["reports"]);
});

test.each([
  "reports-sibling",
  "reports/REPORT-20261027T080005-ffff.json",
  "tasks/TASK-20261027T080005-ffff/task.json",
])("validation leaves unrelated %s usable", (raw) => {
  publish();
  expect(decide("report_validate", { report_id: report.report_id }, [raw])).toEqual({
    kind: "next",
    code: "unrelated",
  });
  expect(fs.readdirSync(cwd)).toEqual(["reports"]);
});

test.each(["missing", "corrupt", "foreign", "symlink"])(
  "unresolvable %s report target fails closed without mkdir",
  (fault) => {
    if (fault !== "missing") {
      publish();
      const path = join(cwd, "reports", `${report.report_id}.json`);
      if (fault === "corrupt") fs.writeFileSync(path, "PRIVATE_RAW_REPORT");
      if (fault === "foreign")
        fs.writeFileSync(
          path,
          JSON.stringify({ ...report, report_id: "REPORT-20261027T080005-ffff" }),
        );
      if (fault === "symlink") {
        fs.renameSync(path, join(cwd, "outside.json"));
        fs.symlinkSync(join(cwd, "outside.json"), path);
      }
    }
    expect(decide("report_validate", { report_id: report.report_id }, ["unrelated"])).toMatchObject(
      { kind: "deny" },
    );
    expect(fs.existsSync(join(cwd, "tasks"))).toBe(false);
  },
);

test.each(["report_generate", "report_validate"])(
  "malformed id never becomes a %s filesystem target",
  (name) => {
    const resolve = vi.spyOn(fs.realpathSync, "native");
    const stat = vi.mocked(fs.lstatSync);
    const read = vi.mocked(fs.readFileSync);
    const id = "../untrusted-path-probe/../../escape";
    const decision = decide(
      name,
      name === "report_generate" ? { task_id: id } : { report_id: id },
      ["unrelated"],
    );
    expect(decision.kind).not.toBe("ask");
    for (const calls of [resolve.mock.calls, stat.mock.calls, read.mock.calls]) {
      expect(calls.some(([path]) => /untrusted-path-probe|escape/u.test(String(path)))).toBe(false);
    }
    expect(fs.readdirSync(cwd)).toEqual([]);
  },
);
