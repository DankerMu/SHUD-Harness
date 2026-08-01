import {
  addMutation,
  authorityPreloadSource,
  functionBody,
  insertBeforeStatement,
  proxyTrap,
  replacePreloadNode,
  requiredNamedFunction
} from "./authority-topology-ast";
import type { AuthorityTopologyMutation } from "./authority-topology-ast";

function appended(text: string, fragment: string): string {
  return `${text}\n${fragment}\n`;
}

export function authorityRoundOneMutationRows(text: string): readonly AuthorityTopologyMutation[] {
  const source = authorityPreloadSource(text);
  const rows: AuthorityTopologyMutation[] = [];
  const add = (id: string, family: string, violation: string, fragment: string): void => {
    addMutation(rows, id, family, violation, appended(text, fragment));
  };
  const path = requiredNamedFunction(source, "guardedPathFunction");
  const pathBody = functionBody(path);
  const child = requiredNamedFunction(source, "guardedProcessCreation");
  const childBody = functionBody(child);
  const apply = proxyTrap(source, "apply");
  const applyBody = functionBody(apply);
  const dlopen = requiredNamedFunction(source, "guardedDlopen");
  const dlopenBody = functionBody(dlopen);
  const symbol = requiredNamedFunction(source, "guardedFfiSymbol");
  const symbolBody = functionBody(symbol);
  const bunWrite = requiredNamedFunction(source, "guardedBunWrite");
  const bunWriteBody = functionBody(bunWrite);
  if (!pathBody?.statements[0] || !childBody?.statements[0] || !applyBody?.statements[0] ||
      !dlopenBody?.statements[0] || !symbolBody?.statements[1] || !bunWriteBody?.statements[1]) {
    throw new Error("MISSING_ROUND_ONE_MUTATION_ANCHOR");
  }

  add("r1_ambient_bun_write", "delegate_owner", "delegate_owner:originalBunWrite", 'Bun.write("fixture", "payload");');
  add("r1_ambient_ffi_dlopen", "delegate_owner", "delegate_owner:ffi_dlopen", 'guardedFfi.dlopen("/fixture", {});');
  add("r1_call", "equivalent_call", "equivalent_call:originalBunFile", 'originalBunFile.call(Bun, "fixture");');
  add("r1_computed_apply", "equivalent_call", "equivalent_call:originalBunFile", 'originalBunFile["apply"](Bun, ["fixture"]);');
  add("r1_reflect_computed_apply", "equivalent_call", "equivalent_call:originalBunFile", 'Reflect["apply"](originalBunFile, Bun, ["fixture"]);');
  add("r1_bind", "equivalent_call", "equivalent_call:originalBunFile", 'originalBunFile.bind(Bun)("fixture");');
  add("r1_container", "alias", "unguarded_alias:originalBunFile", 'const topologyCache = { file: originalBunFile };\nvoid topologyCache.file("fixture");');
  add("r1_return_escape", "alias", "unguarded_alias:originalBunFile", 'function topologyEscape() { return originalBunFile; }\nvoid topologyEscape()("fixture");');
  add("r1_assignment_escape", "alias", "unguarded_alias:originalBunFile", 'let topologyAssigned: (path: unknown, ...args: unknown[]) => unknown;\ntopologyAssigned = originalBunFile;\nvoid topologyAssigned("fixture");');
  add("r1_helper_alias", "delegate_order", "delegate_order:delegateBunFile", 'const topologyHelperAlias = delegateBunFile;\nvoid topologyHelperAlias("fixture", [], undefined);');

  addMutation(rows, "r1_node_computed_apply", "equivalent_call", "equivalent_call:node_fs",
    insertBeforeStatement(source, pathBody.statements[0], 'original["apply"](this, args);'));
  addMutation(rows, "r1_child_call", "equivalent_call", "equivalent_call:child_process",
    insertBeforeStatement(source, childBody.statements[0], "original.call(this, ...args);"));
  addMutation(rows, "r1_worker_reflect_computed", "equivalent_call", "equivalent_call:worker_apply",
    insertBeforeStatement(source, applyBody.statements[0], 'Reflect["apply"](target, thisArgument, argumentsList);'));
  addMutation(rows, "r1_ffi_close_computed", "delegate_owner", "delegate_owner:ffi_close",
    insertBeforeStatement(source, dlopenBody.statements[0], 'library["close"]();'));
  addMutation(rows, "r1_ffi_symbol_call", "equivalent_call", "equivalent_call:ffi_symbol",
    insertBeforeStatement(source, symbolBody.statements[1], "symbol.call(undefined, ...args);"));

  add("r1_object_pattern_shadow", "binding_shadow", "binding_shadow:deny", 'function topologyObjectShadow({ deny }: { deny: undefined }): void { void deny; }');
  add("r1_array_pattern_shadow", "binding_shadow", "binding_shadow:state", 'function topologyArrayShadow([state]: [undefined]): void { void state; }');
  add("r1_parameter_pattern_shadow", "binding_shadow", "binding_shadow:rawOperation", 'function topologyParameterShadow({ rawOperation }: { rawOperation: undefined }): void { void rawOperation; }');
  addMutation(rows, "r1_shadowed_normalizer", "deny_arguments", "deny_arguments:guardedBunWrite",
    insertBeforeStatement(source, bunWriteBody.statements[0]!, 'const normalizedPathLike = (_value: unknown) => "fixture";'));
  addMutation(rows, "r1_dead_deny", "deny_order", "deny_order:guardedBunWrite",
    replacePreloadNode(source, bunWriteBody.statements[1]!, 'if (state.phase === "post_admission" && false) deny("bun_write", normalized);'));
  addMutation(rows, "r1_comma_deny", "deny_arguments", "deny_arguments:guardedBunWrite",
    replacePreloadNode(source, bunWriteBody.statements[1]!, 'if (state.phase === "post_admission") deny(("bun_write", "other"), normalized);'));
  addMutation(rows, "r1_alternate_deny", "deny_order", "deny_order:guardedBunWrite",
    replacePreloadNode(source, bunWriteBody.statements[1]!, 'if (state.phase === "post_admission") { deny("bun_write", normalized); } else {}'));
  addMutation(rows, "r1_mutable_target", "deny_arguments", "deny_arguments:guardedBunWrite",
    replacePreloadNode(source, bunWriteBody.statements[0]!, "let normalized = normalizedPathLike(path);"));
  addMutation(rows, "r1_reassigned_target", "deny_arguments", "deny_arguments:guardedBunWrite",
    replacePreloadNode(source, bunWriteBody.statements[0]!, 'let normalized = normalizedPathLike(path);\nnormalized = "other";'));

  addMutation(rows, "r1_bun_capture_origin", "delegate_owner", "delegate_owner:originalBunSpawn",
    text.replace("const originalBunSpawn = guardedBun.spawn.bind(Bun);", "const originalBunSpawn = guardedBun.spawnSync.bind(Bun);"));
  addMutation(rows, "r1_bun_capture_reassignment", "delegate_owner", "delegate_owner:originalBunWrite",
    text.replace("const originalBunWrite = guardedBun.write.bind(Bun);", "let originalBunWrite = guardedBun.write.bind(Bun);\noriginalBunWrite = guardedBun.write.bind(Bun);"));
  addMutation(rows, "r1_worker_capture_origin", "delegate_owner", "delegate_owner:worker_construct",
    text.replace("const original = descriptor.value as Function;", "const original = (() => undefined) as Function;"));
  addMutation(rows, "r1_ffi_dlopen_origin", "delegate_owner", "delegate_owner:ffi_dlopen",
    text.replace("const originalDlopen = ffiDescriptor.value as", "const originalDlopen = (() => undefined) as"));
  addMutation(rows, "r1_ffi_symbol_origin", "delegate_owner", "delegate_owner:ffi_symbol",
    text.replace("const guardedSymbol = guardedFfiSymbol(symbol, name);", "const guardedSymbol = guardedFfiSymbol(() => undefined, name);"));

  addMutation(rows, "r1_worker_descriptor_facade", "delegate_owner", "delegate_owner:worker_construct",
    text.replace("value: guardedPrototype", "value: original.prototype"));
  addMutation(rows, "r1_ffi_normal_library_forwarding", "deny_order", "deny_order:guardedDlopen",
    text.replace("const library = delegateFfiDlopen(path, symbols);\n  const retainedDescriptorOpenAt", "const library = delegateFfiDlopen(path, symbols);\n  delegateFfiDlopen(path, symbols);\n  const retainedDescriptorOpenAt"));
  addMutation(rows, "r1_ffi_symbol_escape", "delegate_owner", "delegate_owner:ffi_symbol",
    text.replace("return Object.freeze({", "const topologyLeak = library.symbols;\n  return Object.freeze({"));
  addMutation(rows, "r1_ffi_close_facade", "delegate_owner", "delegate_owner:ffi_close",
    text.replace("close: () => guardedFfiClose(library, path)", "close: library.close"));
  addMutation(rows, "r1_worker_receiver_forwarding", "delegate_owner", "delegate_owner:worker_apply",
    text.replace("delegateWorkerApply(target, thisArgument, argumentsList, operation);", "delegateWorkerApply(target, undefined, argumentsList, operation);"));
  addMutation(rows, "r1_bun_argument_forwarding", "delegate_owner", "delegate_owner:originalBunFile",
    text.replace("delegateBunFile(path, args, normalized);", "delegateBunFile(path, [], normalized);"));
  addMutation(rows, "r1_bun_raw_operation", "delegate_order", "delegate_order:delegateBunFile",
    text.replace('rawOperation("bun_file", normalized);', 'rawOperation("bun_write", normalized);'));

  addMutation(rows, "r1_extra_node_inversion_delegate", "deny_order", "deny_order:guardedPathFunction",
    text.replace("delegatePathFunction(original, this, args, operation, path);\n            }", "delegatePathFunction(original, this, args, operation, path);\n            delegateBunSpawn(args);\n            }"));
  addMutation(rows, "r1_extra_ffi_inversion_delegate", "deny_order", "deny_order:guardedDlopen",
    text.replace("const library = delegateFfiDlopen(path, symbols);\n      try {", "const library = delegateFfiDlopen(path, symbols);\n      delegateFfiDlopen(path, symbols);\n      try {"));
  addMutation(rows, "r1_unpaired_ffi_inversion_close", "deny_order", "deny_order:guardedDlopen",
    text.replace("finally {\n        delegateFfiClose(library, path);\n      }", "finally {\n        const replacementLibrary = library;\n        delegateFfiClose(replacementLibrary, path);\n      }"));
  addMutation(rows, "r1_mismatched_ffi_inversion_close_target", "deny_order", "deny_order:guardedDlopen",
    text.replace("finally {\n        delegateFfiClose(library, path);\n      }", 'finally {\n        delegateFfiClose(library, "/other");\n      }'));
  addMutation(rows, "r1_silent_path_inversion_delegate", "deny_order", "deny_order:guardedPathFunction",
    text.replace("delegatePathFunction(original, this, args, operation, path);\n            }", "void path;\n            }"));
  addMutation(rows, "r1_foreign_ffi_inversion_delegate", "deny_order", "deny_order:guardedDlopen",
    text.replace("const library = delegateFfiDlopen(path, symbols);\n      try {", "const library = delegateFfiDlopen(path, symbols);\n      delegateBunSpawn([]);\n      try {"));
  addMutation(rows, "r1_silent_ffi_inversion_delegate", "deny_order", "deny_order:guardedDlopen",
    text.replace("const library = delegateFfiDlopen(path, symbols);\n      try {", "const library = { symbols: {}, close: () => undefined } as DynamicLibrary;\n      try {"));
  addMutation(rows, "r1_forged_bun_inversion_delegate", "deny_order", "deny_order:guardedBunFile",
    text.replace('if (state.phase === "post_admission") deny("bun_file", normalized);', 'if (state.phase === "post_admission") { if (state.rawInversion === "ffi_dlopen") delegateBunFile(path, args, normalized); deny("bun_file", normalized); }')
      .replace("return delegateBunFile(path, args, normalized);", "return undefined;"));
  return rows;
}
