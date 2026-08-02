import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { failure } from "./helpers";
import { withCloseRuntimeTree, type CloseRuntimeMutation } from "./authority-descriptor-close-runtime";

type Entry = "ingress" | "checker";
type EntryOutcome = Readonly<{ code: string | null; exit: number | null; stdout: string; stderr: string }>;
type ChildResult = Readonly<{ exit: number; stderr: string; stdout: string }>;
type SiblingReceipt = Readonly<{
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
type TwoNoRawReceipt = Readonly<{
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

  test("two ordinary no-raw outcomes poison before release without a third callback or raw close", async () => {
    for (const entry of ["ingress", "checker"] as const) {
      const receipt = await isolatedReceipt<TwoNoRawReceipt>("two_no_raw", entry, undefined, "omit");
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
