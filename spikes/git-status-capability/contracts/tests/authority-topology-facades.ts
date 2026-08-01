import ts from "typescript";
import {
  LexicalBindings,
  declarationName,
  functionBody,
  functionNodes,
  functionParameter,
} from "./authority-topology-ast";

function resolvedIdentifier(
  expression: ts.Expression | undefined,
  expected: ts.Declaration | undefined,
  bindings: LexicalBindings
): boolean {
  return expression !== undefined && ts.isIdentifier(expression) && bindings.resolve(expression) === expected;
}

function namedMethod(object: ts.ObjectLiteralExpression, name: string): ts.MethodDeclaration | undefined {
  const candidates = object.properties.filter((property): property is ts.MethodDeclaration =>
    ts.isMethodDeclaration(property) && ts.isIdentifier(property.name) && property.name.text === name
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

function functionReturn(statement: ts.Statement | undefined): ts.Expression | undefined {
  const candidate = statement && ts.isBlock(statement) && statement.statements.length === 1
    ? statement.statements[0]
    : statement;
  return candidate && ts.isReturnStatement(candidate) ? candidate.expression : undefined;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  return ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) ||
    ts.isParenthesizedExpression(expression) ? unwrapExpression(expression.expression) : expression;
}

function propertyEquals(expression: ts.Expression | undefined, name: string, parameter: ts.Declaration | undefined, bindings: LexicalBindings): boolean {
  return expression !== undefined && ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    resolvedIdentifier(expression.left, parameter, bindings) &&
    ts.isStringLiteral(expression.right) && expression.right.text === name;
}

function reflectCall(
  expression: ts.Expression | undefined,
  method: string,
  argumentsList: readonly (ts.Declaration | undefined)[],
  bindings: LexicalBindings
): boolean {
  return expression !== undefined && ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) && expression.expression.expression.text === "Reflect" &&
    expression.expression.name.text === method && expression.arguments.length === argumentsList.length &&
    expression.arguments.every((argument, index) => resolvedIdentifier(argument, argumentsList[index], bindings));
}

function exactWorkerGet(
  method: ts.MethodDeclaration,
  guardedPrototype: ts.Declaration,
  bindings: LexicalBindings
): boolean {
  const body = functionBody(method);
  const target = functionParameter(method, "target", bindings);
  const property = functionParameter(method, "property", bindings);
  const receiver = functionParameter(method, "receiver", bindings);
  if (!body || !target || !property || !receiver || body.statements.length !== 2) return false;
  const [guard, fallback] = body.statements;
  return !!guard && ts.isIfStatement(guard) && !guard.elseStatement &&
    propertyEquals(guard.expression, "prototype", property, bindings) &&
    resolvedIdentifier(functionReturn(guard.thenStatement), guardedPrototype, bindings) &&
    reflectCall(functionReturn(fallback), "get", [target, property, receiver], bindings);
}

function isValueInDescriptor(expression: ts.Expression | undefined, descriptor: ts.Declaration | undefined, bindings: LexicalBindings): boolean {
  return expression !== undefined && ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.InKeyword &&
    ts.isStringLiteral(expression.left) && expression.left.text === "value" &&
    resolvedIdentifier(expression.right, descriptor, bindings);
}

function descriptorReplacement(
  expression: ts.Expression | undefined,
  descriptor: ts.Declaration | undefined,
  guardedPrototype: ts.Declaration,
  bindings: LexicalBindings
): boolean {
  if (!expression || !ts.isObjectLiteralExpression(expression) || expression.properties.length !== 2) return false;
  const [spread, value] = expression.properties;
  return !!spread && ts.isSpreadAssignment(spread) && resolvedIdentifier(spread.expression, descriptor, bindings) &&
    !!value && ts.isPropertyAssignment(value) && ts.isIdentifier(value.name) && value.name.text === "value" &&
    resolvedIdentifier(value.initializer, guardedPrototype, bindings);
}

function exactWorkerDescriptor(
  method: ts.MethodDeclaration,
  guardedPrototype: ts.Declaration,
  bindings: LexicalBindings
): boolean {
  const body = functionBody(method);
  const target = functionParameter(method, "target", bindings);
  const property = functionParameter(method, "property", bindings);
  if (!body || !target || !property || body.statements.length !== 3) return false;
  const [binding, guard, fallback] = body.statements;
  if (!binding || !ts.isVariableStatement(binding) || binding.declarationList.declarations.length !== 1) return false;
  const descriptor = binding.declarationList.declarations[0];
  if (!descriptor || !ts.isIdentifier(descriptor.name) || descriptor.name.text !== "propertyDescriptor" ||
      !reflectCall(descriptor.initializer, "getOwnPropertyDescriptor", [target, property], bindings)) {
    return false;
  }
  if (!guard || !ts.isIfStatement(guard) || guard.elseStatement || !ts.isBinaryExpression(guard.expression) ||
      guard.expression.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken ||
      !ts.isBinaryExpression(guard.expression.left) ||
      guard.expression.left.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken ||
      !propertyEquals(guard.expression.left.left, "prototype", property, bindings) ||
      !resolvedIdentifier(guard.expression.left.right, descriptor, bindings) ||
      !isValueInDescriptor(guard.expression.right, descriptor, bindings) ||
      !descriptorReplacement(functionReturn(guard.thenStatement), descriptor, guardedPrototype, bindings)) {
    return false;
  }
  return resolvedIdentifier(functionReturn(fallback), descriptor, bindings);
}

function workerFacadeIsExact(source: ts.SourceFile, bindings: LexicalBindings): boolean {
  const patch = functionNodes(source, "patchConstructor")[0];
  const body = functionBody(patch);
  if (!patch || !body) return false;
  const guardedBinding = body.statements.flatMap((statement) => ts.isVariableStatement(statement)
    ? statement.declarationList.declarations.filter((declaration) => declarationName(declaration) === "guarded")
    : []
  )[0];
  if (!guardedBinding || !guardedBinding.initializer || !ts.isNewExpression(guardedBinding.initializer) ||
      !ts.isIdentifier(guardedBinding.initializer.expression) || guardedBinding.initializer.expression.text !== "Proxy" ||
      guardedBinding.initializer.arguments?.length !== 2 || !ts.isIdentifier(guardedBinding.initializer.arguments[0]) ||
      !ts.isObjectLiteralExpression(guardedBinding.initializer.arguments[1])) {
    return false;
  }
  const original = body.statements.flatMap((statement) => ts.isVariableStatement(statement)
    ? statement.declarationList.declarations.filter((declaration) => declarationName(declaration) === "original")
    : []
  )[0];
  const guardedPrototype = body.statements.flatMap((statement) => ts.isVariableStatement(statement)
    ? statement.declarationList.declarations.filter((declaration) => declarationName(declaration) === "guardedPrototype")
    : []
  )[0];
  const proxyTarget = guardedBinding.initializer.arguments[0];
  const traps = guardedBinding.initializer.arguments[1];
  const trapNames = traps.properties.map((property) =>
    ts.isMethodDeclaration(property) && ts.isIdentifier(property.name) ? property.name.text : undefined
  );
  const expectedTraps = ["get", "getOwnPropertyDescriptor", "apply", "construct"];
  if (trapNames.length !== expectedTraps.length || new Set(trapNames).size !== expectedTraps.length ||
      !expectedTraps.every((name) => trapNames.includes(name))) return false;
  if (!original || !guardedPrototype || !resolvedIdentifier(proxyTarget, original, bindings)) return false;
  const get = namedMethod(traps, "get");
  const descriptor = namedMethod(traps, "getOwnPropertyDescriptor");
  return !!get && !!descriptor && exactWorkerGet(get, guardedPrototype, bindings) &&
    exactWorkerDescriptor(descriptor, guardedPrototype, bindings);
}

function directCall(
  expression: ts.Expression | undefined,
  expected: ts.Declaration | undefined,
  names: readonly string[],
  bindings: LexicalBindings
): boolean {
  return expression !== undefined && ts.isCallExpression(expression) &&
    resolvedIdentifier(expression.expression, expected, bindings) && expression.arguments.length === names.length &&
    expression.arguments.every((argument, index) => ts.isIdentifier(argument) && argument.text === names[index]);
}

function objectFreeze(expression: ts.Expression | undefined, value: ts.Declaration | undefined, bindings: LexicalBindings): boolean {
  return expression !== undefined && ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) && ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === "Object" && expression.expression.name.text === "freeze" &&
    expression.arguments.length === 1 && resolvedIdentifier(expression.arguments[0], value, bindings);
}

function exactSymbolLoop(
  statement: ts.Statement | undefined,
  symbols: ts.Declaration,
  guardedFfiSymbol: ts.Declaration | undefined,
  bindings: LexicalBindings
): boolean {
  if (!statement || !ts.isForOfStatement(statement) || !ts.isVariableDeclarationList(statement.initializer) ||
      statement.initializer.declarations.length !== 1 || !ts.isVariableDeclaration(statement.initializer.declarations[0])) {
    return false;
  }
  const declaration = statement.initializer.declarations[0];
  if (!ts.isArrayBindingPattern(declaration.name) || declaration.name.elements.length !== 2 ||
      !ts.isBindingElement(declaration.name.elements[0]) || !ts.isBindingElement(declaration.name.elements[1]) ||
      !ts.isIdentifier(declaration.name.elements[0].name) || !ts.isIdentifier(declaration.name.elements[1].name)) return false;
  const name = declaration.name.elements[0].name;
  const symbol = declaration.name.elements[1].name;
  if (!ts.isCallExpression(statement.expression) || !ts.isPropertyAccessExpression(statement.expression.expression) ||
      !ts.isIdentifier(statement.expression.expression.expression) || statement.expression.expression.expression.text !== "Object" ||
      statement.expression.expression.name.text !== "entries" || statement.expression.arguments.length !== 1 ||
      !ts.isPropertyAccessExpression(statement.expression.arguments[0]) || !ts.isIdentifier(statement.expression.arguments[0].expression) ||
      statement.expression.arguments[0].expression.text !== "library" || statement.expression.arguments[0].name.text !== "symbols") {
    return false;
  }
  const body = ts.isBlock(statement.statement) ? statement.statement : undefined;
  if (!body || body.statements.length !== 1 || !ts.isExpressionStatement(body.statements[0]) ||
      !ts.isBinaryExpression(body.statements[0].expression) || body.statements[0].expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
    return false;
  }
  const assignment = body.statements[0].expression;
  return ts.isElementAccessExpression(assignment.left) && resolvedIdentifier(assignment.left.expression, symbols, bindings) &&
    resolvedIdentifier(assignment.left.argumentExpression, bindings.resolve(name), bindings) &&
    directCall(assignment.right, guardedFfiSymbol, [symbol.text, name.text], bindings);
}

function ffiFacadeIsExact(
  source: ts.SourceFile,
  bindings: LexicalBindings,
  modules: ReadonlyMap<string, ts.Declaration>
): boolean {
  const root = functionNodes(source, "guardedDlopen")[0];
  const body = functionBody(root);
  if (!root || !body || body.statements.length !== 5) return false;
  const libraryStatement = body.statements[1];
  const symbolStatement = body.statements[2];
  const loop = body.statements[3];
  const returned = body.statements[4];
  if (!libraryStatement || !ts.isVariableStatement(libraryStatement) || libraryStatement.declarationList.declarations.length !== 1 ||
      !symbolStatement || !ts.isVariableStatement(symbolStatement) || symbolStatement.declarationList.declarations.length !== 1) return false;
  const library = libraryStatement.declarationList.declarations[0];
  const symbols = symbolStatement.declarationList.declarations[0];
  if (!library || !symbols || declarationName(library) !== "library" || declarationName(symbols) !== "guardedSymbols" ||
      !directCall(library.initializer, modules.get("delegateFfiDlopen"), ["path", "symbols"], bindings) ||
      !symbols.initializer || !ts.isObjectLiteralExpression(symbols.initializer) || symbols.initializer.properties.length !== 0 ||
      !exactSymbolLoop(loop, symbols, modules.get("guardedFfiSymbol"), bindings)) {
    return false;
  }
  const returnedValue = functionReturn(returned);
  const returnedObject = returnedValue && unwrapExpression(returnedValue);
  if (!returnedObject || !ts.isCallExpression(returnedObject) || !ts.isPropertyAccessExpression(returnedObject.expression) ||
      !ts.isIdentifier(returnedObject.expression.expression) || returnedObject.expression.expression.text !== "Object" ||
      returnedObject.expression.name.text !== "freeze" || returnedObject.arguments.length !== 1 ||
      !ts.isObjectLiteralExpression(returnedObject.arguments[0]) || returnedObject.arguments[0].properties.length !== 2) return false;
  const [symbolsProperty, closeProperty] = returnedObject.arguments[0].properties;
  if (!symbolsProperty || !closeProperty || !ts.isPropertyAssignment(symbolsProperty) || !ts.isIdentifier(symbolsProperty.name) ||
      symbolsProperty.name.text !== "symbols" || !objectFreeze(symbolsProperty.initializer, symbols, bindings) ||
      !ts.isPropertyAssignment(closeProperty) || !ts.isIdentifier(closeProperty.name) || closeProperty.name.text !== "close" ||
      !ts.isArrowFunction(closeProperty.initializer) || closeProperty.initializer.parameters.length !== 0 ||
      !directCall(closeProperty.initializer.body as ts.Expression, modules.get("guardedFfiClose"), ["library", "path"], bindings)) {
    return false;
  }
  return true;
}

export function authorityFacadeTopologyViolations(
  source: ts.SourceFile,
  bindings: LexicalBindings,
  modules: ReadonlyMap<string, ts.Declaration>
): readonly string[] {
  const violations: string[] = [];
  if (!workerFacadeIsExact(source, bindings)) violations.push("delegate_owner:worker_construct");
  if (!ffiFacadeIsExact(source, bindings, modules)) violations.push("delegate_owner:ffi_close");
  return violations;
}
