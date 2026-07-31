import ts from "typescript";
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
  isFfiCloseInvocation,
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
  sourceWithFunctionBodyOrderMoved,
  variableStatementFor,
  workerProxyTargets,
  wrapperName
} from "./authority-topology-ast";
import type { AuthorityTopologyMutation, CapturedBinding } from "./authority-topology-ast";

export type { AuthorityTopologyMutation } from "./authority-topology-ast";


export function authorityTopologyMutationRows(text: string): readonly AuthorityTopologyMutation[] {
  const source = authorityPreloadSource(text);
  const bindings = new LexicalBindings(source);
  const modules = moduleDeclarations(source);
  const workerTargets = workerProxyTargets(source, bindings);
  const ffiSymbols = ffiSymbolParameters(source, bindings);
  const captured = captureBindings(bindings, workerTargets, ffiSymbols);
  const deny = modules.get("deny");
  const state = modules.get("state");
  if (!deny || !state) throw new Error("MISSING_TOPOLOGY_DENY_OR_STATE");

  const rows: AuthorityTopologyMutation[] = [];
  for (const binding of [
    "originalBunFile",
    "originalBunWrite",
    "originalBunSpawn",
    "originalBunSpawnSync"
  ] as const) {
    const declaration = namedVariable(source, binding);
    addMutation(
      rows,
      `bun_owner_${binding}`,
      "bun_owner",
      `delegate_owner:${binding}`,
      insertAfterNode(
        source,
        variableStatementFor(declaration),
        `\nvoid ${binding}(...([] as unknown[]));`
      )
    );
  }

  const bunFile = namedVariable(source, "originalBunFile");
  addMutation(
    rows,
    "unguarded_alias",
    "alias",
    "unguarded_alias:originalBunFile",
    insertAfterNode(
      source,
      variableStatementFor(bunFile),
      '\nconst unguardedBunFileAlias = originalBunFile;\nvoid unguardedBunFileAlias("fixture");'
    )
  );

  const guardedBunFile = requiredNamedFunction(source, "guardedBunFile");
  const bunFileDeny = ordinaryDenyCall(guardedBunFile, bindings, deny, state);
  addMutation(
    rows,
    "alias_in_deny",
    "alias",
    "deny_arguments:guardedBunFile",
    replacePreloadNode(source, bunFileDeny, 'deny("bun_file", denyAlias("fixture") as unknown as string)')
      .replace(
        "const originalBunFile = guardedBun.file.bind(Bun);",
        "const originalBunFile = guardedBun.file.bind(Bun);\nconst denyAlias = originalBunFile;"
      )
  );

  addMutation(
    rows,
    "equivalent_reflect_apply",
    "equivalent_call",
    "equivalent_call:originalBunFile",
    insertAfterNode(
      source,
      variableStatementFor(bunFile),
      '\nReflect.apply(originalBunFile, Bun, ["fixture"]);'
    )
  );

  const construct = proxyTrap(source, "construct");
  const constructBody = functionBody(construct);
  if (!constructBody) throw new Error("MISSING_CONSTRUCT_TRAP_BODY");
  addMutation(
    rows,
    "constructor_alias",
    "constructor_alias",
    "constructor_alias:worker",
    `${source.text.slice(0, constructBody.getStart(source) + 1)}\nconst rawWorkerAlias = target;\nreturn new rawWorkerAlias(...argumentsList);${source.text.slice(constructBody.getStart(source) + 1)}`
  );

  for (const name of ["state", "deny", "rawOperation", ...HELPER_SPECS.map((spec) => spec.name)]) {
    addMutation(
      rows,
      `binding_shadow_${name}`,
      "binding_shadow",
      `binding_shadow:${name}`,
      `${source.text}\nfunction topologyShadow${name}(): void { const ${name} = undefined; void ${name}; }\n`
    );
  }

  const pathGuard = requiredNamedFunction(source, "guardedPathFunction");
  const pathBody = functionBody(pathGuard);
  if (!pathBody || !pathBody.statements[0]) throw new Error("MISSING_PATH_GUARD_BODY");
  addMutation(
    rows,
    "node_owner_bypass",
    "delegate_owner",
    "delegate_owner:node_fs",
    insertBeforeStatement(source, pathBody.statements[0], "original.apply(this, args);")
  );

  const apply = proxyTrap(source, "apply");
  const applyBody = functionBody(apply);
  if (!applyBody || !applyBody.statements[0]) throw new Error("MISSING_APPLY_TRAP_BODY");
  addMutation(
    rows,
    "worker_apply_owner_bypass",
    "delegate_owner",
    "delegate_owner:worker_apply",
    insertBeforeStatement(source, applyBody.statements[0], "Reflect.apply(target, thisArgument, argumentsList);")
  );
  addMutation(
    rows,
    "worker_construct_owner_bypass",
    "delegate_owner",
    "delegate_owner:worker_construct",
    insertBeforeStatement(source, constructBody.statements[0]!, "Reflect.construct(target, argumentsList, newTarget);")
  );

  const guardedDlopen = requiredNamedFunction(source, "guardedDlopen");
  const dlopenBody = functionBody(guardedDlopen);
  if (!dlopenBody || !dlopenBody.statements[0]) throw new Error("MISSING_FFI_DLOPEN_BODY");
  addMutation(
    rows,
    "ffi_dlopen_owner_bypass",
    "delegate_owner",
    "delegate_owner:ffi_dlopen",
    insertBeforeStatement(source, dlopenBody.statements[0], "originalDlopen(path, symbols);")
  );
  const proxyReturn = dlopenBody.statements.find((statement) => ts.isReturnStatement(statement) &&
    ts.isNewExpression(statement.expression));
  if (!proxyReturn) throw new Error("MISSING_FFI_CLOSE_OWNER_ANCHOR");
  addMutation(
    rows,
    "ffi_close_owner_bypass",
    "delegate_owner",
    "delegate_owner:ffi_close",
    insertBeforeStatement(source, proxyReturn, "library.close();")
  );
  const guardedSymbol = requiredNamedFunction(source, "guardedFfiSymbol");
  const symbolCall = callsIn(guardedSymbol).find((call) => ts.isIdentifier(call.expression) &&
    call.expression.text === "delegateFfiSymbol");
  const symbolStatement = symbolCall && nearestStatement(symbolCall);
  if (!symbolStatement) throw new Error("MISSING_FFI_SYMBOL_OWNER_ANCHOR");
  addMutation(
    rows,
    "ffi_symbol_owner_bypass",
    "delegate_owner",
    "delegate_owner:ffi_symbol",
    insertBeforeStatement(source, symbolStatement, "symbol(...args);")
  );

  const childGuard = requiredNamedFunction(source, "guardedProcessCreation");
  const childBody = functionBody(childGuard);
  if (!childBody || !childBody.statements[0]) throw new Error("MISSING_CHILD_OWNER_BODY");
  addMutation(
    rows,
    "child_owner_bypass",
    "delegate_owner",
    "delegate_owner:child_process",
    insertBeforeStatement(source, childBody.statements[0], "original.apply(this, args);")
  );

  for (const spec of HELPER_SPECS) {
    const helper = requiredNamedFunction(source, spec.name);
    addMutation(
      rows,
      `delegate_order_${spec.name}`,
      "delegate_order",
      `delegate_order:${spec.name}`,
      sourceWithFunctionBodyOrderMoved(source, helper)
    );
  }

  const wrapperMutations: readonly Readonly<{ root: ts.Node; helper: string; invocation: string }>[] = [
    { root: pathGuard, helper: "delegatePathFunction", invocation: "delegatePathFunction(original, this, args, operation, path);" },
    { root: apply, helper: "delegateWorkerApply", invocation: "delegateWorkerApply(target, thisArgument, argumentsList, operation);" },
    { root: construct, helper: "delegateWorkerConstruct", invocation: "delegateWorkerConstruct(target, argumentsList, newTarget, operation);" },
    { root: childGuard, helper: "delegateChildProcess", invocation: "delegateChildProcess(original, this, args, operation);" },
    { root: guardedDlopen, helper: "delegateFfiDlopen", invocation: "delegateFfiDlopen(path, symbols);" },
    { root: requiredNamedFunction(source, "guardedFfiClose"), helper: "delegateFfiClose", invocation: "delegateFfiClose(library, path);" },
    { root: guardedSymbol, helper: "delegateFfiSymbol", invocation: "delegateFfiSymbol(symbol, args, operation, candidate);" },
    { root: requiredNamedFunction(source, "guardedBunFile"), helper: "delegateBunFile", invocation: "delegateBunFile(path, args, normalized);" },
    { root: requiredNamedFunction(source, "guardedBunWrite"), helper: "delegateBunWrite", invocation: "delegateBunWrite(path, args, normalized);" },
    { root: requiredNamedFunction(source, "guardedBunSpawn"), helper: "delegateBunSpawn", invocation: "delegateBunSpawn(args);" },
    { root: requiredNamedFunction(source, "guardedBunSpawnSync"), helper: "delegateBunSpawnSync", invocation: "delegateBunSpawnSync(args);" }
  ];
  for (const mutation of wrapperMutations) {
    const ordinary = ordinaryDenyCall(mutation.root, bindings, deny, state);
    const statement = nearestStatement(ordinary);
    if (!statement) throw new Error(`MISSING_DENY_ORDER_ANCHOR:${mutation.helper}`);
    addMutation(
      rows,
      `deny_order_${mutation.helper}`,
      "deny_order",
      `deny_order:${wrapperName(mutation.root) ?? mutation.helper}`,
      insertBeforeStatement(source, statement, mutation.invocation)
    );
  }

  const guardedBunWrite = requiredNamedFunction(source, "guardedBunWrite");
  const normalDeny = ordinaryDenyCall(guardedBunWrite, bindings, deny, state);
  addMutation(
    rows,
    "deny_arguments_normal",
    "deny_arguments",
    "deny_arguments:guardedBunWrite",
    replacePreloadNode(
      source,
      normalDeny,
      'deny("bun_write", originalBunWrite(path, ...args) as unknown as string)'
    )
  );
  const inversion = callsIn(guardedDlopen).find((call) => callIsDeny(call, bindings, deny) &&
    rawInversionBranch(call, bindings, state));
  if (!inversion) throw new Error("MISSING_INVERSION_DENY_ANCHOR");
  addMutation(
    rows,
    "deny_arguments_inversion",
    "deny_arguments",
    "deny_arguments:guardedDlopen",
    replacePreloadNode(
      source,
      inversion,
      'deny("ffi_dlopen", originalDlopen(path, symbols) as unknown as string)'
    )
  );
  return rows;
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
      helpers[0],
      spec,
      bindings,
      captured,
      modules,
      state,
      rawOperation
    )) {
      violations.add(`delegate_order:${spec.name}`);
    }
  }

  const workerHelperCalls = new Map<"delegateWorkerApply" | "delegateWorkerConstruct", CapturedBinding>([
    ["delegateWorkerApply", "worker_apply"],
    ["delegateWorkerConstruct", "worker_construct"]
  ]);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const insideDeny = isInsideDenyCall(node, bindings, deny);
      if (!insideDeny && callsNamedMember(node, "Reflect", "apply")) {
        const target = node.arguments[0] && bindingForExpression(node.arguments[0], bindings, captured);
        if (isHelperOwner(node, "delegateWorkerApply")) {
          const helper = functionNodes(source, "delegateWorkerApply")[0];
          if (!helper || !node.arguments[0] || !ts.isIdentifier(node.arguments[0]) ||
              bindings.resolve(node.arguments[0]) !== functionParameter(helper, "target", bindings)) {
            violations.add("delegate_owner:worker_apply");
          }
        } else if (target?.binding === "originalBunFile") {
          violations.add("equivalent_call:originalBunFile");
        } else {
          violations.add("delegate_owner:worker_apply");
        }
      } else if (!insideDeny && callsNamedMember(node, "Reflect", "construct")) {
        if (isHelperOwner(node, "delegateWorkerConstruct")) {
          const helper = functionNodes(source, "delegateWorkerConstruct")[0];
          if (!helper || !node.arguments[0] || !ts.isIdentifier(node.arguments[0]) ||
              bindings.resolve(node.arguments[0]) !== functionParameter(helper, "target", bindings)) {
            violations.add("delegate_owner:worker_construct");
          }
        } else {
          violations.add("delegate_owner:worker_construct");
        }
      } else if (!insideDeny && ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "close" && isFfiCloseInvocation(node, bindings, captured)) {
        if (!isHelperOwner(node, "delegateFfiClose")) violations.add("delegate_owner:ffi_close");
      } else if (!insideDeny && ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "apply") {
        const binding = memberInvocationBinding(node, bindings, captured);
        if (binding) {
          if (binding.aliased) {
            violations.add(`unguarded_alias:${binding.binding}`);
          } else if (!isHelperOwner(node, HELPER_BY_BINDING.get(binding.binding) ?? "")) {
            violations.add(`delegate_owner:${binding.binding}`);
          }
        } else if (ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === "original" &&
            namedFunctionOwner(node) === "guardedProcessCreation") {
          violations.add("delegate_owner:child_process");
        }
      } else if (!insideDeny && ts.isIdentifier(node.expression)) {
        const binding = bindingForExpression(node.expression, bindings, captured);
        if (binding) {
          if (binding.aliased) {
            violations.add(`unguarded_alias:${binding.binding}`);
          } else if (!isHelperOwner(node, HELPER_BY_BINDING.get(binding.binding) ?? "")) {
            violations.add(`delegate_owner:${binding.binding}`);
          }
        }
      }

      if (callIsDeny(node, bindings, deny) && !denyArgumentsAreSafe(node, bindings, captured)) {
        violations.add(`deny_arguments:${wrapperName(node) ?? "unknown"}`);
      }
      const helperBinding = ts.isIdentifier(node.expression) ? workerHelperCalls.get(node.expression.text as
        "delegateWorkerApply" | "delegateWorkerConstruct") : undefined;
      if (helperBinding && !isInsideDenyCall(node, bindings, deny)) {
        const target = node.arguments[0];
        if (!target || !ts.isIdentifier(target) || bindings.resolve(target) === undefined ||
            captured.get(bindings.resolve(target)!) !== helperBinding) {
          violations.add(`delegate_owner:${helperBinding}`);
        }
      }
    } else if (ts.isNewExpression(node) && !isInsideDenyCall(node, bindings, deny)) {
      const binding = bindingForExpression(node.expression, bindings, captured);
      if (binding?.binding === "worker_construct") {
        if (binding.aliased) violations.add("constructor_alias:worker");
        else if (!isHelperOwner(node, "delegateWorkerConstruct")) violations.add("delegate_owner:worker_construct");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const wrapperRoots: readonly ts.Node[] = [
    ...functionNodes(source, "guardedPathFunction"),
    ...functionNodes(source, "guardedProcessCreation"),
    ...functionNodes(source, "guardedDlopen"),
    ...functionNodes(source, "guardedFfiClose"),
    ...functionNodes(source, "guardedFfiSymbol"),
    ...functionNodes(source, "guardedBunFile"),
    ...functionNodes(source, "guardedBunWrite"),
    ...functionNodes(source, "guardedBunSpawn"),
    ...functionNodes(source, "guardedBunSpawnSync"),
    proxyTrap(source, "apply"),
    proxyTrap(source, "construct")
  ];
  for (const root of wrapperRoots) {
    const wrapper = wrapperName(root);
    if (!wrapper) continue;
    const ordinary = callsIn(root).filter((call) => callIsDeny(call, bindings, deny) &&
      !rawInversionBranch(call, bindings, state));
    if (ordinary.length !== 1 || !ordinary[0]) {
      violations.add(`deny_order:${wrapper}`);
      continue;
    }
    const ordinaryStart = ordinary[0].getStart(source);
    for (const call of callsIn(root)) {
      if (!ts.isIdentifier(call.expression) || !HELPER_SPECS.some((spec) => spec.name === call.expression.text) ||
          call.getStart(source) >= ordinaryStart || rawInversionBranch(call, bindings, state)) {
        continue;
      }
      violations.add(`deny_order:${wrapper}`);
    }
  }
  return [...violations].sort();
}