import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { rawPrimitiveOwnershipDenials } from "./authority-descriptor-ownership";

export const contractsRoot = join(import.meta.dir, "..");
export const capabilitiesSourcePath = join(contractsRoot, "lib", "capabilities.ts");
export const checkSourcePath = join(contractsRoot, "check.ts");

type RawPrimitiveOwnershipDenial =
  | "raw_open_root_not_handle"
  | "openat_parent_not_handle"
  | "raw_fstat_descriptor_not_handle"
  | "raw_read_descriptor_not_handle"
  | "raw_close_descriptor_not_handle";
type StructuralDenial =
  | RawPrimitiveOwnershipDenial
  | "raw_descriptor_operation_shape"
  | "foreign_descriptor_shape"
  | "stale_descriptor_shape"
  | "flags_invalid_shape"
  | "owner_mismatch_shape";
type RawPrimitiveMutationTarget = "open_sync" | "openat" | "fstat_sync" | "read_sync" | "close_sync";
type RawAliasFamily =
  | "identifier"
  | "object_destructure"
  | "array_destructure"
  | "renamed_property"
  | "property_projection"
  | "assignment"
  | "bind"
  | "wrapper"
  | "nested_function";
type RawAliasMutation = `raw_${RawPrimitiveMutationTarget}_${RawAliasFamily}_alias`;
type CallbackEscapeMutation = `raw_${Exclude<RawPrimitiveMutationTarget, "openat">}_outside_callback`;
export type ProductionMutation =
  | "fd0"
  | "at_fdcwd"
  | "fstat0"
  | "close0"
  | "before_deny_fstat"
  | "raw_descriptor"
  | "foreign_descriptor"
  | "stale_descriptor"
  | "invalid_flags"
  | "invalid_owner"
  | "destructured_helper_shadow"
  | "aliased_openat_call"
  | "wrong_openat_argument"
  | "wrong_openat_flags"
  | RawAliasMutation
  | CallbackEscapeMutation;
export type GuardOrderMutation = "guard_open_root" | "guard_open_relative" | "guard_read_retained";
export type AuditIdentityMutation = "deny_record_zero" | "deny_record_fd_plus_one";
type CapabilityMutation = ProductionMutation | GuardOrderMutation | AuditIdentityMutation;
export type MutatedProductionTree = Readonly<{
  root: string;
  checkPath: string;
  capabilitiesPath: string;
}>;

const STRUCTURAL_DENIAL_ORDER: readonly StructuralDenial[] = [
  "raw_open_root_not_handle",
  "openat_parent_not_handle",
  "raw_fstat_descriptor_not_handle",
  "raw_read_descriptor_not_handle",
  "raw_close_descriptor_not_handle",
  "raw_descriptor_operation_shape",
  "foreign_descriptor_shape",
  "stale_descriptor_shape",
  "flags_invalid_shape",
  "owner_mismatch_shape"
];

const RAW_PRIMITIVE_MUTATION_TARGETS = [
  "open_sync",
  "openat",
  "fstat_sync",
  "read_sync",
  "close_sync"
] as const satisfies readonly RawPrimitiveMutationTarget[];
const RAW_ALIAS_FAMILIES = [
  "identifier",
  "object_destructure",
  "array_destructure",
  "renamed_property",
  "property_projection",
  "assignment",
  "bind",
  "wrapper",
  "nested_function"
] as const satisfies readonly RawAliasFamily[];
const RAW_OWNERSHIP_DENIAL_BY_TARGET: Readonly<Record<RawPrimitiveMutationTarget, RawPrimitiveOwnershipDenial>> = Object.freeze({
  open_sync: "raw_open_root_not_handle",
  openat: "openat_parent_not_handle",
  fstat_sync: "raw_fstat_descriptor_not_handle",
  read_sync: "raw_read_descriptor_not_handle",
  close_sync: "raw_close_descriptor_not_handle"
});

export const RAW_ALIAS_MUTATIONS: readonly RawAliasMutation[] = Object.freeze(
  RAW_PRIMITIVE_MUTATION_TARGETS.flatMap((target) =>
    RAW_ALIAS_FAMILIES.map((family) => `raw_${target}_${family}_alias` as RawAliasMutation)
  )
);
export const CALLBACK_ESCAPE_MUTATIONS: readonly CallbackEscapeMutation[] = Object.freeze([
  "raw_open_sync_outside_callback",
  "raw_fstat_sync_outside_callback",
  "raw_read_sync_outside_callback",
  "raw_close_sync_outside_callback"
]);

type RawMutationSite = Readonly<{
  anchor: string;
  indent: string;
  primitive: string;
  arguments: string;
  guard: string;
}>;

const RAW_MUTATION_SITE_BY_TARGET: Readonly<Record<RawPrimitiveMutationTarget, RawMutationSite>> = Object.freeze({
  open_sync: {
    anchor: '    const descriptor = invokeDescriptorPrimitive("open_root", () => openSync(root, DIRECTORY_OPEN_FLAGS));',
    indent: "    ",
    primitive: "openSync",
    arguments: "root, DIRECTORY_OPEN_FLAGS",
    guard: 'root === "__structural_alias__"'
  },
  openat: {
    anchor: "    const descriptor = invokeDescriptorPrimitive(\n" +
      '      "openat",\n' +
      "      () => openAtPrimitive(parentRecord.fd, childPath, flags)\n" +
      "    );",
    indent: "    ",
    primitive: "openAtPrimitive",
    arguments: "parentRecord.fd, childPath, flags",
    guard: 'childName === "__structural_alias__"'
  },
  fstat_sync: {
    anchor: '    const stats = invokeDescriptorPrimitive("fstat_sync", () => fstatSync(record.fd, { bigint: true }));',
    indent: "    ",
    primitive: "fstatSync",
    arguments: "record.fd, { bigint: true }",
    guard: "record.fd === -424242"
  },
  read_sync: {
    anchor: "    return invokeDescriptorPrimitive(\"read_sync\", () => readSync(record.fd, buffer, offset, length, position));",
    indent: "    ",
    primitive: "readSync",
    arguments: "record.fd, buffer, offset, length, position",
    guard: "position === 424242"
  },
  close_sync: {
    anchor: "      invokeDescriptorPrimitive(\"close_sync\", () => {\n" +
      "        rawCloseAttempted = true;\n" +
      "        closeSync(record.fd);\n" +
      "      });",
    indent: "      ",
    primitive: "closeSync",
    arguments: "record.fd",
    guard: "record.fd === -424242"
  }
});

function rawAliasMutationParts(
  mutation: CapabilityMutation
): Readonly<{ target: RawPrimitiveMutationTarget; family: RawAliasFamily }> | undefined {
  for (const target of RAW_PRIMITIVE_MUTATION_TARGETS) {
    for (const family of RAW_ALIAS_FAMILIES) {
      if (mutation === `raw_${target}_${family}_alias`) return Object.freeze({ target, family });
    }
  }
  return undefined;
}

function callbackEscapeTarget(mutation: CapabilityMutation): Exclude<RawPrimitiveMutationTarget, "openat"> | undefined {
  for (const target of ["open_sync", "fstat_sync", "read_sync", "close_sync"] as const) {
    if (mutation === `raw_${target}_outside_callback`) return target;
  }
  return undefined;
}

export function expectedRawOwnershipDenial(
  mutation: RawAliasMutation | CallbackEscapeMutation
): RawPrimitiveOwnershipDenial {
  const alias = rawAliasMutationParts(mutation);
  if (alias) return RAW_OWNERSHIP_DENIAL_BY_TARGET[alias.target];
  const target = callbackEscapeTarget(mutation);
  if (!target) throw new Error(`unknown raw ownership mutation: ${mutation}`);
  return RAW_OWNERSHIP_DENIAL_BY_TARGET[target];
}

function rawAliasMutationSource(site: RawMutationSite, family: RawAliasFamily): string {
  const call = `rawAlias(${site.arguments});`;
  const guardedCall = `${site.indent}if (${site.guard}) ${call}\n`;
  if (family === "identifier") {
    return `${site.indent}const rawAlias = ${site.primitive};\n${guardedCall}`;
  }
  if (family === "object_destructure") {
    return `${site.indent}const { rawAlias } = { rawAlias: ${site.primitive} };\n${guardedCall}`;
  }
  if (family === "array_destructure") {
    return `${site.indent}const [rawAlias] = [${site.primitive}];\n${guardedCall}`;
  }
  if (family === "renamed_property") {
    return `${site.indent}const { rawPrimitive: rawAlias } = { rawPrimitive: ${site.primitive} };\n${guardedCall}`;
  }
  if (family === "property_projection") {
    return `${site.indent}const rawAlias = ({ rawPrimitive: ${site.primitive} }).rawPrimitive;\n${guardedCall}`;
  }
  if (family === "assignment") {
    return `${site.indent}let rawAlias: typeof ${site.primitive};\n` +
      `${site.indent}rawAlias = ${site.primitive};\n${guardedCall}`;
  }
  if (family === "bind") {
    return `${site.indent}const rawAlias = ${site.primitive}.bind(undefined);\n${guardedCall}`;
  }
  if (family === "wrapper") {
    return `${site.indent}const rawAlias = (): void => { ${site.primitive}(${site.arguments}); };\n` +
      `${site.indent}if (${site.guard}) rawAlias();\n`;
  }
  return `${site.indent}function rawAlias(): void { ${site.primitive}(${site.arguments}); }\n` +
    `${site.indent}if (${site.guard}) rawAlias();\n`;
}

function mutateRawAlias(source: string, mutation: CapabilityMutation): string | undefined {
  const parts = rawAliasMutationParts(mutation);
  if (!parts) return undefined;
  const site = RAW_MUTATION_SITE_BY_TARGET[parts.target];
  if (!source.includes(site.anchor)) throw new Error(`raw alias mutation anchor is absent: ${mutation}`);
  return source.replace(site.anchor, `${rawAliasMutationSource(site, parts.family)}${site.anchor}`);
}

function mutateCallbackEscape(source: string, mutation: CapabilityMutation): string | undefined {
  const target = callbackEscapeTarget(mutation);
  if (!target) return undefined;
  if (target === "open_sync") {
    return replaceRawCall(
      source,
      ['    const descriptor = invokeDescriptorPrimitive("open_root", () => openSync(root, DIRECTORY_OPEN_FLAGS));'],
      '    invokeDescriptorPrimitive("open_root", () => undefined);\n' +
        "    const descriptor = openSync(root, DIRECTORY_OPEN_FLAGS);",
      mutation
    );
  }
  if (target === "fstat_sync") {
    return replaceRawCall(
      source,
      ['    const stats = invokeDescriptorPrimitive("fstat_sync", () => fstatSync(record.fd, { bigint: true }));'],
      '    invokeDescriptorPrimitive("fstat_sync", () => undefined);\n' +
        "    const stats = fstatSync(record.fd, { bigint: true });",
      mutation
    );
  }
  if (target === "read_sync") {
    return replaceRawCall(
      source,
      ['    return invokeDescriptorPrimitive("read_sync", () => readSync(record.fd, buffer, offset, length, position));'],
      '    invokeDescriptorPrimitive("read_sync", () => undefined);\n' +
        "    return readSync(record.fd, buffer, offset, length, position);",
      mutation
    );
  }
  return replaceRawCall(
    source,
    [
      "      invokeDescriptorPrimitive(\"close_sync\", () => {\n" +
        "        rawCloseAttempted = true;\n" +
        "        closeSync(record.fd);\n" +
        "      });"
    ],
    '      invokeDescriptorPrimitive("close_sync", () => undefined);\n' +
      "      rawCloseAttempted = true;\n" +
      "      closeSync(record.fd);",
    mutation
  );
}

function replaceRawCall(
  source: string,
  anchors: readonly string[],
  replacement: string,
  mutation: CapabilityMutation
): string {
  const anchor = anchors.find((candidate) => source.includes(candidate));
  if (!anchor) throw new Error(`descriptor ${mutation} mutation anchor is absent`);
  return source.replace(anchor, replacement);
}

function mutateCapabilitiesSource(source: string, mutation: CapabilityMutation | undefined): string {
  if (!mutation) return source;
  const aliasMutation = mutateRawAlias(source, mutation);
  if (aliasMutation) return aliasMutation;
  const callbackEscape = mutateCallbackEscape(source, mutation);
  if (callbackEscape) return callbackEscape;
  const readAnchors = [
    "readSync(record.fd, buffer, offset, length, position)",
    "readSync(descriptor.fd, buffer, offset, length, position)"
  ] as const;
  if (mutation === "fd0") {
    // FIFO reads reject a positional offset; preserve the raw fd0 operand while making the canary block.
    return replaceRawCall(source, readAnchors, "readSync(0, buffer, offset, length, null)", mutation);
  }
  if (mutation === "at_fdcwd") {
    const readAnchor = readAnchors.find((candidate) => source.includes(`() => ${candidate}`));
    if (!readAnchor) throw new Error("ambient open mutation anchor is absent");
    return source.replace(
      `() => ${readAnchor}`,
      "() => {\n      const ambient = openAt()(-100, childCString(\"ambient-secret\"), FILE_OPEN_FLAGS);\n" +
        `      return ${readAnchor};\n    }`
    );
  }
  if (mutation === "fstat0") {
    return replaceRawCall(
      source,
      ["fstatSync(record.fd, { bigint: true })", "fstatSync(descriptor.fd, { bigint: true })"],
      "fstatSync(0, { bigint: true })",
      mutation
    );
  }
  if (mutation === "close0") {
    const readAnchor = readAnchors.find((candidate) => source.includes(`() => ${candidate}`));
    if (!readAnchor) throw new Error("raw close mutation anchor is absent");
    return source.replace(
      `() => ${readAnchor}`,
      `() => { closeSync(0); return ${readAnchor}; }`
    );
  }
  if (mutation === "before_deny_fstat") {
    const readAnchor = readAnchors.find((candidate) => source.includes(`() => ${candidate}`));
    if (!readAnchor) throw new Error("before-deny mutation anchor is absent");
    return source.replace(
      `() => ${readAnchor}`,
      "() => {\n      fstatSync(0, { bigint: true });\n" +
        "      return readSync(0, buffer, offset, length, null);\n    }"
    );
  }
  if (mutation === "guard_open_root") {
    return replaceRawCall(
      source,
      [
        '  openRoot(root: string, phase: CapabilityPhase): CapabilityDescriptor {\n' +
          "    assertDescriptorPrimitiveMediationInactive();\n" +
          '    if (!isCapabilityPhase(phase) || phase !== "admission" || this.#admissionSealed) {'
      ],
      '  openRoot(root: string, phase: CapabilityPhase): CapabilityDescriptor {\n' +
        "    assertDescriptorPrimitiveMediationInactive();\n" +
        "    openSync(root, DIRECTORY_OPEN_FLAGS);\n" +
        '    if (!isCapabilityPhase(phase) || phase !== "admission" || this.#admissionSealed) {',
      mutation
    );
  }
  if (mutation === "guard_open_relative") {
    return replaceRawCall(
      source,
      ['    const parentRecord = this.#resolve(parent, "openat", requestedPhase, "unproven_parent");'],
      '    const parentRecord = this.#resolve(parent, "openat", requestedPhase, "unproven_parent");\n' +
        "    openAt()(parentRecord.fd, childCString(childName), flags);",
      mutation
    );
  }
  if (mutation === "guard_read_retained") {
    return replaceRawCall(
      source,
      ['    const record = this.#resolve(descriptor, "read_sync", requestedPhase);'],
      '    const record = this.#resolve(descriptor, "read_sync", requestedPhase);\n' +
        "    readSync(record.fd, buffer, offset, length, position);",
      mutation
    );
  }
  if (mutation === "deny_record_zero" || mutation === "deny_record_fd_plus_one") {
    const descriptor = mutation === "deny_record_zero" ? "0" : "record.fd + 1";
    return replaceRawCall(
      source,
      ["return this.#deny(operation, reason, record.fd, record.generation, record.phase);"],
      `return this.#deny(operation, reason, ${descriptor}, record.generation, record.phase);`,
      mutation
    );
  }
  if (mutation === "raw_descriptor") {
    return source.replace("stat(descriptor: CapabilityDescriptor)", "stat(descriptor: number)");
  }
  if (mutation === "foreign_descriptor") return source.replaceAll("#registry", "#registryUnchecked");
  if (mutation === "stale_descriptor") {
    return source.replaceAll("#currentGenerationByDescriptor", "#generationUnchecked");
  }
  if (mutation === "invalid_flags") return source.replaceAll("flags ===", "flags !==");
  if (mutation === "invalid_owner") return source.replace("owner !== expectedOwner", "owner === expectedOwner");
  if (mutation === "destructured_helper_shadow") {
    return replaceRawCall(
      source,
      [
        '    const descriptor = invokeDescriptorPrimitive(\n' +
          '      "openat",\n' +
          "      () => openAtPrimitive(parentRecord.fd, childPath, flags)\n" +
          "    );"
      ],
      "    const approvedInvoke = invokeDescriptorPrimitive;\n" +
        '    const { invokeDescriptorPrimitive } = childName === "__unmediated__"\n' +
        "      ? {\n" +
        "        invokeDescriptorPrimitive: <Result>(\n" +
        "          _operation: DescriptorOperation,\n" +
        "          primitive: () => Result\n" +
        "        ): Result => primitive()\n" +
        "      }\n" +
        "      : { invokeDescriptorPrimitive: approvedInvoke };\n" +
        '    const descriptor = invokeDescriptorPrimitive(\n' +
        '      "openat",\n' +
        "      () => openAtPrimitive(parentRecord.fd, childPath, flags)\n" +
        "    );",
      mutation
    );
  }
  if (mutation === "aliased_openat_call") {
    return replaceRawCall(
      source,
      ["    const openAtPrimitive = openAt();"],
      "    const openAtPrimitive = openAt();\n" +
        "    const extraOpenAt = openAtPrimitive;\n" +
        '    if (childName === "__unmediated__") extraOpenAt(parentRecord.fd, childPath, flags);',
      mutation
    );
  }
  if (mutation === "wrong_openat_argument") {
    return replaceRawCall(
      source,
      ["openAtPrimitive(parentRecord.fd, childPath, flags)"],
      "openAtPrimitive(parentRecord.fd, Buffer.from(\"wrong\"), flags)",
      mutation
    );
  }
  if (mutation === "wrong_openat_flags") {
    return replaceRawCall(
      source,
      ["openAtPrimitive(parentRecord.fd, childPath, flags)"],
      "openAtPrimitive(parentRecord.fd, childPath, FILE_OPEN_FLAGS)",
      mutation
    );
  }
  throw new Error(`unsupported descriptor mutation: ${mutation}`);
}

async function copyProductionSources(root: string, mutation: CapabilityMutation | undefined): Promise<MutatedProductionTree> {
  const libraryRoot = join(contractsRoot, "lib");
  const copiedLibraryRoot = join(root, "lib");
  await mkdir(copiedLibraryRoot, { recursive: true });
  const sourceNames = (await readdir(libraryRoot)).filter((name) => name.endsWith(".ts"));
  await Promise.all(sourceNames.map(async (name) => {
    const source = await readFile(join(libraryRoot, name), "utf8");
    await writeFile(
      join(copiedLibraryRoot, name),
      name === "capabilities.ts" ? mutateCapabilitiesSource(source, mutation) : source
    );
  }));
  await writeFile(join(root, "check.ts"), await readFile(checkSourcePath, "utf8"));
  return Object.freeze({
    root,
    checkPath: join(root, "check.ts"),
    capabilitiesPath: join(copiedLibraryRoot, "capabilities.ts")
  });
}

/** Creates a complete copied production tree without invoking a structural oracle. */
export async function withProductionTree(
  mutation: CapabilityMutation | undefined,
  action: (tree: MutatedProductionTree) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "shud-descriptor-production-"));
  try {
    await action(await copyProductionSources(root, mutation));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Compiles the complete, real check.ts import graph before a structural oracle inspects it. */
export async function withCompiledProductionTree(
  mutation: CapabilityMutation | undefined,
  action: (tree: MutatedProductionTree) => Promise<void>
): Promise<void> {
  await withProductionTree(mutation, async (tree) => {
    const build = await Bun.build({
      entrypoints: [tree.checkPath],
      outdir: join(tree.root, "compiled"),
      target: "bun",
      sourcemap: "none"
    });
    if (!build.success) throw new Error(`full production tree did not compile: ${build.logs.join("\n")}`);
    await action(tree);
  });
}

/**
 * AST-only oracle for the permitted raw syscall operands and public opaque
 * handle vocabulary. The caller has already compiled the complete production
 * graph; this scanner deliberately imports neither the active preload nor the
 * production module it scans.
 */
function isIdentifierNamed(node: ts.Node | undefined, name: string): boolean {
  return Boolean(node && ts.isIdentifier(node) && node.text === name);
}

function isPrivateIdentifierNamed(node: ts.Node | undefined, name: string): boolean {
  return Boolean(node && ts.isPrivateIdentifier(node) && node.text.replace(/^#/, "") === name);
}

function targetCapabilitiesClass(sourceFile: ts.SourceFile): ts.ClassDeclaration | undefined {
  const declarations = sourceFile.statements.filter(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && isIdentifierNamed(statement.name, "ContractCapabilities")
  );
  return declarations.length === 1 ? declarations[0] : undefined;
}

function classMethod(
  classDeclaration: ts.ClassDeclaration | undefined,
  name: string,
  privateName = false
): ts.MethodDeclaration | undefined {
  if (!classDeclaration) return undefined;
  const methods = classDeclaration.members.filter(
    (member): member is ts.MethodDeclaration => ts.isMethodDeclaration(member) &&
      (privateName ? isPrivateIdentifierNamed(member.name, name) : isIdentifierNamed(member.name, name))
  );
  return methods.length === 1 ? methods[0] : undefined;
}


function hasNamedParameter(
  method: ts.MethodDeclaration | undefined,
  parameterName: string,
  typeName: string
): boolean {
  if (!method) return false;
  const parameters = method.parameters.filter((parameter) => isIdentifierNamed(parameter.name, parameterName));
  const parameter = parameters[0];
  return Boolean(
    parameters.length === 1 &&
    parameter?.type && ts.isTypeReferenceNode(parameter.type) &&
    isIdentifierNamed(parameter.type.typeName, typeName)
  );
}

function visitMethodNodes(
  method: ts.MethodDeclaration,
  _sourceFile: ts.SourceFile,
  visitor: (node: ts.Node) => void
): void {
  if (!method.body) return;
  const visit = (node: ts.Node): void => {
    if (node !== method.body && (
      ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)
    )) {
      return;
    }
    visitor(node);
    ts.forEachChild(node, visit);
  };
  visit(method.body);
}

function callExpressionsInMethod(
  method: ts.MethodDeclaration | undefined,
  sourceFile: ts.SourceFile,
  predicate: (call: ts.CallExpression) => boolean
): readonly ts.CallExpression[] {
  if (!method) return [];
  const calls: ts.CallExpression[] = [];
  visitMethodNodes(method, sourceFile, (node) => {
    if (ts.isCallExpression(node) && predicate(node)) calls.push(node);
  });
  return calls;
}


function binaryExpressionsInMethod(
  method: ts.MethodDeclaration | undefined,
  sourceFile: ts.SourceFile,
  predicate: (expression: ts.BinaryExpression) => boolean
): readonly ts.BinaryExpression[] {
  if (!method) return [];
  const expressions: ts.BinaryExpression[] = [];
  visitMethodNodes(method, sourceFile, (node) => {
    if (ts.isBinaryExpression(node) && predicate(node)) expressions.push(node);
  });
  return expressions;
}

function isPropertyAccessNamed(node: ts.Node | undefined, receiverName: string, propertyName: string): boolean {
  return Boolean(
    node && ts.isPropertyAccessExpression(node) &&
    isIdentifierNamed(node.expression, receiverName) &&
    isIdentifierNamed(node.name, propertyName)
  );
}


function hasPrivateCollectionDeclaration(
  classDeclaration: ts.ClassDeclaration | undefined,
  privateName: string,
  collectionName: string
): boolean {
  if (!classDeclaration) return false;
  const declarations = classDeclaration.members.filter(
    (member): member is ts.PropertyDeclaration =>
      ts.isPropertyDeclaration(member) && isPrivateIdentifierNamed(member.name, privateName)
  );
  return declarations.length === 1 && declarations.every((declaration) => {
    const initializer = declaration.initializer;
    return Boolean(
      declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) &&
      initializer && ts.isNewExpression(initializer) &&
      isIdentifierNamed(initializer.expression, collectionName)
    );
  });
}

function hasPrivateLookup(
  classDeclaration: ts.ClassDeclaration | undefined,
  sourceFile: ts.SourceFile,
  privateName: string,
  expectedArgument: (argument: ts.Expression) => boolean
): boolean {
  const resolve = classMethod(classDeclaration, "resolve", true);
  const lookups = callExpressionsInMethod(resolve, sourceFile, (call) => {
    if (
      !ts.isPropertyAccessExpression(call.expression) ||
      !isIdentifierNamed(call.expression.name, "get") ||
      call.arguments.length !== 1 ||
      !expectedArgument(call.arguments[0]!)
    ) {
      return false;
    }
    const receiver = call.expression.expression;
    return ts.isPropertyAccessExpression(receiver) &&
      receiver.expression.kind === ts.SyntaxKind.ThisKeyword &&
      isPrivateIdentifierNamed(receiver.name, privateName);
  });
  return lookups.length === 1;
}

function hasExactFlagComparison(
  method: ts.MethodDeclaration | undefined,
  sourceFile: ts.SourceFile,
  constantName: string
): boolean {
  const comparisons = binaryExpressionsInMethod(
    method,
    sourceFile,
    (expression) =>
      (isIdentifierNamed(expression.left, "flags") && isIdentifierNamed(expression.right, constantName)) ||
      (isIdentifierNamed(expression.left, constantName) && isIdentifierNamed(expression.right, "flags"))
  );
  return comparisons.length === 1 &&
    comparisons[0]!.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    isIdentifierNamed(comparisons[0]!.left, "flags") &&
    isIdentifierNamed(comparisons[0]!.right, constantName);
}

function hasOwnerInequality(method: ts.MethodDeclaration | undefined, sourceFile: ts.SourceFile): boolean {
  const comparisons = binaryExpressionsInMethod(
    method,
    sourceFile,
    (expression) =>
      (isIdentifierNamed(expression.left, "owner") && isIdentifierNamed(expression.right, "expectedOwner")) ||
      (isIdentifierNamed(expression.left, "expectedOwner") && isIdentifierNamed(expression.right, "owner"))
  );
  return comparisons.length === 1 &&
    comparisons[0]!.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
    isIdentifierNamed(comparisons[0]!.left, "owner") &&
    isIdentifierNamed(comparisons[0]!.right, "expectedOwner");
}

export function structuralDescriptorDenials(source: string): readonly StructuralDenial[] {
  const sourceFile = ts.createSourceFile(
    "capabilities.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const capabilities = sourceFile.parseDiagnostics.length === 0
    ? targetCapabilitiesClass(sourceFile)
    : undefined;
  const openRelative = classMethod(capabilities, "openRelative");
  const stat = classMethod(capabilities, "stat");
  const readRetained = classMethod(capabilities, "readRetained");
  const close = classMethod(capabilities, "close");
  const denials = new Set<StructuralDenial>();

  if (
    !hasNamedParameter(openRelative, "parent", "CapabilityDescriptor") ||
    !hasNamedParameter(stat, "descriptor", "CapabilityDescriptor") ||
    !hasNamedParameter(readRetained, "descriptor", "CapabilityDescriptor") ||
    !hasNamedParameter(close, "descriptor", "CapabilityDescriptor") ||
    !hasNamedParameter(openRelative, "phase", "CapabilityPhase") ||
    !hasNamedParameter(readRetained, "phase", "CapabilityPhase")
  ) {
    denials.add("raw_descriptor_operation_shape");
  }
  for (const denial of rawPrimitiveOwnershipDenials(source)) denials.add(denial);
  if (
    !hasPrivateCollectionDeclaration(capabilities, "registry", "WeakMap") ||
    !hasPrivateLookup(capabilities, sourceFile, "registry", (argument) => isIdentifierNamed(argument, "capability"))
  ) {
    denials.add("foreign_descriptor_shape");
  }
  if (
    !hasPrivateCollectionDeclaration(capabilities, "currentGenerationByDescriptor", "Map") ||
    !hasPrivateLookup(capabilities, sourceFile, "currentGenerationByDescriptor", (argument) =>
      isPropertyAccessNamed(argument, "record", "fd")
    )
  ) {
    denials.add("stale_descriptor_shape");
  }
  if (
    !hasExactFlagComparison(openRelative, sourceFile, "DIRECTORY_OPEN_FLAGS") ||
    !hasExactFlagComparison(openRelative, sourceFile, "FILE_OPEN_FLAGS")
  ) {
    denials.add("flags_invalid_shape");
  }
  if (!hasNamedParameter(close, "owner", "CloseOwner") || !hasOwnerInequality(close, sourceFile)) {
    denials.add("owner_mismatch_shape");
  }
  return STRUCTURAL_DENIAL_ORDER.filter((denial) => denials.has(denial));
}
