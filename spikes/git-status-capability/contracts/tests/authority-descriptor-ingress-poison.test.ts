import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { failure } from "./helpers";
import { withCloseRuntimeTree, type CloseRuntimeMutation } from "./authority-descriptor-close-runtime";

type Entry = "ingress" | "checker";
type EntryOutcome = Readonly<{ code: string | null; exit: number | null; stdout: string; stderr: string }>;
type ChildResult = Readonly<{ exit: number; stderr: string; stdout: string }>;
type RetainedOwnerReceipt = Readonly<{
  preCloseOwnerCount: number;
  retainedOwnerCount: number;
  retainedOwnersMatchPreClose: boolean;
}>;
type SiblingReceipt = RetainedOwnerReceipt & Readonly<{
  activeContextCount: number;
  entry: Entry;
  laterAttemptCalls: number;
  laterChecker: EntryOutcome;
  laterIngress: EntryOutcome;
  laterRawCloseCalls: number;
  outcome: EntryOutcome;
  rawCloseCallsAfterTarget: number;
  targetAttempts: number;
  targetRetainedAfterContextDeletion: boolean;
  targetStillUsable: boolean;
}>;
type TwoNoRawReceipt = RetainedOwnerReceipt & Readonly<{
  activeContextCount: number;
  attempts: number;
  closeFaultCalls: number;
  entry: Entry;
  firstAndSecondDistinct: boolean;
  firstAndSecondFrozen: boolean;
  laterAttemptCalls: number;
  laterChecker: EntryOutcome;
  laterIngress: EntryOutcome;
  laterRawCloseCalls: number;
  outcome: EntryOutcome;
  rawCloseCalls: number;
  targetRetainedAfterContextDeletion: boolean;
  targetStillUsable: boolean;
}>;

const childPath = join(import.meta.dir, "authority-descriptor-ingress-poison-child.ts");
const descriptorDirectory = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";

async function descriptorCount(): Promise<number> {
  return (await readdir(descriptorDirectory)).length;
}

async function runChild(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): Promise<ChildResult> {
  const child = Bun.spawn([process.execPath, childPath, ...args], {
    env: { ...process.env, ...environment },
    stderr: "pipe",
    stdout: "pipe"
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  return Object.freeze({ exit, stderr, stdout });
}

async function isolatedReceipt<Value>(
  scenario: "sibling" | "two_no_raw",
  entry: Entry,
  mutation: CloseRuntimeMutation,
  bridge: string | undefined
): Promise<Value> {
  const before = await descriptorCount();
  let result: ChildResult | undefined;
  await withCloseRuntimeTree(mutation, async (tree) => {
    result = await runChild([scenario, entry], {
      SHUD_DESCRIPTOR_CLOSE_RUNTIME_BRIDGE: bridge,
      SHUD_DESCRIPTOR_PRODUCTION_ROOT: tree.root
    });
  });
  Bun.gc(true);
  expect(await descriptorCount()).toBe(before);
  expect(result).toBeDefined();
  expect(result!.exit).toBe(0);
  expect(result!.stderr).toBe("");
  return JSON.parse(result!.stdout) as Value;
}

function expectedFailure(entry: Entry): EntryOutcome {
  return entry === "ingress"
    ? { code: "CONTRACT_SCHEMA_INVALID", exit: null, stdout: "", stderr: "" }
    : { code: "CONTRACT_SCHEMA_INVALID", exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") };
}

function assertRetainedOwnerIdentity(receipt: RetainedOwnerReceipt): void {
  expect(receipt.preCloseOwnerCount).toBeGreaterThan(0);
  expect(receipt.retainedOwnerCount).toBe(receipt.preCloseOwnerCount);
  expect(receipt.retainedOwnersMatchPreClose).toBe(true);
}

function assertSiblingReceipt(receipt: SiblingReceipt, entry: Entry): void {
  expect(receipt.entry).toBe(entry);
  expect(receipt.outcome).toEqual(expectedFailure(entry));
  expect(receipt.targetAttempts).toBe(2);
  expect(receipt.rawCloseCallsAfterTarget).toBe(1);
  expect(receipt.targetRetainedAfterContextDeletion).toBe(true);
  expect(receipt.targetStillUsable).toBe(true);
  expect(receipt.activeContextCount).toBe(0);
  expect(receipt.laterIngress).toEqual(expectedFailure("ingress"));
  expect(receipt.laterChecker).toEqual(expectedFailure("checker"));
  expect(receipt.laterRawCloseCalls).toBe(0);
  expect(receipt.laterAttemptCalls).toBe(0);
  assertRetainedOwnerIdentity(receipt);
}

describe("descriptor-attributed ingress close poison", () => {
  test("a sibling raw close cannot settle an omitted target, and attribution mutation is red", async () => {
    for (const entry of ["ingress", "checker"] as const) {
      const clean = await isolatedReceipt<SiblingReceipt>("sibling", entry, undefined, undefined);
      assertSiblingReceipt(clean, entry);

      const mutated = await isolatedReceipt<SiblingReceipt>("sibling", entry, "contextual_raw_start", undefined);
      expect(() => assertSiblingReceipt(mutated, entry)).toThrow();
      expect(mutated.targetRetainedAfterContextDeletion).toBe(false);
    }
  });

  test("mixed and same-pair no-raw closes retain exact pre-close owner identity, and a first-owner release is red", async () => {
    for (const [scenario, bridge] of [["sibling", undefined], ["two_no_raw", "omit"]] as const) {
      const clean = await isolatedReceipt<RetainedOwnerReceipt>(scenario, "ingress", undefined, bridge);
      assertRetainedOwnerIdentity(clean);

      const mutated = await isolatedReceipt<RetainedOwnerReceipt>(
        scenario,
        "ingress",
        "release_first_owner",
        bridge
      );
      expect(mutated.preCloseOwnerCount).toBe(clean.preCloseOwnerCount);
      expect(mutated.retainedOwnerCount).toBe(clean.preCloseOwnerCount - 1);
      expect(mutated.retainedOwnersMatchPreClose).toBe(false);
      expect(() => assertRetainedOwnerIdentity(mutated)).toThrow();
    }
  });

  test("two ordinary no-raw outcomes poison before release without a third callback or raw close", async () => {
    for (const entry of ["ingress", "checker"] as const) {
      const receipt = await isolatedReceipt<TwoNoRawReceipt>("two_no_raw", entry, undefined, "omit");
      assertRetainedOwnerIdentity(receipt);
      expect(receipt.entry).toBe(entry);
      expect(receipt.outcome).toEqual(expectedFailure(entry));
      expect(receipt.attempts).toBe(2);
      expect(receipt.firstAndSecondDistinct).toBe(true);
      expect(receipt.firstAndSecondFrozen).toBe(true);
      expect(receipt.closeFaultCalls).toBe(0);
      expect(receipt.rawCloseCalls).toBe(0);
      expect(receipt.targetRetainedAfterContextDeletion).toBe(true);
      expect(receipt.targetStillUsable).toBe(true);
      expect(receipt.activeContextCount).toBe(0);
      expect(receipt.laterIngress).toEqual(expectedFailure("ingress"));
      expect(receipt.laterChecker).toEqual(expectedFailure("checker"));
      expect(receipt.laterRawCloseCalls).toBe(0);
      expect(receipt.laterAttemptCalls).toBe(0);
    }
  });
});
