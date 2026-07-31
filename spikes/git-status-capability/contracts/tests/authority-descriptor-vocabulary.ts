import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

export const contractsRoot = join(import.meta.dir, "..");
export const capabilitiesSourcePath = join(contractsRoot, "lib", "capabilities.ts");
export const checkSourcePath = join(contractsRoot, "check.ts");

type StructuralDenial =
  | "raw_read_descriptor_not_handle"
  | "openat_parent_not_handle"
  | "raw_descriptor_operation_shape"
  | "foreign_descriptor_shape"
  | "stale_descriptor_shape"
  | "flags_invalid_shape"
  | "owner_mismatch_shape";
export type ProductionMutation =
  | "fd0"
  | "at_fdcwd"
  | "raw_descriptor"
  | "foreign_descriptor"
  | "stale_descriptor"
  | "invalid_flags"
  | "invalid_owner";
export type MutatedProductionTree = Readonly<{
  root: string;
  checkPath: string;
  capabilitiesPath: string;
}>;

const STRUCTURAL_DENIAL_ORDER: readonly StructuralDenial[] = [
  "raw_read_descriptor_not_handle",
  "openat_parent_not_handle",
  "raw_descriptor_operation_shape",
  "foreign_descriptor_shape",
  "stale_descriptor_shape",
  "flags_invalid_shape",
  "owner_mismatch_shape"
];

function mutateCapabilitiesSource(source: string, mutation: ProductionMutation | undefined): string {
  if (!mutation) return source;
  const readAnchor = "readSync(descriptor.fd, buffer, offset, length, position)";
  if (!source.includes(readAnchor)) throw new Error("descriptor read mutation anchor is absent");
  if (mutation === "fd0") {
    // FIFO reads reject a positional offset; preserve the raw fd0 operand while making the canary block.
    return source.replace(readAnchor, "readSync(0, buffer, offset, length, null)");
  }
  if (mutation === "at_fdcwd") {
    const retainedRead = "    return readSync(descriptor.fd,";
    if (!source.includes(retainedRead)) throw new Error("ambient open mutation anchor is absent");
    return source.replace(
      retainedRead,
      "    const ambient = openAt()(-100, childCString(\"ambient-secret\"), FILE_OPEN_FLAGS);\n" + retainedRead
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
  return source.replace("owner !== expectedOwner", "owner === expectedOwner");
}

async function copyProductionSources(root: string, mutation: ProductionMutation | undefined): Promise<MutatedProductionTree> {
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
  mutation: ProductionMutation | undefined,
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
  mutation: ProductionMutation | undefined,
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

function visitMethodNodes(method: ts.MethodDeclaration, visitor: (node: ts.Node) => void): void {
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
  predicate: (call: ts.CallExpression) => boolean
): readonly ts.CallExpression[] {
  if (!method) return [];
  const calls: ts.CallExpression[] = [];
  visitMethodNodes(method, (node) => {
    if (ts.isCallExpression(node) && predicate(node)) calls.push(node);
  });
  return calls;
}

function callExpressionsInClass(
  classDeclaration: ts.ClassDeclaration | undefined,
  predicate: (call: ts.CallExpression) => boolean
): readonly ts.CallExpression[] {
  if (!classDeclaration) return [];
  const calls: ts.CallExpression[] = [];
  for (const member of classDeclaration.members) {
    if (!ts.isMethodDeclaration(member)) continue;
    calls.push(...callExpressionsInMethod(member, predicate));
  }
  return calls;
}

function binaryExpressionsInMethod(
  method: ts.MethodDeclaration | undefined,
  predicate: (expression: ts.BinaryExpression) => boolean
): readonly ts.BinaryExpression[] {
  if (!method) return [];
  const expressions: ts.BinaryExpression[] = [];
  visitMethodNodes(method, (node) => {
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

function hasOnlyRawReadDescriptorOperand(classDeclaration: ts.ClassDeclaration | undefined): boolean {
  const calls = callExpressionsInClass(
    classDeclaration,
    (call) => isIdentifierNamed(call.expression, "readSync")
  );
  return calls.length === 1 && isPropertyAccessNamed(calls[0]!.arguments[0], "descriptor", "fd");
}

function hasOnlyOpenAtParentOperand(classDeclaration: ts.ClassDeclaration | undefined): boolean {
  const calls = callExpressionsInClass(
    classDeclaration,
    (call) => ts.isCallExpression(call.expression) &&
      isIdentifierNamed(call.expression.expression, "openAt") &&
      call.expression.arguments.length === 0
  );
  return calls.length === 1 && isPropertyAccessNamed(calls[0]!.arguments[0], "parent", "fd");
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
  privateName: string,
  expectedArgument: (argument: ts.Expression) => boolean
): boolean {
  const resolve = classMethod(classDeclaration, "resolve", true);
  const lookups = callExpressionsInMethod(resolve, (call) => {
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
  constantName: string
): boolean {
  const comparisons = binaryExpressionsInMethod(
    method,
    (expression) =>
      (isIdentifierNamed(expression.left, "flags") && isIdentifierNamed(expression.right, constantName)) ||
      (isIdentifierNamed(expression.left, constantName) && isIdentifierNamed(expression.right, "flags"))
  );
  return comparisons.length === 1 &&
    comparisons[0]!.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    isIdentifierNamed(comparisons[0]!.left, "flags") &&
    isIdentifierNamed(comparisons[0]!.right, constantName);
}

function hasOwnerInequality(method: ts.MethodDeclaration | undefined): boolean {
  const comparisons = binaryExpressionsInMethod(
    method,
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
    false,
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
  if (!hasOnlyRawReadDescriptorOperand(capabilities)) {
    denials.add("raw_read_descriptor_not_handle");
  }
  if (!hasOnlyOpenAtParentOperand(capabilities)) {
    denials.add("openat_parent_not_handle");
  }
  if (
    !hasPrivateCollectionDeclaration(capabilities, "registry", "WeakMap") ||
    !hasPrivateLookup(capabilities, "registry", (argument) => isIdentifierNamed(argument, "capability"))
  ) {
    denials.add("foreign_descriptor_shape");
  }
  if (
    !hasPrivateCollectionDeclaration(capabilities, "currentGenerationByDescriptor", "Map") ||
    !hasPrivateLookup(capabilities, "currentGenerationByDescriptor", (argument) =>
      ts.isPropertyAccessExpression(argument) &&
      isIdentifierNamed(argument.name, "fd") &&
      isPropertyAccessNamed(argument.expression, "record", "descriptor")
    )
  ) {
    denials.add("stale_descriptor_shape");
  }
  if (
    !hasExactFlagComparison(openRelative, "DIRECTORY_OPEN_FLAGS") ||
    !hasExactFlagComparison(openRelative, "FILE_OPEN_FLAGS")
  ) {
    denials.add("flags_invalid_shape");
  }
  if (!hasNamedParameter(close, "owner", "CloseOwner") || !hasOwnerInequality(close)) {
    denials.add("owner_mismatch_shape");
  }
  return STRUCTURAL_DENIAL_ORDER.filter((denial) => denials.has(denial));
}
