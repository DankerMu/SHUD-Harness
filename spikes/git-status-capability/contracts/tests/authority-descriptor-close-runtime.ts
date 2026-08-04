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
  | "unlatched_hook_lookup"
  | "unvalidated_authority_fault"
  | "unlatched_before_cleanup"
  | "awaited_admission_return"
  | undefined;
export type CloseRuntimeTree = Readonly<{ root: string }>;
export type RejectionSinkDenial =
  | "rejection_listener_registration"
  | "promise_sink_peek"
  | "promise_identity_rewrite";
/** #189.D: the boundary awaits no mediator-supplied value anywhere in `lib/`. */
export type MediatedAwaitDenial = "awaited_mediator_value";

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
  // #189 F5: the thrown rejection message is interpolated from the fault the
  // caller supplied, so a foreign mediator value is coerced by the template
  // literal - outside the latch, with every descriptor still open.
  if (mutation === "unvalidated_authority_fault") {
    return replaceAnchor(
      source,
      '    if (!isContractAuthorityFault(fault)) throw new Error("CONTRACT_CAPABILITY_FAULT_INVALID");\n' +
        "    withCapabilityCallback(() => this.hooks.onAuthorityViolation?.(fault));\n" +
        "    throw new Error(AUTHORITY_FAULT_MESSAGES[fault]);",
      "    withCapabilityCallback(() => this.hooks.onAuthorityViolation?.(fault));\n" +
        "    throw new Error(`CONTRACT_CAPABILITY_FORBIDDEN_${fault}`);",
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
      "    const authorityFault = withCapabilityCallback(() => admittedAuthorityFault(hooks));\n" +
        '    if (authorityFault) context.rejectForbidden(authorityFault, "post_admission");',
      "    if (admittedAuthorityFault(hooks)) {\n" +
        '      context.rejectForbidden(admittedAuthorityFault(hooks)!, "post_admission");\n    }',
      mutation
    );
  }
  // #189 F5: the mediator value leaves the latch unvalidated, so the coercion
  // the rejection performs on it runs with the latch disarmed.
  if (mutation === "unvalidated_authority_fault") {
    return replaceAnchor(
      source,
      "    const authorityFault = withCapabilityCallback(() => admittedAuthorityFault(hooks));",
      "    const authorityFault = withCapabilityCallback(() => hooks.authorityFault);",
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
  // #189.D: the pre-decision choke-point, reinstated. The hook's return value is
  // awaited whenever it is a promise by internal slot, so the boundary suspends
  // between the sealed admission and its verification, and a mediator that
  // resolves that promise to a thenable it registered outside every latch
  // strands the operation there with every retained descriptor open.
  if (mutation === "awaited_admission_return") {
    return replaceAnchor(
      replaceAnchor(
        source,
        'import { parse, resolve, sep } from "node:path";',
        'import { parse, resolve, sep } from "node:path";\nimport { isPromise } from "node:util/types";',
        mutation
      ),
      "    withCapabilityCallback(() => hooks.afterAdmission?.(admission!.logicalAbsolutePath));",
      "    const admitted: unknown = withCapabilityCallback(\n" +
        "      () => hooks.afterAdmission?.(admission!.logicalAbsolutePath)\n" +
        "    );\n" +
        "    if (isPromise(admitted)) await admitted;",
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

/** Every checked-in library source, with the requested mutation applied. */
export async function librarySources(
  mutation: CloseRuntimeMutation
): Promise<readonly Readonly<{ name: string; source: string }>[]> {
  const names = (await readdir(libraryRoot)).filter((name) => name.endsWith(".ts")).sort();
  return Object.freeze(await Promise.all(names.map(async (name) => {
    const source = await readFile(join(libraryRoot, name), "utf8");
    return Object.freeze({
      name,
      source: name === "capabilities.ts"
        ? capabilitiesMutation(source, mutation)
        : name === "ingress.ts"
        ? ingressMutation(source, mutation)
        : source
    });
  })));
}

/**
 * #189.D structural oracle: `lib/` awaits no mediator-supplied value anywhere.
 *
 * The allowlist is derived from the library itself rather than from a name list,
 * so it cannot drift: an `await` is admitted only when its operand is a plain
 * call of an `async function` declared somewhere in `lib/`, which is work the
 * boundary owns end to end. Every other operand - a variable holding a hook's
 * return value, a property or optional call on the caller's hooks object, a call
 * of an imported or higher-order function that could hand back a mediator value
 * - is denied, as is `for await`. Formatting, comments, and string literals
 * cannot affect the verdict because the scan is over the parsed AST, and an
 * unparsed source fails closed, exactly as `rejectionSinkDenials` does.
 */
export function mediatedAwaitDenials(
  sources: readonly Readonly<{ name: string; source: string }>[]
): readonly MediatedAwaitDenial[] {
  const denied = Object.freeze(["awaited_mediator_value" as const]);
  const parsedSources: ts.SourceFile[] = [];
  for (const { name, source } of sources) {
    const sourceFile = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    const parsed = sourceFile as unknown as Readonly<{ parseDiagnostics?: readonly unknown[] }>;
    if ((parsed.parseDiagnostics?.length ?? 0) > 0) return denied;
    parsedSources.push(sourceFile);
  }

  const libraryOwnedAsyncFunctions = new Set<string>();
  const collect = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name !== undefined &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    ) {
      libraryOwnedAsyncFunctions.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  for (const sourceFile of parsedSources) collect(sourceFile);

  let mediated = false;
  const visit = (node: ts.Node): void => {
    if (ts.isForOfStatement(node) && node.awaitModifier !== undefined) mediated = true;
    if (ts.isAwaitExpression(node)) {
      const operand = node.expression;
      const owned = ts.isCallExpression(operand) &&
        ts.isIdentifier(operand.expression) &&
        operand.questionDotToken === undefined &&
        libraryOwnedAsyncFunctions.has(operand.expression.text);
      if (!owned) mediated = true;
    }
    ts.forEachChild(node, visit);
  };
  for (const sourceFile of parsedSources) visit(sourceFile);
  return mediated ? denied : Object.freeze([]);
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
