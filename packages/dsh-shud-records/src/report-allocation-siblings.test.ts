import * as fs from "node:fs";
import type * as Crypto from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createEvidenceReport } from "./index.ts";
import { makeEvidenceReport } from "./report-render-test-harness.ts";
import { installUnsafe } from "./test-harness.ts";

const entropy = vi.hoisted(() => ({ suffixes: [] as string[] }));
vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof Crypto>();
  return {
    ...actual,
    randomBytes(size: number, callback?: (error: Error | null, bytes: Buffer) => void) {
      if (callback) return actual.randomBytes(size, callback);
      const suffix = size === 2 ? entropy.suffixes.shift() : undefined;
      return suffix === undefined ? actual.randomBytes(size) : Buffer.from(suffix, "hex");
    },
  };
});
let cwd: string;
beforeEach(() => {
  cwd = fs.mkdtempSync(join(tmpdir(), "report-sibling-"));
  fs.mkdirSync(join(cwd, "reports"));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-27T08:00:05Z"));
  entropy.suffixes = ["3f9c", "abcd"];
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(cwd, { recursive: true, force: true });
});
function allocate() {
  const { report_id: ignored, ...fields } = makeEvidenceReport();
  expect(ignored).toMatch(/^REPORT-/u);
  return createEvidenceReport(cwd, fields);
}

test.each(["json", "md"])(
  "existing %s sibling forces a fresh report id and preserves old bytes and mtime",
  (extension) => {
    const path = join(cwd, "reports", `REPORT-20261027T080005-3f9c.${extension}`);
    fs.writeFileSync(path, "prior report evidence\n");
    const before = fs.statSync(path, { bigint: true });
    expect(allocate().report_id).toBe("REPORT-20261027T080005-abcd");
    expect(fs.readFileSync(path, "utf8")).toBe("prior report evidence\n");
    expect(fs.statSync(path, { bigint: true }).mtimeNs).toBe(before.mtimeNs);
    expect(fs.readdirSync(join(cwd, "reports")).sort()).toEqual([
      `REPORT-20261027T080005-3f9c.${extension}`,
      "REPORT-20261027T080005-abcd.json",
    ]);
  },
);

test.each(["symlink", "dangling-link", "fifo", "directory"] as const)(
  "unsafe %s Markdown sibling fails closed rather than overwriting or bypassing it",
  (kind) => {
    const target = join(cwd, "reports", "REPORT-20261027T080005-3f9c.md");
    const outside = join(cwd, "outside");
    fs.writeFileSync(outside, "foreign bytes");
    installUnsafe(target, kind, outside);
    expect(allocate).toThrow();
    expect(fs.readdirSync(join(cwd, "reports"))).toEqual(["REPORT-20261027T080005-3f9c.md"]);
    expect(fs.readFileSync(outside, "utf8")).toBe("foreign bytes");
  },
);
