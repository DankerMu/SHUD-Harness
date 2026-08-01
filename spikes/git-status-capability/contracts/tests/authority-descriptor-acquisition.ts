import ts from "typescript";

type RawAcquisitionDenial =
  | "raw_open_root_not_handle"
  | "openat_parent_not_handle"
  | "raw_fstat_descriptor_not_handle"
  | "raw_read_descriptor_not_handle"
  | "raw_close_descriptor_not_handle";
type ParsedGraph = ReadonlyMap<string, ts.SourceFile>;

const CAPABILITIES_SOURCE = "capabilities.ts";
const NODE_RAW_DENIALS: readonly RawAcquisitionDenial[] = [
  "raw_open_root_not_handle",
  "raw_fstat_descriptor_not_handle",
  "raw_read_descriptor_not_handle",
  "raw_close_descriptor_not_handle"
];
const RAW_ACQUISITION_DENIAL_ORDER: readonly RawAcquisitionDenial[] = [
  "raw_open_root_not_handle",
  "openat_parent_not_handle",
  "raw_fstat_descriptor_not_handle",
  "raw_read_descriptor_not_handle",
  "raw_close_descriptor_not_handle"
];
const NODE_IMPORT_SPECIFIERS: readonly Readonly<{ imported: string; typeOnly: boolean }>[] = [
  { imported: "closeSync", typeOnly: false },
  { imported: "constants", typeOnly: false },
  { imported: "fstatSync", typeOnly: false },
  { imported: "openSync", typeOnly: false },
  { imported: "readSync", typeOnly: false },
  { imported: "BigIntStats", typeOnly: true }
];
const ALLOWED_CAPABILITIES_VALUE_EXPORTS = new Set([
  "FILE_OPEN_FLAGS",
  "DIRECTORY_OPEN_FLAGS",
  "DESCRIPTOR_OPERATION_POLICY",
  "installDescriptorPrimitiveMediator",
  "ContractCapabilities"
]);

function allNodes(node: ts.Node): readonly ts.Node[] {
  const nodes: ts.Node[] = [];
  const visit = (current: ts.Node): void => {
    nodes.push(current);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return nodes;
}

function parseGraph(sources: ReadonlyMap<string, string>): ParsedGraph | undefined {
  const graph = new Map<string, ts.SourceFile>();
  for (const [name, source] of sources) {
    const sourceFile = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (sourceFile.parseDiagnostics.length > 0) return undefined;
    graph.set(name, sourceFile);
  }
  return graph;
}

function moduleSpecifier(declaration: ts.ImportDeclaration): string | undefined {
  return ts.isStringLiteral(declaration.moduleSpecifier) ? declaration.moduleSpecifier.text : undefined;
}

function importsFrom(sourceFile: ts.SourceFile, moduleName: string): readonly ts.ImportDeclaration[] {
  return sourceFile.statements.filter(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) && moduleSpecifier(statement) === moduleName
  );
}

function isExactNamedImport(
  declaration: ts.ImportDeclaration | undefined,
  expected: readonly Readonly<{ imported: string; typeOnly: boolean }>[]
): boolean {
  const clause = declaration?.importClause;
  if (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return false;
  const elements = clause.namedBindings.elements;
  return elements.length === expected.length && elements.every((element, index) => {
    const expectedElement = expected[index]!;
    return !element.propertyName &&
      element.name.text === expectedElement.imported &&
      element.isTypeOnly === expectedElement.typeOnly;
  });
}

function addNodeRawDenials(denials: Set<RawAcquisitionDenial>): void {
  for (const denial of NODE_RAW_DENIALS) denials.add(denial);
}

function rawModuleKind(moduleName: string | undefined): "node" | "ffi" | undefined {
  if (moduleName === "node:fs" || moduleName === "fs") return "node";
  if (moduleName === "bun:ffi") return "ffi";
  return undefined;
}

function stringArgument(call: ts.CallExpression): string | undefined {
  const argument = call.arguments[0];
  return argument && ts.isStringLiteral(argument) ? argument.text : undefined;
}

function loaderModuleKind(call: ts.CallExpression): "node" | "ffi" | undefined {
  if (call.expression.kind === ts.SyntaxKind.ImportKeyword) return rawModuleKind(stringArgument(call));
  if (ts.isIdentifier(call.expression) && call.expression.text === "require") return rawModuleKind(stringArgument(call));
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  if (call.expression.name.text === "require" || call.expression.name.text === "getBuiltinModule") {
    return rawModuleKind(stringArgument(call));
  }
  return undefined;
}

function containsUnexpectedLoader(sourceFile: ts.SourceFile, denials: Set<RawAcquisitionDenial>): void {
  for (const node of allNodes(sourceFile)) {
    if (!ts.isCallExpression(node)) continue;
    const kind = loaderModuleKind(node);
    if (kind === "node") addNodeRawDenials(denials);
    if (kind === "ffi") denials.add("openat_parent_not_handle");
  }
}

function valueExportNames(sourceFile: ts.SourceFile): readonly string[] {
  const names: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
      }
    } else if ((ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) && statement.name) {
      names.push(statement.name.text);
    } else if (ts.isExportAssignment(statement)) {
      names.push("default");
    }
  }
  return names;
}

function hasCanonicalFsImport(sourceFile: ts.SourceFile): boolean {
  const imports = importsFrom(sourceFile, "node:fs");
  return imports.length === 1 && isExactNamedImport(imports[0], NODE_IMPORT_SPECIFIERS);
}

function hasCanonicalFfiImport(sourceFile: ts.SourceFile): boolean {
  const imports = importsFrom(sourceFile, "bun:ffi");
  return imports.length === 1 && isExactNamedImport(imports[0], [{ imported: "dlopen", typeOnly: false }]);
}

function isCachedOpenAtCall(call: ts.CallExpression): boolean {
  let expression: ts.Expression = call.expression;
  if (ts.isNonNullExpression(expression)) expression = expression.expression;
  return ts.isIdentifier(expression) && expression.text === "cachedOpenAt";
}

function isCanonicalDlopenAssignment(call: ts.CallExpression): boolean {
  const symbols = call.parent;
  if (!ts.isPropertyAccessExpression(symbols) || symbols.name.text !== "symbols") return false;
  const openAt = symbols.parent;
  if (!ts.isPropertyAccessExpression(openAt) || openAt.name.text !== "openat") return false;
  const assignment = openAt.parent;
  return ts.isBinaryExpression(assignment) && assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(assignment.left) && assignment.left.text === "cachedOpenAt";
}

function hasCanonicalOpenAtAcquisition(sourceFile: ts.SourceFile): boolean {
  const dlopenCalls = allNodes(sourceFile).filter(
    (node): node is ts.CallExpression => ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) && node.expression.text === "dlopen"
  );
  const cachedCalls = allNodes(sourceFile).filter(
    (node): node is ts.CallExpression => ts.isCallExpression(node) && isCachedOpenAtCall(node)
  );
  const cachedReferences = allNodes(sourceFile).filter(
    (node): node is ts.Identifier => ts.isIdentifier(node) && node.text === "cachedOpenAt"
  );
  const cachedDeclaration = sourceFile.statements.filter(
    (statement): statement is ts.VariableStatement => ts.isVariableStatement(statement)
  ).flatMap((statement) => statement.declarationList.declarations).filter(
    (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "cachedOpenAt"
  );
  return cachedDeclaration.length === 1 && cachedCalls.length === 0 && cachedReferences.length === 6 &&
    dlopenCalls.length === 2 && dlopenCalls.every((call) =>
      call.arguments.length === 2 && ts.isIdentifier(call.arguments[1]) &&
      call.arguments[1].text === "symbols" && isCanonicalDlopenAssignment(call)
    );
}

function hasNoUnexpectedCapabilityValueExport(sourceFile: ts.SourceFile): boolean {
  return valueExportNames(sourceFile).every((name) => ALLOWED_CAPABILITIES_VALUE_EXPORTS.has(name));
}

/**
 * Closes raw descriptor acquisition across a copied `contracts/lib/**` graph.
 * Canonical call ownership is checked separately by the binding-aware oracle;
 * this allowlist rejects every alternate raw loader, import, resolver, cache,
 * or exported helper before that per-call analysis can be trusted.
 */
export function rawAcquisitionGraphDenials(
  sources: ReadonlyMap<string, string>
): readonly RawAcquisitionDenial[] {
  const graph = parseGraph(sources);
  if (!graph) return RAW_ACQUISITION_DENIAL_ORDER;
  const capabilities = graph.get(CAPABILITIES_SOURCE);
  if (!capabilities || !hasCanonicalFsImport(capabilities)) {
    const denials = new Set<RawAcquisitionDenial>();
    addNodeRawDenials(denials);
    if (!capabilities || !hasCanonicalFfiImport(capabilities) || !hasCanonicalOpenAtAcquisition(capabilities)) {
      denials.add("openat_parent_not_handle");
    }
    return RAW_ACQUISITION_DENIAL_ORDER.filter((denial) => denials.has(denial));
  }

  const denials = new Set<RawAcquisitionDenial>();
  if (!hasCanonicalFfiImport(capabilities) || !hasCanonicalOpenAtAcquisition(capabilities)) {
    denials.add("openat_parent_not_handle");
  }
  if (!hasNoUnexpectedCapabilityValueExport(capabilities)) {
    addNodeRawDenials(denials);
    denials.add("openat_parent_not_handle");
  }

  for (const [name, sourceFile] of graph) {
    for (const declaration of sourceFile.statements) {
      if (!ts.isImportDeclaration(declaration)) continue;
      const kind = rawModuleKind(moduleSpecifier(declaration));
      if (!kind) continue;
      const canonical = name === CAPABILITIES_SOURCE && (
        kind === "node" ? hasCanonicalFsImport(sourceFile) : hasCanonicalFfiImport(sourceFile)
      );
      if (canonical) continue;
      if (kind === "node") addNodeRawDenials(denials);
      if (kind === "ffi") denials.add("openat_parent_not_handle");
    }
    containsUnexpectedLoader(sourceFile, denials);
  }
  return RAW_ACQUISITION_DENIAL_ORDER.filter((denial) => denials.has(denial));
}
