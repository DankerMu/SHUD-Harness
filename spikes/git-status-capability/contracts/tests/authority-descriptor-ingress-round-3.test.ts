import { describe, expect, test } from "bun:test";
import { join } from "node:path";

type CleanupSurface = "root" | "child" | "verification" | "retained";
type Entry = "direct" | "checker";
type EntryOutcome = Readonly<{
  code: string;
  exit: number | null;
  stdout: string;
  stderr: string;
}>;
type PoisonReceipt = Readonly<{
  surface: CleanupSurface;
  entry: Entry;
  baseline: number;
  afterFirst: number;
  afterLater: number;
  first: EntryOutcome;
  laterDirect: EntryOutcome;
  laterChecker: EntryOutcome;
  firstRawOpens: number;
  laterRawOpens: number;
  rawCloseCalls: number;
  firstCloseAttemptCount: number;
  laterCloseAttemptCount: number;
  targetAttemptOrdinals: readonly number[];
  targetAttemptsPaired: boolean;
  expectedTargetAttempts: number;
}>;

const childPath = join(import.meta.dir, "authority-descriptor-ingress-round-3-child.ts");

async function runPoisonProbe(surface: CleanupSurface, entry: Entry): Promise<PoisonReceipt> {
  const child = Bun.spawn([process.execPath, childPath, surface, entry], { stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  expect(exit).toBe(0);
  expect(stderr).toBe("");
  return JSON.parse(stdout) as PoisonReceipt;
}

describe("persistent no-raw close fail-stop", () => {
  test("retains each first-chain close owner and blocks all later direct and checker admissions before fd allocation", async () => {
    for (const surface of ["root", "child", "verification", "retained"] as const) {
      for (const entry of ["direct", "checker"] as const) {
        const receipt = await runPoisonProbe(surface, entry);
        expect(receipt.surface).toBe(surface);
        expect(receipt.entry).toBe(entry);
        expect(receipt.first.code).toBe("CONTRACT_SCHEMA_INVALID");
        expect(receipt.first.exit).toBe(entry === "direct" ? null : 2);
        expect(receipt.first.stdout).toBe("");
        expect(receipt.firstRawOpens).toBeGreaterThan(0);
        expect(receipt.targetAttemptOrdinals).toHaveLength(receipt.expectedTargetAttempts);
        expect(receipt.targetAttemptsPaired).toBe(true);
        expect(receipt.firstCloseAttemptCount).toBeGreaterThanOrEqual(receipt.expectedTargetAttempts);
        expect(receipt.rawCloseCalls).toBe(0);
        expect(receipt.afterFirst).toBeGreaterThan(receipt.baseline);
        expect(receipt.laterDirect).toEqual({
          code: "CONTRACT_SCHEMA_INVALID",
          exit: null,
          stdout: "",
          stderr: ""
        });
        expect(receipt.laterChecker.code).toBe("CONTRACT_SCHEMA_INVALID");
        expect(receipt.laterChecker.exit).toBe(2);
        expect(receipt.laterChecker.stdout).toBe("");
        expect(receipt.laterRawOpens).toBe(0);
        expect(receipt.laterCloseAttemptCount).toBe(0);
        expect(receipt.afterLater).toBe(receipt.afterFirst);
      }
    }
  });
});
