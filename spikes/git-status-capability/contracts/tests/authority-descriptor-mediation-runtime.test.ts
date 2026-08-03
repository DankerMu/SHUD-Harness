import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ContractCapabilities } from "../lib/capabilities";
import * as ingress from "../lib/ingress";
import { failure, success } from "./helpers";
import { withCloseRuntimeTree } from "./authority-descriptor-close-runtime";

type Entry = "ingress" | "checker";
type EntryOutcome = Readonly<{ code: string | null; exit: number | null; stdout: string; stderr: string }>;
type ChildResult = Readonly<{ exit: number; stderr: string; stdout: string }>;
type IdentityReceipt = Readonly<{
  allFrozen: boolean;
  closeFaultCalls: number;
  entry: string;
  onCloseCalls: number;
  outcome: EntryOutcome;
  rawCloseCalls: number;
  sameAttempt: boolean;
}>;
type RetryReceipt = Readonly<{
  allFrozen: boolean;
  closeFaultCalls: number;
  entry: Entry;
  firstAndSecondDistinct: boolean;
  firstAndSecondFrozen: boolean;
  firstTwoAttempts: boolean;
  onCloseCalls: number;
  outcome: EntryOutcome;
  rawCloseCalls: number;
  sameAttempt: boolean;
}>;
type TerminalReceipt = Readonly<{
  allFrozen: boolean;
  closeFaultCalls: number;
  entry: Entry;
  onCloseCalls: number;
  outcome: EntryOutcome;
  sameAttempt: boolean;
  targetCloseCalls: number;
  targetRawStarts: number;
}>;

const childPath = join(import.meta.dir, "authority-descriptor-mediation-runtime-child.ts");

async function runChild(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = {}
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

async function receipt<Value>(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = {}
): Promise<Value> {
  const result = await runChild(args, environment);
  expect(result.exit).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as Value;
}

function expectedSuccess(entry: Entry): EntryOutcome {
  return entry === "ingress"
    ? { code: null, exit: null, stdout: "", stderr: "" }
    : { code: null, exit: 0, stdout: success("source_input_record"), stderr: "" };
}

function expectedFailure(entry: Entry): EntryOutcome {
  return entry === "ingress"
    ? { code: "CONTRACT_SCHEMA_INVALID", exit: null, stdout: "", stderr: "" }
    : { code: "CONTRACT_SCHEMA_INVALID", exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") };
}

describe("descriptor close runtime mediation", () => {
  test("direct, ingress, and checker callbacks share frozen attempts; a no-raw retry is distinct; raw starts remain terminal", async () => {
    for (const entry of ["capability", "ingress", "checker"] as const) {
      const identity = await receipt<IdentityReceipt>(["identity", entry]);
      expect(identity.entry).toBe(entry);
      expect(identity.allFrozen).toBe(true);
      expect(identity.sameAttempt).toBe(true);
      expect(identity.onCloseCalls).toBeGreaterThan(0);
      expect(identity.closeFaultCalls).toBe(identity.onCloseCalls);
      expect(identity.rawCloseCalls).toBeGreaterThan(0);
      if (entry === "capability") {
        expect(identity.rawCloseCalls).toBe(1);
        expect(identity.outcome).toEqual({ code: null, exit: null, stdout: "", stderr: "" });
      } else {
        expect(identity.outcome).toEqual(expectedSuccess(entry));
      }
    }

    await withCloseRuntimeTree(undefined, async (tree) => {
      for (const entry of ["ingress", "checker"] as const) {
        const retry = await receipt<RetryReceipt>(["retry", entry], {
          SHUD_DESCRIPTOR_PRODUCTION_ROOT: tree.root,
          SHUD_DESCRIPTOR_CLOSE_RUNTIME_BRIDGE: "omit_once"
        });
        expect(retry.entry).toBe(entry);
        expect(retry.outcome).toEqual(expectedSuccess(entry));
        expect(retry.firstTwoAttempts).toBe(true);
        expect(retry.firstAndSecondDistinct).toBe(true);
        expect(retry.firstAndSecondFrozen).toBe(true);
        expect(retry.allFrozen).toBe(true);
        expect(retry.sameAttempt).toBe(true);
        expect(retry.closeFaultCalls).toBe(retry.onCloseCalls - 1);
        expect(retry.rawCloseCalls).toBeGreaterThan(0);
      }
    });

    for (const [scenario, shouldFail] of [
      ["terminal_return", false],
      ["terminal_throw", true]
    ] as const) {
      for (const entry of ["ingress", "checker"] as const) {
        const terminal = await receipt<TerminalReceipt>([scenario, entry]);
        expect(terminal.entry).toBe(entry);
        expect(terminal.targetCloseCalls).toBe(1);
        expect(terminal.targetRawStarts).toBe(1);
        expect(terminal.allFrozen).toBe(true);
        expect(terminal.sameAttempt).toBe(true);
        expect(terminal.closeFaultCalls).toBe(terminal.onCloseCalls);
        expect(terminal.outcome).toEqual(shouldFail ? expectedFailure(entry) : expectedSuccess(entry));
      }
    }
  });

  test("the #175 capability and ingress public surfaces remain closed", () => {
    expect(Object.getOwnPropertyNames(ContractCapabilities.prototype).sort()).toEqual([
      "close", "constructor", "markRetained", "openRelative", "openRoot", "readRetained", "rejectForbidden",
      "sealAdmission", "stat"
    ]);
    expect(Object.keys(ingress).sort()).toEqual(["ContractError", "parseBoundedJson", "readBoundedFile"]);
  });
});
