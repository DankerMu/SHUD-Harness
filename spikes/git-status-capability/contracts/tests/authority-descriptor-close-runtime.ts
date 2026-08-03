import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

export type CloseRuntimeMutation =
  | "contextual_raw_start"
  | "release_first_owner"
  | "instanceof_recognition"
  | "has_probe_recognition"
  | "property_probe_recognition"
  | "returned_value_inspection"
  | "own_property_hook_gate"
  | "aliased_rejection_listener"
  | "detached_bun_peek"
  | "promise_identity_rewrite"
  | "remove_reentry_guard"
  | "read_off_by_one"
  | "async_unlatched_callback"
  | "suspended_global_latch"
  | "unlatched_hook_lookup"
  | "unlatched_before_cleanup"
  | "inspected_admission_return"
  | undefined;
export type CloseRuntimeTree = Readonly<{ root: string }>;
export type RejectionSinkDenial =
  | "rejection_listener_registration"
  | "promise_sink_peek"
  | "promise_identity_rewrite";

const contractsRoot = join(import.meta.dir, "..");
const libraryRoot = join(contractsRoot, "lib");

const REJECTION_SINK_DENIAL_ORDER: readonly RejectionSinkDenial[] = [
  "rejection_listener_registration",
  "promise_sink_peek",
  "promise_identity_rewrite"
];
const LISTENER_REGISTRAR_NAMES: ReadonlySet<string> = new Set([
  "on",
  "once",
  "addListener",
  "prependListener",
  "prependOnceListener",
  "removeListener",
  "off",
  "removeAllListeners"
]);
const REJECTION_EVENT_NAMES: ReadonlySet<string> = new Set(["unhandledRejection", "rejectionHandled"]);
const PROMISE_IDENTITY_NAMES: ReadonlySet<string> = new Set(["Promise", "then"]);

function replaceAnchor(source: string, anchor: string, replacement: string, mutation: string): string {
  if (!source.includes(anchor)) throw new Error(`close runtime ${mutation} mutation anchor is absent`);
  return source.replace(anchor, replacement);
}

function bridgeSource(source: string): string {
  const bridge = `  #invokeRawClose(record: DescriptorRecord, onRawStart: () => void): void {
    const mode = process.env.SHUD_DESCRIPTOR_CLOSE_RUNTIME_BRIDGE;
    if (mode === "omit") return;
    if (mode === "omit_once") {
      process.env.SHUD_DESCRIPTOR_CLOSE_RUNTIME_BRIDGE = "invoke";
      return;
    }
    if (mode === "sibling") {
      process.env.SHUD_DESCRIPTOR_CLOSE_RUNTIME_BRIDGE = "invoke_then_omit";
      (globalThis as { __shudDescriptorSiblingClose?: () => void }).__shudDescriptorSiblingClose?.();
      return;
    }
    if (mode === "invoke_then_omit") {
      process.env.SHUD_DESCRIPTOR_CLOSE_RUNTIME_BRIDGE = "omit";
    }
    onRawStart();
    closeSync(record.fd);
  }`;
  const anchor = `  #invokeRawClose(record: DescriptorRecord, onRawStart: () => void): void {
    onRawStart();
    closeSync(record.fd);
  }`;
  if (!source.includes(anchor)) throw new Error("close runtime bridge anchor is absent");
  return source.replace(anchor, bridge);
}

function capabilitiesMutation(source: string, mutation: CloseRuntimeMutation): string {
  if (mutation === "read_off_by_one") {
    return replaceAnchor(
      source,
      "    return readSync(record.fd, buffer, offset, length, position);",
      "    return readSync(record.fd, buffer, offset, length, position) + 1;",
      mutation
    );
  }
  if (mutation === "remove_reentry_guard") {
    const anchor = "    this.#assertNoCallbackReentry();\n";
    if (!source.includes(anchor)) throw new Error("close runtime remove_reentry_guard anchor is absent");
    return source.replaceAll(anchor, "");
  }
  if (mutation === "returned_value_inspection") {
    return replaceAnchor(
      source,
      "  try {\n    return callbackLatch.run(true, invoke);\n  } finally {\n    capabilityCallbackDepth -= 1;\n  }",
      "  try {\n    const returned = callbackLatch.run(true, invoke);\n" +
        '    if ((typeof returned === "object" || typeof returned === "function") && returned !== null) {\n' +
        "      Reflect.ownKeys(returned as object);\n    }\n" +
        "    return returned;\n  } finally {\n    capabilityCallbackDepth -= 1;\n  }",
      mutation
    );
  }
  // #189 F1: the pre-fix latch, whose synchronous depth releases at the first
  // await of an asynchronous mediator callback, leaving its continuation
  // unlatched.
  if (mutation === "async_unlatched_callback") {
    return replaceAnchor(
      source,
      "    return callbackLatch.run(true, invoke);",
      "    return invoke();",
      mutation
    );
  }
  // The rejected alternative fix: hold the process-global latch across the
  // whole asynchronous callback, which also latches unrelated concurrent
  // operations.
  if (mutation === "suspended_global_latch") {
    return replaceAnchor(
      source,
      "  capabilityCallbackDepth += 1;\n  try {\n    return callbackLatch.run(true, invoke);\n" +
        "  } finally {\n    capabilityCallbackDepth -= 1;\n  }",
      "  capabilityCallbackDepth += 1;\n  let suspended = false;\n  try {\n" +
        "    const returned = callbackLatch.run(true, invoke);\n" +
        "    const thenable = returned as Readonly<{ then?: unknown }> | null | undefined;\n" +
        '    if (thenable && typeof thenable.then === "function") {\n' +
        "      suspended = true;\n" +
        "      const release = (): void => { capabilityCallbackDepth -= 1; };\n" +
        "      (thenable.then as (onDone: () => void, onFail: () => void) => void)" +
        ".call(returned, release, release);\n    }\n" +
        "    return returned;\n  } finally {\n    if (!suspended) capabilityCallbackDepth -= 1;\n  }",
      mutation
    );
  }
  return source;
}

function ingressMutation(source: string, mutation: CloseRuntimeMutation): string {
  if (mutation === "contextual_raw_start") {
    return replaceAnchor(
      source,
      "        this.#attemptsByPublicAttempt.get(attempt)?.markRawStarted();",
      "        this.#activeCloseAttempts.at(-1)?.markRawStarted();",
      mutation
    );
  }
  if (mutation === "release_first_owner") {
    return replaceAnchor(
      source,
      "    for (let owner = this.#liveOwners; owner; owner = owner.next()) {\n      retainPoisonedIngressOwner(owner);",
      "    for (let owner = this.#liveOwners; owner?.next(); owner = owner.next()) {\n      retainPoisonedIngressOwner(owner);",
      mutation
    );
  }
  if (
    mutation === "instanceof_recognition" ||
    mutation === "has_probe_recognition" ||
    mutation === "property_probe_recognition"
  ) {
    const recognition = mutation === "instanceof_recognition"
      ? "  return value instanceof ContractError;"
      : mutation === "has_probe_recognition"
      ? '  return "code" in (value as object);'
      : '  return (value as Readonly<{ name?: unknown }>).name === "ContractError";';
    return replaceAnchor(
      source,
      "  return contractErrorIdentities.has(value as WeakKey);",
      recognition,
      mutation
    );
  }
  if (mutation === "own_property_hook_gate") {
    return replaceAnchor(
      source,
      "        return hooks.closeFault?.(attempt) ?? false;",
      '        if (!Object.hasOwn(hooks, "closeFault")) return false;\n' +
        "        return hooks.closeFault?.(attempt) ?? false;",
      mutation
    );
  }
  if (mutation === "remove_reentry_guard") {
    return replaceAnchor(source, "  assertNoCallbackReentry();\n", "", mutation);
  }
  // #189 F2: the hook property is read in the caller's own frame, so an
  // accessor-form `observe` runs unlatched and `authorityFault` is read twice.
  if (mutation === "unlatched_hook_lookup") {
    return replaceAnchor(
      replaceAnchor(
        source,
        "  withCapabilityCallback(() => hooks.observe?.(operation));",
        "  const observe = hooks.observe;\n  withCapabilityCallback(() => observe?.(operation));",
        mutation
      ),
      "    const authorityFault = withCapabilityCallback(() => hooks.authorityFault);\n" +
        '    if (authorityFault) context.rejectForbidden(authorityFault, "post_admission");',
      '    if (hooks.authorityFault) context.rejectForbidden(hooks.authorityFault, "post_admission");',
      mutation
    );
  }
  // #189 F3: `beforeCleanup` runs unlatched while every admission descriptor is
  // still open.
  if (mutation === "unlatched_before_cleanup") {
    return replaceAnchor(
      source,
      "    withCapabilityCallback(() => beforeCleanup?.(admittedBytes));",
      "    beforeCleanup?.(admittedBytes);",
      mutation
    );
  }
  // #189 F4: the raw await inspects the returned value's `then` property and
  // adopts a hostile thenable, so the operation can never settle.
  if (mutation === "inspected_admission_return") {
    return replaceAnchor(
      source,
      "    const admitted = withCapabilityCallback(() => hooks.afterAdmission?.(admission!.logicalAbsolutePath));\n" +
        "    if (isPromise(admitted)) await admitted;",
      "    await withCapabilityCallback(() => hooks.afterAdmission?.(admission!.logicalAbsolutePath));",
      mutation
    );
  }
  if (
    mutation === "aliased_rejection_listener" ||
    mutation === "detached_bun_peek" ||
    mutation === "promise_identity_rewrite"
  ) {
    const sink = mutation === "aliased_rejection_listener"
      ? "  const rejectionRegistrar = (process as unknown as Readonly<Record<string, (...args: unknown[]) => unknown>>)[\"addListener\"]!;\n" +
        "  const rejectionRemover = (process as unknown as Readonly<Record<string, (...args: unknown[]) => unknown>>)[\"removeListener\"]!;\n" +
        "  const rejectionSink = (): void => undefined;\n" +
        "  rejectionRegistrar.call(process, \"unhandledRejection\", rejectionSink);\n" +
        "  rejectionRemover.call(process, \"unhandledRejection\", rejectionSink);\n"
      : mutation === "detached_bun_peek"
      ? "  const detachedPeek = (Bun as unknown as Readonly<{ peek: (value: unknown) => unknown }>).peek;\n" +
        "  detachedPeek(Promise.resolve(0));\n"
      : "  (globalThis as unknown as { Promise: unknown }).Promise = class RewrittenPromise extends Promise<unknown> {};\n";
    return replaceAnchor(
      source,
      "  assertNoCallbackReentry();\n",
      `  assertNoCallbackReentry();\n${sink}`,
      mutation
    );
  }
  return source;
}

function ingressProbeSource(source: string, mutation: CloseRuntimeMutation): string {
  let result = ingressMutation(source, mutation);
  if (!result.includes("let retainedPoisonedIngressOwners")) {
    return `${result}\nexport function __testIngressCloseState(): Readonly<{\n  activeContextCount: number; liveDescriptors: readonly object[]; retainedDescriptors: readonly object[];\n}> {\n  return Object.freeze({ activeContextCount: 0, liveDescriptors: Object.freeze([]), retainedDescriptors: Object.freeze([]) });\n}\n`;
  }

  const nodeAnchor = `  retainedNext(): IngressOwnerNode | undefined {\n    return this.#retainedNext;\n  }\n}`;
  if (!result.includes(nodeAnchor)) throw new Error("ingress owner probe anchor is absent");
  result = result.replace(nodeAnchor, `  retainedNext(): IngressOwnerNode | undefined {\n    return this.#retainedNext;\n  }\n\n  descriptorForTest(): CapabilityDescriptor {\n    return this.descriptor;\n  }\n}`);

  const contextAnchor = `  nextActive(): ActiveIngressContext | undefined {`;
  if (!result.includes(contextAnchor)) throw new Error("ingress live-owner probe anchor is absent");
  result = result.replace(
    contextAnchor,
    `  liveDescriptorsForTest(): readonly CapabilityDescriptor[] {\n` +
      `    const descriptors: CapabilityDescriptor[] = [];\n` +
      `    for (let owner = this.#liveOwners; owner; owner = owner.next()) descriptors.push(owner.descriptorForTest());\n` +
      `    return Object.freeze(descriptors);\n  }\n\n${contextAnchor}`
  );
  return `${result}\nexport function __testIngressCloseState(): Readonly<{\n  activeContextCount: number; liveDescriptors: readonly CapabilityDescriptor[]; retainedDescriptors: readonly CapabilityDescriptor[];\n}> {\n  let activeContextCount = 0;\n  const liveDescriptors: CapabilityDescriptor[] = [];\n  for (let context = activeIngressContexts; context; context = context.nextActive()) {\n    activeContextCount += 1;\n    liveDescriptors.push(...context.liveDescriptorsForTest());\n  }\n  const retainedDescriptors: CapabilityDescriptor[] = [];\n  for (let owner = retainedPoisonedIngressOwners; owner; owner = owner.retainedNext()) {\n    retainedDescriptors.push(owner.descriptorForTest());\n  }\n  return Object.freeze({\n    activeContextCount,\n    liveDescriptors: Object.freeze(liveDescriptors),\n    retainedDescriptors: Object.freeze(retainedDescriptors)\n  });\n}\n`;
}

async function copyLibrary(root: string, mutation: CloseRuntimeMutation): Promise<void> {
  const copiedLibraryRoot = join(root, "lib");
  await mkdir(copiedLibraryRoot, { recursive: true });
  const names = (await readdir(libraryRoot)).filter((name) => name.endsWith(".ts"));
  await Promise.all(names.map(async (name) => {
    const source = await readFile(join(libraryRoot, name), "utf8");
    const copied = name === "capabilities.ts"
      ? capabilitiesMutation(bridgeSource(source), mutation)
      : name === "ingress.ts"
      ? ingressProbeSource(source, mutation)
      : source;
    await writeFile(join(copiedLibraryRoot, name), copied);
  }));
}

export async function withCloseRuntimeTree(
  mutation: CloseRuntimeMutation,
  action: (tree: CloseRuntimeTree) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "shud-close-runtime-"));
  try {
    await copyLibrary(root, mutation);
    await action(Object.freeze({ root }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function mediationSources(mutation: CloseRuntimeMutation): Promise<readonly string[]> {
  const [capabilities, ingress] = await Promise.all([
    readFile(join(libraryRoot, "capabilities.ts"), "utf8"),
    readFile(join(libraryRoot, "ingress.ts"), "utf8")
  ]);
  return Object.freeze([
    capabilitiesMutation(capabilities, mutation),
    ingressMutation(ingress, mutation)
  ]);
}

/**
 * Alias-aware rejection-sink oracle. It denies every syntactic route to a
 * global rejection listener, a `peek` promise sink, or a Promise identity
 * rewrite, including computed member access, detached aliases, and transient
 * add-then-remove pairs, because it matches the accessed name rather than a
 * receiver expression.
 */
export function rejectionSinkDenials(source: string): readonly RejectionSinkDenial[] {
  const sourceFile = ts.createSourceFile("mediation.ts", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const denials = new Set<RejectionSinkDenial>();
  // An unparsed source cannot be cleared: fail closed on every sink.
  const parsed = sourceFile as unknown as Readonly<{ parseDiagnostics?: readonly unknown[] }>;
  if ((parsed.parseDiagnostics?.length ?? 0) > 0) return REJECTION_SINK_DENIAL_ORDER;

  const accessedName = (node: ts.Node): string | undefined => {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      return node.argumentExpression.text;
    }
    return undefined;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) && REJECTION_EVENT_NAMES.has(node.text)) {
      denials.add("rejection_listener_registration");
    }
    if (ts.isIdentifier(node) && node.text === "peek") denials.add("promise_sink_peek");
    const name = accessedName(node);
    if (name !== undefined) {
      if (LISTENER_REGISTRAR_NAMES.has(name)) denials.add("rejection_listener_registration");
      if (name === "peek") denials.add("promise_sink_peek");
      if (PROMISE_IDENTITY_NAMES.has(name)) denials.add("promise_identity_rewrite");
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      PROMISE_IDENTITY_NAMES.has(node.left.text)
    ) {
      denials.add("promise_identity_rewrite");
    }
    if (
      (ts.isClassDeclaration(node) || ts.isClassExpression(node)) &&
      node.heritageClauses?.some((clause) => clause.types.some((type) =>
        ts.isIdentifier(type.expression) && type.expression.text === "Promise"
      ))
    ) {
      denials.add("promise_identity_rewrite");
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return REJECTION_SINK_DENIAL_ORDER.filter((denial) => denials.has(denial));
}
