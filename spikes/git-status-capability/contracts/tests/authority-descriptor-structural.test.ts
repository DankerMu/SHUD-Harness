import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import {
  capabilitiesSourcePath,
  structuralDescriptorDenials,
  withCompiledProductionTree,
  type ProductionMutation
} from "./authority-descriptor-vocabulary";

const EXPECTED_STRUCTURAL_DENIAL: Readonly<Record<ProductionMutation, readonly string[]>> = Object.freeze({
  fd0: ["raw_read_descriptor_not_handle"],
  at_fdcwd: ["openat_parent_not_handle"],
  fstat0: ["raw_fstat_descriptor_not_handle"],
  close0: ["raw_close_descriptor_not_handle"],
  before_deny_fstat: ["raw_read_descriptor_not_handle", "raw_fstat_descriptor_not_handle"],
  raw_descriptor: ["raw_descriptor_operation_shape"],
  foreign_descriptor: ["foreign_descriptor_shape"],
  stale_descriptor: ["stale_descriptor_shape"],
  invalid_flags: ["flags_invalid_shape"],
  invalid_owner: ["owner_mismatch_shape"]
});

function replaceSourceAnchor(source: string, anchor: string, replacement: string): string {
  if (!source.includes(anchor)) throw new Error(`structural AST test anchor is absent: ${anchor}`);
  return source.replace(anchor, replacement);
}

const REJECTION_EVENTS: Readonly<Record<string, true>> = Object.freeze({
  unhandledRejection: true,
  rejectionHandled: true
});
const PROCESS_LISTENER_METHODS: Readonly<Record<string, true>> = Object.freeze({
  on: true,
  once: true,
  addListener: true,
  prependListener: true,
  prependOnceListener: true
});
const CAPABILITY_HOOK_NAMES = Object.freeze([
  "closeFault",
  "onCloseAttempt",
  "onAuthorityViolation",
  "onDescriptorAuthorityDenial"
] as const);
const ingressSourcePath = join(import.meta.dir, "../lib/ingress.ts");

function staticMemberName(node: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (!ts.isElementAccessExpression(node)) return undefined;
  const argument = node.argumentExpression;
  if (!argument || (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument))) {
    return undefined;
  }
  return argument.text;
}

function staticString(node: ts.Expression | undefined): string | undefined {
  if (!node || (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node))) {
    return undefined;
  }
  return node.text;
}

function isNamedReceiver(node: ts.Expression, name: string): boolean {
  return ts.isIdentifier(node) && node.text === name;
}

function isPromiseIdentityRewrite(left: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(left)) return left.name.text === "constructor";
  if (!ts.isElementAccessExpression(left)) return false;
  const argument = left.argumentExpression;
  return Boolean(
    argument &&
      ts.isPropertyAccessExpression(argument) &&
      ts.isIdentifier(argument.expression) &&
      argument.expression.text === "Symbol" &&
      argument.name.text === "species"
  );
}

function forbiddenMediatorRuntimeUses(source: string): readonly string[] {
  const tree = ts.createSourceFile("capabilities.ts", source, ts.ScriptTarget.ES2022, true);
  const forbidden: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
        isNamedReceiver(callee.expression, "process") &&
        PROCESS_LISTENER_METHODS[staticMemberName(callee) ?? ""] &&
        REJECTION_EVENTS[staticString(node.arguments[0]) ?? ""]
      ) {
        forbidden.push("rejection_listener");
      }
      if (
        (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
        isNamedReceiver(callee.expression, "Bun") &&
        staticMemberName(callee) === "peek"
      ) {
        forbidden.push("bun_peek");
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isPromiseIdentityRewrite(node.left)
    ) {
      forbidden.push("promise_identity_rewrite");
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return forbidden;
}

function guardedHooksObject(source: string): ts.ObjectLiteralExpression | undefined {
  const tree = ts.createSourceFile("ingress.ts", source, ts.ScriptTarget.ES2022, true);
  let guardedHooks: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "guardedHooks" &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.arguments.length === 1 &&
      ts.isObjectLiteralExpression(node.initializer.arguments[0])
    ) {
      guardedHooks = node.initializer.arguments[0];
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return guardedHooks;
}

function forwardsOriginalHook(property: ts.ObjectLiteralElementLike, hookName: string): boolean {
  if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || property.name.text !== hookName) {
    return false;
  }
  let forwards = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      isNamedReceiver(node.expression.expression, "hooks") &&
      node.expression.name.text === hookName
    ) {
      forwards = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(property.initializer);
  return forwards;
}

function lazyCapabilityHookForwardingIssues(source: string): readonly string[] {
  const guardedHooks = guardedHooksObject(source);
  if (!guardedHooks) return ["guarded_hooks_missing"];
  const issues: string[] = [];
  if (guardedHooks.properties.some((property) => ts.isSpreadAssignment(property))) {
    issues.push("eager_hook_spread");
  }
  for (const hookName of CAPABILITY_HOOK_NAMES) {
    const property = guardedHooks.properties.find((candidate) =>
      ts.isPropertyAssignment(candidate) &&
      ts.isIdentifier(candidate.name) &&
      candidate.name.text === hookName
    );
    if (!property || !forwardsOriginalHook(property, hookName)) issues.push(hookName);
  }
  return issues;
}

function markRetainedHasRawFstat(source: string): boolean {
  const tree = ts.createSourceFile("capabilities.ts", source, ts.ScriptTarget.ES2022, true);
  let hasRawFstat = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isMethodDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "markRetained" &&
      node.body
    ) {
      const findRawFstat = (candidate: ts.Node): void => {
        if (
          ts.isCallExpression(candidate) &&
          ts.isIdentifier(candidate.expression) &&
          candidate.expression.text === "fstatSync"
        ) {
          hasRawFstat = true;
        }
        ts.forEachChild(candidate, findRawFstat);
      };
      ts.forEachChild(node.body, findRawFstat);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return hasRawFstat;
}

describe("retained descriptor structural authority", () => {
  test("the complete real production tree compiles with only opaque descriptor operands", async () => {
    await withCompiledProductionTree(undefined, async (tree) => {
      expect(structuralDescriptorDenials(await readFile(tree.capabilitiesPath, "utf8"))).toEqual([]);
    });
  });

  test("structural-only oracle rejects the exact ambient mutations and every descriptor vocabulary bypass", async () => {
    for (const [mutation, expected] of Object.entries(EXPECTED_STRUCTURAL_DENIAL) as Array<
      [ProductionMutation, readonly string[]]
    >) {
      await withCompiledProductionTree(mutation, async (tree) => {
        expect(structuralDescriptorDenials(await readFile(tree.capabilitiesPath, "utf8"))).toEqual(expected);
      });
    }
  });

  test("mediation rejects direct, alternate, and computed rejection sinks without Promise rewrites", async () => {
    const source = await readFile(capabilitiesSourcePath, "utf8");
    expect(forbiddenMediatorRuntimeUses(source)).toEqual([]);
    expect(forbiddenMediatorRuntimeUses(`${source}
process.on("unhandledRejection", () => undefined);
process.once("rejectionHandled", () => undefined);
process.addListener("unhandledRejection", () => undefined);
process["prependOnceListener"]("rejectionHandled", () => undefined);
Bun.peek(Promise.resolve());
Bun["peek"](Promise.resolve());
Promise.prototype.constructor = Promise;
Promise[Symbol.species] = Promise;
`)).toEqual([
      "rejection_listener",
      "rejection_listener",
      "rejection_listener",
      "rejection_listener",
      "bun_peek",
      "bun_peek",
      "promise_identity_rewrite",
      "promise_identity_rewrite"
    ]);
  });

  test("ingress forwards every capability hook lazily without an eager object spread", async () => {
    const source = await readFile(ingressSourcePath, "utf8");
    expect(lazyCapabilityHookForwardingIssues(source)).toEqual([]);
    const eagerSpread = replaceSourceAnchor(
      source,
      "  const guardedHooks: CapabilityHooks = Object.freeze({",
      "  const guardedHooks: CapabilityHooks = Object.freeze({\n    ...hooks,"
    );
    expect(lazyCapabilityHookForwardingIssues(eagerSpread)).toEqual(["eager_hook_spread"]);
    const missingDenialForwarder = replaceSourceAnchor(
      source,
      "      hooks.onDescriptorAuthorityDenial?.(denial);",
      "      undefined;"
    );
    expect(lazyCapabilityHookForwardingIssues(missingDenialForwarder)).toEqual([
      "onDescriptorAuthorityDenial"
    ]);
  });

  test("the ordered mediation trace cannot hide a raw fstat wrapper in markRetained", async () => {
    const source = await readFile(capabilitiesSourcePath, "utf8");
    expect(markRetainedHasRawFstat(source)).toBe(false);
    expect(markRetainedHasRawFstat(replaceSourceAnchor(
      source,
      '    record.state = "retained";',
      '    fstatSync(record.fd, { bigint: true });\n    record.state = "retained";'
    ))).toBe(true);
  });

  test("AST structural oracle ignores formatting, comments, strings, and local descriptor decoys", async () => {
    const source = await readFile(capabilitiesSourcePath, "utf8");
    const formattedRawOperands = replaceSourceAnchor(
      replaceSourceAnchor(
        replaceSourceAnchor(
          replaceSourceAnchor(
            source,
            "readSync(record.fd, buffer, offset, length, position)",
            `readSync(
      record
        .fd,
      buffer,
      offset,
      length,
      position
    )`
          ),
          "openAtPrimitive(parentRecord.fd, childPath, flags)",
          `openAtPrimitive(
      parentRecord
        .fd,
      childPath,
      flags
    )`
        ),
        "fstatSync(record.fd, { bigint: true })",
        `fstatSync(
      record
        .fd,
      { bigint: true }
    )`
      ),
      "      closeSync(record.fd);",
      `      closeSync(
        record
          .fd
      );`
    );
    expect(structuralDescriptorDenials(formattedRawOperands)).toEqual([]);

    const sourceWithDecoys = `${source}
/* readSync(0, buffer, offset, length, position); openAt()(-100, childCString(childName), flags); */
const structuralDescriptorTextDecoy = "readSync(0, buffer, offset, length, position); openAt()(-100, childCString(childName), flags);";
function localDescriptorDecoy(): void {
  const descriptor = {};
  const parent = {};
  const record = { fd: 0 };
  const parentRecord = { fd: -100 };
  const readSync = (_descriptor: number): number => 0;
  const fstatSync = (_descriptor: number): number => 0;
  const closeSync = (_descriptor: number): void => undefined;
  const openAt = () => (_parent: number): number => 0;
  readSync(record.fd);
  fstatSync(record.fd);
  closeSync(record.fd);
  openAt()(parentRecord.fd);
}
`;
    expect(structuralDescriptorDenials(sourceWithDecoys)).toEqual([]);
  });

  test("AST structural oracle does not let textual copies counterfeit required descriptor nodes", async () => {
    const source = await readFile(capabilitiesSourcePath, "utf8");
    let counterfeit = replaceSourceAnchor(
      source,
      "stat(descriptor: CapabilityDescriptor)",
      "stat(descriptor: number)"
    );
    counterfeit = replaceSourceAnchor(
      counterfeit,
      "    phase: CapabilityPhase\n  ): CapabilityDescriptor {",
      "    phase: string\n  ): CapabilityDescriptor {"
    );
    counterfeit = replaceSourceAnchor(counterfeit, "owner: CloseOwner", "owner: string");
    counterfeit = replaceSourceAnchor(
      counterfeit,
      "readSync(record.fd, buffer, offset, length, position)",
      "0"
    );
    counterfeit = replaceSourceAnchor(
      counterfeit,
      "openAtPrimitive(parentRecord.fd, childPath, flags)",
      "-1"
    );
    counterfeit = replaceSourceAnchor(
      counterfeit,
      "fstatSync(record.fd, { bigint: true })",
      "undefined as never"
    );
    counterfeit = replaceSourceAnchor(counterfeit, "      closeSync(record.fd);", "      return;");
    counterfeit = counterfeit
      .replaceAll("#registry", "#registryUnchecked")
      .replaceAll("#currentGenerationByDescriptor", "#generationUnchecked")
      .replaceAll("flags ===", "flags !==");
    counterfeit = replaceSourceAnchor(counterfeit, "owner !== expectedOwner", "owner === expectedOwner");

    const sourceWithCounterfeitText = `${counterfeit}
const structuralDescriptorCounterfeit = [
  "openRelative(parent: CapabilityDescriptor, phase: CapabilityPhase)",
  "stat(descriptor: CapabilityDescriptor)",
  "readRetained(descriptor: CapabilityDescriptor, phase: CapabilityPhase)",
  "close(descriptor: CapabilityDescriptor, owner: CloseOwner)",
      "readSync(record.fd, buffer, offset, length, position)",
      "openAtPrimitive(parentRecord.fd, childPath, flags)",
      "fstatSync(record.fd, { bigint: true })",
      "closeSync(record.fd)",
  "readonly #registry = new WeakMap",
  "this.#registry.get(capability)",
  "readonly #currentGenerationByDescriptor = new Map",
  "this.#currentGenerationByDescriptor.get(record.fd)",
  "flags === DIRECTORY_OPEN_FLAGS",
  "flags === FILE_OPEN_FLAGS",
  "owner !== expectedOwner"
].join(" ");
`;
    expect(structuralDescriptorDenials(sourceWithCounterfeitText)).toEqual([
      "raw_read_descriptor_not_handle",
      "openat_parent_not_handle",
      "raw_fstat_descriptor_not_handle",
      "raw_close_descriptor_not_handle",
      "raw_descriptor_operation_shape",
      "foreign_descriptor_shape",
      "stale_descriptor_shape",
      "flags_invalid_shape",
      "owner_mismatch_shape"
    ]);
  });

  test("the checked-in source keeps only private retained-descriptor operands and mediated raw primitives", async () => {
    const source = await readFile(capabilitiesSourcePath, "utf8");
    expect(source).toContain('invokeDescriptorPrimitive("open_root", () => openSync(root, DIRECTORY_OPEN_FLAGS))');
    expect(source).toContain('invokeDescriptorPrimitive(\n      "openat",\n      () => openAtPrimitive');
    expect(source).toContain('invokeDescriptorPrimitive("fstat_sync", () => fstatSync(record.fd, { bigint: true }))');
    expect(source).toContain('invokeDescriptorPrimitive("read_sync", () => readSync(record.fd, buffer, offset, length, position))');
    expect(source).toContain('invokeDescriptorPrimitive("close_sync", () => {');
    expect(source).not.toContain('invokeDescriptorPrimitive("mark_retained"');
    expect(source).toContain("openAtPrimitive(parentRecord.fd, childPath, flags)");
    expect(source).toContain("fstatSync(record.fd,");
    expect(source).toContain("readSync(record.fd,");
    expect(source).toContain("closeSync(record.fd)");
    expect(source).not.toContain("openAt()(-100,");
  });
});
