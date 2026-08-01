import ts from "typescript";
import {
  callsNamed,
  callsNamedMember,
  expressionCallsNamed,
  expressionCallsNamedMember,
  namedFunctionOwner,
  replacePreloadNode,
  requiredPreloadBody,
  singlePreloadBody,
  topLevelFunctionBodies
} from "./authority-topology-ast";


function authorityControlSource(text: string): ts.SourceFile {
  return ts.createSourceFile("authority-control.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function authorityControlParseDiagnostics(text: string): readonly ts.Diagnostic[] {
  return ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.Latest },
    fileName: "authority-control.ts",
    reportDiagnostics: true
  }).diagnostics ?? [];
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
  return statement !== undefined && ts.isReturnStatement(statement) && statement.expression !== undefined &&
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
    if (ts.isExpressionStatement(statement) && callsNamedMemberWithIdentifierArgument(
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
  if (authorityControlParseDiagnostics(text).length) {
    violations.add("authority_control_parse_error");
  }

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