import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withProductionTree } from "./authority-descriptor-vocabulary";

type Target = "open_root" | "openat" | "fstat_sync" | "read_sync" | "close_sync";
type RawMode = "returned" | "threw" | "pre";
type PromiseResponse = "ordinary" | "constructor" | "species" | "sink";
type ResponseMode = PromiseResponse | "value" | "throw" | "sentinel" | "thenable" | "proxy";
type ChildResult = Readonly<{ exit: number; stdout: string; stderr: string }>;
type RejectionListenerSnapshot = Readonly<{ unhandledRejection: number; rejectionHandled: number }>;
type MatrixReceipt = Readonly<{
  target: Target;
  rawMode: RawMode;
  responseMode: ResponseMode;
  outcome: Readonly<{ message: string; exactRaw: boolean }>;
  rawCalls: number;
  operations: readonly Target[];
  rawOperations: readonly Target[];
  callbackReturnedUndefined: boolean;
  thenGetterReads: number;
  proxyTrapReads: number;
  nativeHostilityReads: number;
  rejectionListenersBeforeOperation: RejectionListenerSnapshot;
  rejectionListenersAfterOperation: RejectionListenerSnapshot;
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
  rawThrows: number;
  laterOutcome: string | null;
  thenGetterReads: number;
  proxyTrapReads: number;
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
  responseMode: ResponseMode;
  outcome: Readonly<{ message: string; exactRaw: boolean }>;
  rawCalls: number;
  proxyTrapReads: number;
  exactPreInvocationOutcome: boolean | null;
}>;
type HookForwardingReceipt = Readonly<{
  cleanupOutcome: string;
  closeFaultGetterReadsAtAdmission: number;
  closeFaultGetterReads: number;
  closeFaultCalls: number;
  closeFaultReceiverMatches: boolean;
  closeAttemptCalls: number;
  closeAttemptReceiverMatches: boolean;
  authorityOutcome: string;
  authorityCalls: number;
  authorityReceiverMatches: boolean;
}>;
type HostileHooksReceipt = Readonly<{
  directOutcome: string;
  checkerExit: number;
  stdout: string;
  stderr: string;
  ownKeysReads: number;
  getReads: number;
  getPrototypeReads: number;
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
const PRODUCTION_ROOT_ENV = "SHUD_DESCRIPTOR_PRODUCTION_ROOT";
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

function expectNoOperationTimeRejectionListenerDelta(receipt: MatrixReceipt): void {
  expect(receipt.rejectionListenersAfterOperation).toEqual(receipt.rejectionListenersBeforeOperation);
}

function injectOperationTimeRejectionListener(source: string): string {
  const anchor = '  descriptorPrimitiveMediationState = "callback";';
  if (!source.includes(anchor)) throw new Error("operation-time listener mutation anchor is absent");
  return source.replace(
    anchor,
    '  process["once"]("unhandledRejection", () => undefined);\n' + anchor
  );
}

function injectExecutedThirdCloseArgument(source: string): string {
  const anchor = '    if (injectedFault || closeError || hookError) throw new Error("CONTRACT_CAPABILITY_CLOSE_FAILED");';
  if (!source.includes(anchor)) throw new Error("third-close-argument mutation anchor is absent");
  return source.replace(
    anchor,
    "    const runtimeThirdArgument = arguments[2] as unknown as (() => void) | undefined;\n" +
      "    runtimeThirdArgument?.();\n" +
      anchor
  );
}


function injectPostRawProxyInspection(source: string): string {
  const anchor = "  primitiveError = undefined;";
  if (!source.includes(anchor)) throw new Error("post-raw Proxy mutation anchor is absent");
  return source.replace(
    anchor,
    `${anchor}\n  if (mediatorThrew) Reflect.ownKeys(mediatorError as object);`
  );
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
      rejectionListenersBefore: Readonly<{ unhandledRejection: number; rejectionHandled: number }>;
      rejectionListenersAfterImport: Readonly<{ unhandledRejection: number; rejectionHandled: number }>;
      rejectionListenersAfterInstall: Readonly<{ unhandledRejection: number; rejectionHandled: number }>;
    }>>(["installer"]);
    expect(installed).toMatchObject({
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
    expect(installed.rejectionListenersAfterImport).toEqual(installed.rejectionListenersBefore);
    expect(installed.rejectionListenersAfterInstall).toEqual(installed.rejectionListenersBefore);
  });

  test("no-installer behavior remains direct, leaves rejection listeners untouched, and exposes exactly the frozen runtime namespace", async () => {
    const defaultReceipt = await receipt<Readonly<{
      directory: boolean;
      moduleExports: readonly string[];
      rejectionListenersBefore: Readonly<{ unhandledRejection: number; rejectionHandled: number }>;
      rejectionListenersAfter: Readonly<{ unhandledRejection: number; rejectionHandled: number }>;
    }>>(["default"]);
    expect(defaultReceipt.directory).toBe(true);
    expect(defaultReceipt.rejectionListenersAfter).toEqual(defaultReceipt.rejectionListenersBefore);
    expect(defaultReceipt.moduleExports).toEqual([
      "ContractCapabilities",
      "DESCRIPTOR_OPERATION_POLICY",
      "DIRECTORY_OPEN_FLAGS",
      "FILE_OPEN_FLAGS",
      "installDescriptorPrimitiveMediator"
    ]);
  });


  test("a third runtime close argument cannot execute during a direct terminal raw close", async () => {
    expect(await receipt<Readonly<{
      rawCalls: number;
      thirdArgumentCalls: number;
      outcome: string;
    }>>(["third_arg"])).toEqual({
      rawCalls: 1,
      thirdArgumentCalls: 0,
      outcome: "NO_ERROR"
    });
  });

  test("the third-argument runtime oracle kills an executed-arguments mutation", async () => {
    await withProductionTree(undefined, async (tree) => {
      const source = await readFile(tree.capabilitiesPath, "utf8");
      await writeFile(tree.capabilitiesPath, injectExecutedThirdCloseArgument(source));
      expect(await receipt<Readonly<{
        rawCalls: number;
        thirdArgumentCalls: number;
        outcome: string;
      }>>(["third_arg"], tree.root)).toEqual({
        rawCalls: 1,
        thirdArgumentCalls: 1,
        outcome: "THIRD_RUNTIME_CLOSE_ARGUMENT_EXECUTED"
      });
    });
  });

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
        }>>(["close_retry", "open_root", "returned", response, entry]);
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
      }>>(["close_retry", "open_root", "returned", "sentinel", entry]);
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
      const direct = await receipt<DirectCloseReceipt>([
        "direct_close",
        "close_sync",
        "pre",
        responseMode
      ]);
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
      const direct = await receipt<DirectCloseReceipt>([
        "direct_close",
        "close_sync",
        "pre",
        "throw"
      ], tree.root);
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
      const direct = await receipt<DirectNoRawRetryReceipt>([
        "direct_no_raw_retry",
        "close_sync",
        "returned",
        mode
      ]);
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
        const direct = await receipt<DirectNoRawRetryReceipt>([
          "direct_no_raw_retry",
          "close_sync",
          "returned",
          mode
        ], tree.root);
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
      }>>(["close_retry", "open_root", "returned", "value", "direct"], tree.root);
      expect(mutated).toMatchObject({
        outcome: "NO_ERROR",
        rawCallsWhenFirstCloseFault: 0
      });
    });
  });

  test("ingress forwards prototype hooks lazily on the original receiver and normalizes hostile hook objects", async () => {
    const forwarding = await receipt<HookForwardingReceipt>(["hook_forwarding"]);
    expect(forwarding).toMatchObject({
      cleanupOutcome: "CONTRACT_SCHEMA_INVALID",
      closeFaultGetterReadsAtAdmission: 0,
      closeFaultReceiverMatches: true,
      closeAttemptReceiverMatches: true,
      authorityOutcome: "CONTRACT_SCHEMA_INVALID",
      authorityCalls: 1,
      authorityReceiverMatches: true
    });
    expect(forwarding.closeFaultGetterReads).toBeGreaterThan(0);
    expect(forwarding.closeFaultCalls).toBeGreaterThan(0);
    expect(forwarding.closeAttemptCalls).toBeGreaterThan(0);

    const hostile = await receipt<HostileHooksReceipt>(["hostile_hooks"]);
    expect(hostile).toEqual({
      directOutcome: "CONTRACT_SCHEMA_INVALID",
      checkerExit: 2,
      stdout: "",
      stderr: "{\"schema_version\":\"shud.git-status-capability.contract-error.v1\",\"status\":\"error\",\"code\":\"CONTRACT_SCHEMA_INVALID\"}\n",
      ownKeysReads: 0,
      getReads: expect.any(Number),
      getPrototypeReads: 0
    });
    expect(hostile.getReads).toBeGreaterThan(0);
  });

  test("retained invoke closures expire without retaining a completed raw read buffer", async () => {
    expect(await receipt<Readonly<{ expired: string; collected: boolean }>>(["gc"])).toEqual({
      expired: EXPIRED_ERROR,
      collected: true
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

    const postInvokeThrownProxy = await receipt<ControlReceipt>(["control", "open_root", "returned", "throw"]);
    expect(postInvokeThrownProxy).toMatchObject({
      outcome: "NO_ERROR",
      rawCalls: 1,
      reentry: REENTRY_ERROR,
      callbackReturnedUndefined: true
    });
    expectNoMediatorInspection(postInvokeThrownProxy);

    const reentry = await receipt<ControlReceipt>(["control", "open_root", "returned", "sink"]);
    expect(reentry).toMatchObject({
      outcome: "NO_ERROR",
      rawCalls: 1,
      repeated: REPEATED_ERROR,
      reentry: REENTRY_ERROR,
      callbackReturnedUndefined: true
    });
  });

  test("all five primitives preserve raw return or throw over hostile post-raw mediator values", async () => {
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
          expect(row.operations).toEqual(row.rawOperations);
          expect(row.callbackReturnedUndefined).toBe(true);
          expect(row.outcome).toEqual(expectedRawOutcome(target, rawMode));
          expectNoMediatorInspection(row);
          expectNoOperationTimeRejectionListenerDelta(row);
          if (row.fdBefore !== null && row.fdAfter !== null) expect(row.fdAfter).toBe(row.fdBefore);
        }
      }
    }
  });

  test("the post-raw hostile Proxy matrix kills reflective inspection across every primitive outcome", async () => {
    await withProductionTree(undefined, async (tree) => {
      const source = await readFile(tree.capabilitiesPath, "utf8");
      await writeFile(tree.capabilitiesPath, injectPostRawProxyInspection(source));
      for (const target of TARGETS) {
        for (const rawMode of ["returned", "threw"] as const) {
          const row = await receipt<MatrixReceipt>(["matrix", target, rawMode, "throw"], tree.root);
          expect(row.proxyTrapReads).toBeGreaterThan(0);
        }
      }
    });
  });

  test("the operation-time listener receipt kills a computed alternate listener mutation", async () => {
    await withProductionTree(undefined, async (tree) => {

      const source = await readFile(tree.capabilitiesPath, "utf8");
      await writeFile(tree.capabilitiesPath, injectOperationTimeRejectionListener(source));
      const row = await receipt<MatrixReceipt>(
        ["matrix", "open_root", "returned", "ordinary"],
        tree.root
      );
      expect(row.rejectionListenersAfterOperation.unhandledRejection).toBeGreaterThan(
        row.rejectionListenersBeforeOperation.unhandledRejection
      );
      expect(row.rejectionListenersAfterOperation.rejectionHandled).toBe(
        row.rejectionListenersBeforeOperation.rejectionHandled
      );
    });
  });

  test("pre-invocation non-undefined returns fail closed without property access or selected raw work", async () => {
    for (const target of TARGETS) {
      for (const responseMode of [...PROMISE_RESPONSES, "value"] as const) {
        const row = await receipt<MatrixReceipt>(["matrix", target, "pre", responseMode]);
        expect(row.rawCalls).toBe(0);
        expect(row.callbackReturnedUndefined).toBe(false);
        expect(row.outcome).toEqual({
          message: ASYNC_ERROR,
          exactRaw: false
        });
        expectNoMediatorInspection(row);
        expectNoOperationTimeRejectionListenerDelta(row);
      }
    }
  });

  test("pre-invocation thrown sentinel and Proxy values perform no raw work or inspection", async () => {
    for (const target of TARGETS) {
      for (const responseMode of ["throw", "sentinel"] as const) {
        const row = await receipt<MatrixReceipt>(["matrix", target, "pre", responseMode]);
        expect(row.rawCalls).toBe(0);
        expect(row.callbackReturnedUndefined).toBe(false);
        expect(row.outcome).toEqual({
          message: responseMode === "throw" ? "MEDIATOR_THROWN_PROXY" : "MEDIATOR_THROWN_SENTINEL",
          exactRaw: false
        });
        expectNoMediatorInspection(row);
        expectNoOperationTimeRejectionListenerDelta(row);
      }
    }
  });

  test("ordinary thenable getters and Proxy traps remain unread before and after raw invocation", async () => {
    for (const target of TARGETS) {
      for (const responseMode of ["thenable", "proxy"] as const) {
        const before = await receipt<MatrixReceipt>(["matrix", target, "pre", responseMode]);
        expect(before.rawCalls).toBe(0);
        expect(before.outcome.message).toBe(ASYNC_ERROR);
        expectNoMediatorInspection(before);
        expectNoOperationTimeRejectionListenerDelta(before);

        for (const rawMode of ["returned", "threw"] as const) {
          const after = await receipt<MatrixReceipt>(["matrix", target, rawMode, responseMode]);
          expect(after.rawCalls).toBe(1);
          expect(after.outcome).toEqual(expectedRawOutcome(target, rawMode));
          expectNoMediatorInspection(after);
          expectNoOperationTimeRejectionListenerDelta(after);
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
      rawThrows: 0,
      thenGetterReads: 0,
      proxyTrapReads: 0,
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
      rawThrows: 0,
      laterOutcome: null,
      thenGetterReads: 0,
      proxyTrapReads: 0,
      nativeHostilityReads: 0
    });

    const directCloseThrow = await receipt<IngressReceipt>(["ingress", "close_sync", "threw", "ordinary", "direct"]);
    expect(directCloseThrow).toMatchObject({
      entry: "direct",
      rawMode: "threw",
      responseMode: "ordinary",
      outcome: "CONTRACT_SCHEMA_INVALID",
      stdout: "",
      stderr: "",
      rawThrows: 1,
      laterOutcome: expect.stringMatching(/^BYTES:[1-9]\d*$/),
      thenGetterReads: 0,
      proxyTrapReads: 0,
      nativeHostilityReads: 0
    });
    expect(directCloseThrow.rawCalls).toBeGreaterThan(1);

    const checkerCloseThrow = await receipt<IngressReceipt>(["ingress", "close_sync", "threw", "ordinary", "checker"]);
    expect(checkerCloseThrow).toMatchObject({
      entry: "checker",
      rawMode: "threw",
      responseMode: "ordinary",
      outcome: "CHECK:2",
      stdout: "",
      stderr: "{\"schema_version\":\"shud.git-status-capability.contract-error.v1\",\"status\":\"error\",\"code\":\"CONTRACT_SCHEMA_INVALID\"}\n",
      rawThrows: 1,
      laterOutcome: expect.stringMatching(/^BYTES:[1-9]\d*$/),
      thenGetterReads: 0,
      proxyTrapReads: 0,
      nativeHostilityReads: 0
    });
    expect(checkerCloseThrow.rawCalls).toBeGreaterThan(1);

    const directPre = await receipt<IngressReceipt>(["ingress", "open_root", "pre", "ordinary", "direct"]);
    expect(directPre).toEqual({
      entry: "direct",
      rawMode: "pre",
      responseMode: "ordinary",
      outcome: "CONTRACT_SCHEMA_INVALID",
      stdout: "",
      stderr: "",
      rawCalls: 0,
      rawThrows: 0,
      laterOutcome: null,
      thenGetterReads: 0,
      proxyTrapReads: 0,
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
      laterOutcome: null,
      rawThrows: 0,
      thenGetterReads: 0,
      proxyTrapReads: 0,
      nativeHostilityReads: 0
    });

    const directPreThrow = await receipt<IngressReceipt>(["ingress", "open_root", "pre", "throw", "direct"]);
    expect(directPreThrow).toEqual({
      entry: "direct",
      rawMode: "pre",
      responseMode: "throw",
      outcome: "CONTRACT_SCHEMA_INVALID",
      stdout: "",
      stderr: "",
      rawCalls: 0,
      laterOutcome: null,
      rawThrows: 0,
      thenGetterReads: 0,
      proxyTrapReads: 0,
      nativeHostilityReads: 0
    });

    const checkerPreThrow = await receipt<IngressReceipt>(["ingress", "open_root", "pre", "throw", "checker"]);
    expect(checkerPreThrow).toEqual({
      entry: "checker",
      rawMode: "pre",
      responseMode: "throw",
      outcome: "CHECK:2",
      stdout: "",
      stderr: "{\"schema_version\":\"shud.git-status-capability.contract-error.v1\",\"status\":\"error\",\"code\":\"CONTRACT_SCHEMA_INVALID\"}\n",
      rawCalls: 0,
      laterOutcome: null,
      rawThrows: 0,
      thenGetterReads: 0,
      proxyTrapReads: 0,
      nativeHostilityReads: 0
    });
  });
});
