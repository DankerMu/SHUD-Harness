import ts from "typescript";

type Scope = {
  readonly parent: Scope | undefined;
  readonly declarations: Map<string, ts.Declaration>;
};
type CapturedBinding =
  | "node_fs"
  | "worker_apply"
  | "worker_construct"
  | "child_process"
  | "ffi_dlopen"
  | "ffi_close"
  | "ffi_symbol"
  | "originalBunFile"
  | "originalBunWrite"
  | "originalBunSpawn"
  | "originalBunSpawnSync";
type BindingReference = Readonly<{ binding: CapturedBinding; aliased: boolean }>;
type HelperSpec = Readonly<{
  name: string;
  binding: CapturedBinding;
  operation: string;
  target: "none" | "path" | "normalized" | "target";
  delegate: "apply" | "worker_apply" | "worker_construct" | "dlopen" | "close" | "symbol" | "call";
}>;

const HELPER_SPECS: readonly HelperSpec[] = [
  { name: "delegatePathFunction", binding: "node_fs", operation: "operation", target: "path", delegate: "apply" },
  { name: "delegateWorkerApply", binding: "worker_apply", operation: "operation", target: "none", delegate: "worker_apply" },
  { name: "delegateWorkerConstruct", binding: "worker_construct", operation: "operation", target: "none", delegate: "worker_construct" },
  { name: "delegateChildProcess", binding: "child_process", operation: "operation", target: "none", delegate: "apply" },
  { name: "delegateFfiDlopen", binding: "ffi_dlopen", operation: "ffi_dlopen", target: "path", delegate: "dlopen" },
  { name: "delegateFfiClose", binding: "ffi_close", operation: "ffi_close", target: "path", delegate: "close" },
  { name: "delegateFfiSymbol", binding: "ffi_symbol", operation: "operation", target: "target", delegate: "symbol" },
  { name: "delegateBunFile", binding: "originalBunFile", operation: "bun_file", target: "normalized", delegate: "call" },
  { name: "delegateBunWrite", binding: "originalBunWrite", operation: "bun_write", target: "normalized", delegate: "call" },
  { name: "delegateBunSpawn", binding: "originalBunSpawn", operation: "bun_spawn", target: "none", delegate: "call" },
  { name: "delegateBunSpawnSync", binding: "originalBunSpawnSync", operation: "bun_spawn_sync", target: "none", delegate: "call" }
] as const;

const HELPER_BY_BINDING = new Map(HELPER_SPECS.map((spec) => [spec.binding, spec.name] as const));

class LexicalBindings {
  readonly #scopeByNode = new WeakMap<ts.Node, Scope>();
  readonly #allDeclarations: ts.Declaration[] = [];
  readonly #seenDeclarations = new Set<ts.Declaration>();

  constructor(source: ts.SourceFile) {
    const scope: Scope = { parent: undefined, declarations: new Map() };
    this.#scopeByNode.set(source, scope);
    this.#predeclareStatements(source.statements, scope);
    for (const statement of source.statements) this.#visit(statement, scope);
  }

  declarations(): readonly ts.Declaration[] {
    return this.#allDeclarations;
  }

  resolve(identifier: ts.Identifier): ts.Declaration | undefined {
    let scope = this.#scopeByNode.get(identifier);
    for (; scope; scope = scope.parent) {
      const declaration = scope.declarations.get(identifier.text);
      if (declaration) return declaration;
    }
    return undefined;
  }

  #declare(scope: Scope, declaration: ts.Declaration): void {
    for (const { name, declaration: binding } of bindingLeafDeclarations(declaration)) {
      scope.declarations.set(name, binding);
      if (!this.#seenDeclarations.has(binding)) {
        this.#seenDeclarations.add(binding);
        this.#allDeclarations.push(binding);
      }
    }
  }

  #predeclareStatements(statements: readonly ts.Statement[], scope: Scope): void {
    for (const statement of statements) {
      if (ts.isFunctionDeclaration(statement)) {
        this.#declare(scope, statement);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) this.#declare(scope, declaration);
      } else if (ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) {
        this.#declare(scope, statement);
      }
    }
  }

  #visit(node: ts.Node, scope: Scope): void {
    this.#scopeByNode.set(node, scope);
    if (isFunctionLike(node)) {
      const functionScope: Scope = { parent: scope, declarations: new Map() };
      this.#scopeByNode.set(node, functionScope);
      if (ts.isFunctionExpression(node) && node.name) this.#declare(functionScope, node);
      for (const parameter of node.parameters) this.#declare(functionScope, parameter);
      for (const parameter of node.parameters) this.#visit(parameter, functionScope);
      if (node.body && ts.isBlock(node.body)) {
        this.#scopeByNode.set(node.body, functionScope);
        this.#predeclareStatements(node.body.statements, functionScope);
        for (const statement of node.body.statements) this.#visit(statement, functionScope);
      } else if (node.body) {
        this.#visit(node.body, functionScope);
      }
      return;
    }
    if (ts.isBlock(node)) {
      const blockScope: Scope = { parent: scope, declarations: new Map() };
      this.#scopeByNode.set(node, blockScope);
      this.#predeclareStatements(node.statements, blockScope);
      for (const statement of node.statements) this.#visit(statement, blockScope);
      return;
    }
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      const loopScope: Scope = { parent: scope, declarations: new Map() };
      this.#scopeByNode.set(node, loopScope);
      const initializer = node.initializer;
      if (initializer && ts.isVariableDeclarationList(initializer)) {
        for (const declaration of initializer.declarations) this.#declare(loopScope, declaration);
      }
      ts.forEachChild(node, (child) => this.#visit(child, loopScope));
      return;
    }
    if (ts.isCatchClause(node)) {
      const catchScope: Scope = { parent: scope, declarations: new Map() };
      this.#scopeByNode.set(node, catchScope);
      if (node.variableDeclaration) {
        this.#declare(catchScope, node.variableDeclaration);
        this.#visit(node.variableDeclaration, catchScope);
      }
      this.#visit(node.block, catchScope);
      return;
    }
    ts.forEachChild(node, (child) => this.#visit(child, scope));
  }
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node);
}

function declarationName(declaration: ts.Node | undefined): string | undefined {
  const named = declaration as (ts.Node & { name?: ts.BindingName }) | undefined;
  return named?.name && ts.isIdentifier(named.name) ? named.name.text : undefined;
}

function bindingLeafDeclarations(
  declaration: ts.Declaration
): readonly Readonly<{ name: string; declaration: ts.Declaration }>[] {
  const named = declaration as ts.Declaration & { name?: ts.BindingName };
  if (!named.name) return [];
  const leaves: Readonly<{ name: string; declaration: ts.Declaration }>[] = [];
  const visit = (name: ts.BindingName, owner: ts.Declaration): void => {
    if (ts.isIdentifier(name)) {
      leaves.push({ name: name.text, declaration: owner });
      return;
    }
    for (const element of name.elements) {
      if (!ts.isBindingElement(element)) continue;
      visit(element.name, element as unknown as ts.Declaration);
    }
  };
  visit(named.name, declaration);
  return leaves;
}

function authorityPreloadSource(text: string): ts.SourceFile {
  return ts.createSourceFile("authority-preload.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function callsNamed(node: ts.Node | undefined, name: string): node is ts.CallExpression {
  return node !== undefined && ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
    node.expression.text === name;
}

function namedMemberAccess(expression: ts.Expression, objectName: string, memberName: string): boolean {
  return ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) &&
    expression.expression.text === objectName && expression.name.text === memberName;
}

function callsNamedMember(
  node: ts.Node | undefined,
  objectName: string,
  memberName: string
): node is ts.CallExpression {
  return node !== undefined && ts.isCallExpression(node) &&
    namedMemberAccess(node.expression, objectName, memberName);
}

function namedFunctionName(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) return node.name?.text;
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  return undefined;
}

function namedFunctionOwner(node: ts.Node): string | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    const name = namedFunctionName(current);
    if (name) return name;
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

function topLevelFunctionBodies(source: ts.SourceFile, name: string): ts.Block[] {
  const bodies: ts.Block[] = [];
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body) {
      bodies.push(statement.body);
    }
  }
  return bodies;
}

function singlePreloadBody(
  bodies: readonly ts.Block[],
  violation: string,
  violations: Set<string>
): ts.Block | undefined {
  if (bodies.length !== 1 || !bodies[0]) {
    violations.add(violation);
    return undefined;
  }
  return bodies[0];
}

function requiredPreloadBody(bodies: readonly ts.Block[], name: string): ts.Block {
  const body = bodies[0];
  if (bodies.length !== 1 || body === undefined) throw new Error(`MISSING_PRELOAD_TOPOLOGY_NODE:${name}`);
  return body;
}

function replacePreloadNode(source: ts.SourceFile, node: ts.Node, replacement: string): string {
  return `${source.text.slice(0, node.getStart(source))}${replacement}${source.text.slice(node.getEnd())}`;
}

function moduleDeclarations(source: ts.SourceFile): Map<string, ts.Declaration> {
  const declarations = new Map<string, ts.Declaration>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      declarations.set(statement.name.text, statement);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const name = declarationName(declaration);
        if (name) declarations.set(name, declaration);
      }
    }
  }
  return declarations;
}

function declarationIsInside(declaration: ts.Declaration, name: string): boolean {
  return namedFunctionOwner(declaration) === name;
}

function declarationIsChildProcessOriginal(declaration: ts.Declaration): boolean {
  for (let current: ts.Node | undefined = declaration.parent; current; current = current.parent) {
    if (!ts.isForOfStatement(current)) continue;
    const expression = unwrapExpression(current.expression);
    return ts.isArrayLiteralExpression(expression) &&
      expression.elements.some((element) => ts.isStringLiteral(element) && element.text === "exec");
  }
  return false;
}

function captureBindings(
  bindings: LexicalBindings,
  workerTargets: ReadonlyMap<ts.Declaration, CapturedBinding>,
  ffiSymbolParameters: ReadonlySet<ts.Declaration>
): ReadonlyMap<ts.Declaration, CapturedBinding> {
  const captured = new Map<ts.Declaration, CapturedBinding>();
  for (const declaration of bindings.declarations()) {
    const name = declarationName(declaration);
    if (name === "originalBunFile" || name === "originalBunWrite" || name === "originalBunSpawn" ||
        name === "originalBunSpawnSync" || name === "originalDlopen") {
      captured.set(declaration, name === "originalDlopen" ? "ffi_dlopen" : name);
    } else if (name === "original" && declarationIsInside(declaration, "patchPathFunctions")) {
      captured.set(declaration, "node_fs");
    } else if (name === "original" && declarationIsChildProcessOriginal(declaration)) {
      captured.set(declaration, "child_process");
    } else if (name === "original" && declarationIsInside(declaration, "patchConstructor")) {
      captured.set(declaration, "worker_construct");
    }
  }
  for (const [declaration, binding] of workerTargets) captured.set(declaration, binding);
  for (const declaration of ffiSymbolParameters) captured.set(declaration, "ffi_symbol");
  return captured;
}

function functionNodes(source: ts.SourceFile, name: string): ts.FunctionLikeDeclaration[] {
  const functions: ts.FunctionLikeDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node) && namedFunctionName(node) === name) functions.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return functions;
}

function functionBody(node: ts.FunctionLikeDeclaration | undefined): ts.Block | undefined {
  return node?.body && ts.isBlock(node.body) ? node.body : undefined;
}

function functionParameter(
  node: ts.FunctionLikeDeclaration,
  name: string,
  bindings: LexicalBindings
): ts.Declaration | undefined {
  for (const parameter of node.parameters) {
    if (ts.isIdentifier(parameter.name) && parameter.name.text === name) return bindings.resolve(parameter.name);
  }
  return undefined;
}

function workerProxyTargets(source: ts.SourceFile, bindings: LexicalBindings): ReadonlyMap<ts.Declaration, CapturedBinding> {
  const targets = new Map<ts.Declaration, CapturedBinding>();
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Proxy") {
      const original = node.arguments?.[0];
      const handlers = node.arguments?.[1];
      if (!original || !handlers || !ts.isIdentifier(original) || !ts.isObjectLiteralExpression(handlers) ||
          !declarationIsInside(bindings.resolve(original) ?? node, "patchConstructor")) {
        ts.forEachChild(node, visit);
        return;
      }
      for (const property of handlers.properties) {
        if (!ts.isMethodDeclaration(property) || !ts.isIdentifier(property.name) || !property.parameters[0] ||
            !ts.isIdentifier(property.parameters[0].name)) {
          continue;
        }
        const target = bindings.resolve(property.parameters[0].name);
        if (target && property.name.text === "apply") targets.set(target, "worker_apply");
        if (target && property.name.text === "construct") targets.set(target, "worker_construct");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return targets;
}

function ffiSymbolParameters(source: ts.SourceFile, bindings: LexicalBindings): ReadonlySet<ts.Declaration> {
  const parameters = new Set<ts.Declaration>();
  for (const node of functionNodes(source, "guardedFfiSymbol")) {
    const parameter = functionParameter(node, "symbol", bindings);
    if (parameter) parameters.add(parameter);
  }
  return parameters;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) ||
      ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)) {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

function bindingForExpression(
  expression: ts.Expression,
  bindings: LexicalBindings,
  captured: ReadonlyMap<ts.Declaration, CapturedBinding>,
  seen = new Set<ts.Declaration>()
): BindingReference | undefined {
  const value = unwrapExpression(expression);
  if (!ts.isIdentifier(value)) return undefined;
  const declaration = bindings.resolve(value);
  if (!declaration || seen.has(declaration)) return undefined;
  const direct = captured.get(declaration);
  if (direct) return { binding: direct, aliased: false };
  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    seen.add(declaration);
    const alias = bindingForExpression(declaration.initializer, bindings, captured, seen);
    return alias ? { binding: alias.binding, aliased: true } : undefined;
  }
  return undefined;
}

function isInsideDenyCall(node: ts.Node, bindings: LexicalBindings, deny: ts.Declaration | undefined): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) &&
        bindings.resolve(current.expression) === deny) {
      return true;
    }
  }
  return false;
}

function isHelperOwner(node: ts.Node, helper: string): boolean {
  return namedFunctionOwner(node) === helper;
}

function memberInvocationBinding(
  call: ts.CallExpression,
  bindings: LexicalBindings,
  captured: ReadonlyMap<ts.Declaration, CapturedBinding>
): BindingReference | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  if (call.expression.name.text === "apply" || call.expression.name.text === "call" ||
      call.expression.name.text === "bind" || call.expression.name.text === "close") {
    return bindingForExpression(call.expression.expression, bindings, captured);
  }
  return undefined;
}

function matchesHelperParameter(
  expression: ts.Expression,
  helper: ts.FunctionLikeDeclaration,
  name: string,
  bindings: LexicalBindings
): boolean {
  const value = unwrapExpression(expression);
  return ts.isIdentifier(value) && bindings.resolve(value) === functionParameter(helper, name, bindings);
}

function matchesHelperSpreadParameter(
  expression: ts.Expression,
  helper: ts.FunctionLikeDeclaration,
  name: string,
  bindings: LexicalBindings
): boolean {
  return ts.isSpreadElement(expression) && matchesHelperParameter(expression.expression, helper, name, bindings);
}

function delegateInvocation(
  call: ts.CallExpression,
  spec: HelperSpec,
  helper: ts.FunctionLikeDeclaration,
  bindings: LexicalBindings,
  captured: ReadonlyMap<ts.Declaration, CapturedBinding>,
  modules: ReadonlyMap<string, ts.Declaration>
): boolean {
  const parameter = (name: string): ts.Declaration | undefined => functionParameter(helper, name, bindings);
  if (spec.delegate === "apply") {
    return ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "apply" &&
      ts.isIdentifier(call.expression.expression) &&
      bindings.resolve(call.expression.expression) === parameter("original") &&
      call.arguments.length === 2 && matchesHelperParameter(call.arguments[0]!, helper, "thisArgument", bindings) &&
      matchesHelperParameter(call.arguments[1]!, helper, "argumentsList", bindings);
  }
  if (spec.delegate === "worker_apply" || spec.delegate === "worker_construct") {
    const member = spec.delegate === "worker_apply" ? "apply" : "construct";
    const forwarding = spec.delegate === "worker_apply"
      ? ["target", "thisArgument", "argumentsList"]
      : ["target", "argumentsList", "newTarget"];
    return callsNamedMember(call, "Reflect", member) && call.arguments.length === forwarding.length &&
      forwarding.every((name, index) => matchesHelperParameter(call.arguments[index]!, helper, name, bindings));
  }
  if (spec.delegate === "dlopen") {
    return ts.isIdentifier(call.expression) && bindings.resolve(call.expression) === modules.get("originalDlopen") &&
      call.arguments.length === 2 && matchesHelperParameter(call.arguments[0]!, helper, "path", bindings) &&
      matchesHelperParameter(call.arguments[1]!, helper, "symbols", bindings);
  }
  if (spec.delegate === "close") {
    return ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "close" &&
      ts.isIdentifier(call.expression.expression) &&
      bindings.resolve(call.expression.expression) === parameter("library") && call.arguments.length === 0;
  }
  if (spec.delegate === "symbol") {
    return ts.isIdentifier(call.expression) && bindings.resolve(call.expression) === parameter("symbol") &&
      call.arguments.length === 1 && matchesHelperSpreadParameter(call.arguments[0]!, helper, "argumentsList", bindings);
  }
  const expected = [...captured.entries()].find(([, binding]) => binding === spec.binding)?.[0];
  if (!ts.isIdentifier(call.expression) || bindings.resolve(call.expression) !== expected) return false;
  if (spec.name === "delegateBunFile" || spec.name === "delegateBunWrite") {
    return call.arguments.length === 2 && matchesHelperParameter(call.arguments[0]!, helper, "path", bindings) &&
      matchesHelperSpreadParameter(call.arguments[1]!, helper, "argumentsList", bindings);
  }
  return call.arguments.length === 1 && matchesHelperSpreadParameter(call.arguments[0]!, helper, "argumentsList", bindings);
}

function callsIn(node: ts.Node): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (current: ts.Node): void => {
    if (ts.isCallExpression(current)) calls.push(current);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return calls;
}

function rawOperationCall(
  statement: ts.Statement | undefined,
  bindings: LexicalBindings,
  rawOperation: ts.Declaration | undefined
): ts.CallExpression | undefined {
  if (!statement || !ts.isIfStatement(statement)) return undefined;
  const candidate = ts.isBlock(statement.thenStatement)
    ? statement.thenStatement.statements.length === 1 ? statement.thenStatement.statements[0] : undefined
    : statement.thenStatement;
  if (!candidate || !ts.isExpressionStatement(candidate) || !ts.isCallExpression(candidate.expression) ||
      !ts.isIdentifier(candidate.expression.expression) ||
      bindings.resolve(candidate.expression.expression) !== rawOperation) {
    return undefined;
  }
  return candidate.expression;
}

function postAdmissionCondition(
  expression: ts.Expression,
  bindings: LexicalBindings,
  state: ts.Declaration | undefined
): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        ts.isPropertyAccessExpression(node.left) && node.left.name.text === "phase" &&
        ts.isIdentifier(node.left.expression) && bindings.resolve(node.left.expression) === state &&
        ts.isStringLiteral(node.right) && node.right.text === "post_admission") {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return found;
}

function rawArgumentsMatch(
  call: ts.CallExpression,
  spec: HelperSpec,
  helper: ts.FunctionLikeDeclaration,
  bindings: LexicalBindings
): boolean {
  const expectedCount = spec.target === "none" ? 1 : 2;
  if (call.arguments.length !== expectedCount) return false;
  const operation = call.arguments[0];
  if (!operation) return false;
  const operationMatches = spec.operation === "operation"
    ? ts.isIdentifier(operation) && bindings.resolve(operation) === functionParameter(helper, "operation", bindings)
    : ts.isStringLiteral(operation) && operation.text === spec.operation;
  if (!operationMatches) return false;
  if (spec.target === "none") return true;
  const target = call.arguments[1];
  const parameter = spec.target === "target" ? "target" : spec.target;
  return target !== undefined && ts.isIdentifier(target) &&
    bindings.resolve(target) === functionParameter(helper, parameter, bindings);
}

function helperHasExactTopology(
  helper: ts.FunctionLikeDeclaration,
  spec: HelperSpec,
  bindings: LexicalBindings,
  captured: ReadonlyMap<ts.Declaration, CapturedBinding>,
  modules: ReadonlyMap<string, ts.Declaration>,
  state: ts.Declaration | undefined,
  rawOperation: ts.Declaration | undefined
): boolean {
  const body = functionBody(helper);
  if (!body || body.statements.length !== 2) return false;
  const raw = rawOperationCall(body.statements[0], bindings, rawOperation);
  if (!raw || !ts.isIfStatement(body.statements[0]) ||
      !postAdmissionCondition(body.statements[0].expression, bindings, state) ||
      !rawArgumentsMatch(raw, spec, helper, bindings)) {
    return false;
  }
  const delegates = callsIn(body).filter((call) => delegateInvocation(
    call, spec, helper, bindings, captured, modules
  ));
  const finalStatement = body.statements[1];
  const returnsDelegate = ts.isReturnStatement(finalStatement) && finalStatement.expression === delegates[0];
  const invokesDelegate = ts.isExpressionStatement(finalStatement) && finalStatement.expression === delegates[0];
  if (delegates.length !== 1 || delegates[0] === undefined || (!returnsDelegate && !invokesDelegate)) {
    return false;
  }
  return delegates[0].getStart() > raw.getEnd();
}

function wrapperName(node: ts.Node): string | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) {
      if (current.name.text === "apply") return "worker_apply";
      if (current.name.text === "construct") return "worker_construct";
    }
    const name = namedFunctionName(current);
    if (name === "guardedPathFunction" || name === "guardedProcessCreation" || name === "guardedDlopen" ||
        name === "guardedFfiClose" || name === "guardedFfiSymbol" || name === "guardedBunFile" ||
        name === "guardedBunWrite" || name === "guardedBunSpawn" || name === "guardedBunSpawnSync") {
      return name;
    }
  }
  return undefined;
}

function rawInversionBranch(node: ts.Node, bindings: LexicalBindings, state: ts.Declaration | undefined): boolean {
  const rawInversionEquals = (expression: ts.Expression, mode: string): boolean => {
    return ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      ts.isPropertyAccessExpression(expression.left) && expression.left.name.text === "rawInversion" &&
      ts.isIdentifier(expression.left.expression) && bindings.resolve(expression.left.expression) === state &&
      ts.isStringLiteral(expression.right) && expression.right.text === mode;
  };
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (!ts.isIfStatement(current)) continue;
    if (namedFunctionOwner(current) === "guardedDlopen" && rawInversionEquals(current.expression, "ffi_dlopen")) {
      return true;
    }
    if (namedFunctionOwner(current) === "guardedPathFunction" &&
        ts.isBinaryExpression(current.expression) &&
        current.expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        rawInversionEquals(current.expression.left, "node_fs_readFileSync") &&
        ts.isBinaryExpression(current.expression.right) &&
        current.expression.right.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        ts.isIdentifier(current.expression.right.left) && current.expression.right.left.text === "operation" &&
        ts.isStringLiteral(current.expression.right.right) &&
        current.expression.right.right.text === "node_fs_readFileSync") {
      return true;
    }
  }
  return false;
}

function callIsDeny(
  call: ts.CallExpression,
  bindings: LexicalBindings,
  deny: ts.Declaration | undefined
): boolean {
  return ts.isIdentifier(call.expression) && bindings.resolve(call.expression) === deny;
}

function denialHasForbiddenSyntax(
  expression: ts.Expression,
  bindings: LexicalBindings,
  captured: ReadonlyMap<ts.Declaration, CapturedBinding>
): boolean {
  let forbidden = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isAwaitExpression(node) ||
        ts.isYieldExpression(node) || ts.isTaggedTemplateExpression(node) ||
        ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ||
        ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken ||
        ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.EqualsToken &&
          node.operatorToken.kind <= ts.SyntaxKind.QuestionQuestionEqualsToken ||
        ts.isPrefixUnaryExpression(node) && (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken) ||
        ts.isPostfixUnaryExpression(node)) {
      forbidden = true;
    }
    if (ts.isIdentifier(node) && bindingForExpression(node, bindings, captured)) forbidden = true;
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return forbidden;
}

function declarationIsConst(declaration: ts.Declaration): boolean {
  return ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
}

function bindingHasWrite(declaration: ts.Declaration, bindings: LexicalBindings): boolean {
  let written = false;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && bindings.resolve(node) === declaration) {
      const parent = node.parent;
      if (ts.isBinaryExpression(parent) && parent.left === node &&
          parent.operatorToken.kind >= ts.SyntaxKind.EqualsToken &&
          parent.operatorToken.kind <= ts.SyntaxKind.QuestionQuestionEqualsToken ||
          ts.isPrefixUnaryExpression(parent) && parent.operand === node &&
          (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken) ||
          ts.isPostfixUnaryExpression(parent) && parent.operand === node) {
        written = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.getSourceFile());
  return written;
}

function stableBinding(declaration: ts.Declaration, bindings: LexicalBindings): boolean {
  return (declarationIsConst(declaration) || ts.isParameter(declaration)) && !bindingHasWrite(declaration, bindings);
}

function isStringLiteralLoopBinding(declaration: ts.Declaration): boolean {
  for (let current: ts.Node | undefined = declaration.parent; current; current = current.parent) {
    if (!ts.isForOfStatement(current)) continue;
    const iterable = unwrapExpression(current.expression);
    if (ts.isArrayLiteralExpression(iterable)) {
      return iterable.elements.every((element) => ts.isStringLiteral(element));
    }
    return callsNamedMember(iterable, "Object", "getOwnPropertyNames");
  }
  return false;
}

function callsResolvedNamed(
  expression: ts.Expression,
  name: string,
  bindings: LexicalBindings,
  modules: ReadonlyMap<string, ts.Declaration>
): boolean {
  return ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) &&
    bindings.resolve(expression.expression) === modules.get(name);
}

function stringBindingIsSafe(
  expression: ts.Expression,
  bindings: LexicalBindings,
  captured: ReadonlyMap<ts.Declaration, CapturedBinding>,
  seen = new Set<ts.Declaration>()
): boolean {
  const value = unwrapExpression(expression);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return true;
  if (ts.isTemplateExpression(value)) {
    return value.templateSpans.every((span) => stringBindingIsSafe(span.expression, bindings, captured, seen));
  }
  if (!ts.isIdentifier(value) || bindingForExpression(value, bindings, captured)) return false;
  const declaration = bindings.resolve(value);
  if (!declaration || seen.has(declaration) || !stableBinding(declaration, bindings)) return false;
  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    seen.add(declaration);
    return stringBindingIsSafe(declaration.initializer, bindings, captured, seen);
  }
  if (ts.isParameter(declaration)) {
    const owner = namedFunctionOwner(declaration);
    const name = declarationName(declaration);
    return owner === "patchPathFunctions" && name === "operationPrefix" ||
      owner === "patchConstructor" && name === "operation" ||
      owner === "guardedFfiSymbol" && name === "name";
  }
  return declarationName(declaration) === "name" && isStringLiteralLoopBinding(declaration);
}

function targetBindingIsSafe(
  expression: ts.Expression,
  bindings: LexicalBindings,
  modules: ReadonlyMap<string, ts.Declaration>
): boolean {
  const value = unwrapExpression(expression);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return true;
  if (!ts.isIdentifier(value)) return false;
  const declaration = bindings.resolve(value);
  if (!declaration || !stableBinding(declaration, bindings)) return false;
  if (ts.isParameter(declaration)) return declarationName(declaration) === "path" &&
    (namedFunctionOwner(declaration) === "guardedDlopen" || namedFunctionOwner(declaration) === "guardedFfiClose");
  if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;
  if (declarationName(declaration) === "path") {
    return callsResolvedNamed(declaration.initializer, "firstPathLike", bindings, modules);
  }
  if (declarationName(declaration) === "normalized") {
    return callsResolvedNamed(declaration.initializer, "normalizedPathLike", bindings, modules);
  }
  return declarationName(declaration) === "candidate" &&
    callsResolvedNamed(declaration.initializer, "decodedCString", bindings, modules);
}

function denyArgumentsAreSafe(
  call: ts.CallExpression,
  bindings: LexicalBindings,
  captured: ReadonlyMap<ts.Declaration, CapturedBinding>,
  modules: ReadonlyMap<string, ts.Declaration>
): boolean {
  if (call.arguments.length < 1 || call.arguments.length > 2) return false;
  const operation = call.arguments[0];
  if (!operation || denialHasForbiddenSyntax(operation, bindings, captured) ||
      !stringBindingIsSafe(operation, bindings, captured)) {
    return false;
  }
  const target = call.arguments[1];
  return !target || !denialHasForbiddenSyntax(target, bindings, captured) &&
    targetBindingIsSafe(target, bindings, modules);
}

function nearestStatement(node: ts.Node): ts.Statement | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isStatement(current)) return current;
  }
  return undefined;
}

function proxyTrap(source: ts.SourceFile, name: "apply" | "construct"): ts.MethodDeclaration {
  let trap: ts.MethodDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Proxy") {
      const handlers = node.arguments?.[1];
      if (handlers && ts.isObjectLiteralExpression(handlers)) {
        for (const property of handlers.properties) {
          if (ts.isMethodDeclaration(property) && ts.isIdentifier(property.name) && property.name.text === name) {
            if (trap) throw new Error(`DUPLICATE_PROXY_TRAP:${name}`);
            trap = property;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!trap) throw new Error(`MISSING_PROXY_TRAP:${name}`);
  return trap;
}

function requiredNamedFunction(source: ts.SourceFile, name: string): ts.FunctionLikeDeclaration {
  const functions = functionNodes(source, name);
  if (functions.length !== 1 || !functions[0]) throw new Error(`MISSING_NAMED_FUNCTION:${name}`);
  return functions[0];
}

function ordinaryDenyCall(
  root: ts.Node,
  bindings: LexicalBindings,
  deny: ts.Declaration | undefined,
  state: ts.Declaration | undefined
): ts.CallExpression {
  const calls = callsIn(root).filter((call) => callIsDeny(call, bindings, deny) &&
    !rawInversionBranch(call, bindings, state));
  if (calls.length !== 1 || !calls[0]) throw new Error(`MISSING_ORDINARY_DENY:${wrapperName(root) ?? "unknown"}`);
  return calls[0];
}

function insertBeforeStatement(source: ts.SourceFile, statement: ts.Statement, injection: string): string {
  if (ts.isIfStatement(statement.parent) && statement.parent.thenStatement === statement) {
    return replacePreloadNode(source, statement, `{\n${injection}\n${statement.getText(source)}\n}`);
  }
  return `${source.text.slice(0, statement.getStart(source))}${injection}\n${source.text.slice(statement.getStart(source))}`;
}

function insertAfterNode(source: ts.SourceFile, node: ts.Node, insertion: string): string {
  return `${source.text.slice(0, node.getEnd())}${insertion}${source.text.slice(node.getEnd())}`;
}

function variableStatementFor(declaration: ts.VariableDeclaration): ts.VariableStatement {
  if (!ts.isVariableDeclarationList(declaration.parent) || !ts.isVariableStatement(declaration.parent.parent)) {
    throw new Error(`VARIABLE_STATEMENT_ANCHOR_MISSING:${declarationName(declaration) ?? "unknown"}`);
  }
  return declaration.parent.parent;
}

function namedVariable(source: ts.SourceFile, name: string): ts.VariableDeclaration {
  let match: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && declarationName(node) === name) {
      if (match) throw new Error(`DUPLICATE_VARIABLE_ANCHOR:${name}`);
      match = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!match) throw new Error(`MISSING_VARIABLE_ANCHOR:${name}`);
  return match;
}

function sourceWithFunctionBodyOrderMoved(
  source: ts.SourceFile,
  helper: ts.FunctionLikeDeclaration
): string {
  const body = functionBody(helper);
  if (!body || body.statements.length !== 2 || !body.statements[0] || !body.statements[1]) {
    throw new Error(`HELPER_ORDER_ANCHOR_MISSING:${namedFunctionName(helper) ?? "unknown"}`);
  }
  return replacePreloadNode(
    source,
    body,
    `{\n${body.statements[1].getText(source)}\n${body.statements[0].getText(source)}\n}`
  );
}

function addMutation(
  rows: AuthorityTopologyMutation[],
  id: string,
  family: string,
  violation: string,
  source: string
): void {
  rows.push({ id, family, violation, source });
}

export type AuthorityTopologyMutation = Readonly<{
  id: string;
  family: string;
  violation: string;
  source: string;
}>;

export {
  HELPER_SPECS,
  HELPER_BY_BINDING,
  LexicalBindings,
  addMutation,
  authorityPreloadSource,
  bindingForExpression,
  callsIn,
  callIsDeny,
  callsNamed,
  callsNamedMember,
  captureBindings,
  declarationName,
  denyArgumentsAreSafe,
  expressionCallsNamed,
  expressionCallsNamedMember,
  ffiSymbolParameters,
  functionBody,
  functionNodes,
  functionParameter,
  helperHasExactTopology,
  insertAfterNode,
  insertBeforeStatement,
  isHelperOwner,
  isInsideDenyCall,
  memberInvocationBinding,
  moduleDeclarations,
  namedFunctionOwner,
  namedVariable,
  nearestStatement,
  ordinaryDenyCall,
  proxyTrap,
  rawInversionBranch,
  replacePreloadNode,
  requiredNamedFunction,
  requiredPreloadBody,
  singlePreloadBody,
  sourceWithFunctionBodyOrderMoved,
  topLevelFunctionBodies,
  variableStatementFor,
  workerProxyTargets,
  wrapperName
};
export type { CapturedBinding, HelperSpec };