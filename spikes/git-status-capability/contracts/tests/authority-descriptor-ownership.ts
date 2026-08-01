import ts from "typescript";

type RawPrimitiveOwnershipDenial =
  | "raw_open_root_not_handle"
  | "openat_parent_not_handle"
  | "raw_fstat_descriptor_not_handle"
  | "raw_read_descriptor_not_handle"
  | "raw_close_descriptor_not_handle";

type PrimitiveOperation =
  | "open_root"
  | "openat"
  | "fstat_sync"
  | "read_sync"
  | "close_sync";
type ImportedPrimitive = Exclude<PrimitiveOperation, "openat">;
type PrimitiveSpec = Readonly<{
  operation: PrimitiveOperation;
  method: string;
  denial: RawPrimitiveOwnershipDenial;
  imported?: ImportedPrimitive;
}>;
type Analysis = Readonly<{
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
}>;
type CanonicalMediator = Readonly<{
  spec: PrimitiveSpec;
  method: ts.MethodDeclaration;
  call: ts.CallExpression;
  callback: ts.ArrowFunction;
}>;

const VIRTUAL_CAPABILITIES_PATH = "/virtual/capabilities.ts";
const PRIMITIVE_SPECS: readonly PrimitiveSpec[] = [
  { operation: "open_root", method: "openRoot", denial: "raw_open_root_not_handle", imported: "open_root" },
  { operation: "openat", method: "openRelative", denial: "openat_parent_not_handle" },
  { operation: "fstat_sync", method: "stat", denial: "raw_fstat_descriptor_not_handle", imported: "fstat_sync" },
  { operation: "read_sync", method: "readRetained", denial: "raw_read_descriptor_not_handle", imported: "read_sync" },
  { operation: "close_sync", method: "close", denial: "raw_close_descriptor_not_handle", imported: "close_sync" }
];
const RAW_PRIMITIVE_DENIAL_ORDER: readonly RawPrimitiveOwnershipDenial[] = PRIMITIVE_SPECS.map(
  (spec) => spec.denial
);
const IMPORTED_NAME_BY_OPERATION: Readonly<Record<ImportedPrimitive, string>> = Object.freeze({
  open_root: "openSync",
  fstat_sync: "fstatSync",
  read_sync: "readSync",
  close_sync: "closeSync"
});

function analyze(source: string): Analysis | undefined {
  const sourceFile = ts.createSourceFile(
    VIRTUAL_CAPABILITIES_PATH,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  if (sourceFile.parseDiagnostics.length > 0) return undefined;
  const host: ts.CompilerHost = {
    fileExists: (path) => path === VIRTUAL_CAPABILITIES_PATH,
    getCanonicalFileName: (path) => path,
    getCurrentDirectory: () => "/virtual",
    getDefaultLibFileName: () => "",
    getNewLine: () => "\n",
    getSourceFile: (path) => path === VIRTUAL_CAPABILITIES_PATH ? sourceFile : undefined,
    readFile: (path) => path === VIRTUAL_CAPABILITIES_PATH ? source : undefined,
    useCaseSensitiveFileNames: () => true,
    writeFile: () => undefined
  };
  const program = ts.createProgram({
    rootNames: [VIRTUAL_CAPABILITIES_PATH],
    options: { noLib: true, noResolve: true, target: ts.ScriptTarget.Latest },
    host
  });
  const checkedSourceFile = program.getSourceFile(VIRTUAL_CAPABILITIES_PATH);
  if (!checkedSourceFile) return undefined;
  return Object.freeze({ sourceFile: checkedSourceFile, checker: program.getTypeChecker() });
}

function symbolAt(checker: ts.TypeChecker, node: ts.Node | undefined): ts.Symbol | undefined {
  return node && ts.isIdentifier(node) ? checker.getSymbolAtLocation(node) : undefined;
}

function isIdentifier(node: ts.Node | undefined, name: string): node is ts.Identifier {
  return Boolean(node && ts.isIdentifier(node) && node.text === name);
}

function isPrivateIdentifier(node: ts.Node | undefined, name: string): node is ts.PrivateIdentifier {
  return Boolean(node && ts.isPrivateIdentifier(node) && node.text.replace(/^#/, "") === name);
}

function isDeclarationIdentifier(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  return (
    (ts.isImportSpecifier(parent) && parent.name === identifier) ||
    (ts.isFunctionDeclaration(parent) && parent.name === identifier) ||
    (ts.isClassDeclaration(parent) && parent.name === identifier) ||
    (ts.isVariableDeclaration(parent) && parent.name === identifier) ||
    (ts.isParameter(parent) && parent.name === identifier)
  );
}

function allNodes(node: ts.Node): readonly ts.Node[] {
  const nodes: ts.Node[] = [];
  const visit = (current: ts.Node): void => {
    nodes.push(current);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return nodes;
}

function allCalls(node: ts.Node): readonly ts.CallExpression[] {
  return allNodes(node).filter((candidate): candidate is ts.CallExpression => ts.isCallExpression(candidate));
}

function symbolReferences(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  symbol: ts.Symbol
): readonly ts.Identifier[] {
  return allNodes(sourceFile).filter(
    (node): node is ts.Identifier => ts.isIdentifier(node) &&
      !isDeclarationIdentifier(node) &&
      checker.getSymbolAtLocation(node) === symbol
  );
}

function uniqueTopLevelFunction(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  const functions = sourceFile.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && isIdentifier(statement.name, name)
  );
  return functions.length === 1 ? functions[0] : undefined;
}

function uniqueCapabilitiesClass(sourceFile: ts.SourceFile): ts.ClassDeclaration | undefined {
  const classes = sourceFile.statements.filter(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && isIdentifier(statement.name, "ContractCapabilities")
  );
  return classes.length === 1 ? classes[0] : undefined;
}

function uniqueMethod(classDeclaration: ts.ClassDeclaration | undefined, name: string): ts.MethodDeclaration | undefined {
  if (!classDeclaration) return undefined;
  const methods = classDeclaration.members.filter(
    (member): member is ts.MethodDeclaration => ts.isMethodDeclaration(member) && isIdentifier(member.name, name)
  );
  return methods.length === 1 ? methods[0] : undefined;
}

function nearestFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionLike(current)) return current;
    current = current.parent;
  }
  return undefined;
}


function isDescendantOf(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function hasNoNestedFunctionBetween(node: ts.Node, ancestor: ts.FunctionLikeDeclaration): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && current !== ancestor) {
    if (ts.isFunctionLike(current)) return false;
    current = current.parent;
  }
  return current === ancestor;
}

function isDirectCalleeReference(identifier: ts.Identifier, call: ts.CallExpression): boolean {
  return call.expression === identifier;
}

function isExactMediatorCall(
  call: ts.CallExpression,
  helperSymbol: ts.Symbol,
  checker: ts.TypeChecker,
  operation: PrimitiveOperation
): boolean {
  return ts.isIdentifier(call.expression) &&
    checker.getSymbolAtLocation(call.expression) === helperSymbol &&
    call.arguments.length === 2 &&
    ts.isStringLiteral(call.arguments[0]) &&
    call.arguments[0].text === operation &&
    ts.isArrowFunction(call.arguments[1]);
}

function directMethodNodes(method: ts.MethodDeclaration): readonly ts.Node[] {
  if (!method.body) return [];
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== method.body && (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))) {
      return;
    }
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(method.body);
  return nodes;
}

function methodBindingSymbol(
  method: ts.MethodDeclaration,
  name: string,
  checker: ts.TypeChecker
): ts.Symbol | undefined {
  const declarations = [
    ...method.parameters.filter((parameter) => isIdentifier(parameter.name, name)),
    ...directMethodNodes(method).filter(
      (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && isIdentifier(node.name, name)
    )
  ];
  if (declarations.length !== 1) return undefined;
  return symbolAt(checker, declarations[0]!.name);
}

function topLevelBindingSymbol(
  sourceFile: ts.SourceFile,
  name: string,
  checker: ts.TypeChecker
): ts.Symbol | undefined {
  const declarations = sourceFile.statements.flatMap((statement) => {
    if (!ts.isVariableStatement(statement)) return [];
    return statement.declarationList.declarations.filter((declaration) => isIdentifier(declaration.name, name));
  });
  if (declarations.length !== 1) return undefined;
  return symbolAt(checker, declarations[0]!.name);
}

function hasSymbol(node: ts.Node | undefined, symbol: ts.Symbol | undefined, checker: ts.TypeChecker): boolean {
  return Boolean(symbol && node && ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol);
}

function isPropertyOfSymbol(
  expression: ts.Expression | undefined,
  receiver: ts.Symbol | undefined,
  property: string,
  checker: ts.TypeChecker
): boolean {
  return Boolean(
    receiver && expression && ts.isPropertyAccessExpression(expression) &&
      expression.name.text === property &&
      hasSymbol(expression.expression, receiver, checker)
  );
}

function isThisPrivateCall(call: ts.CallExpression, privateName: string): boolean {
  return ts.isPropertyAccessExpression(call.expression) &&
    call.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
    isPrivateIdentifier(call.expression.name, privateName);
}

function isBigintOption(expression: ts.Expression | undefined): boolean {
  if (!expression || !ts.isObjectLiteralExpression(expression) || expression.properties.length !== 1) return false;
  const property = expression.properties[0];
  return ts.isPropertyAssignment(property) &&
    isIdentifier(property.name, "bigint") &&
    property.initializer.kind === ts.SyntaxKind.TrueKeyword;
}

function hasExactChildCString(
  analysis: Analysis,
  method: ts.MethodDeclaration,
  childPath: ts.Symbol
): boolean {
  const childCString = uniqueTopLevelFunction(analysis.sourceFile, "childCString");
  const childCStringSymbol = symbolAt(analysis.checker, childCString?.name);
  const childName = methodBindingSymbol(method, "childName", analysis.checker);
  if (!childCString?.body || !childCStringSymbol || !childName) return false;
  const declarations = directMethodNodes(method).filter(
    (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) &&
      symbolAt(analysis.checker, node.name) === childPath &&
      node.initializer && ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      analysis.checker.getSymbolAtLocation(node.initializer.expression) === childCStringSymbol &&
      node.initializer.arguments.length === 1 &&
      hasSymbol(node.initializer.arguments[0], childName, analysis.checker)
  );
  const references = symbolReferences(analysis.sourceFile, analysis.checker, childCStringSymbol);
  if (declarations.length !== 1 || references.length !== 1 || !ts.isCallExpression(references[0]!.parent) ||
    references[0]!.parent !== declarations[0]!.initializer) {
    return false;
  }
  const value = childCString.parameters.length === 1
    ? symbolAt(analysis.checker, childCString.parameters[0]!.name)
    : undefined;
  const returns = allNodes(childCString.body).filter(
    (node): node is ts.ReturnStatement => ts.isReturnStatement(node) && Boolean(node.expression)
  );
  const expression = returns[0]?.expression;
  if (!value || returns.length !== 1 || !expression || !ts.isCallExpression(expression)) return false;
  if (!ts.isPropertyAccessExpression(expression.expression) || !isIdentifier(expression.expression.expression, "Buffer") ||
    expression.expression.name.text !== "from" || expression.arguments.length !== 2) {
    return false;
  }
  const template = expression.arguments[0];
  if (!ts.isTemplateExpression(template) || !isLiteral(expression.arguments[1], "utf8")) return false;
  return template.head.text === "" &&
    template.templateSpans.length === 1 &&
    hasSymbol(template.templateSpans[0]!.expression, value, analysis.checker) &&
    template.templateSpans[0]!.literal.text === "\0";
}

function isLiteral(expression: ts.Expression | undefined, value: string): boolean {
  return Boolean(expression && ts.isStringLiteral(expression) && expression.text === value);
}


function assignmentMatches(
  expression: ts.BinaryExpression,
  target: (node: ts.Expression) => boolean,
  value: (node: ts.Expression) => boolean
): boolean {
  return expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && target(expression.left) && value(expression.right);
}

function directAssignments(method: ts.MethodDeclaration): readonly ts.BinaryExpression[] {
  return directMethodNodes(method).filter(
    (node): node is ts.BinaryExpression => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
  );
}

function directReturns(method: ts.MethodDeclaration): readonly ts.ReturnStatement[] {
  return directMethodNodes(method).filter((node): node is ts.ReturnStatement => ts.isReturnStatement(node));
}

function descriptorResultSymbol(call: ts.CallExpression, checker: ts.TypeChecker): ts.Symbol | undefined {
  const declaration = ts.isVariableDeclaration(call.parent) && call.parent.initializer === call && isIdentifier(call.parent.name, "descriptor")
    ? call.parent
    : undefined;
  return declaration ? symbolAt(checker, declaration.name) : undefined;
}

function hasOpenRootLifecycle(
  method: ts.MethodDeclaration,
  mediator: ts.CallExpression,
  checker: ts.TypeChecker,
  root: ts.Symbol | undefined,
  phase: ts.Symbol | undefined,
  directoryFlags: ts.Symbol | undefined
): boolean {
  const descriptor = descriptorResultSymbol(mediator, checker);
  const issueCalls = directReturns(method).flatMap((statement) => {
    const expression = statement.expression;
    return expression && ts.isCallExpression(expression) && isThisPrivateCall(expression, "issue") ? [expression] : [];
  });
  const issue = issueCalls[0];
  return Boolean(
    descriptor && issueCalls.length === 1 && issue && issue.arguments.length === 6 &&
      hasSymbol(issue.arguments[0], descriptor, checker) &&
      issue.arguments[1]?.kind === ts.SyntaxKind.NullKeyword &&
      hasSymbol(issue.arguments[2], directoryFlags, checker) &&
      isLiteral(issue.arguments[3], "directory") &&
      hasSymbol(issue.arguments[4], phase, checker) &&
      isLiteral(issue.arguments[5], "pending_retained")
  );
}

function hasOpenAtLifecycle(
  method: ts.MethodDeclaration,
  mediator: ts.CallExpression,
  checker: ts.TypeChecker,
  parentRecord: ts.Symbol | undefined,
  flags: ts.Symbol | undefined,
  requestedPhase: ts.Symbol | undefined
): boolean {
  const descriptor = descriptorResultSymbol(mediator, checker);
  const negativeChecks = directMethodNodes(method).filter(
    (node): node is ts.BinaryExpression => ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.LessThanToken &&
      hasSymbol(node.left, descriptor, checker) &&
      ts.isNumericLiteral(node.right) && node.right.text === "0"
  );
  const issueCalls = directReturns(method).flatMap((statement) => {
    const expression = statement.expression;
    return expression && ts.isCallExpression(expression) && isThisPrivateCall(expression, "issue") ? [expression] : [];
  });
  const issue = issueCalls[0];
  if (!descriptor || negativeChecks.length !== 1 || issueCalls.length !== 1 || !issue || issue.arguments.length !== 6) {
    return false;
  }
  const state = issue.arguments[5];
  return hasSymbol(issue.arguments[0], descriptor, checker) &&
    isPropertyOfSymbol(issue.arguments[1], parentRecord, "generation", checker) &&
    hasSymbol(issue.arguments[2], flags, checker) &&
    isIdentifier(issue.arguments[3], "kind") &&
    hasSymbol(issue.arguments[4], requestedPhase, checker) &&
    Boolean(
      state && ts.isConditionalExpression(state) &&
        ts.isBinaryExpression(state.condition) &&
        state.condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        hasSymbol(state.condition.left, requestedPhase, checker) &&
        isLiteral(state.condition.right, "admission") &&
        isLiteral(state.whenTrue, "pending_retained") &&
        isLiteral(state.whenFalse, "verification")
    );
}

function hasStatLifecycle(
  method: ts.MethodDeclaration,
  mediator: ts.CallExpression,
  checker: ts.TypeChecker,
  record: ts.Symbol | undefined
): boolean {
  const stats = ts.isVariableDeclaration(mediator.parent) && mediator.parent.initializer === mediator && isIdentifier(mediator.parent.name, "stats")
    ? symbolAt(checker, mediator.parent.name)
    : undefined;
  if (!stats) return false;
  const returns = directReturns(method).filter((statement) => hasSymbol(statement.expression, stats, checker));
  const assignments = directAssignments(method);
  const validated = assignments.filter((assignment) => assignmentMatches(
    assignment,
    (left) => isPropertyOfSymbol(left, record, "statValidated", checker),
    (right) => right.kind === ts.SyntaxKind.TrueKeyword
  ));
  const kind = assignments.filter((assignment) => {
    if (!assignmentMatches(
      assignment,
      (left) => isPropertyOfSymbol(left, record, "statKind", checker),
      (right) => ts.isConditionalExpression(right)
    )) {
      return false;
    }
    const value = assignment.right as ts.ConditionalExpression;
    return ts.isCallExpression(value.condition) &&
      ts.isPropertyAccessExpression(value.condition.expression) &&
      value.condition.expression.name.text === "isDirectory" &&
      hasSymbol(value.condition.expression.expression, stats, checker) &&
      isLiteral(value.whenTrue, "directory") &&
      ts.isConditionalExpression(value.whenFalse) &&
      ts.isCallExpression(value.whenFalse.condition) &&
      ts.isPropertyAccessExpression(value.whenFalse.condition.expression) &&
      value.whenFalse.condition.expression.name.text === "isFile" &&
      hasSymbol(value.whenFalse.condition.expression.expression, stats, checker) &&
      isLiteral(value.whenFalse.whenTrue, "file") &&
      value.whenFalse.whenFalse.kind === ts.SyntaxKind.Identifier &&
      (value.whenFalse.whenFalse as ts.Identifier).text === "undefined";
  });
  return returns.length === 1 && validated.length === 1 && kind.length === 1;
}


function hasCloseLifecycle(
  method: ts.MethodDeclaration,
  mediator: ts.CallExpression,
  callback: ts.ArrowFunction,
  rawCall: ts.CallExpression,
  checker: ts.TypeChecker,
  record: ts.Symbol | undefined
): boolean {
  const stateBeforeClose = methodBindingSymbol(method, "stateBeforeClose", checker);
  const rawCloseAttempted = methodBindingSymbol(method, "rawCloseAttempted", checker);
  if (!stateBeforeClose || !rawCloseAttempted || !ts.isBlock(callback.body) ||
    !ts.isExpressionStatement(mediator.parent) || mediator.parent.expression !== mediator) {
    return false;
  }
  const declarations = directMethodNodes(method).filter(
    (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node)
  );
  const stateBeforeCloseDeclaration = declarations.find(
    (declaration) => symbolAt(checker, declaration.name) === stateBeforeClose &&
      isPropertyOfSymbol(declaration.initializer, record, "state", checker)
  );
  const rawCloseAttemptedDeclaration = declarations.find(
    (declaration) => symbolAt(checker, declaration.name) === rawCloseAttempted &&
      declaration.initializer?.kind === ts.SyntaxKind.FalseKeyword
  );
  if (!stateBeforeCloseDeclaration || !rawCloseAttemptedDeclaration) return false;
  const assignments = directAssignments(method);
  const closed = assignments.filter((assignment) => assignmentMatches(
    assignment,
    (left) => isPropertyOfSymbol(left, record, "state", checker),
    (right) => isLiteral(right, "closed")
  ));
  const restored = assignments.filter((assignment) => assignmentMatches(
    assignment,
    (left) => isPropertyOfSymbol(left, record, "state", checker),
    (right) => hasSymbol(right, stateBeforeClose, checker)
  ));
  const callbackAssignments = allNodes(callback.body).filter(
    (node): node is ts.BinaryExpression => ts.isBinaryExpression(node) && assignmentMatches(
      node,
      (left) => hasSymbol(left, rawCloseAttempted, checker),
      (right) => right.kind === ts.SyntaxKind.TrueKeyword
    )
  );
  const noRawBranches = directMethodNodes(method).filter(
    (node): node is ts.IfStatement => ts.isIfStatement(node) &&
      ts.isPrefixUnaryExpression(node.expression) &&
      node.expression.operator === ts.SyntaxKind.ExclamationToken &&
      hasSymbol(node.expression.operand, rawCloseAttempted, checker)
  );
  const retryThrows = noRawBranches.flatMap((branch) => allNodes(branch.thenStatement).filter(
    (node): node is ts.ThrowStatement => ts.isThrowStatement(node) &&
      node.expression && ts.isNewExpression(node.expression) && isIdentifier(node.expression.expression, "RetryableNoRawCloseError")
  ));
  return closed.length === 1 && closed[0]!.pos < mediator.pos &&
    callbackAssignments.length === 1 && callbackAssignments[0]!.pos < rawCall.pos &&
    restored.length === 1 && noRawBranches.length === 1 &&
    isDescendantOf(restored[0]!, noRawBranches[0]!) && retryThrows.length === 1;
}

function importedRawBindings(analysis: Analysis): ReadonlyMap<ImportedPrimitive, ts.Symbol> | undefined {
  const imports = analysis.sourceFile.statements.filter(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "node:fs"
  );
  if (imports.length !== 1) return undefined;
  const clause = imports[0]!.importClause;
  if (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return undefined;
  const bindings = new Map<ImportedPrimitive, ts.Symbol>();
  for (const operation of Object.keys(IMPORTED_NAME_BY_OPERATION) as ImportedPrimitive[]) {
    const importedName = IMPORTED_NAME_BY_OPERATION[operation];
    const specifiers = clause.namedBindings.elements.filter(
      (specifier) => specifier.name.text === importedName && !specifier.propertyName
    );
    const symbol = specifiers.length === 1 ? symbolAt(analysis.checker, specifiers[0]!.name) : undefined;
    if (!symbol) return undefined;
    bindings.set(operation, symbol);
  }
  return bindings;
}

function canonicalMediators(
  analysis: Analysis
): ReadonlyMap<PrimitiveOperation, CanonicalMediator | undefined> | undefined {
  const classDeclaration = uniqueCapabilitiesClass(analysis.sourceFile);
  const helper = uniqueTopLevelFunction(analysis.sourceFile, "invokeDescriptorPrimitive");
  const helperSymbol = symbolAt(analysis.checker, helper?.name);
  if (!classDeclaration || !helperSymbol) return undefined;
  const directCalls = allCalls(analysis.sourceFile).filter(
    (call) => ts.isIdentifier(call.expression) && analysis.checker.getSymbolAtLocation(call.expression) === helperSymbol
  );
  const methods = new Map<PrimitiveOperation, ts.MethodDeclaration | undefined>();
  const mediators = new Map<PrimitiveOperation, CanonicalMediator | undefined>();
  for (const spec of PRIMITIVE_SPECS) {
    const method = uniqueMethod(classDeclaration, spec.method);
    methods.set(spec.operation, method);
    const candidates = method ? directCalls.filter((call) => nearestFunction(call) === method) : [];
    if (method && candidates.length === 1 && isExactMediatorCall(
      candidates[0]!,
      helperSymbol,
      analysis.checker,
      spec.operation
    )) {
      mediators.set(spec.operation, Object.freeze({
        spec,
        method,
        call: candidates[0]!,
        callback: candidates[0]!.arguments[1] as ts.ArrowFunction
      }));
    } else {
      mediators.set(spec.operation, undefined);
    }
  }
  const knownMethods = [...methods.values()].filter(
    (method): method is ts.MethodDeclaration => Boolean(method)
  );
  if (directCalls.some((call) => !knownMethods.some((method) => method === nearestFunction(call)))) {
    return undefined;
  }
  const allowedCalls = new Set(
    [...mediators.values()].flatMap((mediator) => mediator ? [mediator.call] : [])
  );
  for (const reference of symbolReferences(analysis.sourceFile, analysis.checker, helperSymbol)) {
    if ([...allowedCalls].some((call) => isDirectCalleeReference(reference, call))) continue;
    const operation = [...methods.entries()].find(([, method]) => method === nearestFunction(reference))?.[0];
    if (!operation) return undefined;
    mediators.set(operation, undefined);
  }
  return mediators;
}

function rawCallForImportedBinding(
  analysis: Analysis,
  binding: ts.Symbol,
  mediator: CanonicalMediator
): ts.CallExpression | undefined {
  const calls = allCalls(analysis.sourceFile).filter(
    (call) => ts.isIdentifier(call.expression) && analysis.checker.getSymbolAtLocation(call.expression) === binding
  );
  const references = symbolReferences(analysis.sourceFile, analysis.checker, binding);
  if (calls.length !== 1 || references.length !== 1 || !isDirectCalleeReference(references[0]!, calls[0]!)) {
    return undefined;
  }
  const call = calls[0]!;
  return isDescendantOf(call, mediator.callback) && hasNoNestedFunctionBetween(call, mediator.callback) ? call : undefined;
}

function rawOpenAtCall(
  analysis: Analysis,
  mediator: CanonicalMediator
): Readonly<{ call: ts.CallExpression; parentRecord: ts.Symbol; childPath: ts.Symbol; flags: ts.Symbol }> | undefined {
  const openAt = uniqueTopLevelFunction(analysis.sourceFile, "openAt");
  const openAtSymbol = symbolAt(analysis.checker, openAt?.name);
  if (!openAtSymbol) return undefined;
  const candidates = directMethodNodes(mediator.method).filter(
    (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) &&
      isIdentifier(node.name, "openAtPrimitive") &&
      node.initializer && ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      analysis.checker.getSymbolAtLocation(node.initializer.expression) === openAtSymbol &&
      node.initializer.arguments.length === 0
  );
  if (candidates.length !== 1) return undefined;
  const declaration = candidates[0]!;
  const openAtPrimitive = symbolAt(analysis.checker, declaration.name);
  if (!openAtPrimitive || declaration.pos >= mediator.call.pos) return undefined;
  const openAtReferences = symbolReferences(analysis.sourceFile, analysis.checker, openAtSymbol);
  if (openAtReferences.length !== 1 || !ts.isCallExpression(openAtReferences[0]!.parent) ||
    openAtReferences[0]!.parent !== declaration.initializer) {
    return undefined;
  }
  const calls = allCalls(analysis.sourceFile).filter(
    (call) => ts.isIdentifier(call.expression) && analysis.checker.getSymbolAtLocation(call.expression) === openAtPrimitive
  );
  const references = symbolReferences(analysis.sourceFile, analysis.checker, openAtPrimitive);
  if (calls.length !== 1 || references.length !== 1 || !isDirectCalleeReference(references[0]!, calls[0]!)) {
    return undefined;
  }
  const parentRecord = methodBindingSymbol(mediator.method, "parentRecord", analysis.checker);
  const childPath = methodBindingSymbol(mediator.method, "childPath", analysis.checker);
  const flags = methodBindingSymbol(mediator.method, "flags", analysis.checker);
  const call = calls[0]!;
  if (!parentRecord || !childPath || !flags || !hasExactChildCString(analysis, mediator.method, childPath) ||
    !isDescendantOf(call, mediator.callback) || !hasNoNestedFunctionBetween(call, mediator.callback) ||
    call.arguments.length !== 3 || !isPropertyOfSymbol(call.arguments[0], parentRecord, "fd", analysis.checker) ||
    !hasSymbol(call.arguments[1], childPath, analysis.checker) ||
    !hasSymbol(call.arguments[2], flags, analysis.checker)) {
    return undefined;
  }
  return Object.freeze({ call, parentRecord, childPath, flags });
}

function hasExactImportedPrimitive(
  analysis: Analysis,
  mediator: CanonicalMediator,
  binding: ts.Symbol
): boolean {
  const call = rawCallForImportedBinding(analysis, binding, mediator);
  if (!call) return false;
  if (mediator.spec.operation === "open_root") {
    const root = methodBindingSymbol(mediator.method, "root", analysis.checker);
    const flags = topLevelBindingSymbol(analysis.sourceFile, "DIRECTORY_OPEN_FLAGS", analysis.checker);
    const phase = methodBindingSymbol(mediator.method, "phase", analysis.checker);
    return call.arguments.length === 2 &&
      hasSymbol(call.arguments[0], root, analysis.checker) &&
      hasSymbol(call.arguments[1], flags, analysis.checker) &&
      hasOpenRootLifecycle(mediator.method, mediator.call, analysis.checker, root, phase, flags);
  }
  if (mediator.spec.operation === "fstat_sync") {
    const record = methodBindingSymbol(mediator.method, "record", analysis.checker);
    return call.arguments.length === 2 &&
      isPropertyOfSymbol(call.arguments[0], record, "fd", analysis.checker) &&
      isBigintOption(call.arguments[1]) &&
      hasStatLifecycle(mediator.method, mediator.call, analysis.checker, record);
  }
  if (mediator.spec.operation === "read_sync") {
    const record = methodBindingSymbol(mediator.method, "record", analysis.checker);
    const buffer = methodBindingSymbol(mediator.method, "buffer", analysis.checker);
    const offset = methodBindingSymbol(mediator.method, "offset", analysis.checker);
    const length = methodBindingSymbol(mediator.method, "length", analysis.checker);
    const position = methodBindingSymbol(mediator.method, "position", analysis.checker);
    return call.arguments.length === 5 &&
      isPropertyOfSymbol(call.arguments[0], record, "fd", analysis.checker) &&
      hasSymbol(call.arguments[1], buffer, analysis.checker) &&
      hasSymbol(call.arguments[2], offset, analysis.checker) &&
      hasSymbol(call.arguments[3], length, analysis.checker) &&
      hasSymbol(call.arguments[4], position, analysis.checker) &&
      ts.isReturnStatement(mediator.call.parent) && mediator.call.parent.expression === mediator.call;
  }
  const record = methodBindingSymbol(mediator.method, "record", analysis.checker);
  return call.arguments.length === 1 &&
    isPropertyOfSymbol(call.arguments[0], record, "fd", analysis.checker) &&
    hasCloseLifecycle(mediator.method, mediator.call, mediator.callback, call, analysis.checker, record);
}

function hasExactOpenAtPrimitive(analysis: Analysis, mediator: CanonicalMediator): boolean {
  const raw = rawOpenAtCall(analysis, mediator);
  return Boolean(raw && hasOpenAtLifecycle(
    mediator.method,
    mediator.call,
    analysis.checker,
    raw.parentRecord,
    raw.flags,
    methodBindingSymbol(mediator.method, "requestedPhase", analysis.checker)
  ));
}

export function rawPrimitiveOwnershipDenials(source: string): readonly RawPrimitiveOwnershipDenial[] {
  const analysis = analyze(source);
  if (!analysis) return RAW_PRIMITIVE_DENIAL_ORDER;
  const mediators = canonicalMediators(analysis);
  const imported = importedRawBindings(analysis);
  if (!mediators || !imported) return RAW_PRIMITIVE_DENIAL_ORDER;
  const denials = new Set<RawPrimitiveOwnershipDenial>();
  for (const spec of PRIMITIVE_SPECS) {
    const mediator = mediators.get(spec.operation);
    const exact = mediator && (spec.operation === "openat"
      ? hasExactOpenAtPrimitive(analysis, mediator)
      : hasExactImportedPrimitive(analysis, mediator, imported.get(spec.imported!)!));
    if (!exact) denials.add(spec.denial);
  }
  return RAW_PRIMITIVE_DENIAL_ORDER.filter((denial) => denials.has(denial));
}
