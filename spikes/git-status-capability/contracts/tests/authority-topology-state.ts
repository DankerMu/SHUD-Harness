import ts from "typescript";
import {
  LexicalBindings,
  moduleDeclarations,
  stableBinding
} from "./authority-topology-ast";

function resolvedIdentifier(
  expression: ts.Expression | undefined,
  expected: ts.Declaration | undefined,
  bindings: LexicalBindings
): boolean {
  return expression !== undefined && ts.isIdentifier(expression) && bindings.resolve(expression) === expected;
}

function stringEquals(
  expression: ts.Expression | undefined,
  expected: string,
  binding: ts.Declaration | undefined,
  bindings: LexicalBindings
): boolean {
  return expression !== undefined && ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    resolvedIdentifier(expression.left, binding, bindings) &&
    ts.isStringLiteral(expression.right) && expression.right.text === expected;
}

function sameValue(
  left: ts.Expression,
  right: ts.Expression | undefined,
  bindings: LexicalBindings
): boolean {
  if (!right) return false;
  if (ts.isIdentifier(left) && ts.isIdentifier(right)) {
    return bindings.resolve(left) === bindings.resolve(right);
  }
  if (ts.isStringLiteral(left) && ts.isStringLiteral(right)) return left.text === right.text;
  return left.kind === ts.SyntaxKind.NullKeyword && right.kind === ts.SyntaxKind.NullKeyword;
}

function oneStatementBlock(statement: ts.Statement): ts.Statement | undefined {
  return ts.isBlock(statement) && statement.statements.length === 1 ? statement.statements[0] : undefined;
}

function objectCall(
  expression: ts.Expression | undefined,
  method: string,
  argumentsCount: number
): expression is ts.CallExpression {
  return expression !== undefined && ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) && ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === "Object" && expression.expression.name.text === method &&
    expression.arguments.length === argumentsCount;
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
  const properties = object.properties.filter((candidate): candidate is ts.PropertyAssignment =>
    ts.isPropertyAssignment(candidate) && ts.isIdentifier(candidate.name) && candidate.name.text === name
  );
  return properties.length === 1 ? properties[0] : undefined;
}

function arrowProperty(object: ts.ObjectLiteralExpression, name: string): ts.ArrowFunction | undefined {
  const candidate = property(object, name);
  return candidate && ts.isArrowFunction(candidate.initializer) ? candidate.initializer : undefined;
}

function assignmentTo(
  statement: ts.Statement | undefined,
  state: ts.Declaration | undefined,
  name: string,
  value: ts.Expression | undefined,
  bindings: LexicalBindings
): boolean {
  return !!statement && ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) &&
    statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(statement.expression.left) && statement.expression.left.name.text === name &&
    resolvedIdentifier(statement.expression.left.expression, state, bindings) &&
    sameValue(statement.expression.right, value, bindings);
}

function exactSelectedControl(
  modules: ReadonlyMap<string, ts.Declaration>,
  bindings: LexicalBindings
): boolean {
  const selectedControl = modules.get("selectedControl");
  if (!selectedControl || !ts.isVariableDeclaration(selectedControl) || !selectedControl.initializer ||
      !ts.isElementAccessExpression(selectedControl.initializer) || !ts.isNumericLiteral(selectedControl.initializer.argumentExpression) ||
      selectedControl.initializer.argumentExpression.text !== "2" || !ts.isCallExpression(selectedControl.initializer.expression)) return false;
  const slice = selectedControl.initializer.expression;
  return ts.isPropertyAccessExpression(slice.expression) && ts.isPropertyAccessExpression(slice.expression.expression) &&
    ts.isIdentifier(slice.expression.expression.expression) && slice.expression.expression.expression.text === "Bun" &&
    slice.expression.expression.name.text === "argv" && slice.expression.name.text === "slice" &&
    slice.arguments.length === 1 && ts.isNumericLiteral(slice.arguments[0]) && slice.arguments[0]!.text === "2" &&
    stableBinding(selectedControl, bindings);
}

function exactSelectedInversion(
  modules: ReadonlyMap<string, ts.Declaration>,
  bindings: LexicalBindings
): boolean {
  const selectedControl = modules.get("selectedControl");
  const inversion = modules.get("selectedRawInversion");
  if (!selectedControl || !inversion || !ts.isVariableDeclaration(inversion) || !inversion.initializer ||
      !ts.isConditionalExpression(inversion.initializer)) return false;
  const outer = inversion.initializer;
  if (!stringEquals(outer.condition, "raw_read_inversion_canary", selectedControl, bindings) ||
      !ts.isStringLiteral(outer.whenTrue) || outer.whenTrue.text !== "node_fs_readFileSync" ||
      !ts.isConditionalExpression(outer.whenFalse)) return false;
  const inner = outer.whenFalse;
  return stringEquals(inner.condition, "raw_ffi_inversion_canary", selectedControl, bindings) &&
    ts.isStringLiteral(inner.whenTrue) && inner.whenTrue.text === "ffi_dlopen" &&
    inner.whenFalse.kind === ts.SyntaxKind.NullKeyword && stableBinding(inversion, bindings);
}

function exactStateInitializer(state: ts.Declaration | undefined, bindings: LexicalBindings): boolean {
  if (!state || !ts.isVariableDeclaration(state) || !state.initializer || !ts.isObjectLiteralExpression(state.initializer) ||
      !stableBinding(state, bindings)) return false;
  const phase = property(state.initializer, "phase");
  const events = property(state.initializer, "events");
  const rawEvents = property(state.initializer, "rawEvents");
  const rawInversion = property(state.initializer, "rawInversion");
  return !!phase && ts.isStringLiteral(phase.initializer) && phase.initializer.text === "admission" &&
    !!events && ts.isArrayLiteralExpression(events.initializer) && events.initializer.elements.length === 0 &&
    !!rawEvents && ts.isArrayLiteralExpression(rawEvents.initializer) && rawEvents.initializer.elements.length === 0 &&
    !!rawInversion && rawInversion.initializer.kind === ts.SyntaxKind.NullKeyword;
}

function exactPhaseSetter(
  setter: ts.ArrowFunction | undefined,
  state: ts.Declaration | undefined,
  bindings: LexicalBindings
): boolean {
  const parameter = setter?.parameters[0];
  if (!setter || setter.parameters.length !== 1 || !parameter || !ts.isIdentifier(parameter.name) ||
      parameter.name.text !== "value" || !ts.isBlock(setter.body) || setter.body.statements.length !== 1) return false;
  const guard = setter.body.statements[0];
  if (!ts.isIfStatement(guard) || guard.elseStatement || !ts.isBinaryExpression(guard.expression) ||
      !stringEquals(guard.expression, "post_admission", bindings.resolve(parameter.name), bindings)) {
    return false;
  }
  return assignmentTo(guard.thenStatement, state, "phase", guard.expression.right, bindings);
}

function exactRawInversionSetter(
  setter: ts.ArrowFunction | undefined,
  state: ts.Declaration | undefined,
  selected: ts.Declaration | undefined,
  bindings: LexicalBindings
): boolean {
  const parameter = setter?.parameters[0];
  if (!setter || setter.parameters.length !== 1 || !parameter || !ts.isIdentifier(parameter.name) ||
      parameter.name.text !== "value" || !ts.isBlock(setter.body) || setter.body.statements.length !== 1) return false;
  const value = bindings.resolve(parameter.name);
  const outer = setter.body.statements[0];
  if (!ts.isIfStatement(outer) || !outer.elseStatement || !ts.isBinaryExpression(outer.expression) ||
      outer.expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
      !resolvedIdentifier(outer.expression.left, value, bindings) ||
      !resolvedIdentifier(outer.expression.right, selected, bindings) ||
      !assignmentTo(oneStatementBlock(outer.thenStatement), state, "rawInversion", outer.expression.right, bindings) ||
      !ts.isIfStatement(outer.elseStatement) || outer.elseStatement.elseStatement ||
      !ts.isBinaryExpression(outer.elseStatement.expression) ||
      outer.elseStatement.expression.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) return false;
  const nested = outer.elseStatement.expression;
  const [isNull, matchesSelected] = [nested.left, nested.right];
  return ts.isBinaryExpression(isNull) && isNull.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    resolvedIdentifier(isNull.left, value, bindings) && isNull.right.kind === ts.SyntaxKind.NullKeyword &&
    ts.isBinaryExpression(matchesSelected) && matchesSelected.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    ts.isPropertyAccessExpression(matchesSelected.left) && matchesSelected.left.name.text === "rawInversion" &&
    resolvedIdentifier(matchesSelected.left.expression, state, bindings) && resolvedIdentifier(matchesSelected.right, selected, bindings) &&
    assignmentTo(oneStatementBlock(outer.elseStatement.thenStatement), state, "rawInversion", isNull.right, bindings);
}

function exactObservedState(
  source: ts.SourceFile,
  modules: ReadonlyMap<string, ts.Declaration>,
  state: ts.Declaration | undefined,
  bindings: LexicalBindings
): boolean {
  const observed = modules.get("observedState");
  const selected = modules.get("selectedRawInversion");
  if (!observed || !stableBinding(observed, bindings)) return false;
  const definitions: ts.CallExpression[] = [];
  const freezes: ts.CallExpression[] = [];
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement)) continue;
    if (objectCall(statement.expression, "defineProperties", 2) &&
        resolvedIdentifier(statement.expression.arguments[0], observed, bindings)) {
      definitions.push(statement.expression);
    }
    if (objectCall(statement.expression, "freeze", 1) &&
        resolvedIdentifier(statement.expression.arguments[0], observed, bindings)) {
      freezes.push(statement.expression);
    }
  }
  const definitionsObject = definitions[0]?.arguments[1];
  if (definitions.length !== 1 || !definitionsObject || !ts.isObjectLiteralExpression(definitionsObject)) return false;
  const phase = property(definitionsObject, "phase");
  const raw = property(definitionsObject, "rawInversion");
  return !!phase && !!raw && ts.isObjectLiteralExpression(phase.initializer) &&
    ts.isObjectLiteralExpression(raw.initializer) &&
    exactPhaseSetter(arrowProperty(phase.initializer, "set"), state, bindings) &&
    exactRawInversionSetter(arrowProperty(raw.initializer, "set"), state, selected, bindings) &&
    freezes.length === 1;
}

export function authorityStateTopologyViolations(source: ts.SourceFile): readonly string[] {
  const bindings = new LexicalBindings(source);
  const modules = moduleDeclarations(source);
  const state = modules.get("state");
  return exactSelectedControl(modules, bindings) &&
    exactSelectedInversion(modules, bindings) &&
    exactStateInitializer(state, bindings) &&
    exactObservedState(source, modules, state, bindings)
    ? []
    : ["deny_order:guardedPathFunction"];
}
