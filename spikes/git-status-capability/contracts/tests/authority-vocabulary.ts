export const AUTHORITY_PROOF_VERSION = "shud.contract.authority-proof.v1" as const;

export type AuthorityControl =
  | "worker_global_direct"
  | "worker_global_cached"
  | "worker_node_static_import"
  | "worker_node_dynamic_import"
  | "worker_node_get_builtin"
  | "worker_node_create_require"
  | "worker_node_cached_module"
  | "dynamic_eval"
  | "dynamic_function"
  | "dynamic_object_double_constructor"
  | "dynamic_function_constructor"
  | "dynamic_arrow_constructor"
  | "dynamic_async_constructor"
  | "dynamic_generator_constructor"
  | "dynamic_async_generator_constructor"
  | "dynamic_computed_constructor"
  | "dynamic_cached_constructor"
  | "dynamic_async_prototype_constructor"
  | "dynamic_generator_prototype_constructor"
  | "dynamic_async_generator_prototype_constructor"
  | "static_node_fs_read"
  | "node_absolute_open"
  | "node_url_open"
  | "node_buffer_open"
  | "fs_alias_url_open"
  | "ffi_absolute_open"
  | "node_replacement_read"
  | "node_promises_read"
  | "fs_promises_read"
  | "node_promises_property_read"
  | "fs_promises_property_read"
  | "cached_fs_promises_read"
  | "bun_replacement_read"
  | "bun_url_read"
  | "node_write"
  | "bun_write"
  | "node_spawn"
  | "bun_spawn"
  | "builtin_computed_read_absolute"
  | "builtin_computed_stat_relative"
  | "meta_computed_stream_url"
  | "meta_computed_open_buffer"
  | "create_require_computed_write_relative"
  | "create_require_promises_read_url"
  | "meta_computed_ffi_dlopen"
  | "builtin_computed_child_exec_file";

export type AuthorityStructuralViolation = string;
export type AuthorityDenialTarget = "input" | "replacement" | "write_sentinel" | "library" | "none";

export type AuthorityDenialEvent = Readonly<{
  operation: string;
  target: AuthorityDenialTarget;
}>;

export type AuthoritySideEffectOracle = Readonly<{
  workerEntrySentinel: boolean;
  writeSentinel: boolean;
  spawnSentinel: boolean;
  inputUnchanged: boolean;
  replacementUnchanged: boolean;
}>;

export type AuthorityProofRow = Readonly<{
  id: string;
  mutation: string;
  control: AuthorityControl;
  structuralViolation: AuthorityStructuralViolation;
  denialEvent: AuthorityDenialEvent;
  sideEffects: AuthoritySideEffectOracle;
}>;

export const AUTHORITY_WORKER_ENTRY = "shud.contract.authority-worker-entry.v1" as const;

const NO_SIDE_EFFECTS: AuthoritySideEffectOracle = Object.freeze({
  workerEntrySentinel: false,
  writeSentinel: false,
  spawnSentinel: false,
  inputUnchanged: true,
  replacementUnchanged: true
});

function row(
  id: string,
  control: AuthorityControl,
  mutation: string,
  structuralViolation: AuthorityStructuralViolation,
  operation: string,
  target: AuthorityDenialTarget
): AuthorityProofRow {
  return Object.freeze({
    id,
    mutation,
    control,
    structuralViolation,
    denialEvent: Object.freeze({ operation, target }),
    sideEffects: NO_SIDE_EFFECTS
  });
}

export const AUTHORITY_PROOF_REGISTRY = Object.freeze({
  version: AUTHORITY_PROOF_VERSION,
  rows: Object.freeze([
    row(
      "AUTH-WORKER-GLOBAL-DIRECT",
      "worker_global_direct",
      'void new Worker(new URL("data:text/javascript,export%20{}"));',
      "forbidden_identifier:Worker",
      "global_worker",
      "none"
    ),
    row(
      "AUTH-WORKER-GLOBAL-CACHED",
      "worker_global_cached",
      "const authorityCachedGlobalWorker = globalThis.Worker; void authorityCachedGlobalWorker;",
      "unapproved_global:globalThis.Worker",
      "global_worker",
      "none"
    ),
    row(
      "AUTH-WORKER-NODE-STATIC-IMPORT",
      "worker_node_static_import",
      'import { Worker as AuthorityStaticNodeWorker } from "node:worker_threads"; void AuthorityStaticNodeWorker;',
      "unapproved_import:node:worker_threads",
      "node_worker",
      "none"
    ),
    row(
      "AUTH-WORKER-NODE-DYNAMIC-IMPORT",
      "worker_node_dynamic_import",
      'void import("node:worker_threads");',
      "dynamic_import",
      "node_worker",
      "none"
    ),
    row(
      "AUTH-WORKER-NODE-GET-BUILTIN",
      "worker_node_get_builtin",
      'const authorityBuiltinWorkerModule = process.getBuiltinModule("node:worker_threads"); void authorityBuiltinWorkerModule.Worker;',
      "unapproved_global:process.getBuiltinModule",
      "node_worker",
      "none"
    ),
    row(
      "AUTH-WORKER-NODE-CREATE-REQUIRE",
      "worker_node_create_require",
      'import { createRequire as authorityCreateRequire } from "node:module"; const authorityWorkerRequire = authorityCreateRequire(import.meta.url); void authorityWorkerRequire("node:worker_threads").Worker;',
      "unapproved_import:node:module",
      "node_worker",
      "none"
    ),
    row(
      "AUTH-WORKER-NODE-CACHED-MODULE",
      "worker_node_cached_module",
      'const authorityCachedWorkerModule = process.getBuiltinModule("node:worker_threads"); const authorityCachedNodeWorker = authorityCachedWorkerModule.Worker; void authorityCachedNodeWorker;',
      "unapproved_global:process.getBuiltinModule",
      "node_worker",
      "none"
    ),
    row(
      "AUTH-DYNAMIC-EVAL",
      "dynamic_eval",
      'void eval("new Worker(new URL(\\\"data:text/javascript,export%20{}\\\"))");',
      "forbidden_identifier:eval",
      "global_worker",
      "none"
    ),
    row(
      "AUTH-DYNAMIC-FUNCTION",
      "dynamic_function",
      'void Function("return new Worker(new URL(\\\"data:text/javascript,export%20{}\\\"))")();',
      "forbidden_identifier:Function",
      "global_worker",
      "none"
    ),
    row(
      "AUTH-DYNAMIC-OBJECT-DOUBLE-CONSTRUCTOR",
      "dynamic_object_double_constructor",
      'void ({}).constructor.constructor("return 1")();',
      "forbidden_constructor",
      "global_worker",
      "none"
    ),
    row(
      "AUTH-DYNAMIC-FUNCTION-CONSTRUCTOR",
      "dynamic_function_constructor",
      'void (function authorityFunction() {}).constructor("return 1")();',
      "forbidden_constructor",
      "global_worker",
      "none"
    ),
    row(
      "AUTH-DYNAMIC-ARROW-CONSTRUCTOR",
      "dynamic_arrow_constructor",
      'void (() => {}).constructor("return 1")();',
      "forbidden_constructor",
      "global_worker",
      "none"
    ),
    row(
      "AUTH-DYNAMIC-ASYNC-CONSTRUCTOR",
      "dynamic_async_constructor",
      'void (async function authorityAsync() {}).constructor("return 1")();',
      "forbidden_constructor",
      "global_worker",
      "none"
    ),
    row(
      "AUTH-DYNAMIC-GENERATOR-CONSTRUCTOR",
      "dynamic_generator_constructor",
      'void (function* authorityGenerator() {}).constructor("yield 1")();',
      "forbidden_constructor",
      "global_worker",
      "none"
    ),
    row(
      "AUTH-DYNAMIC-ASYNC-GENERATOR-CONSTRUCTOR",
      "dynamic_async_generator_constructor",
      'void (async function* authorityAsyncGenerator() {}).constructor("yield 1")();',
      "forbidden_constructor",
      "global_worker",
      "none"
    ),
    row(
      "AUTH-DYNAMIC-COMPUTED-CONSTRUCTOR",
      "dynamic_computed_constructor",
      'void (function authorityComputed() {})["constructor"]("return 1")();',
      "forbidden_computed_constructor",
      "global_worker",
      "none"
    ),
    row(
      "AUTH-DYNAMIC-CACHED-CONSTRUCTOR",
      "dynamic_cached_constructor",
      'const authorityCachedConstructor = (function authorityCached() {}).constructor; void authorityCachedConstructor("return 1")();',
      "forbidden_constructor",
      "global_worker",
      "none"
    ),
    row(
      "AUTH-DYNAMIC-ASYNC-PROTOTYPE-CONSTRUCTOR",
      "dynamic_async_prototype_constructor",
      'void Object.getPrototypeOf(async function authorityAsyncPrototype() {}).constructor("return 1")();',
      "forbidden_constructor",
      "global_worker",
      "none"
    ),
    row(
      "AUTH-DYNAMIC-GENERATOR-PROTOTYPE-CONSTRUCTOR",
      "dynamic_generator_prototype_constructor",
      'void Object.getPrototypeOf(function* authorityGeneratorPrototype() {}).constructor("yield 1")();',
      "forbidden_constructor",
      "global_worker",
      "none"
    ),
    row(
      "AUTH-DYNAMIC-ASYNC-GENERATOR-PROTOTYPE-CONSTRUCTOR",
      "dynamic_async_generator_prototype_constructor",
      'void Object.getPrototypeOf(async function* authorityAsyncGeneratorPrototype() {}).constructor("yield 1")();',
      "forbidden_constructor",
      "global_worker",
      "none"
    ),
    row(
      "AUTH-LOADER-STATIC-NODE-FS-READ",
      "static_node_fs_read",
      'import { readFileSync as authorityStaticReadFileSync } from "node:fs"; void authorityStaticReadFileSync("/tmp/authority");',
      "unapproved_import:node:fs",
      "node_fs_readFileSync",
      "replacement"
    ),
    row(
      "AUTH-NODE-ABSOLUTE-OPEN",
      "node_absolute_open",
      'void import("node:fs").then(({ openSync }) => openSync("/tmp/authority"));',
      "dynamic_import",
      "node_fs_openSync",
      "input"
    ),
    row(
      "AUTH-NODE-URL-OPEN",
      "node_url_open",
      'void import("node:fs").then(({ openSync }) => openSync(new URL("file:///tmp/authority")));',
      "dynamic_import",
      "node_fs_openSync",
      "input"
    ),
    row(
      "AUTH-NODE-BUFFER-OPEN",
      "node_buffer_open",
      'void import("node:fs").then(({ openSync }) => openSync(Buffer.from("/tmp/authority")));',
      "dynamic_import",
      "node_fs_openSync",
      "input"
    ),
    row(
      "AUTH-FS-ALIAS-URL-OPEN",
      "fs_alias_url_open",
      'void import("fs").then(({ openSync }) => openSync(new URL("file:///tmp/authority")));',
      "dynamic_import",
      "node_fs_openSync",
      "input"
    ),
    row(
      "AUTH-FFI-ABSOLUTE-OPEN",
      "ffi_absolute_open",
      'import { dlopen as authorityDlopen } from "bun:ffi"; void authorityDlopen;',
      "unapproved_import:bun:ffi",
      "ffi_dlopen",
      "library"
    ),
    row(
      "AUTH-NODE-REPLACEMENT-READ",
      "node_replacement_read",
      'void import("node:fs").then(({ readFileSync }) => readFileSync("/tmp/authority"));',
      "dynamic_import",
      "node_fs_readFileSync",
      "replacement"
    ),
    row(
      "AUTH-NODE-PROMISES-READ",
      "node_promises_read",
      'void import("node:fs/promises").then((fs) => fs.readFile("/tmp/authority"));',
      "dynamic_import",
      "node_fs_promises_readFile",
      "replacement"
    ),
    row(
      "AUTH-FS-PROMISES-READ",
      "fs_promises_read",
      'void import("fs/promises").then((fs) => fs.readFile("/tmp/authority"));',
      "dynamic_import",
      "node_fs_promises_readFile",
      "replacement"
    ),
    row(
      "AUTH-NODE-PROMISES-PROPERTY-READ",
      "node_promises_property_read",
      'void import("node:fs").then((fs) => fs.promises.readFile("/tmp/authority"));',
      "dynamic_import",
      "node_fs_promises_readFile",
      "replacement"
    ),
    row(
      "AUTH-FS-PROMISES-PROPERTY-READ",
      "fs_promises_property_read",
      'void import("fs").then((fs) => fs.promises.readFile("/tmp/authority"));',
      "dynamic_import",
      "node_fs_promises_readFile",
      "replacement"
    ),
    row(
      "AUTH-CACHED-FS-PROMISES-READ",
      "cached_fs_promises_read",
      'const authorityCachedFsPromises = process.getBuiltinModule("node:fs/promises"); void authorityCachedFsPromises.readFile("/tmp/authority");',
      "unapproved_global:process.getBuiltinModule",
      "node_fs_promises_readFile",
      "replacement"
    ),
    row(
      "AUTH-BUN-REPLACEMENT-READ",
      "bun_replacement_read",
      'void Bun.file("/tmp/authority").text();',
      "unapproved_global:Bun.file",
      "bun_file",
      "replacement"
    ),
    row(
      "AUTH-BUN-URL-READ",
      "bun_url_read",
      'void Bun.file(new URL("file:///tmp/authority")).text();',
      "unapproved_global:Bun.file",
      "bun_file",
      "replacement"
    ),
    row(
      "AUTH-NODE-WRITE",
      "node_write",
      'void import("node:fs").then(({ writeFileSync }) => writeFileSync("/tmp/authority", "written"));',
      "dynamic_import",
      "node_fs_writeFileSync",
      "write_sentinel"
    ),
    row(
      "AUTH-BUN-WRITE",
      "bun_write",
      'void Bun.write("/tmp/authority", "written");',
      "unapproved_global:Bun.write",
      "bun_write",
      "write_sentinel"
    ),
    row(
      "AUTH-NODE-SPAWN",
      "node_spawn",
      'void import("node:child_process").then(({ spawnSync }) => spawnSync("true"));',
      "dynamic_import",
      "node_child_process_spawnSync",
      "none"
    ),
    row(
      "AUTH-BUN-SPAWN",
      "bun_spawn",
      'void Bun.spawn(["true"]);',
      "unapproved_global:Bun.spawn",
      "bun_spawn",
      "none"
    ),
    row(
      "AUTH-BUILTIN-COMPUTED-READ-ABSOLUTE",
      "builtin_computed_read_absolute",
      'const authorityBuiltinFs = process.getBuiltinModule("node:" + "fs"); void authorityBuiltinFs.readFileSync("/tmp/authority");',
      "unapproved_global:process.getBuiltinModule",
      "node_fs_readFileSync",
      "replacement"
    ),
    row(
      "AUTH-BUILTIN-COMPUTED-STAT-RELATIVE",
      "builtin_computed_stat_relative",
      'const authorityComputedFs = process.getBuiltinModule(["node", "fs"].join(":")); void authorityComputedFs.statSync("authority");',
      "unapproved_global:process.getBuiltinModule",
      "node_fs_statSync",
      "replacement"
    ),
    row(
      "AUTH-META-COMPUTED-STREAM-URL",
      "meta_computed_stream_url",
      'const authorityMetaFs = import.meta.require("node:" + "fs"); void authorityMetaFs.createReadStream(new URL("file:///tmp/authority"));',
      "forbidden_import_meta:require",
      "node_fs_createReadStream",
      "replacement"
    ),
    row(
      "AUTH-META-COMPUTED-OPEN-BUFFER",
      "meta_computed_open_buffer",
      'const authorityMetaBufferFs = import.meta.require(["n", "ode:fs"].join("")); void authorityMetaBufferFs.openSync(Buffer.from("/tmp/authority"));',
      "forbidden_import_meta:require",
      "node_fs_openSync",
      "replacement"
    ),
    row(
      "AUTH-CREATE-REQUIRE-COMPUTED-WRITE-RELATIVE",
      "create_require_computed_write_relative",
      'import { createRequire as authorityComputedRequire } from "node:module"; const authorityComputedLoader = authorityComputedRequire(import.meta.url); void authorityComputedLoader("node:" + "fs").writeFileSync("authority", "written");',
      "unapproved_import:node:module",
      "node_fs_writeFileSync",
      "write_sentinel"
    ),
    row(
      "AUTH-CREATE-REQUIRE-PROMISES-READ-URL",
      "create_require_promises_read_url",
      'import { createRequire as authorityPromisesRequire } from "node:module"; const authorityPromisesLoader = authorityPromisesRequire(import.meta.url); void authorityPromisesLoader(["node:fs", "promises"].join("/")).readFile(new URL("file:///tmp/authority"));',
      "unapproved_import:node:module",
      "node_fs_promises_readFile",
      "replacement"
    ),
    row(
      "AUTH-META-COMPUTED-FFI-DLOPEN",
      "meta_computed_ffi_dlopen",
      'const authorityMetaFfi = import.meta.require("bun:" + "ffi"); void authorityMetaFfi.dlopen("libc.so.6", {});',
      "forbidden_import_meta:require",
      "ffi_dlopen",
      "library"
    ),
    row(
      "AUTH-BUILTIN-COMPUTED-CHILD-EXEC-FILE",
      "builtin_computed_child_exec_file",
      'const authorityBuiltinChild = process.getBuiltinModule(["node", "child_process"].join(":")); void authorityBuiltinChild.execFileSync("true");',
      "unapproved_global:process.getBuiltinModule",
      "node_child_process_execFileSync",
      "none"
    )
  ])
} satisfies Readonly<{ version: typeof AUTHORITY_PROOF_VERSION; rows: readonly AuthorityProofRow[] }>);

export const AUTHORITY_PROOF_ROWS = AUTHORITY_PROOF_REGISTRY.rows;
