import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withProductionTree } from "./authority-descriptor-vocabulary";

type ChildResult = Readonly<{ exit: number; stdout: string; stderr: string }>;
type NoRawCloseMode = "omission" | "value" | "async" | "thenable" | "proxy" | "sentinel" | "hostile";
type DirectNoRawRetryReceipt = Readonly<{
  mode: NoRawCloseMode;
  firstOutcome: string;
  firstSentinel: boolean;
  firstHostile: boolean;
  secondOutcome: string;
  mediatedCloseCalls: number;
  rawCalls: number;
}>;
type DirectCloseReceipt = Readonly<{
  responseMode: "ordinary" | "value" | "throw" | "sentinel";
  outcome: Readonly<{ message: string; exactRaw: boolean }>;
  rawCalls: number;
  proxyTrapReads: number;
  exactPreInvocationOutcome: boolean | null;
}>;

const childPath = join(import.meta.dir, "authority-descriptor-mediation-runtime-child.ts");
const ASYNC_ERROR = "CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_ASYNC";
const CLOSE_ERROR = "CONTRACT_CAPABILITY_CLOSE_FAILED";
const MISSING_ERROR = "CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_INVOCATION_MISSING";
const NO_RAW_CLOSE_MODES = ["omission", "value", "async", "thenable", "proxy", "sentinel", "hostile"] as const;
const NO_RAW_DIRECT_OUTCOMES: Readonly<Record<NoRawCloseMode, string>> = Object.freeze({
  omission: MISSING_ERROR,
  value: ASYNC_ERROR,
  async: ASYNC_ERROR,
  thenable: ASYNC_ERROR,
  proxy: ASYNC_ERROR,
  sentinel: "MEDIATOR_THROWN_SENTINEL",
  hostile: "MEDIATOR_THROWN_PROXY"
});
const PRODUCTION_ROOT_ENV = "SHUD_DESCRIPTOR_PRODUCTION_ROOT";

async function runChild(
  args: readonly string[],
  productionRoot?: string
): Promise<ChildResult> {
  const child = Bun.spawn([process.execPath, childPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    ...(productionRoot ? { env: { ...process.env, [PRODUCTION_ROOT_ENV]: productionRoot } } : {})
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  return Object.freeze({ exit, stdout, stderr });
}

async function receipt<T>(args: readonly string[], productionRoot?: string): Promise<T> {
  const result = await runChild(args, productionRoot);
  expect(result.exit).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as T;
}

function injectPrematureCloseFault(source: string): string {
  const anchor = "    if (!rawCloseAttempted) {";
  if (!source.includes(anchor)) throw new Error("premature closeFault mutation anchor is absent");
  return source.replace(anchor, "    this.hooks.closeFault?.(attempt);\n" + anchor);
}

function injectGenericNoRawCloseRewrite(source: string): string {
  const anchor = "      throw closeError;";
  if (!source.includes(anchor)) throw new Error("generic no-raw close mutation anchor is absent");
  return source.replace(anchor, '      throw new Error("CONTRACT_CAPABILITY_CLOSE_FAILED");');
}

function injectOmissionOnlyNoRawRestore(source: string): string {
  const anchor = `    if (!rawCloseAttempted) {
      record.state = stateBeforeClose;
      // A second ingress query acknowledges that this close never started raw work.
      allowsIngressRawClose(this);
      throw closeError;
    }`;
  if (!source.includes(anchor)) throw new Error("selective no-raw restoration mutation anchor is absent");
  return source.replace(anchor, `    if (!rawCloseAttempted) {
      if (closeError instanceof Error &&
          closeError.message === "CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_INVOCATION_MISSING") {
        record.state = stateBeforeClose;
        // A second ingress query acknowledges that this close never started raw work.
        allowsIngressRawClose(this);
      }
      throw closeError;
    }`);
}

describe("descriptor primitive mediation runtime", () => {
  test("ingress retries only its private no-raw signal and preserves post-raw cleanup faults", async () => {
    for (const response of ["ordinary", "value", "throw"] as const) {
      for (const entry of ["direct", "checker"] as const) {
        const retry = await receipt<Readonly<{
          entry: "direct" | "checker";
          outcome: string;
          stdout: string;
          stderr: string;
          skippedCloseCalls: number;
          hookCalls: number;
          closeFaultCalls: number;
          rawCallsWhenFirstCloseFault: number | null;
          rawCalls: number;
        }>>(["close_retry", response, entry]);
        expect(retry.entry).toBe(entry);
        expect(retry.outcome).toBe(entry === "direct" ? "CONTRACT_SCHEMA_INVALID" : "CHECK:2");
        expect(retry.stdout).toBe("");
        expect(retry.stderr).toBe(entry === "direct"
          ? ""
          : "{\"schema_version\":\"shud.git-status-capability.contract-error.v1\",\"status\":\"error\",\"code\":\"CONTRACT_SCHEMA_INVALID\"}\n");
        expect(retry.skippedCloseCalls).toBe(1);
        expect(retry.closeFaultCalls).toBeGreaterThan(0);
        expect(retry.rawCallsWhenFirstCloseFault).toBeGreaterThan(0);
        expect(retry.rawCalls).toBeGreaterThan(0);
      }
    }

    for (const entry of ["direct", "checker"] as const) {
      const primary = await receipt<Readonly<{
        entry: "direct" | "checker";
        outcome: string;
        stdout: string;
        stderr: string;
        skippedCloseCalls: number;
        rawCallsWhenFirstCloseFault: number | null;
      }>>(["close_retry", "sentinel", entry]);
      expect(primary.entry).toBe(entry);
      expect(primary.outcome).toBe(entry === "direct" ? "CONTRACT_BYTES_LIMIT" : "CHECK:2");
      expect(primary.stdout).toBe("");
      expect(primary.stderr).toBe(entry === "direct"
        ? ""
        : "{\"schema_version\":\"shud.git-status-capability.contract-error.v1\",\"status\":\"error\",\"code\":\"CONTRACT_BYTES_LIMIT\"}\n");
      expect(primary.skippedCloseCalls).toBe(1);
      expect(primary.rawCallsWhenFirstCloseFault).toBeGreaterThan(0);
    }
  });

  test("direct close preserves exact no-raw mediator outcomes without ingress retry authority", async () => {
    for (const [responseMode, message] of [
      ["ordinary", MISSING_ERROR],
      ["value", ASYNC_ERROR],
      ["throw", "MEDIATOR_THROWN_PROXY"],
      ["sentinel", "MEDIATOR_THROWN_SENTINEL"]
    ] as const) {
      const direct = await receipt<DirectCloseReceipt>(["direct_close", responseMode]);
      expect(direct.responseMode).toBe(responseMode);
      expect(direct.outcome).toEqual({ message, exactRaw: false });
      expect(direct.exactPreInvocationOutcome).toBe(
        responseMode === "throw" || responseMode === "sentinel" ? true : null
      );
      expect(direct.rawCalls).toBe(0);
      expect(direct.proxyTrapReads).toBe(0);
    }
  });

  test("the direct-close receipt kills generic rewriting of a no-raw mediator error", async () => {
    await withProductionTree(undefined, async (tree) => {
      const source = await readFile(tree.capabilitiesPath, "utf8");
      await writeFile(tree.capabilitiesPath, injectGenericNoRawCloseRewrite(source));
      const direct = await receipt<DirectCloseReceipt>(["direct_close", "throw"], tree.root);
      expect(direct.outcome).toEqual({
        message: CLOSE_ERROR,
        exactRaw: false
      });
      expect(direct.exactPreInvocationOutcome).toBe(false);
      expect(direct.rawCalls).toBe(0);
    });
  });

  test("direct close restores every no-raw class without consuming ingress retry authority", async () => {
    for (const mode of NO_RAW_CLOSE_MODES) {
      const direct = await receipt<DirectNoRawRetryReceipt>(["direct_no_raw_retry", mode]);
      expect(direct.mode).toBe(mode);
      expect(direct.firstOutcome).toBe(NO_RAW_DIRECT_OUTCOMES[mode]);
      expect(direct.firstSentinel).toBe(mode === "sentinel");
      expect(direct.firstHostile).toBe(mode === "hostile");
      expect(direct.secondOutcome).toBe("NO_ERROR");
      expect(direct.mediatedCloseCalls).toBe(2);
      expect(direct.rawCalls).toBe(1);
    }
  });

  test("the selective omission restoration mutation leaves only the omission direct row green", async () => {
    await withProductionTree(undefined, async (tree) => {
      const source = await readFile(tree.capabilitiesPath, "utf8");
      await writeFile(tree.capabilitiesPath, injectOmissionOnlyNoRawRestore(source));
      for (const mode of NO_RAW_CLOSE_MODES) {
        const direct = await receipt<DirectNoRawRetryReceipt>(["direct_no_raw_retry", mode], tree.root);
        if (mode === "omission") {
          expect(direct.firstOutcome).toBe(NO_RAW_DIRECT_OUTCOMES[mode]);
          expect(direct.secondOutcome).toBe("NO_ERROR");
          expect(direct.mediatedCloseCalls).toBe(2);
          expect(direct.rawCalls).toBe(1);
        } else {
          expect(direct.secondOutcome).not.toBe("NO_ERROR");
          expect(direct.mediatedCloseCalls).toBe(1);
          expect(direct.rawCalls).toBe(0);
        }
      }
    });
  });

  test("the closeFault receipt kills a pre-raw cleanup mutation", async () => {
    await withProductionTree(undefined, async (tree) => {
      const source = await readFile(tree.capabilitiesPath, "utf8");
      await writeFile(tree.capabilitiesPath, injectPrematureCloseFault(source));
      const mutated = await receipt<Readonly<{
        outcome: string;
        rawCallsWhenFirstCloseFault: number | null;
      }>>(["close_retry", "value", "direct"], tree.root);
      expect(mutated).toMatchObject({
        outcome: "NO_ERROR",
        rawCallsWhenFirstCloseFault: 0
      });
    });
  });

  test("a close that reaches the kernel before throwing leaves its old generation stale and its replacement usable", async () => {
    expect(await receipt<Readonly<{
      closeOutcome: string;
      oldOutcome: string;
      currentUsable: boolean;
      denials: readonly string[];
      rawCalls: number;
    }>>(["reuse"])).toEqual({
      closeOutcome: CLOSE_ERROR,
      oldOutcome: "CONTRACT_CAPABILITY_DESCRIPTOR_DENIED",
      currentUsable: true,
      denials: ["stale_descriptor"],
      rawCalls: 1
    });
  });
});
