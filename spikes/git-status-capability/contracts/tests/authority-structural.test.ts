import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { AUTHORITY_PROOF_REGISTRY, AUTHORITY_PROOF_ROWS } from "./authority-vocabulary";
import type { AuthorityProofRow } from "./authority-vocabulary";
import {
  authorityControlLifecycleTopologyViolations,
  authorityPreloadTopologyViolations,
  authorityTopologyMutationRows,
  globalCloseResolveBypassSource
} from "./authority-topology";
import { authorityRoundOneMutationRows } from "./authority-topology-round-one";
import {
  EXPECTED_BASE_TOPOLOGY_MUTATION_SHA256,
  EXPECTED_ROUND_ONE_TOPOLOGY_MUTATION_SHA256
} from "./authority-topology-digests";

const contractsRoot = join(import.meta.dir, "..");
const productionCheckPath = join(contractsRoot, "check.ts");
const productionLibPath = join(contractsRoot, "lib");
const authorityPreloadPath = join(import.meta.dir, "authority-preload.ts");
const authorityControlPath = join(import.meta.dir, "authority-control.ts");
const authorityWorkerPath = join(import.meta.dir, "authority-worker.ts");
const authorityVocabularyPath = join(import.meta.dir, "authority-vocabulary.ts");

const EXPECTED_AUTHORITY_PROOF_VERSION = "shud.contract.authority-proof.v2";
const EXPECTED_AUTHORITY_PROOF_ROW_COUNT = 55;
const EXPECTED_AUTHORITY_PROOF_REGISTRY_SHA256 = "8ae389ead0f1aaad27cdeb080f66e1841376552a963ef9069657d929a118a725";
type AuthorityTopologyProjection = Readonly<{
  id: string;
  family: string;
  violation: string;
  anchor: string;
}>;

const EXPECTED_BASE_TOPOLOGY_PROJECTION = Object.freeze([
  { id: "bun_owner_originalBunFile", family: "bun_owner", violation: "delegate_owner:originalBunFile", anchor: "void originalBunFile(...([] as unknown[]));" },
  { id: "bun_owner_originalBunWrite", family: "bun_owner", violation: "delegate_owner:originalBunWrite", anchor: "void originalBunWrite(...([] as unknown[]));" },
  { id: "bun_owner_originalBunSpawn", family: "bun_owner", violation: "delegate_owner:originalBunSpawn", anchor: "void originalBunSpawn(...([] as unknown[]));" },
  { id: "bun_owner_originalBunSpawnSync", family: "bun_owner", violation: "delegate_owner:originalBunSpawnSync", anchor: "void originalBunSpawnSync(...([] as unknown[]));" },
  { id: "unguarded_alias", family: "alias", violation: "unguarded_alias:originalBunFile", anchor: "const unguardedBunFileAlias = originalBunFile;" },
  { id: "alias_in_deny", family: "alias", violation: "deny_arguments:guardedBunFile", anchor: "const denyAlias = originalBunFile;" },
  { id: "equivalent_reflect_apply", family: "equivalent_call", violation: "equivalent_call:originalBunFile", anchor: "Reflect.apply(originalBunFile, Bun, [\"fixture\"]);" },
  { id: "constructor_alias", family: "constructor_alias", violation: "constructor_alias:worker", anchor: "const rawWorkerAlias = target;" },
  { id: "binding_shadow_state", family: "binding_shadow", violation: "binding_shadow:state", anchor: "function topologyShadowstate" },
  { id: "binding_shadow_deny", family: "binding_shadow", violation: "binding_shadow:deny", anchor: "function topologyShadowdeny" },
  { id: "binding_shadow_rawOperation", family: "binding_shadow", violation: "binding_shadow:rawOperation", anchor: "function topologyShadowrawOperation" },
  { id: "binding_shadow_delegatePathFunction", family: "binding_shadow", violation: "binding_shadow:delegatePathFunction", anchor: "function topologyShadowdelegatePathFunction" },
  { id: "binding_shadow_delegateWorkerApply", family: "binding_shadow", violation: "binding_shadow:delegateWorkerApply", anchor: "function topologyShadowdelegateWorkerApply" },
  { id: "binding_shadow_delegateWorkerConstruct", family: "binding_shadow", violation: "binding_shadow:delegateWorkerConstruct", anchor: "function topologyShadowdelegateWorkerConstruct" },
  { id: "binding_shadow_delegateChildProcess", family: "binding_shadow", violation: "binding_shadow:delegateChildProcess", anchor: "function topologyShadowdelegateChildProcess" },
  { id: "binding_shadow_delegateFfiDlopen", family: "binding_shadow", violation: "binding_shadow:delegateFfiDlopen", anchor: "function topologyShadowdelegateFfiDlopen" },
  { id: "binding_shadow_delegateFfiClose", family: "binding_shadow", violation: "binding_shadow:delegateFfiClose", anchor: "function topologyShadowdelegateFfiClose" },
  { id: "binding_shadow_delegateFfiSymbol", family: "binding_shadow", violation: "binding_shadow:delegateFfiSymbol", anchor: "function topologyShadowdelegateFfiSymbol" },
  { id: "binding_shadow_delegateBunFile", family: "binding_shadow", violation: "binding_shadow:delegateBunFile", anchor: "function topologyShadowdelegateBunFile" },
  { id: "binding_shadow_delegateBunWrite", family: "binding_shadow", violation: "binding_shadow:delegateBunWrite", anchor: "function topologyShadowdelegateBunWrite" },
  { id: "binding_shadow_delegateBunSpawn", family: "binding_shadow", violation: "binding_shadow:delegateBunSpawn", anchor: "function topologyShadowdelegateBunSpawn" },
  { id: "binding_shadow_delegateBunSpawnSync", family: "binding_shadow", violation: "binding_shadow:delegateBunSpawnSync", anchor: "function topologyShadowdelegateBunSpawnSync" },
  { id: "node_owner_bypass", family: "delegate_owner", violation: "delegate_owner:node_fs", anchor: "original.apply(this, args);" },
  { id: "worker_apply_owner_bypass", family: "delegate_owner", violation: "delegate_owner:worker_apply", anchor: "Reflect.apply(target, thisArgument, argumentsList);" },
  { id: "worker_construct_owner_bypass", family: "delegate_owner", violation: "delegate_owner:worker_construct", anchor: "Reflect.construct(target, argumentsList, newTarget);" },
  { id: "ffi_dlopen_owner_bypass", family: "delegate_owner", violation: "delegate_owner:ffi_dlopen", anchor: "originalDlopen(path, symbols);" },
  { id: "ffi_close_owner_bypass", family: "delegate_owner", violation: "delegate_owner:ffi_close", anchor: "library.close();" },
  { id: "ffi_symbol_owner_bypass", family: "delegate_owner", violation: "delegate_owner:ffi_symbol", anchor: "symbol(...args);" },
  { id: "child_owner_bypass", family: "delegate_owner", violation: "delegate_owner:child_process", anchor: "original.apply(this, args);" },
  { id: "delegate_order_delegatePathFunction", family: "delegate_order", violation: "delegate_order:delegatePathFunction", anchor: "return original.apply(thisArgument, argumentsList);" },
  { id: "delegate_order_delegateWorkerApply", family: "delegate_order", violation: "delegate_order:delegateWorkerApply", anchor: "return Reflect.apply(target, thisArgument, argumentsList);" },
  { id: "delegate_order_delegateWorkerConstruct", family: "delegate_order", violation: "delegate_order:delegateWorkerConstruct", anchor: "return Reflect.construct(target, argumentsList, newTarget);" },
  { id: "delegate_order_delegateChildProcess", family: "delegate_order", violation: "delegate_order:delegateChildProcess", anchor: "return original.apply(thisArgument, argumentsList);" },
  { id: "delegate_order_delegateFfiDlopen", family: "delegate_order", violation: "delegate_order:delegateFfiDlopen", anchor: "return originalDlopen(path, symbols);" },
  { id: "delegate_order_delegateFfiClose", family: "delegate_order", violation: "delegate_order:delegateFfiClose", anchor: "library.close();" },
  { id: "delegate_order_delegateFfiSymbol", family: "delegate_order", violation: "delegate_order:delegateFfiSymbol", anchor: "return symbol(...argumentsList);" },
  { id: "delegate_order_delegateBunFile", family: "delegate_order", violation: "delegate_order:delegateBunFile", anchor: "return originalBunFile(path, ...argumentsList);" },
  { id: "delegate_order_delegateBunWrite", family: "delegate_order", violation: "delegate_order:delegateBunWrite", anchor: "return originalBunWrite(path, ...argumentsList);" },
  { id: "delegate_order_delegateBunSpawn", family: "delegate_order", violation: "delegate_order:delegateBunSpawn", anchor: "return originalBunSpawn(...argumentsList);" },
  { id: "delegate_order_delegateBunSpawnSync", family: "delegate_order", violation: "delegate_order:delegateBunSpawnSync", anchor: "return originalBunSpawnSync(...argumentsList);" },
  { id: "deny_order_delegatePathFunction", family: "deny_order", violation: "deny_order:guardedPathFunction", anchor: "delegatePathFunction(original, this, args, operation, path);" },
  { id: "deny_order_delegateWorkerApply", family: "deny_order", violation: "deny_order:worker_apply", anchor: "delegateWorkerApply(target, thisArgument, argumentsList, operation);" },
  { id: "deny_order_delegateWorkerConstruct", family: "deny_order", violation: "deny_order:worker_construct", anchor: "delegateWorkerConstruct(target, argumentsList, newTarget, operation);" },
  { id: "deny_order_delegateChildProcess", family: "deny_order", violation: "deny_order:guardedProcessCreation", anchor: "delegateChildProcess(original, this, args, operation);" },
  { id: "deny_order_delegateFfiDlopen", family: "deny_order", violation: "deny_order:guardedDlopen", anchor: "delegateFfiDlopen(path, symbols);" },
  { id: "deny_order_delegateFfiClose", family: "deny_order", violation: "deny_order:guardedFfiClose", anchor: "delegateFfiClose(library, path);" },
  { id: "deny_order_delegateFfiSymbol", family: "deny_order", violation: "deny_order:guardedFfiSymbol", anchor: "delegateFfiSymbol(symbol, args, operation, candidate);" },
  { id: "deny_order_delegateBunFile", family: "deny_order", violation: "deny_order:guardedBunFile", anchor: "delegateBunFile(path, args, normalized);" },
  { id: "deny_order_delegateBunWrite", family: "deny_order", violation: "deny_order:guardedBunWrite", anchor: "delegateBunWrite(path, args, normalized);" },
  { id: "deny_order_delegateBunSpawn", family: "deny_order", violation: "deny_order:guardedBunSpawn", anchor: "delegateBunSpawn(args);" },
  { id: "deny_order_delegateBunSpawnSync", family: "deny_order", violation: "deny_order:guardedBunSpawnSync", anchor: "delegateBunSpawnSync(args);" },
  { id: "deny_arguments_normal", family: "deny_arguments", violation: "deny_arguments:guardedBunWrite", anchor: "originalBunWrite(path, ...args) as unknown as string" },
  { id: "deny_arguments_inversion", family: "deny_arguments", violation: "deny_arguments:guardedDlopen", anchor: "originalDlopen(path, symbols) as unknown as string" }
] satisfies readonly AuthorityTopologyProjection[]);

const EXPECTED_ROUND_ONE_TOPOLOGY_PROJECTION = Object.freeze([
  { id: "r1_ambient_bun_write", family: "delegate_owner", violation: "delegate_owner:originalBunWrite", anchor: "Bun.write(\"fixture\", \"payload\");" },
  { id: "r1_ambient_ffi_dlopen", family: "delegate_owner", violation: "delegate_owner:ffi_dlopen", anchor: "guardedFfi.dlopen(\"/fixture\", {});" },
  { id: "r1_call", family: "equivalent_call", violation: "equivalent_call:originalBunFile", anchor: "originalBunFile.call(Bun, \"fixture\");" },
  { id: "r1_computed_apply", family: "equivalent_call", violation: "equivalent_call:originalBunFile", anchor: "originalBunFile[\"apply\"](Bun, [\"fixture\"]);" },
  { id: "r1_reflect_computed_apply", family: "equivalent_call", violation: "equivalent_call:originalBunFile", anchor: "Reflect[\"apply\"](originalBunFile, Bun, [\"fixture\"]);" },
  { id: "r1_bind", family: "equivalent_call", violation: "equivalent_call:originalBunFile", anchor: "originalBunFile.bind(Bun)(\"fixture\");" },
  { id: "r1_container", family: "alias", violation: "unguarded_alias:originalBunFile", anchor: "const topologyCache = { file: originalBunFile };" },
  { id: "r1_return_escape", family: "alias", violation: "unguarded_alias:originalBunFile", anchor: "function topologyEscape() { return originalBunFile; }" },
  { id: "r1_assignment_escape", family: "alias", violation: "unguarded_alias:originalBunFile", anchor: "topologyAssigned = originalBunFile;" },
  { id: "r1_helper_alias", family: "delegate_order", violation: "delegate_order:delegateBunFile", anchor: "const topologyHelperAlias = delegateBunFile;" },
  { id: "r1_node_computed_apply", family: "equivalent_call", violation: "equivalent_call:node_fs", anchor: "original[\"apply\"](this, args);" },
  { id: "r1_child_call", family: "equivalent_call", violation: "equivalent_call:child_process", anchor: "original.call(this, ...args);" },
  { id: "r1_worker_reflect_computed", family: "equivalent_call", violation: "equivalent_call:worker_apply", anchor: "Reflect[\"apply\"](target, thisArgument, argumentsList);" },
  { id: "r1_ffi_close_computed", family: "delegate_owner", violation: "delegate_owner:ffi_close", anchor: "library[\"close\"]();" },
  { id: "r1_ffi_symbol_call", family: "equivalent_call", violation: "equivalent_call:ffi_symbol", anchor: "symbol.call(undefined, ...args);" },
  { id: "r1_object_pattern_shadow", family: "binding_shadow", violation: "binding_shadow:deny", anchor: "function topologyObjectShadow({ deny }" },
  { id: "r1_array_pattern_shadow", family: "binding_shadow", violation: "binding_shadow:state", anchor: "function topologyArrayShadow([state]" },
  { id: "r1_parameter_pattern_shadow", family: "binding_shadow", violation: "binding_shadow:rawOperation", anchor: "function topologyParameterShadow({ rawOperation }" },
  { id: "r1_shadowed_normalizer", family: "deny_arguments", violation: "deny_arguments:guardedBunWrite", anchor: "const normalizedPathLike = (_value: unknown) => \"fixture\";" },
  { id: "r1_dead_deny", family: "deny_order", violation: "deny_order:guardedBunWrite", anchor: "state.phase === \"post_admission\" && false" },
  { id: "r1_comma_deny", family: "deny_arguments", violation: "deny_arguments:guardedBunWrite", anchor: "deny((\"bun_write\", \"other\"), normalized);" },
  { id: "r1_alternate_deny", family: "deny_order", violation: "deny_order:guardedBunWrite", anchor: "if (state.phase === \"post_admission\") { deny(\"bun_write\", normalized); } else {}" },
  { id: "r1_mutable_target", family: "deny_arguments", violation: "deny_arguments:guardedBunWrite", anchor: "let normalized = normalizedPathLike(path);" },
  { id: "r1_reassigned_target", family: "deny_arguments", violation: "deny_arguments:guardedBunWrite", anchor: "normalized = \"other\";" },
  { id: "r1_bun_capture_origin", family: "delegate_owner", violation: "delegate_owner:originalBunSpawn", anchor: "const originalBunSpawn = guardedBun.spawnSync.bind(Bun);" },
  { id: "r1_bun_capture_reassignment", family: "delegate_owner", violation: "delegate_owner:originalBunWrite", anchor: "originalBunWrite = guardedBun.write.bind(Bun);" },
  { id: "r1_worker_capture_origin", family: "delegate_owner", violation: "delegate_owner:worker_construct", anchor: "const original = (() => undefined) as Function;" },
  { id: "r1_ffi_dlopen_origin", family: "delegate_owner", violation: "delegate_owner:ffi_dlopen", anchor: "const originalDlopen = (() => undefined) as" },
  { id: "r1_ffi_symbol_origin", family: "delegate_owner", violation: "delegate_owner:ffi_symbol", anchor: "guardedFfiSymbol(() => undefined, name)" },
  { id: "r1_worker_descriptor_facade", family: "delegate_owner", violation: "delegate_owner:worker_construct", anchor: "value: original.prototype" },
  { id: "r1_ffi_normal_library_forwarding", family: "deny_order", violation: "deny_order:guardedDlopen", anchor: "const library = delegateFfiDlopen(path, symbols);\n  delegateFfiDlopen(path, symbols);" },
  { id: "r1_ffi_symbol_escape", family: "delegate_owner", violation: "delegate_owner:ffi_symbol", anchor: "const topologyLeak = library.symbols;" },
  { id: "r1_ffi_close_facade", family: "delegate_owner", violation: "delegate_owner:ffi_close", anchor: "close: library.close" },
  { id: "r1_worker_receiver_forwarding", family: "delegate_owner", violation: "delegate_owner:worker_apply", anchor: "delegateWorkerApply(target, undefined, argumentsList, operation);" },
  { id: "r1_bun_argument_forwarding", family: "delegate_owner", violation: "delegate_owner:originalBunFile", anchor: "delegateBunFile(path, [], normalized)" },
  { id: "r1_bun_raw_operation", family: "delegate_order", violation: "delegate_order:delegateBunFile", anchor: "rawOperation(\"bun_write\", normalized);" },
  { id: "r1_extra_node_inversion_delegate", family: "deny_order", violation: "deny_order:guardedPathFunction", anchor: "delegatePathFunction(original, this, args, operation, path);\n            delegateBunSpawn(args);" },
  { id: "r1_extra_ffi_inversion_delegate", family: "deny_order", violation: "deny_order:guardedDlopen", anchor: "const library = delegateFfiDlopen(path, symbols);\n      delegateFfiDlopen(path, symbols);" },
  { id: "r1_unpaired_ffi_inversion_close", family: "deny_order", violation: "deny_order:guardedDlopen", anchor: "const replacementLibrary = library;\n        delegateFfiClose(replacementLibrary, path);" },
  { id: "r1_mismatched_ffi_inversion_close_target", family: "deny_order", violation: "deny_order:guardedDlopen", anchor: "delegateFfiClose(library, \"/other\");" },
  { id: "r1_silent_path_inversion_delegate", family: "deny_order", violation: "deny_order:guardedPathFunction", anchor: "void path;" },
  { id: "r1_foreign_ffi_inversion_delegate", family: "deny_order", violation: "deny_order:guardedDlopen", anchor: "delegateBunSpawn([]);" },
  { id: "r1_silent_ffi_inversion_delegate", family: "deny_order", violation: "deny_order:guardedDlopen", anchor: "const library = { symbols: {}, close: () => undefined } as DynamicLibrary;" },
  { id: "r1_forged_bun_inversion_delegate", family: "delegate_order", violation: "delegate_order:delegateBunFile", anchor: "if (state.rawInversion === \"ffi_dlopen\") delegateBunFile(path, args, normalized);" },
] satisfies readonly AuthorityTopologyProjection[]);

function authorityRegistryProjection(): string {
  return JSON.stringify({
    version: AUTHORITY_PROOF_REGISTRY.version,
    count: AUTHORITY_PROOF_ROWS.length,
    rows: AUTHORITY_PROOF_ROWS.map((row) => [
      row.id,
      row.control,
      row.structuralViolation,
      row.denialEvent.operation,
      row.denialEvent.target,
      row.sideEffects
    ])
  });
}

function expectFrozenAuthorityRegistry(): void {
  expect(AUTHORITY_PROOF_REGISTRY.version).toBe(EXPECTED_AUTHORITY_PROOF_VERSION);
  expect(AUTHORITY_PROOF_ROWS).toHaveLength(EXPECTED_AUTHORITY_PROOF_ROW_COUNT);
  expect(createHash("sha256").update(authorityRegistryProjection(), "utf8").digest("hex"))
    .toBe(EXPECTED_AUTHORITY_PROOF_REGISTRY_SHA256);
  expect(new Set(AUTHORITY_PROOF_ROWS.map((row) => row.id)).size).toBe(AUTHORITY_PROOF_ROWS.length);
  expect(new Set(AUTHORITY_PROOF_ROWS.map((row) => row.control)).size).toBe(AUTHORITY_PROOF_ROWS.length);
}

const EXACT_PRODUCTION_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  "check.ts": ['import { runCheck } from "./lib/checker";'],
  "lib/canonical-json.ts": [],
  "lib/capabilities.ts": [
    'import { dlopen } from "bun:ffi";',
    'import { closeSync, constants, fstatSync, openSync, readSync, type BigIntStats } from "node:fs";'
  ],
  "lib/checker.ts": [
    'import { ERROR_SCHEMA, SOURCE_PROFILE, SUCCESS_SCHEMA } from "./constants";',
    'import {\n  ContractError,\n  readBoundedFile,\n  type DescriptorIngressHooks\n} from "./ingress";',
    'import { admitSourceInput, type SourceInputKind } from "./schemas";'
  ],
  "lib/constants.ts": [],
  "lib/ingress.ts": [
    'import { parse, resolve, sep } from "node:path";',
    'import { hasOnlyUnicodeScalars } from "./canonical-json";',
    'import {\n  ContractCapabilities,\n  DIRECTORY_OPEN_FLAGS,\n  FILE_OPEN_FLAGS,\n  type BigIntStats,\n  type CapabilityDescriptor,\n  type CapabilityHooks,\n  type ContractAuthorityFault\n} from "./capabilities";'
  ],
  "lib/schemas.ts": [
    'import { posix } from "node:path";',
    'import { canonicalJson } from "./canonical-json";',
    'import { SOURCE_PROFILE } from "./constants";',
    'import { ContractError, parseBoundedJson } from "./ingress";'
  ]
};

const EXACT_PRODUCTION_GLOBALS: Readonly<Record<string, Readonly<{
  process: readonly string[];
  Bun: readonly string[];
}>>> = {
  "check.ts": { process: ["stdout", "stderr", "exit"], Bun: ["argv"] },
  "lib/canonical-json.ts": { process: [], Bun: [] },
  "lib/capabilities.ts": { process: ["platform", "platform"], Bun: [] },
  "lib/checker.ts": { process: [], Bun: [] },
  "lib/constants.ts": { process: [], Bun: [] },
  "lib/ingress.ts": { process: ["platform"], Bun: [] },
  "lib/schemas.ts": { process: [], Bun: [] }
};

const EXACT_PRODUCTION_OBJECT_PROPERTIES: Readonly<Record<string, readonly string[]>> = {
  "check.ts": [],
  "lib/canonical-json.ts": ["keys"],
  "lib/capabilities.ts": [
    "freeze", "freeze", "freeze", "freeze", "freeze", "freeze", "freeze",
    "freeze", "freeze", "freeze", "freeze", "freeze", "freeze", "freeze", "create", "freeze"
  ],
  "lib/checker.ts": [],
  "lib/constants.ts": ["freeze"],
  "lib/ingress.ts": ["freeze", "create"],
  "lib/schemas.ts": ["keys"]
};

const EXACT_PRODUCTION_ELEMENT_ACCESSES: Readonly<Record<string, readonly string[]>> = {
  "check.ts": [],
  "lib/canonical-json.ts": ["record[key]"],
  "lib/capabilities.ts": ["CLOSE_OWNERS_BY_STATE[record.state as keyof typeof CLOSE_OWNERS_BY_STATE]"],
  "lib/checker.ts": ["args[index]", "args[++index]"],
  "lib/constants.ts": [],
  "lib/ingress.ts": [
    "components[index]",
    "segments[index]",
    "admission.components[index]",
    "admission.components[index - 1]",
    "this.text[this.cursor]",
    "this.text[this.cursor]",
    "this.text[this.cursor]",
    "this.text[this.cursor]",
    "result[key]",
    "this.text[this.cursor++]",
    "this.text[this.cursor]",
    "this.text[this.cursor++]",
    "this.text[this.cursor]",
    "this.text[this.cursor]",
    "match[0]",
    "match[0]",
    "this.text[this.cursor]"
  ],
  "lib/schemas.ts": [
    "expected[index]",
    "sorted[index]",
    "value.argv[13]",
    "value.argv[index]",
    "value.argv[14]",
    "primaryTuple[index]",
    "witnessTuple[index]",
    "value.platforms[index]",
    "expectedPlatforms[index]",
    "value.platforms[0]",
    "value.platforms[1]",
    "peers[0]"
  ]
};

const EXACT_PRODUCTION_BINDINGS: Readonly<Record<string, readonly string[]>> = {
  "check.ts": [],
  "lib/canonical-json.ts": [],
  "lib/capabilities.ts": [],
  "lib/checker.ts": [],
  "lib/constants.ts": [],
  "lib/ingress.ts": [],
  "lib/schemas.ts": []
};

function quotedModuleSpecifier(node: ts.ImportDeclaration): string {
  return ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "<nonliteral>";
}

function importMetaExpression(node: ts.Expression): boolean {
  return ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === "meta";
}

function structuralAuthorityViolations(relative: string, text: string): string[] {
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const expectedImports = EXACT_PRODUCTION_IMPORTS[relative];
  const expectedGlobals = EXACT_PRODUCTION_GLOBALS[relative];
  const expectedObjectProperties = EXACT_PRODUCTION_OBJECT_PROPERTIES[relative];
  const expectedElementAccesses = EXACT_PRODUCTION_ELEMENT_ACCESSES[relative];
  const expectedBindings = EXACT_PRODUCTION_BINDINGS[relative];
  const violations = new Set<string>();
  const imports = source.statements.filter(ts.isImportDeclaration).map((node) => node.getText(source));
  const globals = { process: [] as string[], Bun: [] as string[] };
  const objectProperties: string[] = [];
  const elementAccesses: string[] = [];
  const bindings: string[] = [];

  if (!expectedImports || !expectedGlobals || !expectedObjectProperties || !expectedElementAccesses || !expectedBindings) {
    violations.add(`unlisted_production_file:${relative}`);
  }
  if (JSON.stringify(imports) !== JSON.stringify(expectedImports ?? [])) {
    violations.add(`import_inventory:${relative}`);
  }
  for (const declaration of source.statements.filter(ts.isImportDeclaration)) {
    if (!(expectedImports ?? []).includes(declaration.getText(source))) {
      violations.add(`unapproved_import:${quotedModuleSpecifier(declaration)}`);
    }
  }

  const forbiddenIdentifiers = new Set([
    "require", "createRequire", "getBuiltinModule", "eval", "Function", "Worker", "global", "Reflect", "module"
  ]);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      violations.add("dynamic_import");
    }
    if (ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node) && node.moduleSpecifier) {
      violations.add("alternate_module_declaration");
    }
    if (ts.isElementAccessExpression(node)) {
      const elementAccess = node.getText(source);
      elementAccesses.push(elementAccess);
      if (importMetaExpression(node.expression)) violations.add("forbidden_import_meta:require");
      if (!(expectedElementAccesses ?? []).includes(elementAccess)) violations.add("unapproved_element_access");
    }
    if (ts.isBindingElement(node)) {
      const binding = node.getText(source);
      bindings.push(binding);
      if (!(expectedBindings ?? []).includes(binding)) violations.add("unapproved_binding");
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "constructor") {
      violations.add("forbidden_constructor");
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) &&
        node.argumentExpression.text === "constructor") {
      violations.add("forbidden_computed_constructor");
    }
    if (ts.isPropertyAccessExpression(node) && importMetaExpression(node.expression) && node.name.text === "require") {
      violations.add("forbidden_import_meta:require");
    }
    if (ts.isIdentifier(node) && (node.text === "process" || node.text === "Bun")) {
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        const globalName = node.text;
        const property = parent.name.text;
        globals[globalName].push(property);
        if (!(expectedGlobals?.[globalName] ?? []).includes(property)) {
          violations.add(`unapproved_global:${globalName}.${property}`);
        }
      } else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
        violations.add(`computed_global:${node.text}`);
      } else {
        violations.add(`bare_global:${node.text}`);
      }
    } else if (ts.isIdentifier(node) && node.text === "Object") {
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        const property = parent.name.text;
        objectProperties.push(property);
        if (!(expectedObjectProperties ?? []).includes(property)) {
          violations.add(`unapproved_object:Object.${property}`);
        }
      } else {
        violations.add("bare_global:Object");
      }
    } else if (ts.isIdentifier(node) && node.text === "globalThis") {
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        violations.add(`unapproved_global:globalThis.${parent.name.text}`);
      } else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
        violations.add("computed_global:globalThis");
      } else {
        violations.add("forbidden_identifier:globalThis");
      }
    } else if (ts.isIdentifier(node) && forbiddenIdentifiers.has(node.text)) {
      violations.add(`forbidden_identifier:${node.text}`);
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  for (const globalName of ["process", "Bun"] as const) {
    if (JSON.stringify(globals[globalName]) !== JSON.stringify(expectedGlobals?.[globalName] ?? [])) {
      violations.add(`${globalName}_properties:${JSON.stringify(globals[globalName])}`);
    }
  }
  if (JSON.stringify(objectProperties) !== JSON.stringify(expectedObjectProperties ?? [])) {
    violations.add(`Object_properties:${JSON.stringify(objectProperties)}`);
  }
  if (JSON.stringify(elementAccesses) !== JSON.stringify(expectedElementAccesses ?? [])) {
    violations.add(`element_accesses:${JSON.stringify(elementAccesses)}`);
  }
  if (JSON.stringify(bindings) !== JSON.stringify(expectedBindings ?? [])) {
    violations.add(`bindings:${JSON.stringify(bindings)}`);
  }
  return [...violations].sort();
}


function injectProductionMutation(source: string, row: AuthorityProofRow): string {
  const firstLineEnd = source.indexOf("\n");
  if (firstLineEnd < 0) throw new Error("CHECK_ENTRYPOINT_MISSING_SHEBANG_LINE");
  return `${source.slice(0, firstLineEnd + 1)}\n// ${row.id}\n${row.mutation}\n${source.slice(firstLineEnd + 1)}`;
}

async function compileProductionMutation(row: AuthorityProofRow, source: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "shud-authority-structural-"));
  try {
    const entrypoint = join(root, "check.ts");
    await symlink(productionLibPath, join(root, "lib"), "dir");
    await writeFile(entrypoint, source);
    const result = await Bun.build({
      entrypoints: [entrypoint],
      target: "bun",
      format: "esm",
      sourcemap: "none"
    });
    if (!result.success) {
      throw new Error(`${row.id} did not compile: ${result.logs.map((log) => log.message).join("\n")}`);
    }
    expect(result.outputs.length).toBeGreaterThan(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function compilePreloadMutation(id: string, source: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "shud-authority-preload-"));
  try {
    const tests = join(root, "tests");
    await mkdir(tests);
    const entrypoint = join(tests, "authority-preload.ts");
    await symlink(productionLibPath, join(root, "lib"), "dir");
    await writeFile(entrypoint, source);
    const result = await Bun.build({
      entrypoints: [entrypoint],
      target: "bun",
      format: "esm",
      sourcemap: "none"
    });
    if (!result.success) {
      throw new Error(`${id} did not compile: ${result.logs.map((log) => log.message).join("\n")}`);
    }
    expect(result.outputs.length).toBeGreaterThan(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function expectFrozenAuthorityInputs(): Promise<void> {
  const expected: Readonly<Record<string, string>> = {
    [authorityControlPath]: "1837b6d1fb587b1442a39cf7d38fa581e0de13810f5864c5442267af666a592d",
    [authorityWorkerPath]: "028bbfefad7f62066bc7ef931470c81e732e1246c800dee7fbf6a278da364dd3",
    [authorityVocabularyPath]: "0a315ae46fe234046bbb95dc8b65f89a619f0f309fbc7543008637cddec411fc"
  };
  for (const [path, digest] of Object.entries(expected)) {
    expect(createHash("sha256").update(await readFile(path), "utf8").digest("hex")).toBe(digest);
  }
}

async function productionSources(): Promise<Readonly<Record<string, string>>> {
  const libraryFiles = (await readdir(productionLibPath))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => `lib/${name}`)
    .sort();
  const files = ["check.ts", ...libraryFiles].sort();
  expect(files).toEqual(Object.keys(EXACT_PRODUCTION_IMPORTS).sort());
  const entries = await Promise.all(files.map(async (relative) => [
    relative,
    await readFile(join(contractsRoot, relative), "utf8")
  ] as const));
  return Object.fromEntries(entries);
}
function expectFrozenTopologyProjection(
  mutations: readonly Readonly<{ id: string; family: string; violation: string; source: string }>[],
  expected: readonly AuthorityTopologyProjection[],
  expectedDigests: Readonly<Record<string, string>>,
  requireCompleteDigestOracle = false
): void {
  expect(mutations).toHaveLength(expected.length);
  expect(mutations.map(({ id, family, violation }) => ({ id, family, violation }))).toEqual(
    expected.map(({ id, family, violation }) => ({ id, family, violation }))
  );
  if (requireCompleteDigestOracle) {
    expect(Object.keys(expectedDigests).sort()).toEqual(mutations.map((mutation) => mutation.id).sort());
  }
  expect(new Set(mutations.map((mutation) => mutation.id)).size).toBe(mutations.length);
  expect(new Set(mutations.map((mutation) => createHash("sha256").update(mutation.source).digest("hex"))).size)
    .toBe(mutations.length);
  for (const [index, projection] of expected.entries()) {
    const mutation = mutations[index]!;
    expect(mutation.source).toContain(projection.anchor);
    expect(createHash("sha256").update(mutation.source).digest("hex")).toBe(expectedDigests[mutation.id]);
  }
}


describe("source-ingress authority structural proof", () => {
  test("binds the exact independent authority registry contract", () => {
    expectFrozenAuthorityRegistry();
  });

  test("pins the exact production TypeScript inventory, imports, and ambient globals", async () => {
    expect(Bun.version).toBe("1.2.19");
    const sources = await productionSources();
    for (const [relative, source] of Object.entries(sources)) {
      expect(structuralAuthorityViolations(relative, source)).toEqual([]);
    }
  });

  test("pins the restored frozen authority sources and canonical binding-aware topology", async () => {
    await expectFrozenAuthorityInputs();
    const preloadSource = await readFile(authorityPreloadPath, "utf8");
    expect(authorityPreloadTopologyViolations(preloadSource)).toEqual([]);
  });

  test("compiles and rejects every copied binding-aware mutation without loading the active preload", async () => {
    const preloadSource = await readFile(authorityPreloadPath, "utf8");
    const mutations = authorityTopologyMutationRows(preloadSource);
    const familyCounts: Record<string, number> = {};
    for (const mutation of mutations) {
      familyCounts[mutation.family] = (familyCounts[mutation.family] ?? 0) + 1;
    }
    expectFrozenTopologyProjection(
      mutations,
      EXPECTED_BASE_TOPOLOGY_PROJECTION,
      EXPECTED_BASE_TOPOLOGY_MUTATION_SHA256,
      true
    );
    expect(familyCounts).toEqual({
      alias: 2,
      binding_shadow: 14,
      bun_owner: 4,
      constructor_alias: 1,
      delegate_order: 11,
      delegate_owner: 7,
      deny_arguments: 2,
      deny_order: 11,
      equivalent_call: 1
    });

    for (const mutation of mutations) {
      await compilePreloadMutation(mutation.id, mutation.source);
      expect(authorityPreloadTopologyViolations(mutation.source)).toEqual([mutation.violation]);
    }
    expect(authorityPreloadTopologyViolations(preloadSource)).toEqual([]);
  });
  test("freezes and rejects every Round 1 authority topology mutation before source-only compile proof", async () => {
    const preloadSource = await readFile(authorityPreloadPath, "utf8");
    const mutations = authorityRoundOneMutationRows(preloadSource);
    expectFrozenTopologyProjection(
      mutations,
      EXPECTED_ROUND_ONE_TOPOLOGY_PROJECTION,
      EXPECTED_ROUND_ONE_TOPOLOGY_MUTATION_SHA256,
      true
    );
    for (const mutation of mutations) {
      await compilePreloadMutation(mutation.id, mutation.source);
      expect(authorityPreloadTopologyViolations(mutation.source)).toEqual([mutation.violation]);
    }
  });


  test("pins the independent authority-control worker lifecycle topology", async () => {
    const controlSource = await readFile(authorityControlPath, "utf8");
    expect(authorityControlLifecycleTopologyViolations(controlSource)).toEqual([]);
  });

  test("rejects immediate global worker close completion without invoking runtime proof", async () => {
    const controlSource = await readFile(authorityControlPath, "utf8");
    expect(authorityControlLifecycleTopologyViolations(globalCloseResolveBypassSource(controlSource)))
      .toContain("global_close_resolve_outside_close_callback");
  });

  test("compiles every hostile mutation in the real check entrypoint before its independent AST rejection", async () => {
    expectFrozenAuthorityRegistry();

    const checkSource = await readFile(productionCheckPath, "utf8");
    for (const row of AUTHORITY_PROOF_ROWS) {
      const mutatedSource = injectProductionMutation(checkSource, row);
      await compileProductionMutation(row, mutatedSource);
      expect(structuralAuthorityViolations("check.ts", mutatedSource)).toContain(row.structuralViolation);
    }
  });

  test("rejects every non-canonical ambient callable acquisition", async () => {
    const preloadSource = await readFile(authorityPreloadPath, "utf8");
    const insertBeforeNormalized = (
      source: string,
      prefix: string
    ): string => source.replace(
      "function guardedBunWrite(path: unknown, ...args: unknown[]): unknown {\n  const normalized",
      `function guardedBunWrite(path: unknown, ...args: unknown[]): unknown {
  ${prefix}
  const normalized`
    );
    const mutations = [
      {
        id: "r2_early_builtin_capture",
        source: insertBeforeNormalized(
          preloadSource,
          'const rawFs = process.getBuiltinModule("node:fs") as { readFileSync: (value: unknown) => unknown };\n  rawFs.readFileSync(path);'
        ),
        violation: "delegate_owner:node_fs"
      },
      {
        id: "r2_static_import_capture",
        source: insertBeforeNormalized(
          `import { readFileSync as prepatchRead } from "node:fs";\n${preloadSource}`,
          'prepatchRead("/etc/hosts");'
        ),
        violation: "delegate_owner:node_fs"
      },
      {
        id: "r2_require_capture",
        source: insertBeforeNormalized(
          preloadSource,
          'const prepatchFs = import.meta.require("node:fs") as { readFileSync: (path: string) => unknown };\n  prepatchFs.readFileSync("/etc/hosts");'
        ),
        violation: "delegate_owner:node_fs"
      },
      {
        id: "r2_global_capture",
        source: insertBeforeNormalized(preloadSource, "const prepatchWorker = globalThis.Worker;\n  void prepatchWorker;"),
        violation: "delegate_owner:worker_construct"
      },
      {
        id: "r2_descriptor_capture",
        source: insertBeforeNormalized(
          preloadSource,
          'const prepatchWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");\n  void prepatchWorker;'
        ),
        violation: "delegate_owner:worker_construct"
      },
      {
        id: "r2_bun_destructure_capture",
        source: insertBeforeNormalized(
          preloadSource,
          "const { spawnSync: prepatchSpawnSync } = Bun;\n  prepatchSpawnSync([]);"
        ),
        violation: "delegate_owner:originalBunSpawnSync"
      },
      {
        id: "r2_reflect_capture",
        source: insertBeforeNormalized(
          preloadSource,
          'const prepatchWorker = Reflect.get(globalThis, "Worker");\n  void prepatchWorker;'
        ),
        violation: "delegate_owner:worker_construct"
      },
      {
        id: "r2_fs_destructure_capture",
        source: preloadSource.replace(
          'patchPathFunctions(guardedFsPromises, "node_fs_promises");',
          'const { readFileSync: prepatchRead } = guardedFs as { readFileSync: (path: string) => unknown };\nvoid prepatchRead("/etc/hosts");\npatchPathFunctions(guardedFsPromises, "node_fs_promises");'
        ),
        violation: "delegate_owner:node_fs"
      },
      {
        id: "r2_child_destructure_capture",
        source: preloadSource.replace(
          'for (const name of ["exec",',
          'const { exec: prepatchExec } = guardedChildProcess as { exec: (command: string) => unknown };\nvoid prepatchExec("echo unsafe");\nfor (const name of ["exec",'
        ),
        violation: "delegate_owner:child_process"
      },
      {
        id: "r2_ffi_destructure_capture",
        source: preloadSource.replace(
          "const ffiDescriptor =",
          'const { dlopen: prepatchDlopen } = guardedFfi as { dlopen: (path: string, symbols: Record<string, unknown>) => unknown };\nvoid prepatchDlopen("/fixture", {});\nconst ffiDescriptor ='
        ),
        violation: "delegate_owner:ffi_dlopen"
      },
      {
        id: "r2_fs_alias_destructure_capture",
        source: preloadSource.replace(
          'patchPathFunctions(guardedFsPromises, "node_fs_promises");',
          'const prepatchFsAlias = guardedFs;\nconst { readFileSync: prepatchRead } = prepatchFsAlias as { readFileSync: (path: string) => unknown };\nvoid prepatchRead("/etc/hosts");\npatchPathFunctions(guardedFsPromises, "node_fs_promises");'
        ),
        violation: "delegate_owner:node_fs"
      },
      {
        id: "r2_fs_member_alias_capture",
        source: preloadSource.replace(
          'patchPathFunctions(guardedFsPromises, "node_fs_promises");',
          'const prepatchFsAlias = guardedFs;\nvoid (prepatchFsAlias as { readFileSync: (path: string) => unknown }).readFileSync("/etc/hosts");\npatchPathFunctions(guardedFsPromises, "node_fs_promises");'
        ),
        violation: "delegate_owner:node_fs"
      },
      {
        id: "r2_ffi_descriptor_alias_capture",
        source: preloadSource.replace(
          "const originalDlopen = ffiDescriptor.value as (path: string, symbols: Record<string, unknown>) => DynamicLibrary;",
          'const prepatchDescriptor = ffiDescriptor;\nconst prepatchDlopen = prepatchDescriptor.value as (path: string, symbols: Record<string, unknown>) => DynamicLibrary;\nvoid prepatchDlopen("/fixture", {});\nconst originalDlopen = ffiDescriptor.value as (path: string, symbols: Record<string, unknown>) => DynamicLibrary;'
        ),
        violation: "delegate_owner:ffi_dlopen"
      },
    ] as const;
    for (const mutation of mutations) {
      await compilePreloadMutation(mutation.id, mutation.source);
      expect(authorityPreloadTopologyViolations(mutation.source)).toEqual([mutation.violation]);
    }
  });

  test("rejects completion escapes around an otherwise present denial", async () => {
    const preloadSource = await readFile(authorityPreloadPath, "utf8");
    const mutated = preloadSource.replace(
      `function guardedBunSpawnSync(...args: unknown[]): unknown {
  if (isPublicPostAdmission()) deny("bun_spawn_sync");
  return delegateBunSpawnSync(args);
}`,
      `function guardedBunSpawnSync(...args: unknown[]): unknown {
  try {
    if (isPublicPostAdmission()) deny("bun_spawn_sync");
  } finally {
    return delegateBunSpawnSync(args);
  }
}`
    );
    await compilePreloadMutation("r2_finally_return", mutated);
    expect(authorityPreloadTopologyViolations(mutated)).toEqual(["deny_order:guardedBunSpawnSync"]);
    const catchSwallow = preloadSource.replace(
      `function guardedBunSpawnSync(...args: unknown[]): unknown {
  if (isPublicPostAdmission()) deny("bun_spawn_sync");
  return delegateBunSpawnSync(args);
}`,
      `function guardedBunSpawnSync(...args: unknown[]): unknown {
  try {
    if (isPublicPostAdmission()) deny("bun_spawn_sync");
  } catch {}
  return delegateBunSpawnSync(args);
}`
    );
    const deferred = preloadSource.replace(
      `function guardedBunSpawnSync(...args: unknown[]): unknown {
  if (isPublicPostAdmission()) deny("bun_spawn_sync");
  return delegateBunSpawnSync(args);
}`,
      `function guardedBunSpawnSync(...args: unknown[]): unknown {
  if (isPublicPostAdmission()) queueMicrotask(() => deny("bun_spawn_sync"));
  return delegateBunSpawnSync(args);
}`
    );
    await compilePreloadMutation("r2_catch_swallow", catchSwallow);
    expect(authorityPreloadTopologyViolations(catchSwallow)).toEqual(["deny_order:guardedBunSpawnSync"]);
    await compilePreloadMutation("r2_deferred_deny", deferred);
    expect(authorityPreloadTopologyViolations(deferred)).toEqual(["deny_order:guardedBunSpawnSync"]);
  });

  test("rejects raw Worker and FFI facade target escapes", async () => {
    const preloadSource = await readFile(authorityPreloadPath, "utf8");
    const workerMutation = preloadSource.replace(
      `if (property === "prototype") return guardedPrototype;
      return Reflect.get(target, property, receiver);`,
      `if (property === "prototype") return guardedPrototype;
      if (property === "rawTarget") return target;
      return Reflect.get(target, property, receiver);`
    );
    const workerOwnKeysMutation = preloadSource.replace(
      `    construct(target, argumentsList, newTarget) {
      if (isPublicPostAdmission()) deny(operation);
      return delegateWorkerConstruct(target, argumentsList, newTarget, operation);
    }
  });`,
      `    construct(target, argumentsList, newTarget) {
      if (isPublicPostAdmission()) deny(operation);
      return delegateWorkerConstruct(target, argumentsList, newTarget, operation);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target);
    }
  });`
    );
    const ffiMutation = preloadSource.replace(
      "return Object.freeze({\n    symbols: Object.freeze(guardedSymbols),",
      `const rawSymbolsDescriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(library), "symbols");
  if (rawSymbolsDescriptor && typeof rawSymbolsDescriptor.get === "function") {
    guardedSymbols.raw = rawSymbolsDescriptor.get.call(library) as (...args: unknown[]) => unknown;
  }
  return Object.freeze({
    symbols: Object.freeze(guardedSymbols),`
    );
    await compilePreloadMutation("r2_worker_target_escape", workerMutation);
    expect(authorityPreloadTopologyViolations(workerMutation)).toEqual(["delegate_owner:worker_construct"]);
    await compilePreloadMutation("r2_worker_own_keys_escape", workerOwnKeysMutation);
    expect(authorityPreloadTopologyViolations(workerOwnKeysMutation)).toEqual(["delegate_owner:worker_construct"]);
    await compilePreloadMutation("r2_ffi_descriptor_escape", ffiMutation);
    expect(authorityPreloadTopologyViolations(ffiMutation)).toEqual(["delegate_owner:ffi_symbol"]);
  });

  test("models var hoisting and recursive assignment writes", async () => {
    const preloadSource = await readFile(authorityPreloadPath, "utf8");
    const varMutation = preloadSource.replace(
      "value: function guardedPathFunction(this: unknown, ...args: unknown[]) {\n        const descriptorOperation = RAW_DESCRIPTOR_OPERATIONS[name] === true;\n        const path",
      `value: function guardedPathFunction(this: unknown, ...args: unknown[]) {
        const descriptorOperation = RAW_DESCRIPTOR_OPERATIONS[name] === true;
        {
          var original = (() => undefined) as unknown as (...arguments_: unknown[]) => unknown;
        }
        const path`
    );
    const destructuringMutation = preloadSource.replace(
      "function guardedDlopen(path: string, symbols: Record<string, unknown>): DynamicLibrary {\n  if",
      `function guardedDlopen(path: string, symbols: Record<string, unknown>): DynamicLibrary {
  ({ path } = { path: "/other" });
  if`
    );
    const compoundMutation = preloadSource.replace(
      "function guardedDlopen(path: string, symbols: Record<string, unknown>): DynamicLibrary {\n  if",
      `function guardedDlopen(path: string, symbols: Record<string, unknown>): DynamicLibrary {
  path += "/other";
  if`
    );
    const loopMutation = preloadSource.replace(
      "function guardedDlopen(path: string, symbols: Record<string, unknown>): DynamicLibrary {\n  if",
      `function guardedDlopen(path: string, symbols: Record<string, unknown>): DynamicLibrary {
  for ({ path } of [{ path: "/other" }]) {}
  if`
    );
    const nestedDestructuringMutation = preloadSource.replace(
      "function guardedDlopen(path: string, symbols: Record<string, unknown>): DynamicLibrary {\n  if",
      `function guardedDlopen(path: string, symbols: Record<string, unknown>): DynamicLibrary {
  ({ nested: { path } } = { nested: { path: "/other" } });
  if`
    );
    await compilePreloadMutation("r2_var_shadow", varMutation);
    expect(authorityPreloadTopologyViolations(varMutation)).toEqual(["delegate_owner:node_fs"]);
    await compilePreloadMutation("r2_destructured_path_write", destructuringMutation);
    expect(authorityPreloadTopologyViolations(destructuringMutation)).toEqual(["deny_arguments:guardedDlopen"]);
    await compilePreloadMutation("r2_compound_path_write", compoundMutation);
    expect(authorityPreloadTopologyViolations(compoundMutation)).toEqual(["deny_arguments:guardedDlopen"]);
    await compilePreloadMutation("r2_loop_destructured_path_write", loopMutation);
    expect(authorityPreloadTopologyViolations(loopMutation)).toEqual(["deny_arguments:guardedDlopen"]);
    await compilePreloadMutation("r2_nested_destructured_path_write", nestedDestructuringMutation);
    expect(authorityPreloadTopologyViolations(nestedDestructuringMutation)).toEqual(["deny_arguments:guardedDlopen"]);
  });

  test("freezes the exact raw inversion predicates", async () => {
    const preloadSource = await readFile(authorityPreloadPath, "utf8");
    const pathMutation = preloadSource.replace(
      "if (path !== undefined && args.length === 1)",
      "if (true)"
    );
    const ffiMutation = preloadSource.replace(
      'if (state.rawInversion === "ffi_dlopen")',
      "if (true)"
    );
    await compilePreloadMutation("r2_path_inversion_true", pathMutation);
    expect(authorityPreloadTopologyViolations(pathMutation)).toEqual(["deny_order:guardedPathFunction"]);
    await compilePreloadMutation("r2_ffi_inversion_true", ffiMutation);
    expect(authorityPreloadTopologyViolations(ffiMutation)).toEqual(["deny_order:guardedDlopen"]);
  });

  test("freezes the one-way phase setter and startup-bound inversion privilege", async () => {
    const preloadSource = await readFile(authorityPreloadPath, "utf8");
    const phaseMutation = preloadSource.replace(
      `set: (value: unknown): void => {
      if (value === "post_admission") state.phase = "post_admission";
    }`,
      `set: (value: unknown): void => {
      if (value === "admission") state.phase = "admission";
      if (value === "post_admission") state.phase = "post_admission";
    }`
    );
    const inversionMutation = preloadSource.replace(
      `      } else if (value === null && state.rawInversion === selectedRawInversion) {`,
      `      } else if (value === "ffi_dlopen") {
        state.rawInversion = "ffi_dlopen";
      } else if (value === null && state.rawInversion === selectedRawInversion) {`
    );
    await compilePreloadMutation("r2_phase_reopen_setter", phaseMutation);
    expect(authorityPreloadTopologyViolations(phaseMutation)).toEqual(["deny_order:guardedPathFunction"]);
    await compilePreloadMutation("r2_raw_inversion_extra_privilege", inversionMutation);
    expect(authorityPreloadTopologyViolations(inversionMutation)).toEqual(["deny_order:guardedPathFunction"]);
  });

  test("rejects distinct-comment compound rows before topology comparison", async () => {
    const preloadSource = await readFile(authorityPreloadPath, "utf8");
    const rows = authorityRoundOneMutationRows(preloadSource);
    const compound = `${preloadSource}
originalBunFile.call(Bun, "fixture");
originalBunFile["apply"](Bun, ["fixture"]);
Reflect["apply"](originalBunFile, Bun, ["fixture"]);
originalBunFile.bind(Bun)("fixture");
`;
    const expected = EXPECTED_ROUND_ONE_TOPOLOGY_PROJECTION.filter((projection) =>
      ["r1_call", "r1_computed_apply", "r1_reflect_computed_apply", "r1_bind"].includes(projection.id)
    );
    const collapsed = rows.filter((row) => expected.some((projection) => projection.id === row.id))
      .map((row, index) => ({ ...row, source: `${compound}// distinct-${index}\n` }));
    expect(() => expectFrozenTopologyProjection(
      collapsed,
      expected,
      EXPECTED_ROUND_ONE_TOPOLOGY_MUTATION_SHA256
    )).toThrow();
  });

  test("rejects a shared compound source before topology comparison", async () => {
    const preloadSource = await readFile(authorityPreloadPath, "utf8");
    const rows = authorityRoundOneMutationRows(preloadSource);
    const compound = `${preloadSource}
originalBunFile.call(Bun, "fixture");
originalBunFile["apply"](Bun, ["fixture"]);
Reflect["apply"](originalBunFile, Bun, ["fixture"]);
originalBunFile.bind(Bun)("fixture");
`;
    const expected = EXPECTED_ROUND_ONE_TOPOLOGY_PROJECTION.filter((projection) =>
      ["r1_call", "r1_computed_apply", "r1_reflect_computed_apply", "r1_bind"].includes(projection.id)
    );
    const collapsed = rows.filter((row) => expected.some((projection) => projection.id === row.id))
      .map((row) => ({ ...row, source: compound }));
    expect(() => expectFrozenTopologyProjection(
      collapsed,
      expected,
      EXPECTED_ROUND_ONE_TOPOLOGY_MUTATION_SHA256
    )).toThrow();
  });
});
