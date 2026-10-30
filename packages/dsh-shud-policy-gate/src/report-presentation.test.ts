import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import type * as NodeFs from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { INVALID_REPORT_ID_MARKER, REPORT_APPROVAL_REASON_PREFIX } from "./index.ts";
import {
  createPolicyHarness,
  expectAsk,
  OTHER_REPORT_ID,
  REPORT_ID,
  reportFixture,
  snapshotFile,
  SUMMARY_FIRST_LINE,
  SUMMARY_SECOND_LINE,
  writeReport,
} from "./test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
afterEach(() => vi.restoreAllMocks());

test.each(["report_submit", "report_decide"])(
  "%s displays JSON evidence without reading Markdown, logs, or artifacts",
  async (tool) => {
    const h = await createPolicyHarness();
    try {
      const reportPath = await writeReport(h.cwd);
      const markdownPath = join(h.cwd, "reports", `${REPORT_ID}.md`);
      await io.writeFile(markdownPath, "private-markdown-not-evidence");
      await io.writeFile(join(h.cwd, "stdout.log"), "private-log-not-evidence");
      await io.writeFile(join(h.cwd, "artifact.dat"), "private-artifact-not-evidence");
      const beforeReport = await snapshotFile(reportPath);
      const beforeMarkdown = await snapshotFile(markdownPath);
      const input = Object.freeze({
        report_id: REPORT_ID,
        disposition: "revision_requested",
        comment: "PI original comment",
      });
      vi.mocked(fs.readFileSync).mockClear();
      const ask = expectAsk(await h.decide(tool, input));
      expect(ask.reason).toBe(`${REPORT_APPROVAL_REASON_PREFIX} ${REPORT_ID}`);
      for (const display of [ask.en, ask.zh]) {
        expect(display).toContain(REPORT_ID);
        expect(display).toContain(`reports/${REPORT_ID}.md`);
        expect(display).toContain(SUMMARY_FIRST_LINE);
        expect(display).not.toContain(SUMMARY_SECOND_LINE);
        expect(display).not.toContain("\r");
        expect(display).not.toContain("private-markdown-not-evidence");
        expect(display).not.toContain("private-log-not-evidence");
        expect(display).not.toContain("private-artifact-not-evidence");
      }
      expect(vi.mocked(fs.readFileSync).mock.calls.map(([path]) => path)).toEqual([reportPath]);
      expect(await snapshotFile(reportPath)).toEqual(beforeReport);
      expect(await snapshotFile(markdownPath)).toEqual(beforeMarkdown);
      expect(input).toEqual({
        report_id: REPORT_ID,
        disposition: "revision_requested",
        comment: "PI original comment",
      });
      expect(h.next).not.toHaveBeenCalled();
      expect(h.request).not.toHaveBeenCalled();
    } finally {
      await h.dispose();
    }
  },
);

test.each([
  { summary: "  first line  \nsecond", first: "  first line  " },
  { summary: "first\r\nsecond", first: "first" },
  { summary: "first\rlone\nsecond", first: "first\rlone" },
  { summary: "single line without newline", first: "single line without newline" },
  { summary: "single line ending in CR\r", first: "single line ending in CR\r" },
  { summary: "first\r\r\nsecond", first: "first\r" },
  { summary: `${"x".repeat(20_000)} END\nsecond`, first: `${"x".repeat(20_000)} END` },
])(
  "summary uses the first LF boundary without trimming or capping, case %#",
  async ({ summary, first }) => {
    const h = await createPolicyHarness();
    try {
      await writeReport(h.cwd, reportFixture({ summary }));
      const ask = expectAsk(await h.decide("report_submit", { report_id: REPORT_ID }));
      expect(ask.en).toContain(first);
      expect(ask.zh).toContain(first);
      expect(ask.en).not.toContain("first\r\r");
      expect(ask.zh).not.toContain("first\r\r");
      expect(ask.en).not.toContain("second");
      expect(ask.zh).not.toContain("second");
    } finally {
      await h.dispose();
    }
  },
);

test("report_decide displays the full multiline PI comment independently of report readability", async () => {
  const h = await createPolicyHarness();
  try {
    const comment = `  PI original first line\r\n${"preserve this text; ".repeat(2000)}\nLAST LINE  `;
    const ask = expectAsk(
      await h.decide("report_decide", {
        report_id: REPORT_ID,
        disposition: "revision_requested",
        comment,
      }),
    );
    for (const display of [ask.en, ask.zh]) {
      expect(display).toContain("revision_requested");
      expect(display).toContain(comment);
    }
    expect(ask.zh).toContain("无法读取");
    expect(ask.reason).toBe(`${REPORT_APPROVAL_REASON_PREFIX} ${REPORT_ID}`);
    expect(ask.reason).not.toContain(comment);
  } finally {
    await h.dispose();
  }
});

test.each([
  undefined,
  null,
  [],
  7,
  "odd",
  {},
  { report_id: "../tasks/x" },
  { report_id: 7 },
  { report_id: "" },
])(
  "malformed report arguments %j still ask with a safe marker before file reads",
  async (input) => {
    const h = await createPolicyHarness();
    try {
      vi.mocked(fs.readFileSync).mockClear();
      const ask = expectAsk(await h.decide("report_submit", input));
      expect(ask.reason).toBe(`${REPORT_APPROVAL_REASON_PREFIX} ${INVALID_REPORT_ID_MARKER}`);
      expect(ask.reason).not.toContain("../tasks/x");
      expect(ask.zh).toContain("无法读取");
      expect(ask.en).toMatch(/unavailable|cannot read|unable to read/iu);
      expect(fs.readFileSync).not.toHaveBeenCalled();
      expect(await io.readdir(h.cwd)).toEqual([]);
      expect(h.next).not.toHaveBeenCalled();
    } finally {
      await h.dispose();
    }
  },
);

test.each([undefined, null, 7, false, [], { private: "do-not-stringify" }])(
  "missing or non-string decision fields %j use unavailable text",
  async (value) => {
    const h = await createPolicyHarness();
    try {
      await writeReport(h.cwd);
      const ask = expectAsk(
        await h.decide("report_decide", {
          report_id: REPORT_ID,
          disposition: value,
          comment: value,
        }),
      );
      expect(ask.en).toContain(SUMMARY_FIRST_LINE);
      expect(ask.en).toMatch(/unavailable|cannot read|unable to read/iu);
      for (const display of [ask.en, ask.zh]) {
        expect(display).not.toContain("[object Object]");
        expect(display).not.toContain("do-not-stringify");
      }
      expect(ask.zh).toContain("无法读取");
    } finally {
      await h.dispose();
    }
  },
);

test("untrusted field objects never invoke coercion hooks", async () => {
  const h = await createPolicyHarness();
  try {
    const coerce = vi.fn(() => {
      throw new Error("private-coercion-payload");
    });
    const value = { toString: coerce, toJSON: coerce, [Symbol.toPrimitive]: coerce };
    const ask = expectAsk(
      await h.decide("report_decide", { report_id: value, disposition: value, comment: value }),
    );
    expect(ask.reason).toBe(`${REPORT_APPROVAL_REASON_PREFIX} ${INVALID_REPORT_ID_MARKER}`);
    expect(coerce).not.toHaveBeenCalled();
  } finally {
    await h.dispose();
  }
});

test.each([
  "draft",
  "reviewed",
  "awaiting_pi",
  "accepted",
  "revision_requested",
  "rejected",
  "archived",
] as const)("report state %s does not replace host approval", async (status) => {
  const h = await createPolicyHarness();
  try {
    const path = await writeReport(h.cwd, reportFixture({ status }));
    const before = await snapshotFile(path);
    for (const tool of ["report_submit", "report_decide"]) {
      expectAsk(await h.decide(tool, { report_id: REPORT_ID }));
    }
    expect(await snapshotFile(path)).toEqual(before);
    expect(h.next).not.toHaveBeenCalled();
  } finally {
    await h.dispose();
  }
});

test.each(["missing", "corrupt", "schema-invalid", "identity-mismatch", "read-error"])(
  "%s report is unavailable without repair or disclosure",
  async (kind) => {
    const h = await createPolicyHarness();
    try {
      await io.mkdir(join(h.cwd, "reports"));
      const path = join(h.cwd, "reports", `${REPORT_ID}.json`);
      if (kind === "corrupt") await io.writeFile(path, "private-corrupt-json{");
      if (kind === "schema-invalid")
        await io.writeFile(
          path,
          JSON.stringify({ report_id: REPORT_ID, summary: "private-invalid-summary" }),
        );
      if (kind === "identity-mismatch")
        await io.writeFile(
          path,
          JSON.stringify({
            ...reportFixture(),
            report_id: OTHER_REPORT_ID,
            summary: "private-mismatched-summary",
          }),
        );
      if (kind === "read-error") await writeReport(h.cwd);
      const before = kind === "missing" ? null : await snapshotFile(path);
      if (kind === "read-error")
        vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
          throw new Error("private-read-error-secret");
        });
      const ask = expectAsk(await h.decide("report_submit", { report_id: REPORT_ID }));
      expect(ask.reason).toBe(`${REPORT_APPROVAL_REASON_PREFIX} ${REPORT_ID}`);
      expect(ask.zh).toContain("无法读取");
      if (kind === "read-error") {
        expect(fs.readFileSync).toHaveBeenLastCalledWith(path, "utf8");
      }
      for (const display of [ask.en, ask.zh]) {
        expect(display).not.toContain("private-");
        expect(display).not.toContain(SUMMARY_FIRST_LINE);
        expect(display).not.toContain(h.cwd);
      }
      if (before) expect(await snapshotFile(path)).toEqual(before);
      else await expect(io.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await h.dispose();
    }
  },
);

test.each([
  "directory-symlink",
  "directory-file",
  "directory-fifo",
  "file-symlink",
  "file-directory",
  "file-fifo",
])("unsafe report path %s stays unchanged and displays unavailable", async (kind) => {
  const h = await createPolicyHarness();
  try {
    const outside = join(h.root, "outside");
    const foreignReport = await writeReport(
      outside,
      reportFixture({ summary: "private-foreign-summary" }),
    );
    const foreignBefore = await snapshotFile(foreignReport);
    const reports = join(h.cwd, "reports");
    const target = join(reports, `${REPORT_ID}.json`);
    if (kind.startsWith("file-")) await io.mkdir(reports);
    const unsafe = kind.startsWith("directory-") ? reports : target;
    if (kind.endsWith("symlink"))
      await io.symlink(
        kind.startsWith("directory-") ? join(outside, "reports") : foreignReport,
        unsafe,
      );
    if (kind === "directory-file") await io.writeFile(unsafe, "foreign-directory-blocker");
    if (kind === "file-directory") await io.mkdir(unsafe);
    if (kind.endsWith("fifo")) execFileSync("mkfifo", [unsafe]);
    const before = await io.lstat(unsafe, { bigint: true });
    vi.mocked(fs.readFileSync).mockClear();
    const ask = expectAsk(await h.decide("report_submit", { report_id: REPORT_ID }));
    expect(ask.zh).toContain("无法读取");
    expect(ask.en).not.toContain("private-foreign-summary");
    expect(ask.zh).not.toContain("private-foreign-summary");
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(await snapshotFile(foreignReport)).toEqual(foreignBefore);
    expect((await io.lstat(unsafe, { bigint: true })).ino).toBe(before.ino);
    if (kind.endsWith("symlink"))
      expect(await io.readlink(unsafe)).toBe(
        kind.startsWith("directory-") ? join(outside, "reports") : foreignReport,
      );
    if (kind === "directory-file")
      expect(await io.readFile(unsafe, "utf8")).toBe("foreign-directory-blocker");
  } finally {
    await h.dispose();
  }
});

test("canonical read creates a missing managed reports directory but no report object", async () => {
  const h = await createPolicyHarness();
  try {
    expect(await io.readdir(h.cwd)).toEqual([]);
    expectAsk(await h.decide("report_submit", { report_id: REPORT_ID }));
    expect(await io.readdir(h.cwd)).toEqual(["reports"]);
    expect(await io.readdir(join(h.cwd, "reports"))).toEqual([]);
  } finally {
    await h.dispose();
  }
});

test.each([undefined, ""])(
  "missing session cwd %j never falls back to process cwd",
  async (cwd) => {
    const h = await createPolicyHarness();
    try {
      const path = await writeReport(h.cwd);
      const before = await snapshotFile(path);
      h.session.header.cwd = cwd;
      const processCwd = vi.spyOn(process, "cwd").mockReturnValue(h.cwd);
      vi.mocked(fs.readFileSync).mockClear();
      const ask = expectAsk(
        await h.decide("report_submit", { report_id: REPORT_ID, workdir: h.cwd }),
      );
      processCwd.mockRestore();
      expect(ask.zh).toContain("无法读取");
      expect(ask.en).not.toContain(SUMMARY_FIRST_LINE);
      expect(fs.readFileSync).not.toHaveBeenCalled();
      expect(await snapshotFile(path)).toEqual(before);
    } finally {
      await h.dispose();
    }
  },
);

test("argument workdir cannot redirect report presentation away from the calling workspace", async () => {
  const h = await createPolicyHarness();
  try {
    await writeReport(h.cwd);
    const other = join(h.root, "other-workspace");
    const foreign = await writeReport(other, reportFixture({ summary: "private-other-workspace" }));
    const before = await snapshotFile(foreign);
    const ask = expectAsk(
      await h.decide("report_submit", { report_id: REPORT_ID, workdir: other }),
    );
    expect(ask.en).toContain(SUMMARY_FIRST_LINE);
    expect(ask.zh).toContain(SUMMARY_FIRST_LINE);
    expect(ask.en).not.toContain("private-other-workspace");
    expect(ask.zh).not.toContain("private-other-workspace");
    expect(await snapshotFile(foreign)).toEqual(before);
  } finally {
    await h.dispose();
  }
});
