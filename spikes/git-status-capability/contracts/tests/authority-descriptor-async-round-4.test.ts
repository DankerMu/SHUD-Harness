import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  withCompiledProductionTreeTransform,
  type MutatedProductionTree
} from "./authority-descriptor-vocabulary";

type Target = "open_root" | "openat" | "fstat_sync" | "read_sync" | "close_sync";
type Mode = "post_return" | "post_throw" | "pre";
type Entry = "capability" | "ingress" | "checker";
type AsyncReceipt = Readonly<{
  target: Target;
  mode: Mode;
  entry: Entry;
  outer: string;
  outerIsExactRaw: boolean;
  targetRawCalls: number;
  callbackSnapshots: readonly boolean[];
  invokeReturnedUndefined: boolean;
  mediatorCaught: boolean;
  unhandledRejections: readonly string[];
  checkerStdout: string;
  checkerStderr: string;
  eventLoopTurns: number;
}>;
type ChildResult = Readonly<{ exit: number; stdout: string; stderr: string }>;

const childPath = join(import.meta.dir, "authority-descriptor-outcome-round-3-child.ts");
const TARGETS = ["open_root", "openat", "fstat_sync", "read_sync", "close_sync"] as const;
const ASYNC_ERROR = "CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_ASYNC";
const CLOSE_ERROR = "CONTRACT_CAPABILITY_CLOSE_FAILED";
const RAW_ERROR = "ROUND_THREE_RAW_SENTINEL";
const POST_REJECTION = "ROUND_FOUR_POST_INVOKE_REJECTION";
const PRE_REJECTION = "ROUND_FOUR_PRE_INVOKE_REJECTION";

async function runChild(args: readonly string[]): Promise<ChildResult> {
  const child = Bun.spawn([process.execPath, childPath, ...args], { stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  return Object.freeze({ exit, stdout, stderr });
}

async function runProbe(target: Target, mode: Mode, entry: Entry = "capability"): Promise<AsyncReceipt> {
  const result = await runChild([target, mode, entry]);
  expect(result.exit).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as AsyncReceipt;
}

function expectSettledNativeRejection(
  receipt: AsyncReceipt,
  target: Target,
  mode: Mode,
  rawCalls: number
): void {
  expect(receipt.target).toBe(target);
  expect(receipt.mode).toBe(mode);
  expect(receipt.targetRawCalls).toBe(rawCalls);
  expect(receipt.callbackSnapshots).toEqual(rawCalls === 0 ? [] : [true]);
  expect(receipt.invokeReturnedUndefined).toBe(mode !== "pre");
  expect(receipt.mediatorCaught).toBe(false);
  expect(receipt.unhandledRejections).toEqual([]);
  expect(receipt.eventLoopTurns).toBe(1);
}

function expectRawErrorPrecedence(receipt: AsyncReceipt, target: Target): void {
  if (target === "close_sync") {
    expect(receipt.outer).toBe(CLOSE_ERROR);
    expect(receipt.outerIsExactRaw).toBe(false);
    return;
  }
  expect(receipt.outer).toBe(RAW_ERROR);
  expect(receipt.outerIsExactRaw).toBe(true);
}

function parseReceipt(stdout: string): AsyncReceipt | undefined {
  try {
    return JSON.parse(stdout) as AsyncReceipt;
  } catch {
    return undefined;
  }
}

async function runSinkRemovalMutation(tree: MutatedProductionTree, mode: "post_return" | "pre"): Promise<ChildResult> {
  return await runChild(["open_root", mode, "capability", tree.capabilitiesPath]);
}
describe("native mediator rejection settlement", () => {
  test("each post-invocation native rejection settles after raw return and raw throw across all five primitives", async () => {
    for (const target of TARGETS) {
      const returned = await runProbe(target, "post_return");
      expectSettledNativeRejection(returned, target, "post_return", 1);
      expect(returned.entry).toBe("capability");
      expect(returned.outer).toBe("NO_ERROR");
      expect(returned.outerIsExactRaw).toBe(false);

      const threw = await runProbe(target, "post_throw");
      expectSettledNativeRejection(threw, target, "post_throw", 1);
      expect(threw.entry).toBe("capability");
      expectRawErrorPrecedence(threw, target);
    }
  });

  test("each pre-invocation native rejection is settled, starts no selected raw primitive, and keeps its existing public outcome", async () => {
    for (const target of TARGETS) {
      const receipt = await runProbe(target, "pre");
      expectSettledNativeRejection(receipt, target, "pre", 0);
      expect(receipt.entry).toBe("capability");
      expect(receipt.outer).toBe(target === "close_sync" ? CLOSE_ERROR : ASYNC_ERROR);
      expect(receipt.outerIsExactRaw).toBe(false);
    }
  });

  test("public direct ingress and checker receipts remain coherent after post- and pre-invocation native rejection", async () => {
    const postIngress = await runProbe("open_root", "post_return", "ingress");
    expectSettledNativeRejection(postIngress, "open_root", "post_return", 1);
    expect(postIngress.outer).toMatch(/^BYTES:[1-9]\d*$/);
    expect(postIngress.checkerStdout).toBe("");
    expect(postIngress.checkerStderr).toBe("");

    const preIngress = await runProbe("open_root", "pre", "ingress");
    expectSettledNativeRejection(preIngress, "open_root", "pre", 0);
    expect(preIngress.outer).toBe("CONTRACT_SCHEMA_INVALID");
    expect(preIngress.checkerStdout).toBe("");
    expect(preIngress.checkerStderr).toBe("");

    const postChecker = await runProbe("open_root", "post_return", "checker");
    expectSettledNativeRejection(postChecker, "open_root", "post_return", 1);
    expect(postChecker.outer).toBe("CHECK:0");
    expect(postChecker.checkerStdout).toBe(
      "{\"schema_version\":\"shud.git-status-capability.contract-check-receipt.v1\",\"status\":\"ok\",\"input_kind\":\"source_input_record\"}\n"
    );
    expect(postChecker.checkerStderr).toBe("");

    const preChecker = await runProbe("open_root", "pre", "checker");
    expectSettledNativeRejection(preChecker, "open_root", "pre", 0);
    expect(preChecker.outer).toBe("CHECK:2");
    expect(preChecker.checkerStdout).toBe("");
    expect(preChecker.checkerStderr).toBe(
      "{\"schema_version\":\"shud.git-status-capability.contract-error.v1\",\"status\":\"error\",\"code\":\"CONTRACT_SCHEMA_INVALID\"}\n"
    );
  });

  test("a copied production mutation that disables both native-promise sinks turns the process proof red", async () => {
    let mutated = false;
    await withCompiledProductionTreeTransform((sourceName, source) => {
      if (sourceName !== "capabilities.ts") return source;
      const withoutUninvokedSink = source.replace(
        "mediatorReturnedAsync = settleNativeMediatorPromise(mediatorResult) ||\n        mediatorReturnedThenable(mediatorResult);",
        "mediatorReturnedAsync = mediatorReturnedThenable(mediatorResult);"
      );
      if (withoutUninvokedSink === source) throw new Error("async pre-invocation sink anchor is absent");
      const withoutPostInvokeSink = withoutUninvokedSink.replace(
        "      settleNativeMediatorPromise(mediatorResult);",
        "      void mediatorResult;"
      );
      if (withoutPostInvokeSink === withoutUninvokedSink) throw new Error("async post-invocation sink anchor is absent");
      mutated = true;
      return withoutPostInvokeSink;
    }, async (tree) => {
      for (const [mode, rejection] of [
        ["post_return", POST_REJECTION],
        ["pre", PRE_REJECTION]
      ] as const) {
        const result = await runSinkRemovalMutation(tree, mode);
        const receipt = parseReceipt(result.stdout);
        const rejectionWasObservable = receipt?.unhandledRejections.includes(rejection) ?? false;
        expect(
          result.exit !== 0 || result.stderr.includes(rejection) || rejectionWasObservable
        ).toBe(true);
      }
    });
  });
});
