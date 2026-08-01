import ts from "typescript";
import { ambientAcquisitionViolations } from "./authority-topology-acquisition";
import { authorityFacadeTopologyViolations } from "./authority-topology-facades";
import { exactInversionTopologyViolations } from "./authority-topology-inversions";
import { authorityStateTopologyViolations } from "./authority-topology-state";
import {
  HELPER_SPECS,
  HELPER_BY_BINDING,
  LexicalBindings,
  addMutation,
  authorityPreloadSource,
  bindingForExpression,
  callsIn,
  callIsDeny,
  callsNamedMember,
  captureBindings,
  declarationName,
  denyArgumentsAreSafe,
  ffiSymbolParameters,
  functionBody,
  functionNodes,
  functionParameter,
  helperHasExactTopology,
  insertAfterNode,
  insertBeforeStatement,
  isHelperOwner,
  isDeclarationName,
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
  sourceWithFunctionBodyOrderMoved,
  stableBinding,
  variableStatementFor,
  workerProxyTargets,
  wrapperName
} from "./authority-topology-ast";
import type { CapturedBinding } from "./authority-topology-ast";
export type { AuthorityTopologyMutation } from "./authority-topology-ast";
export { authorityTopologyMutationRows } from "./authority-topology-mutations";
type WrapperEdge = Readonly<{
  wrapper: string;
  helper: string;
  binding: CapturedBinding;
  parameters: readonly string[];
  count: number;
}>;
const WRAPPER_EDGES: readonly WrapperEdge[] = [
  { wrapper: "guardedPathFunction", helper: "delegatePathFunction", binding: "node_fs", parameters: ["original", "this", "args", "operation", "path"], count: 2 },
  { wrapper: "worker_apply", helper: "delegateWorkerApply", binding: "worker_apply", parameters: ["target", "thisArgument", "argumentsList", "operation"], count: 1 },
  { wrapper: "worker_construct", helper: "delegateWorkerConstruct", binding: "worker_construct", parameters: ["target", "argumentsList", "newTarget", "operation"], count: 1 },
  { wrapper: "guardedProcessCreation", helper: "delegateChildProcess", binding: "child_process", parameters: ["original", "this", "args", "operation"], count: 1 },
  { wrapper: "guardedDlopen", helper: "delegateFfiDlopen", binding: "ffi_dlopen", parameters: ["path", "symbols"], count: 2 },
  { wrapper: "guardedFfiClose", helper: "delegateFfiClose", binding: "ffi_close", parameters: ["library", "path"], count: 1 },
  { wrapper: "guardedFfiSymbol", helper: "delegateFfiSymbol", binding: "ffi_symbol", parameters: ["symbol", "args", "operation", "candidate"], count: 1 },
  { wrapper: "guardedBunFile", helper: "delegateBunFile", binding: "originalBunFile", parameters: ["path", "args", "normalized"], count: 1 },
  { wrapper: "guardedBunWrite", helper: "delegateBunWrite", binding: "originalBunWrite", parameters: ["path", "args", "normalized"], count: 1 },
  { wrapper: "guardedBunSpawn", helper: "delegateBunSpawn", binding: "originalBunSpawn", parameters: ["args"], count: 1 },
  { wrapper: "guardedBunSpawnSync", helper: "delegateBunSpawnSync", binding: "originalBunSpawnSync", parameters: ["args"], count: 1 }
];
function directModuleCall(
  call: ts.CallExpression,
  name: string,
  bindings: LexicalBindings,
  modules: ReadonlyMap<string, ts.Declaration>
): boolean {
  return ts.isIdentifier(call.expression) && bindings.resolve(call.expression) === modules.get(name);
}

function wrapperRoot(source: ts.SourceFile, edge: WrapperEdge): ts.Node | undefined {
  if (edge.wrapper === "worker_apply" || edge.wrapper === "worker_construct") {
    try {
      return proxyTrap(source, edge.wrapper === "worker_apply" ? "apply" : "construct");
    } catch {
      return undefined;
    }
  }
  return functionNodes(source, edge.wrapper)[0];
}

function wrapperArgumentMatches(
  expression: ts.Expression,
  expected: string,
  edge: WrapperEdge,
  bindings: LexicalBindings,
  captured: ReadonlyMap<ts.Declaration, CapturedBinding>
): boolean {
  if (expected === "this") return expression.kind === ts.SyntaxKind.ThisKeyword;
  if (!ts.isIdentifier(expression)) return false;
  const declaration = bindings.resolve(expression);
  if (!declaration) return false;
  if (expected === "original" || expected === "target" || expected === "symbol" ||
      expected.startsWith("originalBun")) {
    return stableBinding(declaration, bindings) && captured.get(declaration) === edge.binding;
  }
  if (declarationName(declaration) !== expected) return false;
  const owner = namedFunctionOwner(declaration);
  if (expected === "operation" && (edge.wrapper === "worker_apply" || edge.wrapper === "worker_construct")) {
    return owner === "patchConstructor";
  }
  return edge.wrapper === "worker_apply" ? owner === "apply" :
    edge.wrapper === "worker_construct" ? owner === "construct" : owner === edge.wrapper;
}

function wrapperCallMatches(
  call: ts.CallExpression,
  edge: WrapperEdge,
  bindings: LexicalBindings,
  captured: ReadonlyMap<ts.Declaration, CapturedBinding>,
  modules: ReadonlyMap<string, ts.Declaration>
): boolean {
  return directModuleCall(call, edge.helper, bindings, modules) &&
    call.arguments.length === edge.parameters.length &&
    edge.parameters.every((parameter, index) =>
      wrapperArgumentMatches(call.arguments[index]!, parameter, edge, bindings, captured)
    );
}
function wrapperEdgeViolations(
  source: ts.SourceFile,
  bindings: LexicalBindings,
  captured: ReadonlyMap<ts.Declaration, CapturedBinding>,
  modules: ReadonlyMap<string, ts.Declaration>,
  deny: ts.Declaration | undefined,
  state: ts.Declaration | undefined
): readonly string[] {
  const violations: string[] = [];
  for (const edge of WRAPPER_EDGES) {
    const root = wrapperRoot(source, edge);
    const matching = root ? callsIn(root).filter((call) => wrapperCallMatches(
      call, edge, bindings, captured, modules
    )) : [];
    const ordinary = root ? callsIn(root).filter((call) =>
      callIsDeny(call, bindings, deny) && !rawInversionBranch(call, bindings, state)
    ) : [];
    const earlyDelegate = ordinary[0] !== undefined && matching.some((call) =>
      !rawInversionBranch(call, bindings, state) && call.getStart(source) < ordinary[0]!.getStart(source)
    );
    if (matching.length !== edge.count) {
      violations.push(earlyDelegate || edge.wrapper === "guardedPathFunction" || edge.wrapper === "guardedDlopen"
        ? `deny_order:${edge.wrapper}`
        : `delegate_owner:${edge.binding}`);
    }
  }
  return violations;
}
function capturedReferenceAllowed(
  identifier: ts.Identifier,
  binding: CapturedBinding,
  bindings: LexicalBindings,
  captured: ReadonlyMap<ts.Declaration, CapturedBinding>,
  modules: ReadonlyMap<string, ts.Declaration>
): boolean {
  const parent = identifier.parent;
  const helper = HELPER_BY_BINDING.get(binding);
  if (ts.isCallExpression(parent) && parent.expression === identifier && helper &&
      isHelperOwner(identifier, helper)) {
    return true;
  }
  if (ts.isCallExpression(parent) && parent.arguments.includes(identifier)) {
    if (parent.arguments[0] === identifier && binding === "worker_apply" &&
        isHelperOwner(identifier, "delegateWorkerApply") && staticMemberName(parent.expression) === "apply") {
      return true;
    }
    if (parent.arguments[0] === identifier && binding === "worker_construct" &&
        isHelperOwner(identifier, "delegateWorkerConstruct") && staticMemberName(parent.expression) === "construct") {
      return true;
    }
    if (parent.arguments[0] === identifier && binding === "worker_construct" &&
        directModuleCall(parent, "guardedWorkerPrototype", bindings, modules) &&
        namedFunctionOwner(identifier) === "patchConstructor") {
      return true;
    }
    return WRAPPER_EDGES.some((edge) => edge.binding === binding &&
      wrapperCallMatches(parent, edge, bindings, captured, modules));
  }
  return ts.isNewExpression(parent) && parent.arguments?.[0] === identifier &&
    namedFunctionOwner(identifier) === "patchConstructor";
}
function aliasFeedsOnlyDeny(
  identifier: ts.Identifier,
  bindings: LexicalBindings,
  deny: ts.Declaration | undefined
): boolean {
  const declaration = identifier.parent;
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== identifier ||
      !ts.isIdentifier(declaration.name)) {
    return false;
  }
  const alias = bindings.resolve(declaration.name);
  if (!alias) return false;
  let used = false;
  let onlyDenied = true;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && bindings.resolve(node) === alias && !isDeclarationName(node, alias)) {
      used = true;
      if (!isInsideDenyCall(node, bindings, deny)) onlyDenied = false;
    }
    ts.forEachChild(node, visit);
  };
  visit(identifier.getSourceFile());
  return used && onlyDenied;
}

function aliasEscape(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  return ts.isVariableDeclaration(parent) && parent.initializer === identifier ||
    ts.isPropertyAssignment(parent) && parent.initializer === identifier ||
    ts.isArrayLiteralExpression(parent) || ts.isReturnStatement(parent) ||
    ts.isBinaryExpression(parent) && parent.right === identifier &&
      parent.operatorToken.kind >= ts.SyntaxKind.EqualsToken &&
      parent.operatorToken.kind <= ts.SyntaxKind.QuestionQuestionEqualsToken;
}

function staticMemberName(expression: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return ts.isElementAccessExpression(expression) &&
    (ts.isStringLiteral(expression.argumentExpression) || ts.isNumericLiteral(expression.argumentExpression))
    ? expression.argumentExpression.text
    : undefined;
}

function equivalentCallReference(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === identifier) {
    return parent.name.text === "call" || parent.name.text === "bind";
  }
  if (ts.isElementAccessExpression(parent) && parent.expression === identifier) {
    const name = staticMemberName(parent);
    return name === "call" || name === "apply" || name === "bind";
  }
  return ts.isCallExpression(parent) && parent.arguments[0] === identifier &&
    (staticMemberName(parent.expression) === "apply" || staticMemberName(parent.expression) === "construct");
}

function unwrapped(expression: ts.Expression): ts.Expression {
  return ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) ||
    ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)
    ? unwrapped(expression.expression)
    : expression;
}

function bunRoot(
  expression: ts.Expression,
  bindings: LexicalBindings,
  modules: ReadonlyMap<string, ts.Declaration>,
  seen = new Set<ts.Declaration>()
): boolean {
  const value = unwrapped(expression);
  if (!ts.isIdentifier(value)) return false;
  if (value.text === "Bun" && bindings.resolve(value) === undefined) return true;
  const declaration = bindings.resolve(value);
  if (!declaration || seen.has(declaration)) return false;
  if (declaration === modules.get("guardedBun") && stableBinding(declaration, bindings) &&
      ts.isVariableDeclaration(declaration) && declaration.initializer) {
    return bunRoot(declaration.initializer, bindings, modules, seen);
  }
  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    seen.add(declaration);
    return bunRoot(declaration.initializer, bindings, modules, seen);
  }
  return false;
}

function bunPropertyBinding(name: string | undefined): CapturedBinding | undefined {
  if (name === "file") return "originalBunFile";
  if (name === "write") return "originalBunWrite";
  if (name === "spawn") return "originalBunSpawn";
  return name === "spawnSync" ? "originalBunSpawnSync" : undefined;
}


function bunMemberBinding(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  bindings: LexicalBindings,
  modules: ReadonlyMap<string, ts.Declaration>
): CapturedBinding | undefined {
  if (!bunRoot(node.expression, bindings, modules)) return undefined;
  return bunPropertyBinding(staticMemberName(node));
}

function canonicalBunMemberUse(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  binding: CapturedBinding,
  bindings: LexicalBindings,
  modules: ReadonlyMap<string, ts.Declaration>
): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === "bind" &&
      ts.isCallExpression(parent.parent) && parent.parent.expression === parent &&
      ts.isVariableDeclaration(parent.parent.parent) &&
      ["originalBunFile", "originalBunWrite", "originalBunSpawn", "originalBunSpawnSync"]
        .includes(declarationName(parent.parent.parent) ?? "") &&
      parent.parent.arguments.length === 1 && ts.isIdentifier(parent.parent.arguments[0]!) &&
      parent.parent.arguments[0]!.text === "Bun") {
    return true;
  }
  if (!ts.isBinaryExpression(parent) || parent.left !== node ||
      parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isIdentifier(parent.right)) {
    return false;
  }
  const expected = binding === "originalBunFile" ? "guardedBunFile" :
    binding === "originalBunWrite" ? "guardedBunWrite" :
    binding === "originalBunSpawn" ? "guardedBunSpawn" : "guardedBunSpawnSync";
  return parent.right.text === expected && bindings.resolve(parent.right) === modules.get(expected);
}

function descriptorValueCapture(
  declaration: ts.Declaration,
  bindings: LexicalBindings,
  modules: ReadonlyMap<string, ts.Declaration>
): boolean {
  if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;
  const value = unwrapped(declaration.initializer);
  if (!ts.isPropertyAccessExpression(value) || value.name.text !== "value" || !ts.isIdentifier(value.expression)) {
    return false;
  }
  const descriptor = bindings.resolve(value.expression);
  if (!descriptor || !stableBinding(descriptor, bindings) || !ts.isVariableDeclaration(descriptor) ||
      !descriptor.initializer || !ts.isCallExpression(unwrapped(descriptor.initializer))) {
    return false;
  }
  const call = unwrapped(descriptor.initializer) as ts.CallExpression;
  if (!ts.isPropertyAccessExpression(call.expression) || !ts.isIdentifier(call.expression.expression) ||
      call.expression.expression.text !== "Object" || call.expression.name.text !== "getOwnPropertyDescriptor" ||
      call.arguments.length !== 2 || !ts.isIdentifier(call.arguments[0]!) || !ts.isIdentifier(call.arguments[1]!)) {
    return false;
  }
  const owner = namedFunctionOwner(declaration);
  if (owner === "patchPathFunctions") {
    const functionNode = functionNodes(declaration.getSourceFile(), owner)[0];
    const loopName = bindings.resolve(call.arguments[1]!);
    return functionNode !== undefined && bindings.resolve(call.arguments[0]!) ===
      functionParameter(functionNode, "module", bindings) && loopName !== undefined &&
      stableBinding(loopName, bindings) && declarationName(loopName) === "name" &&
      ts.isVariableDeclaration(loopName) && ts.isVariableDeclarationList(loopName.parent) &&
      ts.isForOfStatement(loopName.parent.parent);
  }
  if (owner === "patchConstructor") {
    const functionNode = functionNodes(declaration.getSourceFile(), owner)[0];
    return functionNode !== undefined && bindings.resolve(call.arguments[0]!) ===
      functionParameter(functionNode, "module", bindings) &&
      bindings.resolve(call.arguments[1]!) === functionParameter(functionNode, "name", bindings);
  }
  return bindings.resolve(call.arguments[0]!) === modules.get("guardedChildProcess") &&
    call.arguments[1]!.text === "name";
}

function exactBunCapture(
  declaration: ts.Declaration,
  binding: CapturedBinding,
  bindings: LexicalBindings,
  modules: ReadonlyMap<string, ts.Declaration>
): boolean {
  if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;
  const call = unwrapped(declaration.initializer);
  if (!ts.isCallExpression(call) || call.arguments.length !== 1 || !ts.isIdentifier(call.arguments[0]!) ||
      call.arguments[0]!.text !== "Bun" || !ts.isPropertyAccessExpression(call.expression) ||
      call.expression.name.text !== "bind") {
    return false;
  }
  const member = call.expression.expression;
  return (ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member)) &&
    bunMemberBinding(member, bindings, modules) === binding;
}

function exactFfiDlopenCapture(
  declaration: ts.Declaration,
  bindings: LexicalBindings,
  modules: ReadonlyMap<string, ts.Declaration>
): boolean {
  if (!ts.isVariableDeclaration(declaration) || !declaration.initializer ||
      !ts.isPropertyAccessExpression(unwrapped(declaration.initializer))) {
    return false;
  }
  const value = unwrapped(declaration.initializer) as ts.PropertyAccessExpression;
  const descriptor = modules.get("ffiDescriptor");
  const ffi = modules.get("guardedFfi");
  if (value.name.text !== "value" || !ts.isIdentifier(value.expression) ||
      bindings.resolve(value.expression) !== descriptor || !descriptor || !stableBinding(descriptor, bindings) ||
      !ts.isVariableDeclaration(descriptor) || !descriptor.initializer ||
      !ts.isCallExpression(unwrapped(descriptor.initializer))) {
    return false;
  }
  const descriptorCall = unwrapped(descriptor.initializer) as ts.CallExpression;
  if (!ts.isPropertyAccessExpression(descriptorCall.expression) ||
      !ts.isIdentifier(descriptorCall.expression.expression) ||
      descriptorCall.expression.expression.text !== "Object" ||
      descriptorCall.expression.name.text !== "getOwnPropertyDescriptor" ||
      descriptorCall.arguments.length !== 2 || !ts.isIdentifier(descriptorCall.arguments[0]!) ||
      bindings.resolve(descriptorCall.arguments[0]!) !== ffi ||
      !ts.isStringLiteral(descriptorCall.arguments[1]!) || descriptorCall.arguments[1]!.text !== "dlopen") {
    return false;
  }
  if (!ffi || !stableBinding(ffi, bindings) || !ts.isVariableDeclaration(ffi) ||
      !ffi.initializer || !ts.isCallExpression(unwrapped(ffi.initializer))) {
    return false;
  }
  const ffiCall = unwrapped(ffi.initializer) as ts.CallExpression;
  return ts.isPropertyAccessExpression(ffiCall.expression) &&
    ts.isMetaProperty(ffiCall.expression.expression) &&
    ffiCall.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    ffiCall.expression.expression.name.text === "meta" && ffiCall.expression.name.text === "require" &&
    ffiCall.arguments.length === 1 && ts.isStringLiteral(ffiCall.arguments[0]!) &&
    ffiCall.arguments[0]!.text === "bun:ffi";
}

function exactFfiSymbolCapture(
  source: ts.SourceFile,
  bindings: LexicalBindings,
  modules: ReadonlyMap<string, ts.Declaration>
): boolean {
  const calls = callsIn(source).filter((call) => directModuleCall(call, "guardedFfiSymbol", bindings, modules));
  const call = calls[0];
  if (!call || calls.length !== 1 || call.arguments.length !== 2 ||
      !ts.isIdentifier(call.arguments[0]!) || !ts.isIdentifier(call.arguments[1]!)) return false;
  const symbol = bindings.resolve(call.arguments[0]!);
  const name = bindings.resolve(call.arguments[1]!);
  return symbol !== undefined && name !== undefined && declarationName(symbol) === "symbol" &&
    declarationName(name) === "name" && ts.isBindingElement(symbol) && ts.isBindingElement(name) &&
    symbol.parent === name.parent && ts.isArrayBindingPattern(symbol.parent) &&
    ts.isVariableDeclaration(symbol.parent.parent) && ts.isVariableDeclarationList(symbol.parent.parent.parent) &&
    ts.isForOfStatement(symbol.parent.parent.parent.parent);
}

function captureContractViolations(
  source: ts.SourceFile,
  bindings: LexicalBindings,
  captured: ReadonlyMap<ts.Declaration, CapturedBinding>,
  modules: ReadonlyMap<string, ts.Declaration>
): readonly string[] {
  const violations = new Set<string>();
  for (const spec of HELPER_SPECS.filter((spec) => spec.binding !== "ffi_close")) {
    if (![...captured.values()].includes(spec.binding)) violations.add(`delegate_owner:${spec.binding}`);
  }
  for (const [declaration, binding] of captured) {
    if (!stableBinding(declaration, bindings)) {
      violations.add(`delegate_owner:${binding}`);
      continue;
    }
    if (binding === "originalBunFile" || binding === "originalBunWrite" ||
        binding === "originalBunSpawn" || binding === "originalBunSpawnSync") {
      if (!exactBunCapture(declaration, binding, bindings, modules)) violations.add(`delegate_owner:${binding}`);
    } else if (binding === "ffi_dlopen") {
      if (!exactFfiDlopenCapture(declaration, bindings, modules)) violations.add("delegate_owner:ffi_dlopen");
    } else if (binding === "node_fs" || binding === "child_process" ||
        binding === "worker_construct" && declarationName(declaration) === "original") {
      if (!descriptorValueCapture(declaration, bindings, modules)) violations.add(`delegate_owner:${binding}`);
    }
  }
  if (!exactFfiSymbolCapture(source, bindings, modules)) violations.add("delegate_owner:ffi_symbol");
  return [...violations];
}

function exactPostAdmissionCondition(
  expression: ts.Expression,
  bindings: LexicalBindings,
  state: ts.Declaration | undefined,
  modules: ReadonlyMap<string, ts.Declaration>
): boolean {
  if (ts.isCallExpression(expression) && expression.arguments.length === 0 &&
      directModuleCall(expression, "isPublicPostAdmission", bindings, modules)) {
    return true;
  }
  return ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    ts.isPropertyAccessExpression(expression.left) && expression.left.name.text === "phase" &&
    ts.isIdentifier(expression.left.expression) && bindings.resolve(expression.left.expression) === state &&
    ts.isStringLiteral(expression.right) && expression.right.text === "post_admission";
}

function denyDominatesWrapper(
  root: ts.Node,
  source: ts.SourceFile,
  bindings: LexicalBindings,
  deny: ts.Declaration | undefined,
  state: ts.Declaration | undefined,
  modules: ReadonlyMap<string, ts.Declaration>
): boolean {
  let ordinary: ts.CallExpression;
  try {
    ordinary = ordinaryDenyCall(root, bindings, deny, state);
  } catch {
    return false;
  }
  let guard: ts.IfStatement | undefined;
  for (let current: ts.Node | undefined = ordinary.parent; current; current = current.parent) {
    if (ts.isTryStatement(current)) return false;
    if (!guard && ts.isIfStatement(current) &&
        exactPostAdmissionCondition(current.expression, bindings, state, modules)) {
      guard = current;
    }
  }
  if (!guard || guard.elseStatement) return false;
  const denyStatement = nearestStatement(ordinary);
  if (!denyStatement || !ts.isExpressionStatement(denyStatement) || denyStatement.expression !== ordinary ||
      (ts.isBlock(guard.thenStatement)
        ? guard.thenStatement.statements.at(-1) !== denyStatement
        : guard.thenStatement !== denyStatement)) return false;
  for (const call of callsIn(root)) {
    if (!ts.isIdentifier(call.expression) || !HELPER_SPECS.some((spec) =>
      bindings.resolve(call.expression as ts.Identifier) === modules.get(spec.name)
    ) || rawInversionBranch(call, bindings, state)) {
      continue;
    }
    if (call.getStart(source) < guard.getEnd() || call.getStart(source) < guard.getStart(source)) return false;
  }
  return true;
}

function inversionTopologyViolations(
  source: ts.SourceFile,
  bindings: LexicalBindings,
  captured: ReadonlyMap<ts.Declaration, CapturedBinding>,
  modules: ReadonlyMap<string, ts.Declaration>,
  state: ts.Declaration | undefined,
  deny: ts.Declaration | undefined
): readonly string[] {
  const violations: string[] = [];
  const rawHelpers = callsIn(source).filter((call) => rawInversionBranch(call, bindings, state) &&
    ts.isIdentifier(call.expression) && HELPER_SPECS.some((spec) =>
      bindings.resolve(call.expression as ts.Identifier) === modules.get(spec.name)
    ));
  const pathEdge = WRAPPER_EDGES[0]!;
  const path = wrapperRoot(source, pathEdge);
  const pathCalls = path ? callsIn(path).filter((call) => rawHelpers.includes(call)) : [];
  const expectedPathCalls = pathCalls.filter((call) =>
    wrapperCallMatches(call, pathEdge, bindings, captured, modules)
  );
  if (pathCalls.length !== 1 || expectedPathCalls.length !== 1) violations.push("deny_order:guardedPathFunction");

  const dlopen = wrapperRoot(source, WRAPPER_EDGES[4]!);
  const rawCalls = dlopen ? callsIn(dlopen).filter((call) => rawHelpers.includes(call)) : [];
  const dlopenEdge = WRAPPER_EDGES[4]!;
  const rawDlopen = rawCalls.filter((call) => wrapperCallMatches(call, dlopenEdge, bindings, captured, modules));
  const rawLibrary = rawDlopen.length === 1 && ts.isVariableDeclaration(rawDlopen[0]!.parent)
    ? rawDlopen[0]!.parent : undefined;
  const rawClose = rawCalls.filter((call) => directModuleCall(call, "delegateFfiClose", bindings, modules));
  const rawDeny = dlopen ? callsIn(dlopen).filter((call) =>
    rawInversionBranch(call, bindings, state) && callIsDeny(call, bindings, deny)
  ) : [];
  const closeIsPaired = rawClose.length === 1 && rawLibrary && rawDeny.length === 1 &&
    rawClose[0]!.arguments.length === 2 && ts.isIdentifier(rawClose[0]!.arguments[0]!) &&
    bindings.resolve(rawClose[0]!.arguments[0]!) === rawLibrary &&
    ts.isIdentifier(rawClose[0]!.arguments[1]!) && ts.isIdentifier(rawDlopen[0]!.arguments[0]!) &&
    bindings.resolve(rawClose[0]!.arguments[1]!) === bindings.resolve(rawDlopen[0]!.arguments[0]!) &&
    rawDlopen[0]!.getStart(source) < rawDeny[0]!.getStart(source) &&
    rawDeny[0]!.getStart(source) < rawClose[0]!.getStart(source) &&
    (() => { for (let node: ts.Node | undefined = rawClose[0]; node; node = node.parent) {
      if (ts.isTryStatement(node.parent) && node.parent.finallyBlock === node) return true;
    } return false; })();
  if (rawCalls.length !== 2 || rawDlopen.length !== 1 || !closeIsPaired) {
    violations.push("deny_order:guardedDlopen");
  }
  for (const call of rawHelpers) {
    if (!pathCalls.includes(call) && !rawCalls.includes(call)) violations.push(`deny_order:${wrapperName(call) ?? "unknown"}`);
  }
  return violations;
}
export function authorityPreloadTopologyViolations(text: string): string[] {
  const source = authorityPreloadSource(text);
  const violations = new Set<string>();
  const bindings = new LexicalBindings(source);
  const modules = moduleDeclarations(source);
  const state = modules.get("state");
  const deny = modules.get("deny");
  const rawOperation = modules.get("rawOperation");
  const workerTargets = workerProxyTargets(source, bindings);
  const ffiSymbols = ffiSymbolParameters(source, bindings);
  const captured = captureBindings(bindings, workerTargets, ffiSymbols);
  for (const name of ["state", "deny", "rawOperation", ...HELPER_SPECS.map((spec) => spec.name)]) {
    const expected = modules.get(name);
    for (const declaration of bindings.declarations()) {
      if (declarationName(declaration) === name && declaration !== expected) {
        violations.add(`binding_shadow:${name}`);
      }
    }
  }
  for (const spec of HELPER_SPECS) {
    const helpers = functionNodes(source, spec.name);
    if (helpers.length !== 1 || !helpers[0] || !helperHasExactTopology(
      helpers[0], spec, bindings, captured, modules, state, rawOperation
    )) {
      violations.add(`delegate_order:${spec.name}`);
    }
  }
  for (const violation of captureContractViolations(source, bindings, captured, modules)) violations.add(violation);
  for (const violation of ambientAcquisitionViolations(source, bindings)) violations.add(violation);
  for (const violation of authorityStateTopologyViolations(source)) violations.add(violation);

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const declaration = bindings.resolve(node);
      const binding = declaration && captured.get(declaration);
      if (declaration && binding && !isDeclarationName(node, declaration) &&
          !isInsideDenyCall(node, bindings, deny) &&
          !capturedReferenceAllowed(node, binding, bindings, captured, modules) &&
          !aliasFeedsOnlyDeny(node, bindings, deny)) {
        if (binding === "worker_construct" && aliasEscape(node)) {
          violations.add("constructor_alias:worker");
        } else if (aliasEscape(node)) {
          violations.add(`unguarded_alias:${binding}`);
        } else if (equivalentCallReference(node)) {
          const parent = node.parent;
          const directWorkerReflect = ts.isCallExpression(parent) &&
            ts.isPropertyAccessExpression(parent.expression) && ts.isIdentifier(parent.expression.expression) &&
            parent.expression.expression.text === "Reflect" &&
            (binding === "worker_apply" || binding === "worker_construct");
          violations.add(directWorkerReflect ? `delegate_owner:${binding}` : `equivalent_call:${binding}`);
        } else {
          violations.add(`delegate_owner:${binding}`);
        }
      }
      const helper = declaration && HELPER_SPECS.find((spec) => modules.get(spec.name) === declaration);
      if (helper && !isDeclarationName(node, declaration)) {
        const parent = node.parent;
        const owner = wrapperName(node);
        const edge = owner ? WRAPPER_EDGES.find((candidate) => candidate.wrapper === owner) : undefined;
        const exact = ts.isCallExpression(parent) && parent.expression === node &&
          edge !== undefined && edge.helper === helper.name &&
          wrapperCallMatches(parent, edge, bindings, captured, modules);
        const inversionHelper = ts.isCallExpression(parent) && parent.expression === node &&
          (rawInversionBranch(parent, bindings, state) ||
            owner === "guardedDlopen" &&
            (helper.name === "delegateFfiDlopen" || helper.name === "delegateFfiClose"));
        if (!exact && !inversionHelper) {
          violations.add(edge ? `delegate_owner:${edge.binding}` : `delegate_order:${helper.name}`);
        }
      }
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const binding = bunMemberBinding(node, bindings, modules);
      if (binding && !canonicalBunMemberUse(node, binding, bindings, modules)) {
        violations.add(`delegate_owner:${binding}`);
      }
      const member = staticMemberName(node);
      if (member === "close" && ts.isIdentifier(node.expression) && node.expression.text === "library" &&
          !isHelperOwner(node, "delegateFfiClose")) {
        violations.add("delegate_owner:ffi_close");
      }
      if (member === "dlopen" && ts.isIdentifier(node.expression) &&
          bindings.resolve(node.expression) === modules.get("guardedFfi")) {
        violations.add("delegate_owner:ffi_dlopen");
      }
      if (member === "symbols" && ts.isIdentifier(node.expression) && node.expression.text === "library") {
        const parent = node.parent;
        const entryRead = ts.isCallExpression(parent) && parent.arguments.includes(node) &&
          staticMemberName(parent.expression) === "entries" && namedFunctionOwner(node) === "guardedDlopen";
        if (!entryRead) violations.add("delegate_owner:ffi_symbol");
      }
    }
    if (ts.isCallExpression(node)) {
      if (staticMemberName(node.expression) === "getPrototypeOf" &&
          ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "Object" && node.arguments.length === 1 &&
          ts.isIdentifier(node.arguments[0]!) && node.arguments[0]!.text === "library") {
        violations.add("delegate_owner:ffi_symbol");
      }
      if (callIsDeny(node, bindings, deny) && !denyArgumentsAreSafe(node, bindings, captured, modules)) {
        violations.add(`deny_arguments:${wrapperName(node) ?? "unknown"}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  if (violations.size === 0) {
    for (const edge of WRAPPER_EDGES) {
      const root = wrapperRoot(source, edge);
      if (!root || !denyDominatesWrapper(root, source, bindings, deny, state, modules)) {
        violations.add(`deny_order:${edge.wrapper}`);
      }
    }
  }
  if (violations.size === 0) {
    for (const violation of wrapperEdgeViolations(source, bindings, captured, modules, deny, state)) {
      violations.add(violation);
    }
  }
  if (violations.size === 0) {
    for (const violation of inversionTopologyViolations(source, bindings, captured, modules, state, deny)) {
      violations.add(violation);
    }
  }
  if (violations.size === 0) {
    for (const violation of exactInversionTopologyViolations(source, bindings, modules, state)) violations.add(violation);
  }
  if (violations.size === 0) {
    for (const violation of authorityFacadeTopologyViolations(source, bindings, modules)) violations.add(violation);
  }
  return [...violations].sort();
}