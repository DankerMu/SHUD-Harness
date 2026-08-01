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
  invalid_owner: ["owner_mismatch_shape"]
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

function exportedFunction(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const declarations = sourceFile.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && hasExportModifier(statement) && statement.name?.text === name
  );
  if (declarations.length !== 1) throw new Error(`expected one exported function named ${name}`);
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

    const installer = exportedFunction(surface.sourceFile, "installDescriptorPrimitiveMediator");
    expect(installer.typeParameters).toBeUndefined();
    expect(installer.parameters).toHaveLength(1);
    expect(isExactNamedParameter(installer.parameters[0]!, "mediator", "DescriptorPrimitiveMediator")).toBe(true);
    expect(installer.type?.kind).toBe(ts.SyntaxKind.VoidKeyword);
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

  test("AST structural oracle does not let textual copies counterfeit required descriptor nodes", async () => {
    const source = await readFile(capabilitiesSourcePath, "utf8");
    let counterfeit = replaceSourceAnchor(
      source,
      "stat(descriptor: CapabilityDescriptor)",
      "stat(descriptor: number)"
    );
    counterfeit = replaceSourceAnchor(
      counterfeit,
      "    phase: CapabilityPhase\n  ): CapabilityDescriptor {\n    const requestedPhase =",
      "    phase: string\n  ): CapabilityDescriptor {\n    const requestedPhase ="
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
    counterfeit = replaceSourceAnchor(
      counterfeit,
      "      invokeDescriptorPrimitive(\"close_sync\", () => closeSync(record.fd));",
      "      return;"
    );
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
