import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
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
  invalid_owner: ["owner_mismatch_shape"],
  destructured_helper_shadow: ["openat_parent_not_handle"],
  aliased_openat_call: ["openat_parent_not_handle"],
  wrong_openat_argument: ["openat_parent_not_handle"],
  wrong_openat_flags: ["openat_parent_not_handle"]
});

const FROZEN_PRE183_RUNTIME_EXPORTS = [
  "ContractCapabilities",
  "DESCRIPTOR_OPERATION_POLICY",
  "DIRECTORY_OPEN_FLAGS",
  "FILE_OPEN_FLAGS"
] as const;
const FROZEN_PRE183_TYPE_EXPORTS = [
  "BigIntStats",
  "CapabilityDescriptor",
  "CapabilityHooks",
  "CapabilityPhase",
  "CloseAttempt",
  "CloseOwner",
  "ContractAuthorityFault",
  "DescriptorAuthorityDenial",
  "DescriptorCapabilityState",
  "DescriptorOperation"
] as const;

function replaceSourceAnchor(source: string, anchor: string, replacement: string): string {
  if (!source.includes(anchor)) throw new Error(`structural AST test anchor is absent: ${anchor}`);
  return source.replace(anchor, replacement);
}

type CapabilityExportSurface = Readonly<{
  sourceFile: ts.SourceFile;
  runtime: readonly string[];
  types: readonly string[];
}>;

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return Boolean(modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function capabilityExportSurface(source: string): CapabilityExportSurface {
  const sourceFile = ts.createSourceFile(
    "capabilities.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  if (sourceFile.parseDiagnostics.length > 0) throw new Error("capability export source does not parse");

  const runtime: string[] = [];
  const types: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
        throw new Error("capability export surface must use named exports");
      }
      const target = statement.isTypeOnly ? types : runtime;
      for (const element of statement.exportClause.elements) target.push(element.name.text);
      continue;
    }
    if (!hasExportModifier(statement)) continue;
    if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
      types.push(statement.name.text);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) throw new Error("capability runtime export must have an identifier");
        runtime.push(declaration.name.text);
      }
      continue;
    }
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) {
      if (!statement.name) throw new Error("capability runtime export must have a name");
      runtime.push(statement.name.text);
      continue;
    }
    throw new Error("capability export surface has an unsupported declaration");
  }
  return Object.freeze({ sourceFile, runtime: runtime.sort(), types: types.sort() });
}

function exportedTypeAlias(sourceFile: ts.SourceFile, name: string): ts.TypeAliasDeclaration {
  const declarations = sourceFile.statements.filter(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && hasExportModifier(statement) && statement.name.text === name
  );
  if (declarations.length !== 1) throw new Error(`expected one exported type alias named ${name}`);
  return declarations[0]!;
}

function exportedRuntimeVariable(sourceFile: ts.SourceFile, name: string): ts.VariableDeclaration {
  const declarations: ts.VariableDeclaration[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) declarations.push(declaration);
    }
  }
  if (declarations.length !== 1) throw new Error(`expected one exported runtime variable named ${name}`);
  return declarations[0]!;
}

function isExactNamedParameter(parameter: ts.ParameterDeclaration, name: string, typeName: string): boolean {
  return ts.isIdentifier(parameter.name) &&
    parameter.name.text === name &&
    !parameter.dotDotDotToken &&
    !parameter.questionToken &&
    !parameter.initializer &&
    Boolean(
      parameter.type &&
      ts.isTypeReferenceNode(parameter.type) &&
      ts.isIdentifier(parameter.type.typeName) &&
      parameter.type.typeName.text === typeName
    );
}

type InstallerSurfaceDenial =
  | "installer_not_nonconstructible"
  | "installer_not_frozen"
  | "installer_property_surface"
  | "installer_prototype_surface";

function installerSurfaceDenials(source: string): readonly InstallerSurfaceDenial[] {
  const sourceFile = ts.createSourceFile(
    "capabilities.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  if (sourceFile.parseDiagnostics.length > 0) return ["installer_not_nonconstructible"];
  const installer = exportedRuntimeVariable(sourceFile, "installDescriptorPrimitiveMediator");
  const denials: InstallerSurfaceDenial[] = [];
  if (!ts.isArrowFunction(installer.initializer)) denials.push("installer_not_nonconstructible");
  const frozen = sourceFile.statements.some((statement) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
    const call = statement.expression;
    return ts.isPropertyAccessExpression(call.expression) &&
      ts.isIdentifier(call.expression.expression) &&
      call.expression.expression.text === "Object" &&
      call.expression.name.text === "freeze" &&
      call.arguments.length === 1 &&
      ts.isIdentifier(call.arguments[0]) &&
      call.arguments[0].text === "installDescriptorPrimitiveMediator";
  });
  if (!frozen) denials.push("installer_not_frozen");
  let propertySurfaceMutation = false;
  let prototypeSurfaceMutation = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression;
      const method = node.expression.name.text;
      const mutatesInstaller = ts.isIdentifier(receiver) &&
        ["Object", "Reflect"].includes(receiver.text) &&
        ts.isIdentifier(node.arguments[0]) &&
        node.arguments[0].text === "installDescriptorPrimitiveMediator";
      if (mutatesInstaller && method === "setPrototypeOf") prototypeSurfaceMutation = true;
      if (
        mutatesInstaller &&
        ["assign", "defineProperty", "defineProperties", "set"].includes(method)
      ) {
        propertySurfaceMutation = true;
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === "installDescriptorPrimitiveMediator"
    ) {
      propertySurfaceMutation = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (propertySurfaceMutation) denials.push("installer_property_surface");
  if (prototypeSurfaceMutation) denials.push("installer_prototype_surface");
  return denials;
}

function rawOpenSyncDenials(source: string): readonly string[] {
  const sourceFile = ts.createSourceFile(
    "capabilities.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "openSync") {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const onlyRootOpen = calls.length === 1 &&
    calls[0]!.arguments.length === 2 &&
    ts.isIdentifier(calls[0]!.arguments[0]) &&
    calls[0]!.arguments[0].text === "root" &&
    ts.isIdentifier(calls[0]!.arguments[1]) &&
    calls[0]!.arguments[1].text === "DIRECTORY_OPEN_FLAGS";
  return onlyRootOpen ? [] : ["open_sync_call_surface"];
}

type InvocationSurfaceDenial = "invocation_not_frozen" | "invocation_property_surface";

function invocationSurfaceDenials(source: string): readonly InvocationSurfaceDenial[] {
  const sourceFile = ts.createSourceFile(
    "capabilities.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const helper = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "invokeDescriptorPrimitive"
  );
  if (!helper?.body) return ["invocation_not_frozen"];
  const declarations: ts.VariableDeclaration[] = [];
  const mediatorCalls: ts.CallExpression[] = [];
  const freezeCalls: ts.CallExpression[] = [];
  let propertySurfaceMutation = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "invoke" &&
      node.initializer &&
      ts.isArrowFunction(node.initializer)
    ) {
      declarations.push(node);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "mediator") {
      mediatorCalls.push(node);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Object" &&
      node.expression.name.text === "freeze" &&
      node.arguments.length === 1 &&
      ts.isIdentifier(node.arguments[0]) &&
      node.arguments[0].text === "invoke"
    ) {
      freezeCalls.push(node);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      ["Object", "Reflect"].includes(node.expression.expression.text) &&
      ["assign", "defineProperty", "defineProperties", "set", "setPrototypeOf"].includes(node.expression.name.text) &&
      ts.isIdentifier(node.arguments[0]) &&
      node.arguments[0].text === "invoke"
    ) {
      propertySurfaceMutation = true;
    }
    if (
      ts.isBinaryExpression(node) &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === "invoke"
    ) {
      propertySurfaceMutation = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(helper.body);
  const denials: InvocationSurfaceDenial[] = [];
  const invoke = declarations[0];
  const mediatorCall = mediatorCalls[0];
  const frozen = Boolean(
    invoke &&
    mediatorCall &&
    freezeCalls.filter((call) => invoke.end <= call.pos && call.end <= mediatorCall.pos).length === 1
  );
  if (!frozen) denials.push("invocation_not_frozen");
  if (propertySurfaceMutation) denials.push("invocation_property_surface");
  return denials;
}

describe("retained descriptor structural authority", () => {
  test("the complete real production tree compiles with only opaque descriptor operands", async () => {
    await withCompiledProductionTree(undefined, async (tree) => {
      expect(structuralDescriptorDenials(await readFile(tree.capabilitiesPath, "utf8"))).toEqual([]);
    });
  });

  test("AST export surface freezes the prior handoff and permits only the #183 installer plus erased signatures", async () => {
    const surface = capabilityExportSurface(await readFile(capabilitiesSourcePath, "utf8"));
    expect(surface.runtime).toEqual([
      ...FROZEN_PRE183_RUNTIME_EXPORTS,
      "installDescriptorPrimitiveMediator"
    ].sort());
    expect(surface.types).toEqual([
      ...FROZEN_PRE183_TYPE_EXPORTS,
      "DescriptorPrimitiveInvocation",
      "DescriptorPrimitiveMediator"
    ].sort());

    const invocationAlias = exportedTypeAlias(surface.sourceFile, "DescriptorPrimitiveInvocation");
    if (!ts.isFunctionTypeNode(invocationAlias.type)) {
      throw new Error("DescriptorPrimitiveInvocation must be a function type");
    }
    expect(invocationAlias.type.typeParameters).toBeUndefined();
    expect(invocationAlias.type.parameters).toHaveLength(0);
    expect(invocationAlias.type.type.kind).toBe(ts.SyntaxKind.UnknownKeyword);

    const mediatorAlias = exportedTypeAlias(surface.sourceFile, "DescriptorPrimitiveMediator");
    if (!ts.isFunctionTypeNode(mediatorAlias.type)) {
      throw new Error("DescriptorPrimitiveMediator must be a function type");
    }
    expect(mediatorAlias.type.typeParameters).toBeUndefined();
    expect(mediatorAlias.type.parameters).toHaveLength(2);
    expect(isExactNamedParameter(mediatorAlias.type.parameters[0]!, "operation", "DescriptorOperation")).toBe(true);
    expect(isExactNamedParameter(
      mediatorAlias.type.parameters[1]!,
      "invoke",
      "DescriptorPrimitiveInvocation"
    )).toBe(true);
    expect(mediatorAlias.type.type.kind).toBe(ts.SyntaxKind.UnknownKeyword);

    const installer = exportedRuntimeVariable(surface.sourceFile, "installDescriptorPrimitiveMediator");
    if (!ts.isArrowFunction(installer.initializer)) {
      throw new Error("installDescriptorPrimitiveMediator must be a non-constructible arrow function");
    }
    expect(installer.initializer.typeParameters).toBeUndefined();
    expect(installer.initializer.parameters).toHaveLength(1);
    expect(isExactNamedParameter(installer.initializer.parameters[0]!, "mediator", "DescriptorPrimitiveMediator"))
      .toBe(true);
    expect(installer.initializer.type?.kind).toBe(ts.SyntaxKind.VoidKeyword);
  });

  test("installer source is frozen, non-constructible, and rejects property or pre-freeze prototype mutation", async () => {
    const source = await readFile(capabilitiesSourcePath, "utf8");
    expect(installerSurfaceDenials(source)).toEqual([]);
    const propertyMutation = `${source}
Object.defineProperty(installDescriptorPrimitiveMediator, "reset", { value: () => undefined });
`;
    expect(installerSurfaceDenials(propertyMutation)).toEqual(["installer_property_surface"]);
    const assignmentMutation = `${source}
installDescriptorPrimitiveMediator.rawResult = undefined;
`;
    expect(installerSurfaceDenials(assignmentMutation)).toEqual(["installer_property_surface"]);
    const prototypeMutation = replaceSourceAnchor(
      source,
      "Object.freeze(installDescriptorPrimitiveMediator);",
      "Object.setPrototypeOf(installDescriptorPrimitiveMediator, { reset: () => undefined });\n" +
        "Object.freeze(installDescriptorPrimitiveMediator);"
    );
    expect(installerSurfaceDenials(prototypeMutation)).toEqual(["installer_prototype_surface"]);
  });

  test("the invocation closure freezes its property and prototype surface before mediator execution", async () => {
    const source = await readFile(capabilitiesSourcePath, "utf8");
    expect(invocationSurfaceDenials(source)).toEqual([]);
    const rawResultMutation = replaceSourceAnchor(
      source,
      "      primitiveResult = primitive();",
      '      primitiveResult = primitive();\n      Object.defineProperty(invoke, "rawResult", { value: primitiveResult });'
    );
    expect(invocationSurfaceDenials(rawResultMutation)).toEqual(["invocation_property_surface"]);
    const missingFreezeMutation = replaceSourceAnchor(source, "  Object.freeze(invoke);", "");
    expect(invocationSurfaceDenials(missingFreezeMutation)).toEqual(["invocation_not_frozen"]);
  });

  test("every openSync call has the one exact root argument tuple, including a non-root mutation", async () => {
    const source = await readFile(capabilitiesSourcePath, "utf8");
    expect(rawOpenSyncDenials(source)).toEqual([]);
    const mutated = replaceSourceAnchor(
      source,
      '    const descriptor = invokeDescriptorPrimitive("open_root", () => openSync(root, DIRECTORY_OPEN_FLAGS));',
      '    openSync("/dev/null", FILE_OPEN_FLAGS);\n' +
        '    const descriptor = invokeDescriptorPrimitive("open_root", () => openSync(root, DIRECTORY_OPEN_FLAGS));'
    );
    expect(rawOpenSyncDenials(mutated)).toEqual(["open_sync_call_surface"]);
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
      "closeSync(record.fd)",
      `closeSync(
        record
          .fd
      )`
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

  test("AST mediation ownership resolves lexical bindings and rejects local helper or conditional openat shadows", async () => {
    const source = await readFile(capabilitiesSourcePath, "utf8");
    const helperShadow = replaceSourceAnchor(
      source,
      "    const descriptor = invokeDescriptorPrimitive(\n" +
        "      \"openat\",\n" +
        "      () => openAtPrimitive(parentRecord.fd, childPath, flags)\n" +
        "    );",
      "    const invokeDescriptorPrimitive = <Result>(\n" +
        "      _operation: DescriptorOperation,\n" +
        "      primitive: () => Result\n" +
        "    ): Result => primitive();\n" +
        "    const descriptor = invokeDescriptorPrimitive(\n" +
        "      \"openat\",\n" +
        "      () => openAtPrimitive(parentRecord.fd, childPath, flags)\n" +
        "    );"
    );
    expect(structuralDescriptorDenials(helperShadow)).toEqual(["openat_parent_not_handle"]);

    const destructuredHelperShadow = replaceSourceAnchor(
      source,
      "    const descriptor = invokeDescriptorPrimitive(\n" +
        "      \"openat\",\n" +
        "      () => openAtPrimitive(parentRecord.fd, childPath, flags)\n" +
        "    );",
      "    const approvedInvoke = invokeDescriptorPrimitive;\n" +
        '    const { invokeDescriptorPrimitive } = childName === "__unmediated__"\n' +
        "      ? { invokeDescriptorPrimitive: <Result>(_: DescriptorOperation, primitive: () => Result): Result => primitive() }\n" +
        "      : { invokeDescriptorPrimitive: approvedInvoke };\n" +
        "    const descriptor = invokeDescriptorPrimitive(\n" +
        "      \"openat\",\n" +
        "      () => openAtPrimitive(parentRecord.fd, childPath, flags)\n" +
        "    );"
    );
    expect(structuralDescriptorDenials(destructuredHelperShadow)).toEqual(["openat_parent_not_handle"]);

    const destructuredHelperAliasShadow = replaceSourceAnchor(
      source,
      "    const descriptor = invokeDescriptorPrimitive(\n" +
        "      \"openat\",\n" +
        "      () => openAtPrimitive(parentRecord.fd, childPath, flags)\n" +
        "    );",
      "    const approvedInvoke = invokeDescriptorPrimitive;\n" +
        '    const { approved: invokeDescriptorPrimitive } = childName === "__unmediated__"\n' +
        "      ? { approved: <Result>(_: DescriptorOperation, primitive: () => Result): Result => primitive() }\n" +
        "      : { approved: approvedInvoke };\n" +
        "    const descriptor = invokeDescriptorPrimitive(\n" +
        "      \"openat\",\n" +
        "      () => openAtPrimitive(parentRecord.fd, childPath, flags)\n" +
        "    );"
    );
    expect(structuralDescriptorDenials(destructuredHelperAliasShadow)).toEqual(["openat_parent_not_handle"]);

    const aliasedOpenAtCall = replaceSourceAnchor(
      source,
      "    const openAtPrimitive = openAt();",
      "    const openAtPrimitive = openAt();\n" +
        "    const extraOpenAt = openAtPrimitive;\n" +
        '    if (childName === "__unmediated__") extraOpenAt(parentRecord.fd, childPath, flags);'
    );
    expect(structuralDescriptorDenials(aliasedOpenAtCall)).toEqual(["openat_parent_not_handle"]);

    const wrongOpenAtArgument = replaceSourceAnchor(
      source,
      "openAtPrimitive(parentRecord.fd, childPath, flags)",
      "openAtPrimitive(parentRecord.fd, Buffer.from(\"wrong\"), flags)"
    );
    expect(structuralDescriptorDenials(wrongOpenAtArgument)).toEqual(["openat_parent_not_handle"]);

    const wrongOpenAtArity = replaceSourceAnchor(
      source,
      "openAtPrimitive(parentRecord.fd, childPath, flags)",
      "openAtPrimitive(parentRecord.fd, childPath)"
    );
    expect(structuralDescriptorDenials(wrongOpenAtArity)).toEqual(["openat_parent_not_handle"]);

    const wrongOpenAtFlags = replaceSourceAnchor(
      source,
      "openAtPrimitive(parentRecord.fd, childPath, flags)",
      "openAtPrimitive(parentRecord.fd, childPath, FILE_OPEN_FLAGS)"
    );
    expect(structuralDescriptorDenials(wrongOpenAtFlags)).toEqual(["openat_parent_not_handle"]);

    const conditionalOpenAtShadow = replaceSourceAnchor(
      source,
      "    const openAtPrimitive = openAt();",
      "    const openAt = childName === \"__unmediated__\"\n" +
        "      ? () => (_parent: number, _path: Buffer, _flags: number): number => -1\n" +
        "      : () => { throw new Error(\"conditional openat shadow\"); };\n" +
        "    const openAtPrimitive = openAt();"
    );
    expect(structuralDescriptorDenials(conditionalOpenAtShadow)).toEqual(["openat_parent_not_handle"]);
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
      "    phase: CapabilityPhase\n  ): CapabilityDescriptor {\n" +
        "    assertDescriptorPrimitiveMediationInactive();\n    const requestedPhase =",
      "    phase: string\n  ): CapabilityDescriptor {\n" +
        "    assertDescriptorPrimitiveMediationInactive();\n    const requestedPhase ="
    );
    counterfeit = replaceSourceAnchor(counterfeit, "owner: CloseOwner", "owner: string");
    counterfeit = replaceSourceAnchor(
      counterfeit,
      "    return invokeDescriptorPrimitive(\"read_sync\", () => readSync(record.fd, buffer, offset, length, position));",
      "    return 0;"
    );
    counterfeit = replaceSourceAnchor(
      counterfeit,
      "    const descriptor = invokeDescriptorPrimitive(\n" +
        "      \"openat\",\n" +
        "      () => openAtPrimitive(parentRecord.fd, childPath, flags)\n" +
        "    );",
      "    const descriptor = -1;"
    );
    counterfeit = replaceSourceAnchor(
      counterfeit,
      "    const stats = invokeDescriptorPrimitive(\"fstat_sync\", () => fstatSync(record.fd, { bigint: true }));",
      "    throw new Error(\"counterfeit\");"
    );
    counterfeit = replaceSourceAnchor(counterfeit, "        closeSync(record.fd);", "        return;");
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

  test("the checked-in source keeps only private retained-descriptor operands and no ambient parent operand", async () => {
    const source = await readFile(capabilitiesSourcePath, "utf8");
    expect(source).toContain("() => readSync(record.fd,");
    expect(source).toContain("fstatSync(record.fd,");
    expect(source).toContain("closeSync(record.fd)");
    expect(source).not.toContain("openAt()(-100,");
  });
});
