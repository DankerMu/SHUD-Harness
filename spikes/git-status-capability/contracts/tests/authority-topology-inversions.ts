import ts from "typescript";
import {
  LexicalBindings,
  functionBody,
  functionNodes
} from "./authority-topology-ast";

function isIdentifierResolved(
  expression: ts.Expression | undefined,
  expected: ts.Declaration | undefined,
  bindings: LexicalBindings
): boolean {
  return expression !== undefined && ts.isIdentifier(expression) && bindings.resolve(expression) === expected;
}


function rawModeConditionWithBindings(
  expression: ts.Expression,
  state: ts.Declaration | undefined,
  mode: string,
  bindings: LexicalBindings
): boolean {
  return ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    ts.isPropertyAccessExpression(expression.left) && expression.left.name.text === "rawInversion" &&
    isIdentifierResolved(expression.left.expression, state, bindings) &&
    ts.isStringLiteral(expression.right) && expression.right.text === mode;
}

function operationCondition(expression: ts.Expression, operation: string): boolean {
  return ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    ts.isIdentifier(expression.left) && expression.left.text === "operation" &&
    ts.isStringLiteral(expression.right) && expression.right.text === operation;
}

function callResolved(
  expression: ts.Expression | undefined,
  expected: ts.Declaration | undefined,
  bindings: LexicalBindings,
  names: readonly string[]
): boolean {
  return expression !== undefined && ts.isCallExpression(expression) &&
    isIdentifierResolved(expression.expression, expected, bindings) && expression.arguments.length === names.length &&
    expression.arguments.every((argument, index) => names[index] === "this"
      ? argument.kind === ts.SyntaxKind.ThisKeyword
      : ts.isIdentifier(argument) && argument.text === names[index]);
}

function exactPathPredicate(expression: ts.Expression): boolean {
  if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) {
    return false;
  }
  const pathDefined = expression.left;
  const oneArgument = expression.right;
  return ts.isBinaryExpression(pathDefined) && pathDefined.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
    ts.isIdentifier(pathDefined.left) && pathDefined.left.text === "path" &&
    ts.isIdentifier(pathDefined.right) && pathDefined.right.text === "undefined" &&
    ts.isBinaryExpression(oneArgument) && oneArgument.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    ts.isPropertyAccessExpression(oneArgument.left) && ts.isIdentifier(oneArgument.left.expression) &&
    oneArgument.left.expression.text === "args" && oneArgument.left.name.text === "length" &&
    ts.isNumericLiteral(oneArgument.right) && oneArgument.right.text === "1";
}

function exactPathInversionCondition(
  expression: ts.Expression,
  state: ts.Declaration | undefined,
  bindings: LexicalBindings
): boolean {
  const terms = (current: ts.Expression): readonly ts.Expression[] =>
    ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      ? [...terms(current.left), ...terms(current.right)]
      : [current];
  const values = terms(expression);
  return values.length === 3 && ts.isPrefixUnaryExpression(values[0]!) &&
    values[0]!.operator === ts.SyntaxKind.ExclamationToken && ts.isIdentifier(values[0]!.operand) &&
    values[0]!.operand.text === "descriptorOperation" &&
    rawModeConditionWithBindings(values[1]!, state, "node_fs_readFileSync", bindings) &&
    operationCondition(values[2]!, "node_fs_readFileSync");
}

function exactPathInversion(
  source: ts.SourceFile,
  bindings: LexicalBindings,
  modules: ReadonlyMap<string, ts.Declaration>,
  state: ts.Declaration | undefined
): boolean {
  const root = functionNodes(source, "guardedPathFunction")[0];
  if (!root) return false;
  const body = functionBody(root);
  if (!body) return false;
  const candidates: ts.IfStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node) && exactPathInversionCondition(node.expression, state, bindings)) {
      candidates.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  const candidate = candidates[0];
  if (!candidate || candidates.length !== 1 || candidate.elseStatement || !ts.isBlock(candidate.thenStatement) ||
      candidate.thenStatement.statements.length !== 1 || !ts.isIfStatement(candidate.thenStatement.statements[0])) {
    return false;
  }
  const predicate = candidate.thenStatement.statements[0];
  if (predicate.elseStatement || !exactPathPredicate(predicate.expression) || !ts.isBlock(predicate.thenStatement) ||
      predicate.thenStatement.statements.length !== 1) {
    return false;
  }
  const statement = predicate.thenStatement.statements[0];
  return ts.isExpressionStatement(statement) && callResolved(
    statement.expression,
    modules.get("delegatePathFunction"),
    bindings,
    ["original", "this", "args", "operation", "path"]
  );
}

function exactFfiInversion(
  source: ts.SourceFile,
  bindings: LexicalBindings,
  modules: ReadonlyMap<string, ts.Declaration>,
  state: ts.Declaration | undefined
): boolean {
  const root = functionNodes(source, "guardedDlopen")[0];
  if (!root) return false;
  const candidates: ts.IfStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node) && rawModeConditionWithBindings(node.expression, state, "ffi_dlopen", bindings)) {
      candidates.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  const candidate = candidates[0];
  if (!candidate || candidates.length !== 1 || candidate.elseStatement || !ts.isBlock(candidate.thenStatement) ||
      candidate.thenStatement.statements.length !== 2) {
    return false;
  }
  const [libraryStatement, completion] = candidate.thenStatement.statements;
  if (!ts.isVariableStatement(libraryStatement) || libraryStatement.declarationList.declarations.length !== 1 ||
      !ts.isTryStatement(completion) || completion.catchClause || !completion.finallyBlock ||
      completion.tryBlock.statements.length !== 1 || completion.finallyBlock.statements.length !== 1) {
    return false;
  }
  const library = libraryStatement.declarationList.declarations[0];
  if (!library || !ts.isIdentifier(library.name) || library.name.text !== "library" || !library.initializer ||
      !callResolved(library.initializer, modules.get("delegateFfiDlopen"), bindings, ["path", "symbols"])) {
    return false;
  }
  const denial = completion.tryBlock.statements[0];
  const close = completion.finallyBlock.statements[0];
  if (!denial || !close || !ts.isReturnStatement(denial) || !denial.expression ||
      !ts.isCallExpression(denial.expression) ||
      !isIdentifierResolved(denial.expression.expression, modules.get("deny"), bindings) ||
      denial.expression.arguments.length !== 2 || !ts.isStringLiteral(denial.expression.arguments[0]) ||
      denial.expression.arguments[0].text !== "ffi_dlopen" || !ts.isIdentifier(denial.expression.arguments[1]) ||
      denial.expression.arguments[1].text !== "path") {
    return false;
  }
  return ts.isExpressionStatement(close) &&
    callResolved(close.expression, modules.get("delegateFfiClose"), bindings, ["library", "path"]);
}

export function exactInversionTopologyViolations(
  source: ts.SourceFile,
  bindings: LexicalBindings,
  modules: ReadonlyMap<string, ts.Declaration>,
  state: ts.Declaration | undefined
): readonly string[] {
  const violations: string[] = [];
  if (!exactPathInversion(source, bindings, modules, state)) violations.push("deny_order:guardedPathFunction");
  if (!exactFfiInversion(source, bindings, modules, state)) violations.push("deny_order:guardedDlopen");
  return violations;
}
