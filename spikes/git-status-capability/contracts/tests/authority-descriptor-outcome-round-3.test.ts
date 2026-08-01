import { describe, expect, test } from "bun:test";
import { join } from "node:path";

type Target = "open_root" | "openat" | "fstat_sync" | "read_sync" | "close_sync";
type OutcomeReceipt = Readonly<{
  target: Target;
  outer: string;
  outerIsExactRaw: boolean;
  rawError: Readonly<{ message: string; fd: number; path: string; sentinel: string }>;
  targetRawCalls: number;
  callbackSnapshots: readonly boolean[];
  invokeReturnedUndefined: boolean;
  mediatorCaught: boolean;
  repeatedError: string;
  mutationAttempted: boolean;
  mutationSucceeded: boolean;
}>;

const childPath = join(import.meta.dir, "authority-descriptor-outcome-round-3-child.ts");
const REPEATED_INVOCATION = "CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_INVOCATION_REPEATED";

async function runOutcomeProbe(target: Target): Promise<OutcomeReceipt> {
  const child = Bun.spawn([process.execPath, childPath, target], { stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  expect(exit).toBe(0);
  expect(stderr).toBe("");
  return JSON.parse(stdout) as OutcomeReceipt;
}

describe("raw primitive outcome privacy", () => {
  test("each raw throw remains private, exact, callback-scoped, and exactly once", async () => {
    for (const target of ["open_root", "openat", "fstat_sync", "read_sync", "close_sync"] as const) {
      const receipt = await runOutcomeProbe(target);
      expect(receipt.target).toBe(target);
      expect(receipt.targetRawCalls).toBe(1);
      expect(receipt.callbackSnapshots).toEqual([true]);
      expect(receipt.invokeReturnedUndefined).toBe(true);
      expect(receipt.mediatorCaught).toBe(false);
      expect(receipt.repeatedError).toBe(REPEATED_INVOCATION);
      expect(receipt.mutationAttempted).toBe(true);
      expect(receipt.mutationSucceeded).toBe(false);
      expect(receipt.rawError).toEqual({
        message: "ROUND_THREE_RAW_SENTINEL",
        fd: 917,
        path: "/private/sentinel",
        sentinel: "UNCHANGED"
      });
      if (target === "close_sync") {
        expect(receipt.outer).toBe("CONTRACT_CAPABILITY_CLOSE_FAILED");
        expect(receipt.outerIsExactRaw).toBe(false);
      } else {
        expect(receipt.outer).toBe("ROUND_THREE_RAW_SENTINEL");
        expect(receipt.outerIsExactRaw).toBe(true);
      }
    }
  });
});
