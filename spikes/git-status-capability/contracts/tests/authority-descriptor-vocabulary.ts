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
  | "raw_fstat_descriptor_not_handle"
  | "raw_close_descriptor_not_handle"
  | "raw_descriptor_operation_shape"
  | "foreign_descriptor_shape"
  | "stale_descriptor_shape"
  | "flags_invalid_shape"
  | "owner_mismatch_shape";
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
  | "wrong_openat_flags";
export type GuardOrderMutation = "guard_open_root" | "guard_open_relative" | "guard_read_retained";
export type AuditIdentityMutation = "deny_record_zero" | "deny_record_fd_plus_one";
type CapabilityMutation = ProductionMutation | GuardOrderMutation | AuditIdentityMutation;
export type MutatedProductionTree = Readonly<{
  root: string;
  checkPath: string;
  capabilitiesPath: string;
}>;

const STRUCTURAL_DENIAL_ORDER: readonly StructuralDenial[] = [
  "raw_read_descriptor_not_handle",
  "openat_parent_not_handle",
  "raw_fstat_descriptor_not_handle",
  "raw_close_descriptor_not_handle",
  "raw_descriptor_operation_shape",
  "foreign_descriptor_shape",
  "stale_descriptor_shape",
  "flags_invalid_shape",
  "owner_mismatch_shape"
];

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

type LexicalBinding = Readonly<{ declaration: ts.Declaration; scope: ts.Node }>;

function topLevelFunction(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  const declarations = sourceFile.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && isIdentifierNamed(statement.name, name)
  );
  return declarations.length === 1 ? declarations[0] : undefined;
}

function lexicalBindingScope(declaration: ts.Declaration): ts.Node | undefined {
  let current: ts.Node | undefined = declaration.parent;
  while (current) {
    if (
      ts.isFunctionLike(current) ||
      ts.isBlock(current) ||
      ts.isSourceFile(current) ||
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isCatchClause(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function bindingNameIdentifiers(bindingName: ts.BindingName): readonly ts.Identifier[] {
  if (ts.isIdentifier(bindingName)) return [bindingName];
  const identifiers: ts.Identifier[] = [];
  const visit = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      identifiers.push(name);
      return;
    }
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue;
      visit(element.name);
    }
  };
  visit(bindingName);
  return identifiers;
}

function namedLocalBindings(sourceFile: ts.SourceFile, name: string): readonly LexicalBinding[] {
  const bindings: LexicalBinding[] = [];
  const record = (declaration: ts.Declaration & { name?: ts.DeclarationName }): void => {
    const bindingName = declaration.name;
    if (
      !bindingName ||
      (!ts.isIdentifier(bindingName) && !ts.isObjectBindingPattern(bindingName) && !ts.isArrayBindingPattern(bindingName))
    ) {
      return;
    }
    if (!bindingNameIdentifiers(bindingName).some((identifier) => identifier.text === name)) return;
    const scope = lexicalBindingScope(declaration);
    if (scope && !ts.isSourceFile(scope)) bindings.push({ declaration, scope });
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isImportSpecifier(node) ||
      ts.isNamespaceImport(node) ||
      ts.isImportClause(node)
    ) {
      record(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bindings;
}

function scopeContains(scope: ts.Node, node: ts.Node): boolean {
  return scope.pos <= node.pos && node.end <= scope.end;
}

function referencesTopLevelFunction(
  identifier: ts.Node | undefined,
  sourceFile: ts.SourceFile,
  name: string
): boolean {
  if (!identifier || !isIdentifierNamed(identifier, name) || !topLevelFunction(sourceFile, name)) return false;
  return namedLocalBindings(sourceFile, name).every((binding) => !scopeContains(binding.scope, identifier));
}

function referencesLocalBinding(
  identifier: ts.Node | undefined,
  sourceFile: ts.SourceFile,
  declaration: ts.VariableDeclaration
): boolean {
  if (
    !identifier ||
    !ts.isIdentifier(declaration.name) ||
    !isIdentifierNamed(identifier, declaration.name.text)
  ) {
    return false;
  }
  const containingBindings = namedLocalBindings(sourceFile, declaration.name.text).filter(
    (binding) => scopeContains(binding.scope, identifier)
  );
  return containingBindings.length === 1 && containingBindings[0]!.declaration === declaration;
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
  sourceFile: ts.SourceFile,
  visitor: (node: ts.Node) => void
): void {
  if (!method.body) return;
  const visit = (node: ts.Node, parent: ts.Node | undefined): void => {
    if (node !== method.body && (
      ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)
    )) {
      const mediatedPrimitiveCallback = ts.isArrowFunction(node) &&
        ts.isCallExpression(parent) &&
        referencesTopLevelFunction(parent.expression, sourceFile, "invokeDescriptorPrimitive") &&
        parent.arguments.length === 2 &&
        parent.arguments[1] === node;
      if (!mediatedPrimitiveCallback) return;
    }
    visitor(node);
    ts.forEachChild(node, (child) => visit(child, node));
  };
  visit(method.body, undefined);
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

function callExpressionsInClass(
  classDeclaration: ts.ClassDeclaration | undefined,
  sourceFile: ts.SourceFile,
  predicate: (call: ts.CallExpression) => boolean
): readonly ts.CallExpression[] {
  if (!classDeclaration) return [];
  const calls: ts.CallExpression[] = [];
  for (const member of classDeclaration.members) {
    if (!ts.isMethodDeclaration(member)) continue;
    calls.push(...callExpressionsInMethod(member, sourceFile, predicate));
  }
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

function hasOnlyRawReadDescriptorOperand(
  classDeclaration: ts.ClassDeclaration | undefined,
  sourceFile: ts.SourceFile
): boolean {
  const calls = callExpressionsInClass(
    classDeclaration,
    sourceFile,
    (call) => isIdentifierNamed(call.expression, "readSync")
  );
  return calls.length === 1 && isPropertyAccessNamed(calls[0]!.arguments[0], "record", "fd");
}

function allCallExpressions(
  node: ts.Node,
  predicate: (call: ts.CallExpression) => boolean
): readonly ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (current: ts.Node): void => {
    if (ts.isCallExpression(current) && predicate(current)) calls.push(current);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return calls;
}

function variableDeclarations(node: ts.Node): readonly ts.VariableDeclaration[] {
  const declarations: ts.VariableDeclaration[] = [];
  const visit = (current: ts.Node): void => {
    if (ts.isVariableDeclaration(current)) declarations.push(current);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return declarations;
}

function hasNoTopLevelFunctionAliases(sourceFile: ts.SourceFile, name: string): boolean {
  return variableDeclarations(sourceFile).every(
    (declaration) =>
      !ts.isIdentifier(declaration.name) ||
      !declaration.initializer ||
      !referencesTopLevelFunction(declaration.initializer, sourceFile, name)
  );
}

function hasOnlyCanonicalMediationCallsites(
  classDeclaration: ts.ClassDeclaration | undefined,
  sourceFile: ts.SourceFile
): boolean {
  if (!classDeclaration || !topLevelFunction(sourceFile, "invokeDescriptorPrimitive")) return false;
  if (!hasNoTopLevelFunctionAliases(sourceFile, "invokeDescriptorPrimitive")) return false;
  const expected = [
    ["openRoot", "open_root"],
    ["openRelative", "openat"],
    ["stat", "fstat_sync"],
    ["readRetained", "read_sync"],
    ["close", "close_sync"]
  ] as const;
  const calls = allCallExpressions(
    sourceFile,
    (call) => referencesTopLevelFunction(call.expression, sourceFile, "invokeDescriptorPrimitive")
  );
  if (calls.length !== expected.length) return false;
  return expected.every(([methodName, operation]) => {
    const method = classMethod(classDeclaration, methodName);
    const methodCalls = callExpressionsInMethod(
      method,
      sourceFile,
      (call) => referencesTopLevelFunction(call.expression, sourceFile, "invokeDescriptorPrimitive")
    );
    return methodCalls.length === 1 &&
      ts.isStringLiteral(methodCalls[0]!.arguments[0]) &&
      methodCalls[0]!.arguments[0].text === operation &&
      methodCalls[0]!.arguments.length === 2 &&
      ts.isArrowFunction(methodCalls[0]!.arguments[1]);
  });
}

function hasExactChildCString(
  openRelative: ts.MethodDeclaration,
  sourceFile: ts.SourceFile
): boolean {
  const childPathDeclarations = variableDeclarations(openRelative).filter(
    (declaration) =>
      ts.isIdentifier(declaration.name) &&
      declaration.name.text === "childPath" &&
      declaration.initializer &&
      ts.isCallExpression(declaration.initializer) &&
      referencesTopLevelFunction(declaration.initializer.expression, sourceFile, "childCString") &&
      declaration.initializer.arguments.length === 1 &&
      isIdentifierNamed(declaration.initializer.arguments[0], "childName")
  );
  if (childPathDeclarations.length !== 1) return false;
  const childCString = topLevelFunction(sourceFile, "childCString");
  if (!childCString?.body) return false;
  const returns: ts.ReturnStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node)) returns.push(node);
    ts.forEachChild(node, visit);
  };
  visit(childCString.body);
  if (returns.length !== 1 || !returns[0]!.expression || !ts.isCallExpression(returns[0]!.expression)) {
    return false;
  }
  const call = returns[0]!.expression;
  if (
    !isPropertyAccessNamed(call.expression, "Buffer", "from") ||
    call.arguments.length !== 2 ||
    !ts.isTemplateExpression(call.arguments[0]) ||
    !ts.isStringLiteral(call.arguments[1]) ||
    call.arguments[1].text !== "utf8"
  ) {
    return false;
  }
  const template = call.arguments[0];
  return template.head.text === "" &&
    template.templateSpans.length === 1 &&
    isIdentifierNamed(template.templateSpans[0]!.expression, "value") &&
    template.templateSpans[0]!.literal.text === "\0";
}

function hasExactOpenAtResultRelation(
  openRelative: ts.MethodDeclaration,
  sourceFile: ts.SourceFile,
  mediator: ts.CallExpression
): boolean {
  if (
    !ts.isVariableDeclaration(mediator.parent) ||
    !ts.isIdentifier(mediator.parent.name) ||
    mediator.parent.name.text !== "descriptor"
  ) {
    return false;
  }
  const negativeChecks = binaryExpressionsInMethod(
    openRelative,
    sourceFile,
    (expression) =>
      isIdentifierNamed(expression.left, "descriptor") &&
      expression.operatorToken.kind === ts.SyntaxKind.LessThanToken &&
      ts.isNumericLiteral(expression.right) &&
      expression.right.text === "0"
  );
  if (negativeChecks.length !== 1) return false;
  const issueReturns: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isReturnStatement(node) &&
      node.expression &&
      ts.isCallExpression(node.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
      isPrivateIdentifierNamed(node.expression.expression.name, "issue")
    ) {
      issueReturns.push(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(openRelative);
  const issue = issueReturns[0];
  const state = issue?.arguments[5];
  return issueReturns.length === 1 &&
    issue!.arguments.length === 6 &&
    isIdentifierNamed(issue!.arguments[0], "descriptor") &&
    isPropertyAccessNamed(issue!.arguments[1], "parentRecord", "generation") &&
    isIdentifierNamed(issue!.arguments[2], "flags") &&
    isIdentifierNamed(issue!.arguments[3], "kind") &&
    isIdentifierNamed(issue!.arguments[4], "requestedPhase") &&
    Boolean(
      state &&
      ts.isConditionalExpression(state) &&
      ts.isBinaryExpression(state.condition) &&
      isIdentifierNamed(state.condition.left, "requestedPhase") &&
      state.condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      ts.isStringLiteral(state.condition.right) &&
      state.condition.right.text === "admission" &&
      ts.isStringLiteral(state.whenTrue) &&
      state.whenTrue.text === "pending_retained" &&
      ts.isStringLiteral(state.whenFalse) &&
      state.whenFalse.text === "verification"
    );
}

function hasOnlyOpenAtParentOperand(
  classDeclaration: ts.ClassDeclaration | undefined,
  sourceFile: ts.SourceFile
): boolean {
  const openRelative = classMethod(classDeclaration, "openRelative");
  if (!openRelative || !hasOnlyCanonicalMediationCallsites(classDeclaration, sourceFile)) return false;
  if (!hasNoTopLevelFunctionAliases(sourceFile, "openAt") || !hasExactChildCString(openRelative, sourceFile)) {
    return false;
  }

  const resolutions = variableDeclarations(openRelative).filter(
    (declaration) =>
      ts.isIdentifier(declaration.name) &&
      declaration.name.text === "openAtPrimitive" &&
      declaration.initializer &&
      ts.isCallExpression(declaration.initializer) &&
      referencesTopLevelFunction(declaration.initializer.expression, sourceFile, "openAt") &&
      declaration.initializer.arguments.length === 0
  );
  if (resolutions.length !== 1) return false;
  const resolution = resolutions[0]!;
  const factoryCalls = allCallExpressions(
    classDeclaration!,
    (call) => referencesTopLevelFunction(call.expression, sourceFile, "openAt")
  );
  if (factoryCalls.length !== 1 || factoryCalls[0] !== resolution.initializer) return false;

  const aliases = [resolution];
  for (const declaration of variableDeclarations(openRelative)) {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isIdentifier(declaration.initializer)) {
      continue;
    }
    if (aliases.some((binding) => referencesLocalBinding(declaration.initializer, sourceFile, binding))) {
      aliases.push(declaration);
    }
  }
  if (aliases.length !== 1) return false;

  const mediators = callExpressionsInMethod(
    openRelative,
    sourceFile,
    (call) =>
      referencesTopLevelFunction(call.expression, sourceFile, "invokeDescriptorPrimitive") &&
      call.arguments.length === 2 &&
      ts.isStringLiteral(call.arguments[0]) &&
      call.arguments[0].text === "openat" &&
      ts.isArrowFunction(call.arguments[1])
  );
  if (mediators.length !== 1) return false;
  const mediator = mediators[0]!;
  const callback = mediator.arguments[1]!;
  if (!ts.isArrowFunction(callback) || resolution.pos >= callback.pos) return false;
  const calls = allCallExpressions(
    classDeclaration!,
    (call) => referencesLocalBinding(call.expression, sourceFile, resolution)
  );
  const callbackCalls = calls.filter(
    (call) => call.pos >= callback.body.pos && call.end <= callback.body.end
  );
  const rawCall = calls[0];
  return calls.length === 1 &&
    callbackCalls.length === 1 &&
    rawCall === callbackCalls[0] &&
    rawCall!.arguments.length === 3 &&
    isPropertyAccessNamed(rawCall!.arguments[0], "parentRecord", "fd") &&
    isIdentifierNamed(rawCall!.arguments[1], "childPath") &&
    isIdentifierNamed(rawCall!.arguments[2], "flags") &&
    hasExactOpenAtResultRelation(openRelative, sourceFile, mediator);
}

function hasOnlyRawFstatDescriptorOperand(
  classDeclaration: ts.ClassDeclaration | undefined,
  sourceFile: ts.SourceFile
): boolean {
  const calls = callExpressionsInClass(
    classDeclaration,
    sourceFile,
    (call) => isIdentifierNamed(call.expression, "fstatSync")
  );
  return calls.length === 1 && isPropertyAccessNamed(calls[0]!.arguments[0], "record", "fd");
}

function hasOnlyRawCloseDescriptorOperand(
  classDeclaration: ts.ClassDeclaration | undefined,
  sourceFile: ts.SourceFile
): boolean {
  const calls = callExpressionsInClass(
    classDeclaration,
    sourceFile,
    (call) => isIdentifierNamed(call.expression, "closeSync")
  );
  return calls.length === 1 && isPropertyAccessNamed(calls[0]!.arguments[0], "record", "fd");
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
  if (!hasOnlyRawReadDescriptorOperand(capabilities, sourceFile)) {
    denials.add("raw_read_descriptor_not_handle");
  }
  if (!hasOnlyOpenAtParentOperand(capabilities, sourceFile)) {
    denials.add("openat_parent_not_handle");
  }
  if (!hasOnlyRawFstatDescriptorOperand(capabilities, sourceFile)) {
    denials.add("raw_fstat_descriptor_not_handle");
  }
  if (!hasOnlyRawCloseDescriptorOperand(capabilities, sourceFile)) {
    denials.add("raw_close_descriptor_not_handle");
  }
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
