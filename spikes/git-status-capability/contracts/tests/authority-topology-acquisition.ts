import ts from "typescript";
import {
  LexicalBindings,
  callsIn,
  functionBody,
  functionNodes
} from "./authority-topology-ast";

const CANONICAL_STATIC_IMPORTS = [
  'import { mock } from "bun:test";',
  'import { resolve } from "node:path";',
  'import { fileURLToPath } from "node:url";'
] as const;

function exactStaticImports(source: ts.SourceFile): boolean {
  const imports = source.statements.filter(ts.isImportDeclaration);
  return imports.length === CANONICAL_STATIC_IMPORTS.length &&
    imports.every((declaration, index) => declaration.getText(source) === CANONICAL_STATIC_IMPORTS[index]);
}

function memberCall(call: ts.CallExpression, object: string, member: string): boolean {
  return ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === object && call.expression.name.text === member;
}

function enclosingVariable(call: ts.CallExpression): ts.VariableDeclaration | undefined {
  let current: ts.Node = call;
  while (ts.isAsExpression(current.parent) || ts.isTypeAssertionExpression(current.parent) ||
         ts.isParenthesizedExpression(current.parent) || ts.isNonNullExpression(current.parent)) {
    current = current.parent;
  }
  return ts.isVariableDeclaration(current.parent) ? current.parent : undefined;
}

function exactBuiltinModuleFactory(source: ts.SourceFile): boolean {
  const root = functionNodes(source, "builtinModule")[0];
  const body = functionBody(root);
  if (!root || !body || root.parameters.length !== 1 || !ts.isIdentifier(root.parameters[0]!.name) ||
      root.parameters[0]!.name.text !== "name" || body.statements.length !== 3) return false;
  const [binding, guard, returned] = body.statements;
  if (!binding || !ts.isVariableStatement(binding) || binding.declarationList.declarations.length !== 1) return false;
  const value = binding.declarationList.declarations[0];
  if (!value || !ts.isIdentifier(value.name) || value.name.text !== "value" || !value.initializer ||
      !ts.isCallExpression(value.initializer) || !memberCall(value.initializer, "process", "getBuiltinModule") ||
      value.initializer.arguments.length !== 1 || !ts.isIdentifier(value.initializer.arguments[0]) ||
      value.initializer.arguments[0].text !== "name") return false;
  return !!guard && ts.isIfStatement(guard) && !!returned && ts.isReturnStatement(returned);
}

function exactFfiRequire(call: ts.CallExpression): boolean {
  const declaration = enclosingVariable(call);
  return !!declaration && ts.isIdentifier(declaration.name) && declaration.name.text === "guardedFfi" &&
    ts.isVariableDeclarationList(declaration.parent) && ts.isVariableStatement(declaration.parent.parent) &&
    ts.isSourceFile(declaration.parent.parent.parent) &&
    call.arguments.length === 1 && ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === "bun:ffi";
}

function isImportMetaRequire(call: ts.CallExpression): boolean {
  return ts.isPropertyAccessExpression(call.expression) && ts.isMetaProperty(call.expression.expression) &&
    call.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    call.expression.expression.name.text === "meta" && call.expression.name.text === "require";
}

function exactGlobalThisUse(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (ts.isCallExpression(parent) && parent.arguments[0] === identifier && memberCall(parent, "Object", "defineProperty")) {
    return true;
  }
  let current: ts.Node = identifier;
  while (ts.isAsExpression(current.parent) || ts.isTypeAssertionExpression(current.parent) ||
         ts.isParenthesizedExpression(current.parent)) current = current.parent;
  return ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name) &&
    current.parent.name.text === "globalAuthority" && ts.isVariableDeclarationList(current.parent.parent) &&
    ts.isVariableStatement(current.parent.parent.parent) && ts.isSourceFile(current.parent.parent.parent.parent);
}

const CANONICAL_DESCRIPTOR_ACQUISITION_SURFACES = [
  "Object.getOwnPropertyDescriptor(module, name)",
  'Object.getOwnPropertyDescriptor(original, "prototype")',
  'Object.getOwnPropertyDescriptor(originalPrototype, "constructor")',
  "Object.getOwnPropertyDescriptor(module, name)",
  "Object.getOwnPropertyDescriptor(guardedChildProcess, name)",
  'Object.getOwnPropertyDescriptor(guardedFfi, "dlopen")',
  'Object.getOwnPropertyDescriptor(globalAuthority, "Worker")',
  "Object.getOwnPropertyDescriptor(ContractCapabilities.prototype, name)"
] as const;
const CANONICAL_REFLECTIVE_DESCRIPTOR_SURFACES = [
  "Reflect.getOwnPropertyDescriptor(target, property)"
] as const;
const CANONICAL_REFLECTIVE_GETTER_SURFACES = [
  "Reflect.get(target, property, receiver)",
  "Reflect.get(target, property, receiver)",
  "Reflect.get(target, property, receiver)",
  "Reflect.get(target, property, receiver)"
] as const;
const CANONICAL_DESCRIPTOR_MEMBER_SURFACES = [
  "descriptor.value",
  "descriptor.value",
  "descriptor.value",
  "descriptor.value",
  "descriptor.value",
  "constructorDescriptor.value",
  "constructorDescriptor.configurable",
  "constructorDescriptor.writable",
  "descriptor.value",
  "descriptor.value",
  "descriptor.value",
  "descriptor.value",
  "ffiDescriptor.value",
  "ffiDescriptor.value",
  "globalWorkerDescriptor.value",
  "descriptor.value",
  "descriptor.writable",
  "descriptor.configurable",
  "descriptor.value"
] as const;


function firstUnexpectedSurface(actual: readonly string[], expected: readonly string[]): string | undefined {
  const length = Math.max(actual.length, expected.length);
  for (let index = 0; index < length; index += 1) {
    if (actual[index] === expected[index]) continue;
    if (actual[index] === expected[index + 1]) return expected[index];
    if (actual[index + 1] === expected[index]) return actual[index];
    return actual[index] ?? expected[index];
  }
  return undefined;
}

function callsWithMember(source: ts.SourceFile, object: string, member: string): readonly string[] {
  return callsIn(source)
    .filter((call) => memberCall(call, object, member))
    .map((call) => call.getText(source));
}

function descriptorMemberSurfaces(source: ts.SourceFile): readonly string[] {
  const names = new Set(["descriptor", "constructorDescriptor", "ffiDescriptor", "globalWorkerDescriptor"]);
  const members: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) &&
        names.has(node.expression.text)) {
      members.push(node.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return members;
}

function descriptorViolation(source: ts.SourceFile): string | undefined {
  const objectDescriptors = callsWithMember(source, "Object", "getOwnPropertyDescriptor");
  const reflectiveDescriptors = callsWithMember(source, "Reflect", "getOwnPropertyDescriptor");
  const reflectiveGetters = callsWithMember(source, "Reflect", "get");
  const members = descriptorMemberSurfaces(source);
  const unexpected = firstUnexpectedSurface(objectDescriptors, CANONICAL_DESCRIPTOR_ACQUISITION_SURFACES) ??
    firstUnexpectedSurface(reflectiveDescriptors, CANONICAL_REFLECTIVE_DESCRIPTOR_SURFACES) ??
    firstUnexpectedSurface(reflectiveGetters, CANONICAL_REFLECTIVE_GETTER_SURFACES) ??
    firstUnexpectedSurface(members, CANONICAL_DESCRIPTOR_MEMBER_SURFACES);
  if (unexpected === undefined) return undefined;
  if (unexpected.includes("library")) return "delegate_owner:ffi_symbol";
  if (unexpected.includes("guardedFfi") || unexpected.includes("ffiDescriptor")) {
    return "delegate_owner:ffi_dlopen";
  }
  if (unexpected.includes("guardedChildProcess")) return "delegate_owner:child_process";
  if (unexpected.includes("process") || unexpected.includes("fs")) return "delegate_owner:node_fs";
  return "delegate_owner:worker_construct";
}

function staticPropertyName(name: ts.PropertyName | undefined): string | undefined {
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    ? name.text
    : undefined;
}

function bindingPatternProperties(pattern: ts.ObjectBindingPattern): readonly string[] {
  const names: string[] = [];
  for (const element of pattern.elements) {
    if (!ts.isBindingElement(element)) continue;
    const name = staticPropertyName(element.propertyName) ??
      (ts.isIdentifier(element.name) ? element.name.text : undefined);
    if (name) names.push(name);
  }
  return names;
}

function exactCapabilityDestructure(declaration: ts.VariableDeclaration): boolean {
  if (!ts.isObjectBindingPattern(declaration.name) || !declaration.initializer ||
      declaration.name.elements.length !== 1) return false;
  const [element] = declaration.name.elements;
  if (!element || !ts.isBindingElement(element) || !ts.isIdentifier(element.name) ||
      element.name.text !== "ContractCapabilities" ||
      staticPropertyName(element.propertyName) !== undefined) return false;
  const initializer = declaration.initializer;
  return ts.isAwaitExpression(initializer) && ts.isCallExpression(initializer.expression) &&
    initializer.expression.expression.kind === ts.SyntaxKind.ImportKeyword &&
    initializer.expression.arguments.length === 1 && ts.isStringLiteral(initializer.expression.arguments[0]) &&
    initializer.expression.arguments[0].text === "../lib/capabilities";
}

function authorityDestructureSource(
  expression: ts.Expression,
  bindings: LexicalBindings,
  seen = new Set<ts.Declaration>()
): boolean {
  let value = expression;
  while (ts.isAsExpression(value) || ts.isTypeAssertionExpression(value) ||
         ts.isParenthesizedExpression(value) || ts.isNonNullExpression(value)) {
    value = value.expression;
  }
  if (ts.isIdentifier(value)) {
    if ([
      "Bun",
      "guardedBun",
      "guardedFs",
      "guardedFsPromises",
      "guardedChildProcess",
      "guardedFfi",
      "guardedNodeWorkerThreads",
      "globalAuthority",
      "globalThis"
    ].includes(value.text)) return true;
    const declaration = bindings.resolve(value);
    if (!declaration || seen.has(declaration) || !ts.isVariableDeclaration(declaration) ||
        !declaration.initializer) return false;
    seen.add(declaration);
    return authorityDestructureSource(declaration.initializer, bindings, seen);
  }
  if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
    return authorityDestructureSource(value.expression, bindings, seen);
  }
  return ts.isCallExpression(value) &&
    (ts.isIdentifier(value.expression) && value.expression.text === "builtinModule" ||
      memberCall(value, "process", "getBuiltinModule") || isImportMetaRequire(value) ||
      memberCall(value, "Object", "getOwnPropertyDescriptor") ||
      memberCall(value, "Reflect", "get") || memberCall(value, "Reflect", "getOwnPropertyDescriptor"));
}

function rawModuleBinding(
  expression: ts.Expression,
  bindings: LexicalBindings,
  seen = new Set<ts.Declaration>()
): string | undefined {
  let value = expression;
  while (ts.isAsExpression(value) || ts.isTypeAssertionExpression(value) ||
         ts.isParenthesizedExpression(value) || ts.isNonNullExpression(value)) {
    value = value.expression;
  }
  if (ts.isIdentifier(value)) {
    if (value.text === "guardedFs" || value.text === "guardedFsPromises") return "node_fs";
    if (value.text === "guardedChildProcess") return "child_process";
    if (value.text === "guardedFfi") return "ffi_dlopen";
    if (value.text === "guardedNodeWorkerThreads" || value.text === "globalAuthority" ||
        value.text === "globalThis") return "worker_construct";
    if (value.text === "Bun" || value.text === "guardedBun") return undefined;
    const declaration = bindings.resolve(value);
    if (!declaration || seen.has(declaration) || !ts.isVariableDeclaration(declaration) ||
        !declaration.initializer) return undefined;
    seen.add(declaration);
    return rawModuleBinding(declaration.initializer, bindings, seen);
  }
  if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
    return rawModuleBinding(value.expression, bindings, seen);
  }
  if (!ts.isCallExpression(value)) return undefined;
  if (isImportMetaRequire(value)) {
    const requested = value.arguments[0];
    return requested && ts.isStringLiteral(requested) &&
      (requested.text === "node:fs" || requested.text === "fs")
      ? "node_fs"
      : "ffi_dlopen";
  }
  if (ts.isIdentifier(value.expression) && value.expression.text === "builtinModule" ||
      memberCall(value, "process", "getBuiltinModule")) {
    const requested = value.arguments[0];
    if (requested && ts.isStringLiteral(requested)) {
      if (requested.text.includes("child_process")) return "child_process";
      if (requested.text.includes("worker_threads")) return "worker_construct";
    }
    return "node_fs";
  }
  return undefined;
}

function rawModuleMemberViolation(source: ts.SourceFile, bindings: LexicalBindings): string | undefined {
  let violation: string | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const binding = rawModuleBinding(node.expression, bindings);
      if (binding) violation ??= `delegate_owner:${binding}`;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violation;
}

function descriptorOwner(declaration: ts.Declaration): string | undefined {
  if (!ts.isVariableDeclaration(declaration) || !declaration.initializer ||
      !ts.isCallExpression(declaration.initializer)) return undefined;
  const call = declaration.initializer;
  if (!memberCall(call, "Object", "getOwnPropertyDescriptor") &&
      !memberCall(call, "Reflect", "getOwnPropertyDescriptor")) return undefined;
  const target = call.arguments[0];
  if (target && ts.isIdentifier(target)) {
    if (target.text === "guardedFfi") return "ffi_dlopen";
    if (target.text === "guardedChildProcess") return "child_process";
    if (target.text === "globalAuthority") return "worker_construct";
    if (target.text === "library") return "ffi_symbol";
  }
  return "node_fs";
}

function descriptorAliasOwner(
  expression: ts.Expression,
  bindings: LexicalBindings,
  seen = new Set<ts.Declaration>()
): string | undefined {
  let value = expression;
  while (ts.isAsExpression(value) || ts.isTypeAssertionExpression(value) ||
         ts.isParenthesizedExpression(value) || ts.isNonNullExpression(value)) {
    value = value.expression;
  }
  if (!ts.isIdentifier(value)) return undefined;
  const declaration = bindings.resolve(value);
  if (!declaration || seen.has(declaration)) return undefined;
  const direct = descriptorOwner(declaration);
  if (direct) return direct;
  if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return undefined;
  seen.add(declaration);
  return descriptorAliasOwner(declaration.initializer, bindings, seen);
}

function directDescriptorAccess(expression: ts.Expression, bindings: LexicalBindings): boolean {
  let value = expression;
  while (ts.isAsExpression(value) || ts.isTypeAssertionExpression(value) ||
         ts.isParenthesizedExpression(value) || ts.isNonNullExpression(value)) {
    value = value.expression;
  }
  return ts.isIdentifier(value) && (() => {
    const declaration = bindings.resolve(value);
    return declaration !== undefined && descriptorOwner(declaration) !== undefined;
  })();
}

function descriptorAliasViolation(source: ts.SourceFile, bindings: LexicalBindings): string | undefined {
  let violation: string | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const owner = descriptorAliasOwner(node.expression, bindings);
      if (owner && !directDescriptorAccess(node.expression, bindings)) {
        violation ??= `delegate_owner:${owner}`;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violation;
}

function destructureViolation(source: ts.SourceFile, bindings: LexicalBindings): string | undefined {
  let violation: string | undefined;
  const forProperties = (properties: readonly string[]): void => {
    if (properties.some((name) => name === "dlopen")) violation ??= "delegate_owner:ffi_dlopen";
    else if (properties.some((name) => name === "close")) violation ??= "delegate_owner:ffi_close";
    else if (properties.some((name) => name === "symbols")) violation ??= "delegate_owner:ffi_symbol";
    else if (properties.some((name) => name === "Worker")) violation ??= "delegate_owner:worker_construct";
    else if (properties.some((name) => name === "file")) violation ??= "delegate_owner:originalBunFile";
    else if (properties.some((name) => name === "write")) violation ??= "delegate_owner:originalBunWrite";
    else if (properties.some((name) => name === "spawn")) violation ??= "delegate_owner:originalBunSpawn";
    else if (properties.some((name) => name === "spawnSync")) violation ??= "delegate_owner:originalBunSpawnSync";
    else if (properties.some((name) => ["exec", "execFile", "execFileSync", "execSync", "fork"].includes(name))) {
      violation ??= "delegate_owner:child_process";
    } else {
      violation ??= "delegate_owner:node_fs";
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer &&
        !exactCapabilityDestructure(node) && authorityDestructureSource(node.initializer, bindings)) {
      forProperties(bindingPatternProperties(node.name));
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
               ts.isObjectLiteralExpression(node.left) && authorityDestructureSource(node.right, bindings)) {
      const properties = node.left.properties.flatMap((property) => {
        if (ts.isShorthandPropertyAssignment(property) || ts.isPropertyAssignment(property)) {
          const name = staticPropertyName(property.name);
          return name === undefined ? [] : [name];
        }
        return [];
      });
      forProperties(properties);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violation;
}

export function ambientAcquisitionViolations(source: ts.SourceFile, bindings: LexicalBindings): readonly string[] {
  const violations = new Set<string>();
  const imports = source.statements.filter(ts.isImportDeclaration);
  if (!exactStaticImports(source)) {
    const importsFfi = imports.some((declaration) =>
      ts.isStringLiteral(declaration.moduleSpecifier) && declaration.moduleSpecifier.text === "bun:ffi"
    );
    violations.add(importsFfi ? "delegate_owner:ffi_dlopen" : "delegate_owner:node_fs");
  }
  const builtinCalls = callsIn(source).filter((call) => memberCall(call, "process", "getBuiltinModule"));
  if (builtinCalls.length !== 1 || !exactBuiltinModuleFactory(source)) {
    violations.add("delegate_owner:node_fs");
  }
  const ffiRequires = callsIn(source).filter(isImportMetaRequire);
  if (ffiRequires.length !== 1 || !exactFfiRequire(ffiRequires[0]!)) {
    const importsFs = ffiRequires.some((call) =>
      ts.isStringLiteral(call.arguments[0]) &&
      (call.arguments[0]!.text === "node:fs" || call.arguments[0]!.text === "fs")
    );
    violations.add(importsFs ? "delegate_owner:node_fs" : "delegate_owner:ffi_dlopen");
  }
  const globalUses: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "globalThis") globalUses.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (globalUses.length !== 2 || globalUses.some((identifier) => !exactGlobalThisUse(identifier))) {
    violations.add("delegate_owner:worker_construct");
  }
  const destructure = destructureViolation(source, bindings);
  if (destructure) violations.add(destructure);
  const rawMember = rawModuleMemberViolation(source, bindings);
  if (rawMember) violations.add(rawMember);
  const descriptorAlias = descriptorAliasViolation(source, bindings);
  if (descriptorAlias) violations.add(descriptorAlias);
  const descriptor = descriptorViolation(source);
  if (descriptor) violations.add(descriptor);
  return [...violations];
}
