import { describe, expect, test } from "bun:test";
import { join } from "node:path";

type Target = "open_root" | "openat" | "fstat_sync" | "read_sync" | "close_sync";
type RawMode = "returned" | "threw" | "pre";
type PromiseResponse = "ordinary" | "constructor" | "species" | "sink";
type ResponseMode = PromiseResponse | "value" | "throw" | "thenable" | "proxy";
type ChildResult = Readonly<{ exit: number; stdout: string; stderr: string }>;
type MatrixReceipt = Readonly<{
  target: Target;
  rawMode: RawMode;
  responseMode: ResponseMode;
  outcome: Readonly<{ message: string; exactRaw: boolean }>;
  rawCalls: number;
  operations: readonly Target[];
  callbackReturnedUndefined: boolean;
  thenGetterReads: number;
  proxyTrapReads: number;
  nativeHostilityReads: number;
  fdBefore: number | null;
  fdAfter: number | null;
}>;
type IngressReceipt = Readonly<{
  entry: "direct" | "checker";
  rawMode: RawMode;
  responseMode: ResponseMode;
  outcome: string;
  stdout: string;
  stderr: string;
  rawCalls: number;
  nativeHostilityReads: number;
}>;
type ControlReceipt = Readonly<{
  control: ResponseMode;
  outcome: string;
  rawCalls: number;
  repeated: string;
  expired: string;
  reentry: string;
  callbackReturnedUndefined: boolean;
  thenGetterReads: number;
  proxyTrapReads: number;
  nativeHostilityReads: number;
}>;

const childPath = join(import.meta.dir, "authority-descriptor-mediation-runtime-child.ts");
const TARGETS = ["open_root", "openat", "fstat_sync", "read_sync", "close_sync"] as const;
const PROMISE_RESPONSES = ["ordinary", "constructor", "species", "sink"] as const;
const ASYNC_ERROR = "CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_ASYNC";
const CLOSE_ERROR = "CONTRACT_CAPABILITY_CLOSE_FAILED";
const MISSING_ERROR = "CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_INVOCATION_MISSING";
const EXPIRED_ERROR = "CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_INVOCATION_EXPIRED";
const REPEATED_ERROR = "CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_INVOCATION_REPEATED";
const REENTRY_ERROR = "CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_REENTRY";
const INVALID_INSTALLER_ERROR = "CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_INVALID";
const REPEATED_INSTALLER_ERROR = "CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_ALREADY_INSTALLED";

async function runChild(args: readonly string[]): Promise<ChildResult> {
  const child = Bun.spawn([process.execPath, childPath, ...args], { stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  return Object.freeze({ exit, stdout, stderr });
}

async function receipt<T>(args: readonly string[]): Promise<T> {
  const result = await runChild(args);
  expect(result.exit).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as T;
}

function expectedRawOutcome(target: Target, rawMode: RawMode): Readonly<{ message: string; exactRaw: boolean }> {
  if (rawMode === "returned") return { message: "NO_ERROR", exactRaw: false };
  if (target === "close_sync") return { message: CLOSE_ERROR, exactRaw: false };
  return { message: "MEDIATOR_RAW_SENTINEL", exactRaw: true };
}

function expectNoMediatorInspection(receipt: Readonly<{
  thenGetterReads: number;
  proxyTrapReads: number;
  nativeHostilityReads: number;
}>): void {
  expect(receipt.thenGetterReads).toBe(0);
  expect(receipt.proxyTrapReads).toBe(0);
  expect(receipt.nativeHostilityReads).toBe(0);
}

describe("descriptor primitive mediation runtime", () => {
  test("installer validates before latching and exposes only a frozen non-constructible callable", async () => {
    const installed = await receipt<Readonly<{
      invalid: string;
      first: string;
      repeated: string;
      frozen: boolean;
      constructible: boolean;
      ownNames: readonly string[];
      ownSymbols: readonly unknown[];
      prototypeIsFunction: boolean;
      hiddenProperties: readonly string[];
    }>>(["installer"]);
    expect(installed).toEqual({
      invalid: INVALID_INSTALLER_ERROR,
      first: "NO_ERROR",
      repeated: REPEATED_INSTALLER_ERROR,
      frozen: true,
      constructible: false,
      ownNames: ["length", "name"],
      ownSymbols: [],
      prototypeIsFunction: true,
      hiddenProperties: []
    });
  });

  test("no-installer behavior remains direct and exposes no mediation control", async () => {
    const defaultReceipt = await receipt<Readonly<{
      directory: boolean;
      hiddenExports: readonly string[];
    }>>(["default"]);
    expect(defaultReceipt).toEqual({ directory: true, hiddenExports: [] });
  });

  test("missing, expired, invalid-return, repeated, and callback reentry retain their stable outcomes", async () => {
    const missing = await receipt<ControlReceipt>(["control", "open_root", "returned", "ordinary"]);
    expect(missing).toMatchObject({
      outcome: MISSING_ERROR,
      rawCalls: 0,
      repeated: "NO_ERROR",
      expired: "NO_ERROR",
      reentry: "NO_ERROR"
    });

    const expired = await receipt<ControlReceipt>(["control", "open_root", "returned", "constructor"]);
    expect(expired).toMatchObject({ outcome: MISSING_ERROR, rawCalls: 0, expired: EXPIRED_ERROR });

    const invalidReturn = await receipt<ControlReceipt>(["control", "open_root", "returned", "species"]);
    expect(invalidReturn).toMatchObject({ outcome: ASYNC_ERROR, rawCalls: 0 });
    expectNoMediatorInspection(invalidReturn);

    for (const shape of ["thenable", "proxy"] as const) {
      const invalid = await receipt<ControlReceipt>(["control", "open_root", "returned", shape]);
      expect(invalid).toMatchObject({ outcome: ASYNC_ERROR, rawCalls: 0 });
      expectNoMediatorInspection(invalid);
    }

    const reentry = await receipt<ControlReceipt>(["control", "open_root", "returned", "sink"]);
    expect(reentry).toMatchObject({
      outcome: "NO_ERROR",
      rawCalls: 1,
      repeated: REPEATED_ERROR,
      reentry: REENTRY_ERROR,
      callbackReturnedUndefined: true
    });
  });

  test("all five primitives preserve a started raw return or throw over invalid synchronous returns", async () => {
    for (const target of TARGETS) {
      for (const rawMode of ["returned", "threw"] as const) {
        for (const responseMode of [...PROMISE_RESPONSES, "value", "throw"] as const) {
          const row = await receipt<MatrixReceipt>(["matrix", target, rawMode, responseMode]);
          expect(row.target).toBe(target);
          expect(row.rawMode).toBe(rawMode);
          expect(row.responseMode).toBe(responseMode);
          expect(row.operations.every((operation) => TARGETS.includes(operation))).toBe(true);
          expect(row.rawCalls).toBe(1);
          expect(row.operations).toContain(target);
          expect(row.callbackReturnedUndefined).toBe(true);
          expect(row.outcome).toEqual(expectedRawOutcome(target, rawMode));
          expectNoMediatorInspection(row);
          if (row.fdBefore !== null && row.fdAfter !== null) expect(row.fdAfter).toBe(row.fdBefore);
        }
      }
    }
  });

  test("pre-invocation non-undefined returns fail closed without property access or selected raw work", async () => {
    for (const target of TARGETS) {
      for (const responseMode of [...PROMISE_RESPONSES, "value"] as const) {
        const row = await receipt<MatrixReceipt>(["matrix", target, "pre", responseMode]);
        expect(row.rawCalls).toBe(0);
        expect(row.callbackReturnedUndefined).toBe(false);
        expect(row.outcome).toEqual({
          message: target === "close_sync" ? CLOSE_ERROR : ASYNC_ERROR,
          exactRaw: false
        });
        expectNoMediatorInspection(row);
      }
    }
  });

  test("ordinary thenable getters and Proxy traps remain unread before and after raw invocation", async () => {
    for (const target of TARGETS) {
      for (const responseMode of ["thenable", "proxy"] as const) {
        const before = await receipt<MatrixReceipt>(["matrix", target, "pre", responseMode]);
        expect(before.rawCalls).toBe(0);
        expect(before.outcome.message).toBe(target === "close_sync" ? CLOSE_ERROR : ASYNC_ERROR);
        expectNoMediatorInspection(before);

        for (const rawMode of ["returned", "threw"] as const) {
          const after = await receipt<MatrixReceipt>(["matrix", target, rawMode, responseMode]);
          expect(after.rawCalls).toBe(1);
          expect(after.outcome).toEqual(expectedRawOutcome(target, rawMode));
          expectNoMediatorInspection(after);
        }
      }
    }
  });

  test("representative direct and checker receipts retain their public contract", async () => {
    const directPost = await receipt<IngressReceipt>(["ingress", "open_root", "returned", "constructor", "direct"]);
    expect(directPost).toMatchObject({
      entry: "direct",
      outcome: expect.stringMatching(/^BYTES:[1-9]\d*$/),
      rawCalls: 1,
      stdout: "",
      stderr: "",
      nativeHostilityReads: 0
    });

    const checkerPost = await receipt<IngressReceipt>(["ingress", "open_root", "returned", "species", "checker"]);
    expect(checkerPost).toEqual({
      entry: "checker",
      rawMode: "returned",
      responseMode: "species",
      outcome: "CHECK:0",
      stdout: "{\"schema_version\":\"shud.git-status-capability.contract-check-receipt.v1\",\"status\":\"ok\",\"input_kind\":\"source_input_record\"}\n",
      stderr: "",
      rawCalls: 1,
      nativeHostilityReads: 0
    });

    const directPre = await receipt<IngressReceipt>(["ingress", "open_root", "pre", "ordinary", "direct"]);
    expect(directPre).toEqual({
      entry: "direct",
      rawMode: "pre",
      responseMode: "ordinary",
      outcome: "CONTRACT_SCHEMA_INVALID",
      stdout: "",
      stderr: "",
      rawCalls: 0,
      nativeHostilityReads: 0
    });

    const checkerPre = await receipt<IngressReceipt>(["ingress", "open_root", "pre", "sink", "checker"]);
    expect(checkerPre).toEqual({
      entry: "checker",
      rawMode: "pre",
      responseMode: "sink",
      outcome: "CHECK:2",
      stdout: "",
      stderr: "{\"schema_version\":\"shud.git-status-capability.contract-error.v1\",\"status\":\"error\",\"code\":\"CONTRACT_SCHEMA_INVALID\"}\n",
      rawCalls: 0,
      nativeHostilityReads: 0
    });
  });
});
