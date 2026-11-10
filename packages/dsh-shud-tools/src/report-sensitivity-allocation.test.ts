import * as fs from "node:fs";
import type * as NodeCrypto from "node:crypto";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { fileSnapshot, readCard } from "./analysis-create/test-harness.ts";
import { getCard } from "./task-linked/test-harness.ts";
import { DRAFT, generated, reportHarness, seedEvidence } from "./report-workflow/test-harness.ts";
import { seedAcceptanceBatch, sensitivityHarness } from "./report-sensitivity/test-harness.ts";

const entropy = vi.hoisted(() => ({ suffixes: [] as string[] }));
vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof NodeCrypto>();
  return {
    ...actual,
    randomBytes(size: number, callback?: (error: Error | null, bytes: Buffer) => void) {
      if (callback) return actual.randomBytes(size, callback);
      const suffix = size === 2 ? entropy.suffixes.shift() : undefined;
      return suffix === undefined ? actual.randomBytes(size) : Buffer.from(suffix, "hex");
    },
  };
});

const TAKEN = "REPORT-20261108T100000-aaaa";
const REALLOCATED = "REPORT-20261108T100000-bbbb";

afterEach(() => {
  vi.useRealTimers();
  entropy.suffixes = [];
});

/** Pre-seed one sibling of the first drawn id, then draw that id followed by a free one. */
function seedTakenSibling(cwd: string, extension: string) {
  const path = join(cwd, "reports", `${TAKEN}.${extension}`);
  fs.mkdirSync(join(cwd, "reports"), { recursive: true });
  fs.writeFileSync(path, "pre-existing sibling bytes\n");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-08T10:00:00.000Z"));
  entropy.suffixes = ["aaaa", "bbbb"];
  return { path, before: fileSnapshot(path) };
}

test("a lone summary sibling forces sensitivity report reallocation without overwrite", async () => {
  const h = await sensitivityHarness();
  try {
    await seedAcceptanceBatch(h);
    const taken = seedTakenSibling(h.cwd, "sensitivity.json");
    const report = generated(h, await h.generate());
    expect(report.report_id).toBe(REALLOCATED);
    expect(fileSnapshot(taken.path)).toEqual(taken.before);
    expect(fs.readdirSync(join(h.cwd, "reports")).sort()).toEqual([
      `${TAKEN}.sensitivity.json`,
      `${REALLOCATED}.json`,
      `${REALLOCATED}.md`,
      `${REALLOCATED}.sensitivity.json`,
    ]);
    expect(report.sensitivity_summary?.path).toBe(`reports/${REALLOCATED}.sensitivity.json`);
    expect(readCard(h).linked_reports).toEqual([REALLOCATED]);
  } finally {
    await h.dispose();
  }
});

test("a lone Markdown sibling forces science_assist report reallocation without overwrite", async () => {
  const h = await reportHarness();
  try {
    await seedEvidence(h);
    const taken = seedTakenSibling(h.cwd, "md");
    const report = generated(h, await h.invoke("report_generate", DRAFT));
    expect(report.report_id).toBe(REALLOCATED);
    expect(fileSnapshot(taken.path)).toEqual(taken.before);
    expect(fs.readdirSync(join(h.cwd, "reports")).sort()).toEqual([
      `${TAKEN}.md`,
      `${REALLOCATED}.json`,
      `${REALLOCATED}.md`,
    ]);
    expect(getCard(h).linked_reports).toEqual([REALLOCATED]);
  } finally {
    await h.dispose();
  }
});
