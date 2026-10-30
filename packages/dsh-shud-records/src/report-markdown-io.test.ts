import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ReportIdSchema } from "@shud-harness/dsh-shud-core";
import { readReportMarkdown, writeReportMarkdown } from "./index.ts";
import { installUnsafe } from "./test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof io>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const native = await vi.importActual<typeof fs>("node:fs");
const nativeIo = await vi.importActual<typeof io>("node:fs/promises");
const id = ReportIdSchema.parse("REPORT-20261027T080005-3f9c");
let cwd: string;
beforeEach(() => {
  cwd = native.mkdtempSync(join(tmpdir(), "report-markdown-io-"));
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(native.readFileSync);
  vi.mocked(io.rename).mockReset().mockImplementation(nativeIo.rename);
});
afterEach(() => {
  native.rmSync(cwd, { recursive: true, force: true });
});
function target() {
  return join(cwd, "reports", `${id}.md`);
}

test("absent Markdown returns undefined without creating reports; writer atomically publishes exact bytes", async () => {
  expect(readReportMarkdown(cwd, id)).toBeUndefined();
  expect(native.readdirSync(cwd)).toEqual([]);
  await writeReportMarkdown(cwd, id, "# report\nDRAFT — not accepted by PI\n");
  expect(readReportMarkdown(cwd, id)).toBe("# report\nDRAFT — not accepted by PI\n");
  expect(native.readdirSync(join(cwd, "reports"))).toEqual([`${id}.md`]);
  expect(io.rename).toHaveBeenCalledTimes(1);
});

test.each(["symlink", "dangling-link", "fifo", "directory"] as const)(
  "reader and writer reject %s target without changing external bytes",
  async (kind) => {
    native.mkdirSync(join(cwd, "reports"));
    const outside = join(cwd, "outside");
    native.writeFileSync(outside, "immutable external");
    installUnsafe(target(), kind, outside);
    expect(() => readReportMarkdown(cwd, id)).toThrow();
    await expect(writeReportMarkdown(cwd, id, "replacement")).rejects.toThrow();
    expect(native.readFileSync(outside, "utf8")).toBe("immutable external");
    expect(io.rename).not.toHaveBeenCalled();
    expect(native.readdirSync(join(cwd, "reports"))).toEqual([`${id}.md`]);
  },
);

test.each(["symlink", "file", "fifo"] as const)(
  "reader and writer reject %s reports ancestor",
  async (kind) => {
    const outside = join(cwd, "outside");
    native.mkdirSync(outside);
    installUnsafe(join(cwd, "reports"), kind, outside);
    expect(() => readReportMarkdown(cwd, id)).toThrow();
    await expect(writeReportMarkdown(cwd, id, "replacement")).rejects.toThrow();
    expect(native.readdirSync(outside)).toEqual([]);
    expect(io.rename).not.toHaveBeenCalled();
  },
);

test("unreadable Markdown is not absent and diagnostics discard raw error causes", async () => {
  await writeReportMarkdown(cwd, id, "original");
  vi.mocked(fs.readFileSync).mockImplementation((...args) => {
    if (args[0] === target())
      throw Object.assign(new Error("PRIVATE_MARKDOWN_READ"), { code: "EACCES" });
    return native.readFileSync(...args);
  });
  let failure: unknown;
  try {
    readReportMarkdown(cwd, id);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).not.toContain("PRIVATE_MARKDOWN_READ");
  expect(native.readFileSync(target(), "utf8")).toBe("original");
});

test("atomic rename failure preserves old Markdown bytes and mtime and removes temporary file", async () => {
  await writeReportMarkdown(cwd, id, "original");
  const before = native.statSync(target(), { bigint: true });
  vi.mocked(io.rename).mockImplementation(() =>
    Promise.reject(Object.assign(new Error("PRIVATE_MARKDOWN_WRITE"), { code: "EIO" })),
  );
  await expect(writeReportMarkdown(cwd, id, "replacement")).rejects.toThrow();
  expect(native.readFileSync(target(), "utf8")).toBe("original");
  expect(native.statSync(target(), { bigint: true }).mtimeNs).toBe(before.mtimeNs);
  expect(native.readdirSync(join(cwd, "reports"))).toEqual([`${id}.md`]);
});
