import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, parse, resolve, sep } from "node:path";
import { canonicalJson } from "../lib/canonical-json";
import {
  ContractCapabilities,
  type CloseAttempt,
  type ContractAuthorityFault
} from "../lib/capabilities";
import { SOURCE_PROFILE } from "../lib/constants";
import {
  ContractError,
  parseBoundedJson,
  type DescriptorOperation
} from "../lib/ingress";
import { admitSourceInput } from "../lib/schemas";
import {
  capture,
  countedItems,
  descriptorCount,
  directCommand,
  failure,
  recordWithEntries,
  sourceRecord,
  success,
  validIdentityPath,
  validSourcePath,
  withTemporaryFile
} from "./helpers";

type Kind = "source_input_record" | "source_identity_projection";
type FailureScenario = "upper_symlink" | "parent_symlink" | "ancestor_replacement" | "final_replacement";
type AuthorityControl =
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

const exactProductionImports: Readonly<Record<string, readonly string[]>> = {
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
    'import {\n  ContractCapabilities,\n  DIRECTORY_OPEN_FLAGS,\n  FILE_OPEN_FLAGS,\n  type BigIntStats,\n  type CapabilityHooks,\n  type ContractAuthorityFault\n} from "./capabilities";'
  ],
  "lib/schemas.ts": [
    'import { posix } from "node:path";',
    'import { canonicalJson } from "./canonical-json";',
    'import { SOURCE_PROFILE } from "./constants";',
    'import { ContractError, parseBoundedJson } from "./ingress";'
  ]
};

const exactGlobalProperties: Readonly<Record<string, Readonly<{ process: readonly string[]; Bun: readonly string[] }>>> = {
  "check.ts": { process: ["stdout", "stderr", "exit"], Bun: ["argv"] },
  "lib/canonical-json.ts": { process: [], Bun: [] },
  "lib/capabilities.ts": { process: ["platform", "platform"], Bun: [] },
  "lib/checker.ts": { process: [], Bun: [] },
  "lib/constants.ts": { process: [], Bun: [] },
  "lib/ingress.ts": { process: ["platform"], Bun: [] },
  "lib/schemas.ts": { process: [], Bun: [] }
};

function structuralAuthorityViolations(relative: string, text: string): string[] {
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: string[] = [];
  const imports = source.statements.filter(ts.isImportDeclaration).map((node) => node.getText(source));
  if (JSON.stringify(imports) !== JSON.stringify(exactProductionImports[relative])) {
    violations.push(`imports:${JSON.stringify(imports)}`);
  }
  const globalProperties = { process: [] as string[], Bun: [] as string[] };
  const forbiddenIdentifiers = new Set([
    "require", "createRequire", "getBuiltinModule", "eval", "Function",
    "global", "globalThis", "Reflect", "module"
  ]);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      violations.push("dynamic_import");
    }
    if (ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node) && node.moduleSpecifier) {
      violations.push("alternate_module_declaration");
    }
    if (ts.isIdentifier(node) && forbiddenIdentifiers.has(node.text)) {
      violations.push(`forbidden_identifier:${node.text}`);
    }
    if (ts.isIdentifier(node) && (node.text === "process" || node.text === "Bun")) {
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        globalProperties[node.text].push(parent.name.text);
      } else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
        violations.push(`computed_global:${node.text}`);
      } else {
        violations.push(`bare_global:${node.text}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const expectedGlobals = exactGlobalProperties[relative];
  if (JSON.stringify(globalProperties.process) !== JSON.stringify(expectedGlobals?.process)) {
    violations.push(`process_properties:${JSON.stringify(globalProperties.process)}`);
  }
  if (JSON.stringify(globalProperties.Bun) !== JSON.stringify(expectedGlobals?.Bun)) {
    violations.push(`bun_properties:${JSON.stringify(globalProperties.Bun)}`);
  }
  return violations;
}

const authorityPreloadPath = join(import.meta.dir, "authority-preload.ts");
const authorityControlPath = join(import.meta.dir, "authority-control.ts");

async function guardedCommand(
  args: string[],
  env: Record<string, string> = {}
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(
    [process.execPath, "--preload", authorityPreloadPath, ...args],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } }
  );
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  return { exit, stdout, stderr };
}

function componentCount(path: string): number {
  const absolute = normalizedAuthorityTarget(path);
  const root = parse(absolute).root;
  return 1 + absolute.slice(root.length).split(sep).filter(Boolean).length;
}

function normalizedAuthorityTarget(path: string): string {
  let absolute = resolve(path);
  if (process.platform === "darwin") {
    for (const alias of ["/etc", "/tmp", "/var"] as const) {
      if (absolute === alias || absolute.startsWith(`${alias}/`)) absolute = `/private${absolute}`;
    }
  }
  return absolute;
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected contract error");
  } catch (error) {
    expect(error).toBeInstanceOf(ContractError);
    expect((error as ContractError).code).toBe(code);
  }
}

async function exerciseFailure(kind: Kind, fixturePath: string, scenario: FailureScenario): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "shud-source-capability-"));
  const operations: DescriptorOperation[] = [];
  let replacementPath: string | undefined;
  const replacementBytes = Buffer.from('{"replacement":"must-not-be-read"}');
  try {
    const upper = join(root, "upper");
    const ancestor = join(upper, "ancestor");
    const parent = join(ancestor, "parent");
    await mkdir(parent, { recursive: true });
    const input = join(parent, basename(fixturePath));
    await writeFile(input, await readFile(fixturePath));
    let selectedInput = input;

    if (scenario === "upper_symlink") {
      const upperLink = join(root, "upper-link");
      await symlink(upper, upperLink);
      selectedInput = join(upperLink, "ancestor", "parent", basename(input));
    } else if (scenario === "parent_symlink") {
      const parentLink = join(ancestor, "parent-link");
      await symlink(parent, parentLink);
      selectedInput = join(parentLink, basename(input));
    }

    const result = await capture(["--input", selectedInput, "--kind", kind], {
      observe: (operation) => { operations.push(operation); },
      afterAdmission: async () => {
        if (scenario === "ancestor_replacement") {
          const retainedAncestor = join(upper, "ancestor.retained");
          await rename(ancestor, retainedAncestor);
          replacementPath = join(ancestor, "parent", basename(input));
          await mkdir(join(ancestor, "parent"), { recursive: true });
          await writeFile(replacementPath, replacementBytes);
        } else if (scenario === "final_replacement") {
          await rename(input, `${input}.retained`);
          replacementPath = input;
          await writeFile(replacementPath, replacementBytes);
        }
      }
    });

    expect(result).toEqual({ exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") });
    expect(result.stderr.endsWith("\n")).toBe(true);
    if (replacementPath) expect(await readFile(replacementPath)).toEqual(replacementBytes);
    expect(operations.filter((operation) => operation.phase === "post_admission" && operation.operation === "read_retained")).toHaveLength(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("descriptor-bound source ingress", () => {
  test("source record direct command emits the exact LF-terminated public receipt", async () => {
    const result = await directCommand(["--input", validSourcePath, "--kind", "source_input_record"]);
    expect(result).toEqual({ exit: 0, stdout: success("source_input_record"), stderr: "" });
    expect(result.stdout.endsWith("\n")).toBe(true);
  });

  test("canonical source records preserve canonical JSON and byte-identical repeat receipts", async () => {
    const bytes = await readFile(validSourcePath);
    const canonicalOracle = await readFile(new URL(
      "../fixtures/valid/source-input-record-paired-surrogate.canonical.json",
      import.meta.url
    ));
    expect(Buffer.from(admitSourceInput("source_input_record", bytes))).toEqual(canonicalOracle.subarray(0, -1));
    expect(new TextDecoder().decode(canonicalOracle)).toContain("😀.json");
    expect(canonicalJson({ "😀": "\ud83d\ude00" })).toBe('{"😀":"😀"}');
    const expected = { exit: 0, stdout: success("source_input_record"), stderr: "" };
    expect(await capture(["--input", validSourcePath, "--kind", "source_input_record"])).toEqual(expected);
    expect(await capture(["--input", validSourcePath, "--kind", "source_input_record"])).toEqual(expected);
  });

  test("central capability boundary is the only OS authority import and direct commands preserve input bytes", async () => {
    expect(Object.getOwnPropertyNames(ContractCapabilities.prototype).sort()).toEqual([
      "close", "constructor", "openRelative", "openRoot", "readRetained", "rejectForbidden", "stat"
    ]);
    for (const [kind, path] of [
      ["source_input_record", validSourcePath],
      ["source_identity_projection", validIdentityPath]
    ] as const) {
      const beforeBytes = await readFile(path);
      const beforeStat = await stat(path);
      expect((await directCommand(["--input", path, "--kind", kind])).exit).toBe(0);
      expect(await readFile(path)).toEqual(beforeBytes);
      const afterStat = await stat(path);
      expect(afterStat.mode).toBe(beforeStat.mode);
      expect(afterStat.size).toBe(beforeStat.size);
      expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    }
    const libraryFiles = (await readdir(new URL("../lib/", import.meta.url)))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => `lib/${name}`);
    const implementations = ["check.ts", ...libraryFiles].sort();
    expect(implementations).toEqual(Object.keys(exactProductionImports).sort());
    for (const relative of implementations) {
      const text = await readFile(new URL(`../${relative}`, import.meta.url), "utf8");
      expect(structuralAuthorityViolations(relative, text)).toEqual([]);
      if (relative === "lib/capabilities.ts") {
        expect(text.match(/const symbols = .*$/gm)).toEqual([
          'const symbols = { openat: { args: ["i32", "cstring", "i32"], returns: "i32" } } as const;'
        ]);
        expect([...text.matchAll(/\.symbols\.([A-Za-z][A-Za-z0-9_]*)/g)].map((match) => match[1])).toEqual([
          "openat", "openat"
        ]);
        expect(text.split("\n").filter((line) =>
          /\b(?:dlopen|openSync|fstatSync|readSync|closeSync)\s*\(/.test(line)
        ).map((line) => line.trim())).toEqual([
          'cachedOpenAt = dlopen("/usr/lib/libSystem.B.dylib", symbols).symbols.openat;',
          'cachedOpenAt = dlopen("libc.so.6", symbols).symbols.openat;',
          "return openSync(root, DIRECTORY_OPEN_FLAGS);",
          "return fstatSync(descriptor, { bigint: true });",
          "return readSync(descriptor, buffer, offset, length, position);",
          "closeSync(descriptor);"
        ]);
      }
    }
  });

  test("active central gate rejects unreported ambient open, replacement read, write, and child spawn controls", async () => {
    const faults: ContractAuthorityFault[] = [
      "ambient_absolute_open", "replacement_object_read", "file_write", "child_spawn"
    ];
    for (const [kind, path] of [
      ["source_input_record", validSourcePath],
      ["source_identity_projection", validIdentityPath]
    ] as const) {
      for (const fault of faults) {
        const violations: ContractAuthorityFault[] = [];
        expect(await capture(["--input", path, "--kind", kind], {
          authorityFault: fault,
          onAuthorityViolation: (violation) => { violations.push(violation); }
        })).toEqual({ exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") });
        expect(violations).toEqual([fault]);
      }
      expect(await capture(["--input", path, "--kind", kind])).toEqual({
        exit: 0, stdout: success(kind), stderr: ""
      });
    }
  });

  test("independent preload denies actual Node, Bun, and FFI authority before side effects", async () => {
    const controls: ReadonlyArray<Readonly<{
      control: AuthorityControl;
      operation: string;
      target: "input" | "replacement" | "sentinel" | "library" | "none";
    }>> = [
      { control: "node_absolute_open", operation: "node_fs_openSync", target: "input" },
      { control: "node_url_open", operation: "node_fs_openSync", target: "input" },
      { control: "node_buffer_open", operation: "node_fs_openSync", target: "input" },
      { control: "fs_alias_url_open", operation: "node_fs_openSync", target: "input" },
      { control: "ffi_absolute_open", operation: "ffi_dlopen", target: "library" },
      { control: "node_replacement_read", operation: "node_fs_readFileSync", target: "replacement" },
      { control: "node_promises_read", operation: "node_fs_promises_readFile", target: "replacement" },
      { control: "fs_promises_read", operation: "node_fs_promises_readFile", target: "replacement" },
      { control: "node_promises_property_read", operation: "node_fs_promises_readFile", target: "replacement" },
      { control: "fs_promises_property_read", operation: "node_fs_promises_readFile", target: "replacement" },
      { control: "bun_replacement_read", operation: "bun_file", target: "replacement" },
      { control: "bun_url_read", operation: "bun_file", target: "replacement" },
      { control: "node_write", operation: "node_fs_writeFileSync", target: "sentinel" },
      { control: "bun_write", operation: "bun_write", target: "sentinel" },
      { control: "node_spawn", operation: "node_child_process_spawnSync", target: "none" },
      { control: "bun_spawn", operation: "bun_spawn", target: "none" },
      { control: "builtin_computed_read_absolute", operation: "node_fs_readFileSync", target: "replacement" },
      { control: "builtin_computed_stat_relative", operation: "node_fs_statSync", target: "replacement" },
      { control: "meta_computed_stream_url", operation: "node_fs_createReadStream", target: "replacement" },
      { control: "meta_computed_open_buffer", operation: "node_fs_openSync", target: "replacement" },
      { control: "create_require_computed_write_relative", operation: "node_fs_writeFileSync", target: "sentinel" },
      { control: "create_require_promises_read_url", operation: "node_fs_promises_readFile", target: "replacement" },
      { control: "meta_computed_ffi_dlopen", operation: "ffi_dlopen", target: "library" },
      { control: "builtin_computed_child_exec_file", operation: "node_child_process_execFileSync", target: "none" }
    ];
    const productionControls = [
      "builtin_computed_read_absolute",
      "builtin_computed_stat_relative",
      "meta_computed_stream_url",
      "meta_computed_open_buffer",
      "create_require_computed_write_relative",
      "create_require_promises_read_url",
      "meta_computed_ffi_dlopen",
      "builtin_computed_child_exec_file"
    ] as const;
    for (const [kind, input] of [
      ["source_input_record", validSourcePath],
      ["source_identity_projection", validIdentityPath]
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), "shud-source-authority-"));
      const productionSentinel = join(root, "production-import.sentinel");
      const replacement = join(root, "replacement.json");
      const replacementBytes = Buffer.from('{"replacement":"must-not-be-read"}');
      const inputBytes = await readFile(input);
      await writeFile(replacement, replacementBytes);
      try {
        const productionObserved: unknown[] = [];
        const productionExpected: unknown[] = [];
        for (const control of productionControls) {
          const productionProcess = await guardedCommand(
            [authorityControlPath, kind, input, "production_path", replacement, productionSentinel],
            {
              SHUD_CONTRACT_AUTHORITY_RED_CONTROL: control,
              SHUD_CONTRACT_AUTHORITY_RED_TARGET: replacement,
              SHUD_CONTRACT_AUTHORITY_RED_SENTINEL: productionSentinel
            }
          );
          const productionResult = JSON.parse(productionProcess.stdout) as {
            exit: number; stdout: string; stderr: string; events: string[];
          };
          productionObserved.push({
            control,
            processExit: productionProcess.exit,
            processStderr: productionProcess.stderr,
            result: productionResult,
            sentinelExists: await Bun.file(productionSentinel).exists(),
            replacementUnchanged: (await readFile(replacement)).equals(replacementBytes)
          });
          productionExpected.push({
            control,
            processExit: 0,
            processStderr: "",
            result: { exit: 0, stdout: success(kind), stderr: "", events: [] },
            sentinelExists: false,
            replacementUnchanged: true
          });
        }
        expect(productionObserved).toEqual(productionExpected);
        const observed: unknown[] = [];
        const expected: unknown[] = [];
        for (const spec of controls) {
          const sentinel = join(root, `${spec.control}.sentinel`);
          const result = await guardedCommand([
            authorityControlPath, kind, input, spec.control, replacement, sentinel
          ]);
          const payload = JSON.parse(result.stdout) as {
            exit: number; stdout: string; stderr: string; events: string[];
          };
          const target = spec.target === "input" ? input
            : spec.target === "replacement" ? replacement
            : spec.target === "sentinel" ? sentinel
            : spec.target === "library"
              ? process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6"
            : "";
          observed.push({
            processExit: result.exit,
            processStderr: result.stderr,
            payload,
            sentinelExists: await Bun.file(sentinel).exists(),
            replacementUnchanged: (await readFile(replacement)).equals(replacementBytes),
            inputUnchanged: (await readFile(input)).equals(inputBytes)
          });
          expected.push({
            processExit: 0,
            processStderr: "",
            payload: {
              exit: 2,
              stdout: "",
              stderr: failure("CONTRACT_SCHEMA_INVALID"),
              events: [
                `${spec.operation}:${spec.target === "library" ? target
                  : target ? normalizedAuthorityTarget(target) : ""}`,
                `control_error:CONTRACT_TEST_AUTHORITY_DENIED:${spec.operation}`
              ]
            },
            sentinelExists: false,
            replacementUnchanged: true,
            inputUnchanged: true
          });
        }
        expect(observed).toEqual(expected);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test("post-admission tripwire permits only retained-descriptor-relative opens and retained reads", async () => {
    for (const [kind, path] of [
      ["source_input_record", validSourcePath],
      ["source_identity_projection", validIdentityPath]
    ] as const) {
      const operations: DescriptorOperation[] = [];
      expect(await capture(["--input", path, "--kind", kind], {
        observe: (operation) => { operations.push(operation); }
      })).toEqual({ exit: 0, stdout: success(kind), stderr: "" });
      const afterAdmission = operations.filter((operation) => operation.phase === "post_admission");
      expect(afterAdmission.length).toBeGreaterThan(0);
      expect(afterAdmission.some((operation) => operation.operation === "open_root")).toBe(false);
      for (const operation of afterAdmission) {
        expect(operation.path.startsWith("/")).toBe(false);
        if (operation.operation === "open_relative") {
          expect(operation.path.includes("/")).toBe(false);
          expect(operation.parentDescriptor).toBeNumber();
        } else {
          expect(operation.operation).toBe("read_retained");
          expect(operation.descriptor).toBeNumber();
        }
      }
    }
  });

  test("upper and parent symlinks plus ancestor and final replacements fail without reading replacement bytes", async () => {
    for (const [kind, path] of [
      ["source_input_record", validSourcePath],
      ["source_identity_projection", validIdentityPath]
    ] as const) {
      for (const scenario of ["upper_symlink", "parent_symlink", "ancestor_replacement", "final_replacement"] as const) {
        await exerciseFailure(kind, path, scenario);
      }
    }
  });

  test("success and every named failure restore descriptor baseline across repeated loops", async () => {
    const baseline = await descriptorCount();
    for (let repeat = 0; repeat < 6; repeat += 1) {
      for (const [kind, path] of [
        ["source_input_record", validSourcePath],
        ["source_identity_projection", validIdentityPath]
      ] as const) {
        expect((await capture(["--input", path, "--kind", kind])).exit).toBe(0);
        for (const scenario of ["upper_symlink", "parent_symlink", "ancestor_replacement", "final_replacement"] as const) {
          await exerciseFailure(kind, path, scenario);
        }
      }
    }
    Bun.gc(true);
    expect(await descriptorCount()).toBe(baseline);
  });

  test("success, hook throw, byte bound, malformed JSON, and schema failure all restore descriptors", async () => {
    const baseline = await descriptorCount();
    expect((await capture(["--input", validSourcePath, "--kind", "source_input_record"])).exit).toBe(0);
    expect((await capture(["--input", validSourcePath, "--kind", "source_input_record"], {
      afterAdmission: () => { throw new Error("hook fault"); }
    })).exit).toBe(2);
    await withTemporaryFile(" ".repeat(SOURCE_PROFILE.bytes + 1), async (path) => {
      expect((await capture(["--input", path, "--kind", "source_input_record"])).stderr).toBe(failure("CONTRACT_BYTES_LIMIT"));
    });
    for (const text of ["{", "{}"] as const) {
      await withTemporaryFile(text, async (path) => {
        expect((await capture(["--input", path, "--kind", "source_input_record"])).exit).toBe(2);
      });
    }
    const directoryRoot = await mkdtemp(join(tmpdir(), "shud-source-directory-input-"));
    try {
      expect((await capture(["--input", directoryRoot, "--kind", "source_input_record"])).exit).toBe(2);
    } finally {
      await rm(directoryRoot, { recursive: true, force: true });
    }
    Bun.gc(true);
    expect(await descriptorCount()).toBe(baseline);
  });

  test("close faults preserve primary errors, settle every descriptor, and make cleanup-only failure stable", async () => {
    for (const [kind, path] of [
      ["source_input_record", validSourcePath],
      ["source_identity_projection", validIdentityPath]
    ] as const) {
      const components = componentCount(path);
      const cleanupOnly: CloseAttempt[] = [];
      expect(await capture(["--input", path, "--kind", kind], {
        closeFault: (attempt) => attempt.owner === "retained",
        onCloseAttempt: (attempt) => { cleanupOnly.push(attempt); }
      })).toEqual({ exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") });
      expect(cleanupOnly).toHaveLength(3 * components - 2);
      expect(cleanupOnly.filter((attempt) => attempt.owner === "verification")).toHaveLength(2 * (components - 1));
      expect(cleanupOnly.filter((attempt) => attempt.owner === "retained")).toHaveLength(components);
      expect(cleanupOnly.map((attempt) => attempt.ordinal)).toEqual(
        Array.from({ length: cleanupOnly.length }, (_, index) => index + 1)
      );

      const verificationFault: CloseAttempt[] = [];
      expect(await capture(["--input", path, "--kind", kind], {
        closeFault: (attempt) => attempt.owner === "verification",
        onCloseAttempt: (attempt) => { verificationFault.push(attempt); }
      })).toEqual({ exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") });
      expect(verificationFault).toHaveLength(components + 1);
      expect(verificationFault[0]!.owner).toBe("verification");
      expect(verificationFault.slice(1).every((attempt) => attempt.owner === "retained")).toBe(true);
    }

    for (const kind of ["source_input_record", "source_identity_projection"] as const) {
      await withTemporaryFile(" ".repeat(SOURCE_PROFILE.bytes + 1), async (path) => {
        const attempts: CloseAttempt[] = [];
        const components = componentCount(path);
        expect(await capture(["--input", path, "--kind", kind], {
          closeFault: (attempt) => attempt.owner === "retained",
          onCloseAttempt: (attempt) => { attempts.push(attempt); }
        })).toEqual({ exit: 2, stdout: "", stderr: failure("CONTRACT_BYTES_LIMIT") });
        expect(attempts).toHaveLength(2 * components - 1);
        expect(attempts.filter((attempt) => attempt.owner === "retained")).toHaveLength(components);
      });

      const directoryRoot = await mkdtemp(join(tmpdir(), "shud-source-admission-close-"));
      try {
        const attempts: CloseAttempt[] = [];
        const components = componentCount(directoryRoot);
        expect(await capture(["--input", directoryRoot, "--kind", kind], {
          closeFault: () => true,
          onCloseAttempt: (attempt) => { attempts.push(attempt); }
        })).toEqual({ exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") });
        expect(attempts).toHaveLength(components);
        expect(attempts[0]!.owner).toBe("unretained");
        expect(attempts.slice(1).every((attempt) => attempt.owner === "retained")).toBe(true);
      } finally {
        await rm(directoryRoot, { recursive: true, force: true });
      }
    }
  });
});

describe("normalized source record and frozen capacity", () => {
  test("the admitted set appears once and encoder results contain the exact binding keys", async () => {
    const fixture = await sourceRecord();
    expect(Object.keys(fixture.primary_result).sort()).toEqual([
      "entry_count", "manifest_digest", "source_input_digest", "status"
    ]);
    expect(Object.keys(fixture.witness_result).sort()).toEqual([
      "entry_count", "manifest_digest", "source_input_digest", "status"
    ]);
    expect(JSON.stringify(fixture).match(/admitted_paths/g)).toHaveLength(1);
    expect(JSON.stringify(fixture).match(/admitted_modes/g)).toHaveLength(1);
  });

  test("each primary and witness tuple mismatch and any reintroduced admitted array is rejected", async () => {
    const fixture = await sourceRecord();
    const mutations: Array<(value: any) => void> = [];
    for (const result of ["primary_result", "witness_result"] as const) {
      mutations.push(
        (value) => { value[result].source_input_digest = "3".repeat(64); },
        (value) => { value[result].manifest_digest = "4".repeat(64); },
        (value) => { value[result].entry_count += 1; },
        (value) => { value[result].admitted_paths = [...value.admitted_paths]; },
        (value) => { value[result].admitted_modes = [...value.admitted_modes]; }
      );
    }
    for (const mutate of mutations) {
      const changed = structuredClone(fixture);
      mutate(changed);
      await withTemporaryFile(JSON.stringify(changed), async (path) => {
        expect(await capture(["--input", path, "--kind", "source_input_record"])).toEqual({
          exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID")
        });
      });
    }
  });

  test("237 entries are exactly 512 items and succeed while 238 are 514 and hit only the item limit", async () => {
    for (const [entries, itemCount, expected] of [
      [237, 512, { exit: 0, stdout: success("source_input_record"), stderr: "" }],
      [238, 514, { exit: 2, stdout: "", stderr: failure("CONTRACT_JSON_ITEM_LIMIT") }]
    ] as const) {
      const value = recordWithEntries(entries);
      const bytes = Buffer.from(JSON.stringify(value));
      expect(countedItems(value)).toBe(itemCount);
      expect(bytes.byteLength).toBeLessThan(SOURCE_PROFILE.bytes);
      await withTemporaryFile(bytes, async (path) => {
        expect(await directCommand(["--input", path, "--kind", "source_input_record"])).toEqual(expected);
      });
    }
  });

  test("parser node exact and plus one remain independent under a relaxed item ceiling", () => {
    const nodes = (count: number) => Buffer.from(`[${Array.from({ length: count - 1 }, () => "0").join(",")}]`);
    const profile = { ...SOURCE_PROFILE, items: SOURCE_PROFILE.nodes };
    expect(() => parseBoundedJson(nodes(SOURCE_PROFILE.nodes), profile)).not.toThrow();
    expectCode(() => parseBoundedJson(nodes(SOURCE_PROFILE.nodes + 1), profile), "CONTRACT_JSON_NODE_LIMIT");
  });

  test("malformed array values and object members override pending item or node limits", async () => {
    const nodeBoundary =
      `[${Array.from({ length: SOURCE_PROFILE.nodes - 1 }, () => "0").join(",")},"unterminated]`;
    const cases = [
      `[${Array.from({ length: SOURCE_PROFILE.items }, () => "0").join(",")},]`,
      `[${Array.from({ length: SOURCE_PROFILE.items }, () => "0").join(",")},truX]`,
      `{${Array.from({ length: SOURCE_PROFILE.items }, (_, index) => `"k${index}":0`).join(",")},"tail"}`,
      nodeBoundary
    ];
    const observed: unknown[] = [];
    const expected: unknown[] = [];
    for (const kind of ["source_input_record", "source_identity_projection"] as const) {
      for (const text of cases) {
        await withTemporaryFile(text, async (path) => {
          observed.push(await capture(["--input", path, "--kind", kind]));
          expected.push({ exit: 2, stdout: "", stderr: failure("CONTRACT_JSON_MALFORMED") });
        });
      }
    }
    try {
      parseBoundedJson(Buffer.from(nodeBoundary), { ...SOURCE_PROFILE, items: SOURCE_PROFILE.nodes });
      observed.push("parsed");
    } catch (error) {
      observed.push(error instanceof ContractError ? error.code : "unknown");
    }
    expected.push("CONTRACT_JSON_MALFORMED");
    expect(observed).toEqual(expected);
  });

  test("pending item or node limits override later nonfinite number semantics", async () => {
    const itemBoundary =
      `[${Array.from({ length: SOURCE_PROFILE.items }, () => "0").join(",")},1e9999]`;
    const observed: unknown[] = [];
    const expected: unknown[] = [];
    for (const kind of ["source_input_record", "source_identity_projection"] as const) {
      for (const [text, code] of [
        [itemBoundary, "CONTRACT_JSON_ITEM_LIMIT"],
        ["1e9999", "CONTRACT_SCHEMA_INVALID"],
        ["1e9999 trailing", "CONTRACT_JSON_MALFORMED"]
      ] as const) {
        await withTemporaryFile(text, async (path) => {
          observed.push(await capture(["--input", path, "--kind", kind]));
          expected.push({ exit: 2, stdout: "", stderr: failure(code) });
        });
      }
    }
    const nodeBoundary = Buffer.from(
      `[${Array.from({ length: SOURCE_PROFILE.nodes - 1 }, () => "0").join(",")},1e9999]`
    );
    try {
      parseBoundedJson(nodeBoundary, { ...SOURCE_PROFILE, items: SOURCE_PROFILE.nodes });
      observed.push("parsed");
    } catch (error) {
      observed.push(error instanceof ContractError ? error.code : "unknown");
    }
    expected.push("CONTRACT_JSON_NODE_LIMIT");
    expect(observed).toEqual(expected);
  });

  test("legal depth 12 reaches schema validation and depth 13 returns only the depth limit for both kinds", async () => {
    const exact = "[".repeat(SOURCE_PROFILE.depth - 1) + "0" + "]".repeat(SOURCE_PROFILE.depth - 1);
    const plusOne = "[".repeat(SOURCE_PROFILE.depth) + "0" + "]".repeat(SOURCE_PROFILE.depth);
    for (const kind of ["source_input_record", "source_identity_projection"] as const) {
      for (const [text, code] of [
        [exact, "CONTRACT_SCHEMA_INVALID"],
        [plusOne, "CONTRACT_JSON_DEPTH_LIMIT"]
      ] as const) {
        await withTemporaryFile(text, async (path) => {
          expect(await capture(["--input", path, "--kind", kind])).toEqual({
            exit: 2, stdout: "", stderr: failure(code)
          });
        });
      }
    }
  });

  test("byte, depth, item, UTF-8, malformed, duplicate, unknown, and missing failures retain exact receipts", async () => {
    const valid = await sourceRecord();
    const cases: Array<[Uint8Array | string, string]> = [
      [" ".repeat(SOURCE_PROFILE.bytes + 1), "CONTRACT_BYTES_LIMIT"],
      [Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xed, 0xa0, 0x80, 0x7d]), "CONTRACT_UTF8_INVALID"],
      ["{", "CONTRACT_JSON_MALFORMED"],
      ["{} trailing", "CONTRACT_JSON_MALFORMED"],
      ['{"x":1,"x":2}', "CONTRACT_JSON_DUPLICATE_KEY"],
      ["[".repeat(SOURCE_PROFILE.depth) + "0" + "]".repeat(SOURCE_PROFILE.depth), "CONTRACT_JSON_DEPTH_LIMIT"],
      [`[${Array.from({ length: SOURCE_PROFILE.items + 1 }, () => "0").join(",")}]`, "CONTRACT_JSON_ITEM_LIMIT"]
    ];
    const missing = structuredClone(valid); delete missing.source_sha;
    const unknown = structuredClone(valid); unknown.future = true;
    cases.push([JSON.stringify(missing), "CONTRACT_SCHEMA_INVALID"], [JSON.stringify(unknown), "CONTRACT_SCHEMA_INVALID"]);
    for (const [bytes, code] of cases) {
      await withTemporaryFile(bytes, async (path) => {
        expect(await capture(["--input", path, "--kind", "source_input_record"])).toEqual({
          exit: 2, stdout: "", stderr: failure(code)
        });
      });
    }
  });

  test("escaped surrogate failure classes and CR/LF path identities are rejected", async () => {
    for (const escaped of ["\\uD83D", "\\uDE00", "\\uDE00\\uD83D", "\\uD83D\\u0041"]) {
      for (const text of [`{"${escaped}":0}`, `{"x":"${escaped}"}`]) {
        await withTemporaryFile(text, async (path) => {
          expect(await capture(["--input", path, "--kind", "source_input_record"])).toEqual({
            exit: 2, stdout: "", stderr: failure("CONTRACT_JSON_MALFORMED")
          });
        });
      }
    }
    const fixture = await sourceRecord();
    for (const unsafePath of ["cr\r.json", "lf\n.json"]) {
      const changed = structuredClone(fixture);
      changed.admitted_paths[0] = unsafePath;
      await withTemporaryFile(JSON.stringify(changed), async (path) => {
        expect(await capture(["--input", path, "--kind", "source_input_record"])).toEqual({
          exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID")
        });
      });
    }
  });

  test("source byte ceiling remains inclusive", async () => {
    const base = JSON.stringify(await sourceRecord());
    const exact = base + " ".repeat(SOURCE_PROFILE.bytes - Buffer.byteLength(base));
    expect(Buffer.byteLength(exact)).toBe(SOURCE_PROFILE.bytes);
    await withTemporaryFile(exact, async (path) => {
      expect(await capture(["--input", path, "--kind", "source_input_record"])).toEqual({
        exit: 0, stdout: success("source_input_record"), stderr: ""
      });
    });
  });

  test("malformed argv and future-owned kinds have no partial output", async () => {
    for (const args of [
      ["--input", validSourcePath, "--kind", "dependency_graph"],
      ["--input", validSourcePath],
      ["--input", validSourcePath, "--kind", "source_input_record", "--kind", "source_input_record"],
      ["--repository-root", ".", "--check-current"]
    ]) {
      expect(await capture(args)).toEqual({ exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") });
    }
  });
});
