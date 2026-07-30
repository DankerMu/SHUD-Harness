import ts from "typescript";

function authorityPreloadSource(text: string): ts.SourceFile {
  return ts.createSourceFile("authority-preload.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function callsNamed(node: ts.Node | undefined, name: string): node is ts.CallExpression {
  return node !== undefined && ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) && node.expression.text === name;
}

function namedMemberAccess(expression: ts.Expression, objectName: string, memberName: string): boolean {
  if (ts.isPropertyAccessExpression(expression)) {
    return ts.isIdentifier(expression.expression) && expression.expression.text === objectName &&
      expression.name.text === memberName;
  }
  return ts.isElementAccessExpression(expression) && ts.isIdentifier(expression.expression) &&
    expression.expression.text === objectName && ts.isStringLiteral(expression.argumentExpression) &&
    expression.argumentExpression.text === memberName;
}

function callsNamedMember(
  node: ts.Node | undefined,
  objectName: string,
  memberName: string
): node is ts.CallExpression {
  return node !== undefined && ts.isCallExpression(node) &&
    namedMemberAccess(node.expression, objectName, memberName);
}

function namedMemberAccessNode(node: ts.Node, objectName: string, memberName: string): boolean {
  return (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    namedMemberAccess(node, objectName, memberName);
}

function namedFunctionOwner(node: ts.Node): string | undefined {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isMethodDeclaration(current)) {
      if (current.name && ts.isIdentifier(current.name)) return current.name.text;
    }
    if (ts.isArrowFunction(current) && ts.isVariableDeclaration(current.parent) &&
        ts.isIdentifier(current.parent.name)) {
      return current.parent.name.text;
    }
  }
  return undefined;
}

function expressionCallsNamed(statement: ts.Statement | undefined, name: string): boolean {
  return statement !== undefined && ts.isExpressionStatement(statement) && callsNamed(statement.expression, name);
}

function expressionCallsNamedMember(
  statement: ts.Statement | undefined,
  objectName: string,
  memberName: string
): boolean {
  return statement !== undefined && ts.isExpressionStatement(statement) &&
    callsNamedMember(statement.expression, objectName, memberName);
}

function returnCallsNamed(statement: ts.Statement | undefined, name: string): boolean {
  return statement !== undefined && ts.isReturnStatement(statement) && callsNamed(statement.expression, name);
}

function returnCallsNamedMember(
  statement: ts.Statement | undefined,
  objectName: string,
  memberName: string
): boolean {
  return statement !== undefined && ts.isReturnStatement(statement) &&
    callsNamedMember(statement.expression, objectName, memberName);
}

function statePropertyEqualsString(expression: ts.Expression, property: string, value: string): boolean {
  return ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    namedMemberAccess(expression.left, "state", property) &&
    ts.isStringLiteral(expression.right) && expression.right.text === value;
}

function statePropertyEqualsIdentifier(expression: ts.Expression, property: string, value: string): boolean {
  return ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    namedMemberAccess(expression.left, "state", property) &&
    ts.isIdentifier(expression.right) && expression.right.text === value;
}

function postAdmissionCondition(expression: ts.Expression): boolean {
  return statePropertyEqualsString(expression, "phase", "post_admission");
}

function postAdmissionPathCondition(expression: ts.Expression): boolean {
  return ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
    postAdmissionCondition(expression.left) && ts.isIdentifier(expression.right) &&
    expression.right.text === "path";
}

function topLevelFunctionBodies(source: ts.SourceFile, name: string): ts.Block[] {
  return source.statements.flatMap((statement) => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body
      ? [statement.body]
      : []
  ));
}

function namedFunctionExpressionBodies(source: ts.SourceFile, name: string): ts.Block[] {
  const bodies: ts.Block[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionExpression(node) && node.name?.text === name) bodies.push(node.body);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bodies;
}

function namedArrowInitializerBodies(source: ts.SourceFile, name: string): ts.Block[] {
  const bodies: ts.Block[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name &&
        node.initializer && ts.isArrowFunction(node.initializer) && ts.isBlock(node.initializer.body)) {
      bodies.push(node.initializer.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bodies;
}

function constructTrapBodies(source: ts.SourceFile): ts.Block[] {
  const bodies: ts.Block[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "construct" &&
        namedFunctionOwner(node) === "patchConstructor" && node.body) {
      bodies.push(node.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bodies;
}

function singlePreloadBody(
  bodies: readonly ts.Block[],
  violation: string,
  violations: Set<string>
): ts.Block | undefined {
  if (bodies.length !== 1) {
    violations.add(violation);
    return undefined;
  }
  return bodies[0];
}

function helperDelegatesAfterRawOperation(
  body: ts.Block,
  condition: (expression: ts.Expression) => boolean,
  delegation: (statement: ts.Statement | undefined) => boolean
): boolean {
  const [rawGuard, delegated] = body.statements;
  return body.statements.length === 2 && rawGuard !== undefined && ts.isIfStatement(rawGuard) &&
    rawGuard.elseStatement === undefined && condition(rawGuard.expression) &&
    expressionCallsNamed(rawGuard.thenStatement, "rawOperation") && delegation(delegated);
}

function variableInitializesNamedCall(
  statement: ts.Statement | undefined,
  bindingName: string,
  delegateName: string
): boolean {
  if (statement === undefined || !ts.isVariableStatement(statement)) return false;
  const declaration = statement.declarationList.declarations[0];
  return statement.declarationList.declarations.length === 1 && declaration !== undefined &&
    ts.isIdentifier(declaration.name) && declaration.name.text === bindingName &&
    callsNamed(declaration.initializer, delegateName);
}

function constructTrapHasTopology(body: ts.Block): boolean {
  const [postAdmissionGuard, normalDelegate] = body.statements;
  return body.statements.length === 2 && postAdmissionGuard !== undefined &&
    ts.isIfStatement(postAdmissionGuard) && postAdmissionGuard.elseStatement === undefined &&
    postAdmissionCondition(postAdmissionGuard.expression) &&
    expressionCallsNamed(postAdmissionGuard.thenStatement, "deny") &&
    returnCallsNamed(normalDelegate, "delegateWorkerConstruct");
}

function pathGuardHasTopology(body: ts.Block): boolean {
  let postAdmissionGuard: ts.IfStatement | undefined;
  let postAdmissionGuardIndex = -1;
  let normalDelegateIndex = -1;
  for (let index = 0; index < body.statements.length; index += 1) {
    const statement = body.statements[index];
    if (statement === undefined) return false;
    if (ts.isIfStatement(statement) && postAdmissionPathCondition(statement.expression)) {
      if (postAdmissionGuard) return false;
      postAdmissionGuard = statement;
      postAdmissionGuardIndex = index;
    }
    if (returnCallsNamed(statement, "delegatePathFunction")) {
      if (normalDelegateIndex >= 0) return false;
      normalDelegateIndex = index;
    }
  }
  if (!postAdmissionGuard || postAdmissionGuardIndex >= normalDelegateIndex ||
      postAdmissionGuard.elseStatement !== undefined || !ts.isBlock(postAdmissionGuard.thenStatement)) {
    return false;
  }

  const [inversionGuard, normalDeny] = postAdmissionGuard.thenStatement.statements;
  if (postAdmissionGuard.thenStatement.statements.length !== 2 || inversionGuard === undefined ||
      !ts.isIfStatement(inversionGuard) || inversionGuard.elseStatement !== undefined ||
      !statePropertyEqualsIdentifier(inversionGuard.expression, "rawInversion", "operation") ||
      !ts.isBlock(inversionGuard.thenStatement) || !expressionCallsNamed(normalDeny, "deny")) {
    return false;
  }

  return inversionGuard.thenStatement.statements.length === 1 &&
    expressionCallsNamed(inversionGuard.thenStatement.statements[0], "delegatePathFunction");
}

function ffiDlopenHasTopology(body: ts.Block): boolean {
  const [postAdmissionGuard, normalDelegate] = body.statements;
  if (postAdmissionGuard === undefined || !ts.isIfStatement(postAdmissionGuard) ||
      postAdmissionGuard.elseStatement !== undefined || !postAdmissionCondition(postAdmissionGuard.expression) ||
      !ts.isBlock(postAdmissionGuard.thenStatement) ||
      !variableInitializesNamedCall(normalDelegate, "library", "delegateFfiDlopen")) {
    return false;
  }

  const [inversionGuard, normalDeny] = postAdmissionGuard.thenStatement.statements;
  if (postAdmissionGuard.thenStatement.statements.length !== 2 || inversionGuard === undefined ||
      !ts.isIfStatement(inversionGuard) || inversionGuard.elseStatement !== undefined ||
      !statePropertyEqualsString(inversionGuard.expression, "rawInversion", "ffi_dlopen") ||
      !ts.isBlock(inversionGuard.thenStatement) || !expressionCallsNamed(normalDeny, "deny")) {
    return false;
  }

  const [inversionDelegate, cleanup] = inversionGuard.thenStatement.statements;
  if (inversionGuard.thenStatement.statements.length !== 2 ||
      !variableInitializesNamedCall(inversionDelegate, "library", "delegateFfiDlopen") ||
      cleanup === undefined || !ts.isTryStatement(cleanup) || cleanup.catchClause !== undefined ||
      cleanup.finallyBlock === undefined || cleanup.tryBlock.statements.length !== 1 ||
      cleanup.finallyBlock.statements.length !== 1 ||
      !returnCallsNamed(cleanup.tryBlock.statements[0], "deny")) {
    return false;
  }

  return expressionCallsNamed(cleanup.finallyBlock.statements[0], "delegateFfiClose");
}

export function authorityPreloadTopologyViolations(text: string): string[] {
  const source = authorityPreloadSource(text);
  const violations = new Set<string>();
  if (source.parseDiagnostics.length > 0) violations.add("authority_preload_parse_error");

  const visit = (node: ts.Node): void => {
    if (namedMemberAccessNode(node, "Reflect", "construct") &&
        namedFunctionOwner(node) !== "delegateWorkerConstruct") {
      violations.add("worker_construct_outside_delegateWorkerConstruct");
    }
    if (namedMemberAccessNode(node, "original", "apply")) {
      const owner = namedFunctionOwner(node);
      if (owner !== "delegatePathFunction" && owner !== "delegateChildProcess") {
        violations.add("path_original_apply_outside_delegatePathFunction_or_delegateChildProcess");
      }
    }
    if (callsNamed(node, "originalDlopen") && namedFunctionOwner(node) !== "delegateFfiDlopen") {
      violations.add("ffi_dlopen_outside_delegateFfiDlopen");
    }
    if (namedMemberAccessNode(node, "library", "close") &&
        namedFunctionOwner(node) !== "delegateFfiClose") {
      violations.add("ffi_close_outside_delegateFfiClose");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const workerDelegate = singlePreloadBody(
    topLevelFunctionBodies(source, "delegateWorkerConstruct"),
    "delegateWorkerConstruct_missing_or_duplicated",
    violations
  );
  if (workerDelegate && !helperDelegatesAfterRawOperation(
    workerDelegate,
    postAdmissionCondition,
    (statement) => returnCallsNamedMember(statement, "Reflect", "construct")
  )) {
    violations.add("delegateWorkerConstruct_requires_raw_before_construct");
  }

  const pathDelegate = singlePreloadBody(
    topLevelFunctionBodies(source, "delegatePathFunction"),
    "delegatePathFunction_missing_or_duplicated",
    violations
  );
  if (pathDelegate && !helperDelegatesAfterRawOperation(
    pathDelegate,
    postAdmissionPathCondition,
    (statement) => returnCallsNamedMember(statement, "original", "apply")
  )) {
    violations.add("delegatePathFunction_requires_raw_before_apply");
  }

  const childDelegate = singlePreloadBody(
    topLevelFunctionBodies(source, "delegateChildProcess"),
    "delegateChildProcess_missing_or_duplicated",
    violations
  );
  if (childDelegate && !helperDelegatesAfterRawOperation(
    childDelegate,
    postAdmissionCondition,
    (statement) => returnCallsNamedMember(statement, "original", "apply")
  )) {
    violations.add("delegateChildProcess_requires_raw_before_apply");
  }

  const ffiDelegate = singlePreloadBody(
    topLevelFunctionBodies(source, "delegateFfiDlopen"),
    "delegateFfiDlopen_missing_or_duplicated",
    violations
  );
  if (ffiDelegate && !helperDelegatesAfterRawOperation(
    ffiDelegate,
    postAdmissionCondition,
    (statement) => returnCallsNamed(statement, "originalDlopen")
  )) {
    violations.add("delegateFfiDlopen_requires_raw_before_dlopen");
  }

  const ffiCloseDelegate = singlePreloadBody(
    topLevelFunctionBodies(source, "delegateFfiClose"),
    "delegateFfiClose_missing_or_duplicated",
    violations
  );
  if (ffiCloseDelegate && !helperDelegatesAfterRawOperation(
    ffiCloseDelegate,
    postAdmissionCondition,
    (statement) => expressionCallsNamedMember(statement, "library", "close")
  )) {
    violations.add("delegateFfiClose_requires_raw_before_close");
  }

  const constructTrap = singlePreloadBody(
    constructTrapBodies(source),
    "guarded_construct_trap_missing_or_duplicated",
    violations
  );
  if (constructTrap && !constructTrapHasTopology(constructTrap)) {
    violations.add("guarded_construct_requires_denial_then_delegateWorkerConstruct");
  }

  const pathGuard = singlePreloadBody(
    namedFunctionExpressionBodies(source, "guardedPathFunction"),
    "guarded_path_function_missing_or_duplicated",
    violations
  );
  if (pathGuard && !pathGuardHasTopology(pathGuard)) {
    violations.add("guarded_path_requires_declared_inversion_topology");
  }

  const ffiGuard = singlePreloadBody(
    namedArrowInitializerBodies(source, "guardedDlopen"),
    "guarded_ffi_dlopen_missing_or_duplicated",
    violations
  );
  if (ffiGuard && !ffiDlopenHasTopology(ffiGuard)) {
    violations.add("guarded_ffi_requires_declared_inversion_topology");
  }

  return [...violations].sort();
}

function requiredPreloadBody(bodies: readonly ts.Block[], name: string): ts.Block {
  const body = bodies[0];
  if (bodies.length !== 1 || body === undefined) throw new Error(`MISSING_PRELOAD_TOPOLOGY_NODE:${name}`);
  return body;
}

function requiredGuardDenyStatement(
  body: ts.Block,
  condition: (expression: ts.Expression) => boolean,
  name: string
): ts.Statement {
  let match: ts.Statement | undefined;
  for (const statement of body.statements) {
    if (!ts.isIfStatement(statement) || !condition(statement.expression)) continue;
    const candidates = ts.isBlock(statement.thenStatement)
      ? statement.thenStatement.statements
      : [statement.thenStatement];
    for (const candidate of candidates) {
      if (!expressionCallsNamed(candidate, "deny")) continue;
      if (match) throw new Error(`DUPLICATE_PRELOAD_GUARD_DENY:${name}`);
      match = candidate;
    }
  }
  if (!match) throw new Error(`MISSING_PRELOAD_GUARD_DENY:${name}`);
  return match;
}

function requiredNamedCall(source: ts.SourceFile, name: string): ts.CallExpression {
  let match: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (callsNamed(node, name)) {
      if (match) throw new Error(`DUPLICATE_PRELOAD_NAMED_CALL:${name}`);
      match = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!match) throw new Error(`MISSING_PRELOAD_NAMED_CALL:${name}`);
  return match;
}

function replacePreloadNode(source: ts.SourceFile, node: ts.Node, replacement: string): string {
  return `${source.text.slice(0, node.getStart(source))}${replacement}${source.text.slice(node.getEnd())}`;
}

export function workerConstructBypassSource(text: string): string {
  const source = authorityPreloadSource(text);
  const constructTrap = requiredPreloadBody(constructTrapBodies(source), "construct");
  return replacePreloadNode(
    source,
    requiredGuardDenyStatement(constructTrap, postAdmissionCondition, "construct"),
    "{\n        Reflect.construct(target, argumentsList, newTarget);\n        deny(operation);\n      }"
  );
}

export function pathApplyBypassSource(text: string): string {
  const source = authorityPreloadSource(text);
  const pathGuard = requiredPreloadBody(namedFunctionExpressionBodies(source, "guardedPathFunction"), "path");
  return replacePreloadNode(
    source,
    requiredGuardDenyStatement(pathGuard, postAdmissionPathCondition, "path"),
    "original.apply(this, args);\n          deny(operation, path);"
  );
}

export function ffiDlopenBypassSource(text: string): string {
  const source = authorityPreloadSource(text);
  const ffiGuard = requiredPreloadBody(namedArrowInitializerBodies(source, "guardedDlopen"), "ffi_dlopen");
  return replacePreloadNode(
    source,
    requiredGuardDenyStatement(ffiGuard, postAdmissionCondition, "ffi_dlopen"),
    "originalDlopen(path, symbols);\n    deny(\"ffi_dlopen\", path);"
  );
}

export function ffiCloseBypassSource(text: string): string {
  const source = authorityPreloadSource(text);
  return replacePreloadNode(source, requiredNamedCall(source, "delegateFfiClose"), "library.close()");
}

function authorityControlSource(text: string): ts.SourceFile {
  return ts.createSourceFile("authority-control.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}


function awaitsNamedWithIdentifiers(
  statement: ts.Statement | undefined,
  name: string,
  identifiers: readonly string[]
): boolean {
  if (statement === undefined || !ts.isExpressionStatement(statement) ||
      !ts.isAwaitExpression(statement.expression)) {
    return false;
  }
  const call = statement.expression.expression;
  if (!callsNamed(call, name) || call.arguments.length !== identifiers.length) return false;
  return identifiers.every((identifier, index) => {
    const argument = call.arguments[index];
    return argument !== undefined && ts.isIdentifier(argument) && argument.text === identifier;
  });
}

function returnsStringLiteral(statement: ts.Statement | undefined, value: string): boolean {
  return statement !== undefined && ts.isReturnStatement(statement) &&
    ts.isStringLiteral(statement.expression) && statement.expression.text === value;
}

function identifierEqualsString(expression: ts.Expression, identifier: string, value: string): boolean {
  return ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    ts.isIdentifier(expression.left) && expression.left.text === identifier &&
    ts.isStringLiteral(expression.right) && expression.right.text === value;
}

function variableInitializesNamedMemberCall(
  statement: ts.Statement | undefined,
  bindingName: string,
  objectName: string,
  memberName: string
): boolean {
  if (statement === undefined || !ts.isVariableStatement(statement)) return false;
  const declaration = statement.declarationList.declarations[0];
  return statement.declarationList.declarations.length === 1 && declaration !== undefined &&
    ts.isIdentifier(declaration.name) && declaration.name.text === bindingName &&
    callsNamedMemberWithIdentifierArgument(
      declaration.initializer,
      objectName,
      memberName,
      0,
      "candidate"
    );
}

function callsNamedMemberWithIdentifierArgument(
  node: ts.Node | undefined,
  objectName: string,
  memberName: string,
  argumentIndex: number,
  identifier: string
): boolean {
  if (!callsNamedMember(node, objectName, memberName)) return false;
  const argument = node.arguments[argumentIndex];
  return argument !== undefined && ts.isIdentifier(argument) && argument.text === identifier;
}

function negatedPromiseLikeCompletion(expression: ts.Expression): boolean {
  if (!ts.isPrefixUnaryExpression(expression) || expression.operator !== ts.SyntaxKind.ExclamationToken) {
    return false;
  }
  const promiseLike = expression.operand;
  if (!callsNamed(promiseLike, "isPromiseLike")) return false;
  const completion = promiseLike.arguments[0];
  return promiseLike.arguments.length === 1 && completion !== undefined &&
    ts.isIdentifier(completion) && completion.text === "completion";
}

function statementContainsThrow(statement: ts.Statement): boolean {
  if (ts.isThrowStatement(statement)) return true;
  return ts.isBlock(statement) && statement.statements.some(statementContainsThrow);
}

function nestedFunctionBodies(root: ts.Node, name: string): ts.Block[] {
  const bodies: ts.Block[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body) bodies.push(node.body);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return bodies;
}

function callsNamedOnlyFromOwner(root: ts.Node, name: string, owner: string): boolean {
  let found = false;
  let valid = true;
  const visit = (node: ts.Node): void => {
    if (callsNamed(node, name)) {
      if (found || namedFunctionOwner(node) !== owner) valid = false;
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found && valid;
}

function closeListenerRegistration(statement: ts.Statement): boolean {
  if (!ts.isExpressionStatement(statement)) return false;
  const registration = statement.expression;
  if (!callsNamedMember(registration, "addEventListener", "call")) return false;
  const event = registration.arguments[1];
  const callback = registration.arguments[2];
  return event !== undefined && ts.isStringLiteral(event) && event.text === "close" &&
    callback !== undefined && ts.isIdentifier(callback) && callback.text === "close";
}

function globalCloseListenerBeforeTerminate(body: ts.Block): boolean {
  const tryStatements: ts.TryStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTryStatement(node)) tryStatements.push(node);
    ts.forEachChild(node, visit);
  };
  visit(body);
  if (tryStatements.length !== 1) return false;

  let listenerIndex = -1;
  let terminateIndex = -1;
  for (let index = 0; index < tryStatements[0].tryBlock.statements.length; index += 1) {
    const statement = tryStatements[0].tryBlock.statements[index];
    if (statement === undefined) return false;
    if (closeListenerRegistration(statement)) {
      if (listenerIndex >= 0) return false;
      listenerIndex = index;
    }
    if (expressionCallsNamedMember(statement, "terminate", "call")) {
      if (terminateIndex >= 0) return false;
      terminateIndex = index;
    }
  }
  return listenerIndex >= 0 && terminateIndex >= 0 && listenerIndex < terminateIndex;
}

function globalCloseCompletionHasTopology(body: ts.Block): boolean {
  const closeBodies = nestedFunctionBodies(body, "close");
  const resolveOnceBodies = nestedFunctionBodies(body, "resolveOnce");
  return closeBodies.length === 1 && resolveOnceBodies.length === 1 &&
    closeBodies[0] !== undefined && closeBodies[0].statements.length === 1 &&
    expressionCallsNamed(closeBodies[0].statements[0], "resolveOnce") &&
    callsNamedOnlyFromOwner(body, "resolve", "resolveOnce") &&
    callsNamedOnlyFromOwner(body, "resolveOnce", "close");
}

function promiseCompletionThen(node: ts.Node): boolean {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== "then") {
    return false;
  }
  const promiseResolution = node.expression.expression;
  if (!callsNamedMember(promiseResolution, "Promise", "resolve")) return false;
  const completion = promiseResolution.arguments[0];
  return promiseResolution.arguments.length === 1 && completion !== undefined &&
    ts.isIdentifier(completion) && completion.text === "completion";
}

function awaitedPromiseExecutor(body: ts.Block): ts.Block | undefined {
  if (body.statements.length !== 1) return undefined;
  const statement = body.statements[0];
  if (statement === undefined || !ts.isExpressionStatement(statement) ||
      !ts.isAwaitExpression(statement.expression)) {
    return undefined;
  }
  const promise = statement.expression.expression;
  if (!ts.isNewExpression(promise) || !ts.isIdentifier(promise.expression) ||
      promise.expression.text !== "Promise") {
    return undefined;
  }
  const executor = promise.arguments?.[0];
  return executor !== undefined && ts.isArrowFunction(executor) && ts.isBlock(executor.body)
    ? executor.body
    : undefined;
}

function boundedNodeExitHasTopology(body: ts.Block): boolean {
  const executor = awaitedPromiseExecutor(body);
  if (!executor) return false;

  let timeout = false;
  let completionThen = false;
  const visit = (node: ts.Node): void => {
    if (callsNamed(node, "setTimeout")) {
      const duration = node.arguments[1];
      if (duration !== undefined && ts.isIdentifier(duration) &&
          duration.text === "WORKER_TERMINATION_TIMEOUT_MS") {
        timeout = true;
      }
    }
    if (promiseCompletionThen(node)) completionThen = true;
    ts.forEachChild(node, visit);
  };
  visit(executor);
  return timeout && completionThen;
}

function workerTerminationHasTopology(body: ts.Block): boolean {
  let globalGuard: ts.IfStatement | undefined;
  let globalGuardIndex = -1;
  for (let index = 0; index < body.statements.length; index += 1) {
    const statement = body.statements[index];
    if (statement === undefined || !ts.isIfStatement(statement) ||
        !identifierEqualsString(statement.expression, "channel", "global")) {
      continue;
    }
    if (globalGuard) return false;
    globalGuard = statement;
    globalGuardIndex = index;
  }
  if (!globalGuard || !ts.isBlock(globalGuard.thenStatement) ||
      globalGuard.thenStatement.statements.length !== 2 ||
      !awaitsNamedWithIdentifiers(
        globalGuard.thenStatement.statements[0],
        "awaitGlobalWorkerClose",
        ["candidate", "terminate"]
      ) ||
      !returnsStringLiteral(globalGuard.thenStatement.statements[1], "close")) {
    return false;
  }

  const completion = body.statements[globalGuardIndex + 1];
  const promiseGuard = body.statements[globalGuardIndex + 2];
  const boundedAwait = body.statements[globalGuardIndex + 3];
  const exit = body.statements[globalGuardIndex + 4];
  return variableInitializesNamedMemberCall(completion, "completion", "terminate", "call") &&
    promiseGuard !== undefined && ts.isIfStatement(promiseGuard) &&
    negatedPromiseLikeCompletion(promiseGuard.expression) &&
    statementContainsThrow(promiseGuard.thenStatement) &&
    awaitsNamedWithIdentifiers(boundedAwait, "awaitNodeWorkerExit", ["completion"]) &&
    returnsStringLiteral(exit, "exit");
}

function throwingSentinelExistenceGuard(statement: ts.Statement): boolean {
  return ts.isIfStatement(statement) &&
    callsNamedMemberWithIdentifierArgument(
      statement.expression,
      "staticNodeFs",
      "existsSync",
      0,
      "workerEntrySentinel"
    ) &&
    statementContainsThrow(statement.thenStatement);
}

function sentinelCleanupPrecedesRoutePush(body: ts.Block): boolean {
  const loops: ts.ForOfStatement[] = [];
  for (const statement of body.statements) {
    if (ts.isForOfStatement(statement)) loops.push(statement);
  }
  if (loops.length !== 1 || !ts.isBlock(loops[0].statement)) return false;

  const tryStatements = loops[0].statement.statements.filter(ts.isTryStatement);
  if (tryStatements.length !== 1) return false;

  let removalIndex = -1;
  let existenceProofIndex = -1;
  let routePushIndex = -1;
  const statements = tryStatements[0].tryBlock.statements;
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    if (statement === undefined) return false;
    if (callsNamedMemberWithIdentifierArgument(
      statement.expression,
      "staticNodeFs",
      "rmSync",
      0,
      "workerEntrySentinel"
    )) removalIndex = index;
    if (throwingSentinelExistenceGuard(statement)) existenceProofIndex = index;
    if (expressionCallsNamedMember(statement, "routes", "push")) routePushIndex = index;
  }
  return removalIndex >= 0 && existenceProofIndex >= 0 && routePushIndex >= 0 &&
    removalIndex < existenceProofIndex && existenceProofIndex < routePushIndex;
}

export function authorityControlLifecycleTopologyViolations(text: string): string[] {
  const source = authorityControlSource(text);
  const violations = new Set<string>();
  if (source.parseDiagnostics.length > 0) violations.add("authority_control_parse_error");

  const globalClose = singlePreloadBody(
    topLevelFunctionBodies(source, "awaitGlobalWorkerClose"),
    "awaitGlobalWorkerClose_missing_or_duplicated",
    violations
  );
  if (globalClose) {
    if (!globalCloseListenerBeforeTerminate(globalClose)) {
      violations.add("global_close_listener_must_precede_terminate");
    }
    if (!callsNamedOnlyFromOwner(globalClose, "resolve", "resolveOnce")) {
      violations.add("global_close_resolve_outside_close_callback");
    }
    if (!callsNamedOnlyFromOwner(globalClose, "resolveOnce", "close")) {
      violations.add("global_close_resolve_once_outside_close_callback");
    }
    if (!globalCloseCompletionHasTopology(globalClose)) {
      violations.add("global_close_requires_close_callback_completion");
    }
  }

  const workerTermination = singlePreloadBody(
    topLevelFunctionBodies(source, "awaitWorkerTermination"),
    "awaitWorkerTermination_missing_or_duplicated",
    violations
  );
  if (workerTermination && !workerTerminationHasTopology(workerTermination)) {
    violations.add("worker_termination_requires_global_close_and_bounded_node_exit");
  }

  const nodeExit = singlePreloadBody(
    topLevelFunctionBodies(source, "awaitNodeWorkerExit"),
    "awaitNodeWorkerExit_missing_or_duplicated",
    violations
  );
  if (nodeExit && !boundedNodeExitHasTopology(nodeExit)) {
    violations.add("node_worker_exit_requires_bounded_completion_wait");
  }

  const livenessCanary = singlePreloadBody(
    topLevelFunctionBodies(source, "runWorkerLivenessCanary"),
    "runWorkerLivenessCanary_missing_or_duplicated",
    violations
  );
  if (livenessCanary && !sentinelCleanupPrecedesRoutePush(livenessCanary)) {
    violations.add("worker_sentinel_cleanup_must_precede_route_receipt");
  }

  return [...violations].sort();
}

function requiredControlTerminateCallStatement(body: ts.Block): ts.ExpressionStatement {
  let match: ts.ExpressionStatement | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node) && callsNamedMember(node.expression, "terminate", "call")) {
      if (match) throw new Error("DUPLICATE_CONTROL_GLOBAL_TERMINATE");
      match = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  if (!match) throw new Error("MISSING_CONTROL_GLOBAL_TERMINATE");
  return match;
}

export function globalCloseResolveBypassSource(text: string): string {
  const source = authorityControlSource(text);
  const globalClose = requiredPreloadBody(
    topLevelFunctionBodies(source, "awaitGlobalWorkerClose"),
    "awaitGlobalWorkerClose"
  );
  return replacePreloadNode(
    source,
    requiredControlTerminateCallStatement(globalClose),
    "terminate.call(candidate);\n      resolve();"
  );
}
