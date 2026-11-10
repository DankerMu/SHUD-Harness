import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cardSnapshot, treeOrAbsent } from "./task-linked/test-harness.ts";
import { expectReportError } from "./report-workflow/test-harness.ts";
import {
  seedAcceptanceBatch,
  sensitivityHarness,
  type SensitivityHarness,
} from "./report-sensitivity/test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});
const native = await vi.importActual<typeof fs>("node:fs");

let h: SensitivityHarness;
beforeEach(async () => {
  h = await sensitivityHarness();
});
afterEach(async () => {
  vi.mocked(fs.openSync).mockImplementation(native.openSync);
  await h.dispose();
});

const planOpens = () =>
  vi.mocked(fs.openSync).mock.calls.filter(([path]) => String(path).endsWith(`/${h.plan}.json`));

test("plan bytes swapped after the closure read fail sensitivity_summary and write nothing", async () => {
  await seedAcceptanceBatch(h);
  const swapped = JSON.parse(h.planBytes.toString("utf8")) as {
    parameter_space_rationale: { basis: string };
  };
  swapped.parameter_space_rationale.basis = "A different, schema-valid basis.";
  // The closure reads the plan through readFileSync; the summary bytes are a separate
  // descriptor read, so the swap lands exactly between the two reads.
  vi.mocked(fs.openSync).mockImplementation((...args: Parameters<typeof native.openSync>) => {
    if (String(args[0]).endsWith(`/${h.plan}.json`)) {
      native.writeFileSync(h.planPath, JSON.stringify(swapped));
    }
    return native.openSync(...args);
  });
  vi.mocked(fs.openSync).mockClear();
  const card = await cardSnapshot(h);
  const runs = await treeOrAbsent(join(h.cwd, "runs"));
  const message = expectReportError(await h.generate(), /sensitivity_summary/u);
  expect(message).not.toMatch(/closure failed/u);
  // Exactly one plan open, read-only and no-follow: the descriptor-bound byte read.
  const opens = planOpens();
  expect(opens).toHaveLength(1);
  const flags = Number(opens[0][1]);
  expect(flags & native.constants.O_NOFOLLOW).toBe(native.constants.O_NOFOLLOW);
  expect(flags & (native.constants.O_WRONLY | native.constants.O_RDWR)).toBe(0);
  expect(await treeOrAbsent(join(h.cwd, "reports"))).toBeNull();
  expect(await cardSnapshot(h)).toEqual(card);
  expect(await treeOrAbsent(join(h.cwd, "runs"))).toEqual(runs);
});

test("unchanged plan bytes are read once through the no-follow descriptor", async () => {
  await seedAcceptanceBatch(h);
  vi.mocked(fs.openSync).mockClear();
  const result = await h.generate();
  expect(result.isError, JSON.stringify(result)).toBe(false);
  const opens = planOpens();
  expect(opens).toHaveLength(1);
  expect(Number(opens[0][1]) & native.constants.O_NOFOLLOW).toBe(native.constants.O_NOFOLLOW);
  expect(native.readFileSync(h.planPath)).toEqual(h.planBytes);
});
