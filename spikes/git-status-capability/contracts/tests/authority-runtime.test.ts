import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AUTHORITY_PROOF_REGISTRY,
  AUTHORITY_PROOF_ROWS,
  AUTHORITY_WORKER_ENTRY
} from "./authority-vocabulary";
import type { AuthorityDenialTarget } from "./authority-vocabulary";
import {
  checkPath,
  failure,
  success,
  validIdentityPath,
  validSourcePath
} from "./helpers";

const authorityPreloadPath = join(import.meta.dir, "authority-preload.ts");
const authorityControlPath = join(import.meta.dir, "authority-control.ts");
const systemLibraryPath = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";

const EXPECTED_AUTHORITY_PROOF_VERSION = "shud.contract.authority-proof.v2";
const EXPECTED_AUTHORITY_PROOF_ROW_COUNT = 55;
const EXPECTED_AUTHORITY_PROOF_REGISTRY_SHA256 = "8ae389ead0f1aaad27cdeb080f66e1841376552a963ef9069657d929a118a725";

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

type GuardedCommand = Readonly<{ exit: number; stdout: string; stderr: string }>;
type GuardedCommandLaunch = Readonly<{
  command: string[];
  options: Readonly<{ stdout: "pipe"; stderr: "pipe"; env: Record<string, string | undefined> }>;
}>;

function normalizedAuthorityTarget(path: string): string {
  const absolute = resolve(path);
  if (process.platform === "darwin") {
    for (const alias of ["/etc", "/tmp", "/var"] as const) {
      if (absolute === alias || absolute.startsWith(`${alias}/`)) return `/private${absolute}`;
    }
  }
  return absolute;
}

function denialTarget(
  target: AuthorityDenialTarget,
  input: string,
  replacement: string,
  writeSentinel: string
): string {
  switch (target) {
    case "input":
      return normalizedAuthorityTarget(input);
    case "replacement":
      return normalizedAuthorityTarget(replacement);
    case "write_sentinel":
      return normalizedAuthorityTarget(writeSentinel);
    case "library":
      return systemLibraryPath;
    case "none":
      return "";
  }
}

function guardedCommandLaunch(args: readonly string[]): GuardedCommandLaunch {
  return {
    command: [process.execPath, "--preload", authorityPreloadPath, ...args],
    options: { stdout: "pipe", stderr: "pipe", env: { ...process.env } }
  };
}

async function guardedCommand(args: readonly string[]): Promise<GuardedCommand> {
  const launch = guardedCommandLaunch(args);
  const child = Bun.spawn(launch.command, launch.options);
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  return { exit, stdout, stderr };
}

function controlArguments(
  kind: "source_input_record" | "source_identity_projection",
  input: string,
  control: string,
  replacement: string,
  workerSentinel: string,
  writeSentinel: string,
  spawnSentinel: string
): readonly string[] {
  return [
    authorityControlPath,
    kind,
    input,
    control,
    replacement,
    workerSentinel,
    writeSentinel,
    spawnSentinel
  ];
}

describe("source-ingress authority runtime proof", () => {
  test("binds the exact independent authority registry contract", () => {
    expectFrozenAuthorityRegistry();
  });

  test("both unchanged direct commands retain exact receipts and no denial under the active preload", async () => {
    expect(Bun.version).toBe("1.2.19");
    const root = await mkdtemp(join(tmpdir(), "shud-authority-direct-"));
    const replacement = join(root, "replacement.json");
    const workerSentinel = join(root, "worker.sentinel");
    const writeSentinel = join(root, "write.sentinel");
    const spawnSentinel = join(root, "spawn.sentinel");
    const replacementBytes = Buffer.from('{"replacement":"must-not-be-read"}');
    await writeFile(replacement, replacementBytes);
    try {
      for (const [kind, input] of [
        ["source_input_record", validSourcePath],
        ["source_identity_projection", validIdentityPath]
      ] as const) {
        expect(await guardedCommand([checkPath, "--input", input, "--kind", kind])).toEqual({
          exit: 0,
          stdout: success(kind),
          stderr: ""
        });
        const directPayload = {
          exit: 0,
          stdout: success(kind),
          stderr: "",
          events: [] as string[],
          rawEvents: [] as string[],
          workerLiveness: null
        };
        expect(await guardedCommand(controlArguments(
          kind,
          input,
          "direct_success",
          replacement,
          workerSentinel,
          writeSentinel,
          spawnSentinel
        ))).toEqual({
          exit: 0,
          stdout: `${JSON.stringify(directPayload)}\n`,
          stderr: ""
        });
        expect(await readFile(replacement)).toEqual(replacementBytes);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("proves message-configured global and parent-port Worker fixture liveness during admission before hostile rows", async () => {
    expect(Bun.version).toBe("1.2.19");
    const root = await mkdtemp(join(tmpdir(), "shud-authority-worker-liveness-"));
    const replacement = join(root, "replacement.json");
    const workerSentinel = join(root, "worker.sentinel");
    const writeSentinel = join(root, "write.sentinel");
    const spawnSentinel = join(root, "spawn.sentinel");
    const replacementBytes = Buffer.from('{"replacement":"must-not-be-read"}');
    const inputBytes = await readFile(validSourcePath);
    await writeFile(replacement, replacementBytes);
    try {
      const expectedPayload = {
        exit: 0,
        stdout: success("source_input_record"),
        stderr: "",
        events: [] as string[],
        rawEvents: [] as string[],
        workerLiveness: {
          phase: "admission",
          routes: [
            {
              route: "global_direct",
              transport: "message",
              channel: "global",
              entry: AUTHORITY_WORKER_ENTRY,
              inputBytes: inputBytes.byteLength,
              sentinelBytes: AUTHORITY_WORKER_ENTRY,
              termination: "close",
              cleanup: "complete"
            },
            {
              route: "node_worker_threads",
              transport: "message",
              channel: "parent_port",
              entry: AUTHORITY_WORKER_ENTRY,
              inputBytes: inputBytes.byteLength,
              sentinelBytes: AUTHORITY_WORKER_ENTRY,
              termination: "exit",
              cleanup: "complete"
            },
            {
              route: "bare_worker_threads",
              transport: "message",
              channel: "parent_port",
              entry: AUTHORITY_WORKER_ENTRY,
              inputBytes: inputBytes.byteLength,
              sentinelBytes: AUTHORITY_WORKER_ENTRY,
              termination: "exit",
              cleanup: "complete"
            }
          ]
        }
      };
      expect(await guardedCommand(controlArguments(
        "source_input_record",
        validSourcePath,
        "worker_liveness_canary",
        replacement,
        workerSentinel,
        writeSentinel,
        spawnSentinel
      ))).toEqual({
        exit: 0,
        stdout: `${JSON.stringify(expectedPayload)}\n`,
        stderr: ""
      });
      expect(await Bun.file(workerSentinel).exists()).toBe(false);
      expect(await Bun.file(writeSentinel).exists()).toBe(false);
      expect(await Bun.file(spawnSentinel).exists()).toBe(false);
      expect(await readFile(replacement)).toEqual(replacementBytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("proves raw-operation inversion canaries observe pre-denial delegation", async () => {
    const root = await mkdtemp(join(tmpdir(), "shud-authority-raw-inversion-"));
    const replacement = join(root, "replacement.json");
    const workerSentinel = join(root, "worker.sentinel");
    const writeSentinel = join(root, "write.sentinel");
    const spawnSentinel = join(root, "spawn.sentinel");
    const replacementBytes = Buffer.from('{"replacement":"must-not-be-read"}');
    await writeFile(replacement, replacementBytes);
    try {
      for (const canary of [
        {
          control: "raw_read_inversion_canary",
          operation: "node_fs_readFileSync",
          target: normalizedAuthorityTarget(replacement),
          rawEvents: [`raw:node_fs_readFileSync:${normalizedAuthorityTarget(replacement)}`]
        },
        {
          control: "raw_ffi_inversion_canary",
          operation: "ffi_dlopen",
          target: systemLibraryPath,
          rawEvents: [`raw:ffi_dlopen:${systemLibraryPath}`, `raw:ffi_close:${systemLibraryPath}`]
        }
      ] as const) {
        const expectedPayload = {
          exit: 2,
          stdout: "",
          stderr: failure("CONTRACT_SCHEMA_INVALID"),
          events: [
            `${canary.operation}:${canary.target}`,
            `control_error:CONTRACT_TEST_AUTHORITY_DENIED:${canary.operation}`
          ],
          rawEvents: canary.rawEvents,
          workerLiveness: null
        };
        expect(await guardedCommand(controlArguments(
          "source_input_record",
          validSourcePath,
          canary.control,
          replacement,
          workerSentinel,
          writeSentinel,
          spawnSentinel
        ))).toEqual({
          exit: 0,
          stdout: `${JSON.stringify(expectedPayload)}\n`,
          stderr: ""
        });
      }
      expect(await readFile(replacement)).toEqual(replacementBytes);
      expect(await Bun.file(workerSentinel).exists()).toBe(false);
      expect(await Bun.file(writeSentinel).exists()).toBe(false);
      expect(await Bun.file(spawnSentinel).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("runs every registry control after admission with no structural scanner and exact pre-side-effect denials", async () => {
    expectFrozenAuthorityRegistry();

    const root = await mkdtemp(join(tmpdir(), "shud-authority-runtime-"));
    const replacement = join(root, "replacement.json");
    const replacementBytes = Buffer.from('{"replacement":"must-not-be-read"}');
    const inputBytes = await readFile(validSourcePath);
    await writeFile(replacement, replacementBytes);
    try {
      for (const row of AUTHORITY_PROOF_ROWS) {
        const workerSentinel = join(root, `${row.id}.worker.sentinel`);
        const writeSentinel = join(root, `${row.id}.write.sentinel`);
        const spawnSentinel = join(root, `${row.id}.spawn.sentinel`);
        const target = denialTarget(row.denialEvent.target, validSourcePath, replacement, writeSentinel);
        const expectedPayload = {
          exit: 2,
          stdout: "",
          stderr: failure("CONTRACT_SCHEMA_INVALID"),
          events: [
            `${row.denialEvent.operation}:${target}`,
            `control_error:CONTRACT_TEST_AUTHORITY_DENIED:${row.denialEvent.operation}`
          ],
          rawEvents: row.sideEffects.rawEvents,
          workerLiveness: null
        };
        expect(await guardedCommand(controlArguments(
          "source_input_record",
          validSourcePath,
          row.control,
          replacement,
          workerSentinel,
          writeSentinel,
          spawnSentinel
        ))).toEqual({
          exit: 0,
          stdout: `${JSON.stringify(expectedPayload)}\n`,
          stderr: ""
        });
        expect(await Bun.file(workerSentinel).exists()).toBe(row.sideEffects.workerEntrySentinel);
        expect(await Bun.file(writeSentinel).exists()).toBe(row.sideEffects.writeSentinel);
        expect(await Bun.file(spawnSentinel).exists()).toBe(row.sideEffects.spawnSentinel);
        expect((await readFile(validSourcePath)).equals(inputBytes)).toBe(row.sideEffects.inputUnchanged);
        expect((await readFile(replacement)).equals(replacementBytes)).toBe(row.sideEffects.replacementUnchanged);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("freezes the guarded launcher inherited environment and absent stdin shape", async () => {
    const arguments_ = ["--eval", "process.exit(0)"];
    const launch = guardedCommandLaunch(arguments_);
    expect(launch.command).toEqual([process.execPath, "--preload", authorityPreloadPath, ...arguments_]);
    expect(launch.options).toEqual({ stdout: "pipe", stderr: "pipe", env: { ...process.env } });
    expect(launch.options.env).not.toBe(process.env);
    expect(Object.keys(launch.options).sort()).toEqual(["env", "stderr", "stdout"]);
    expect("stdin" in launch.options).toBe(false);

    const key = "SHUD_CONTRACT_AUTHORITY_ENV_SENTINEL";
    const previous = process.env[key];
    const sentinel = "authority-launcher-env-copy";
    process.env[key] = sentinel;
    try {
      expect(await guardedCommand([
        "--eval",
        `process.stdout.write(JSON.stringify({ value: process.env[${JSON.stringify(key)}] }));`
      ])).toEqual({
        exit: 0,
        stdout: JSON.stringify({ value: sentinel }),
        stderr: ""
      });
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  test("fails closed for fd, stdin, Bun numeric fd, and every ordinary FFI operand after admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "shud-authority-fail-closed-"));
    const input = join(root, "input");
    const unlinkSentinel = join(root, "unlink.sentinel");
    const inputBytes = Buffer.from("authority-input-bytes");
    const unlinkBytes = Buffer.from("must-not-unlink");
    await writeFile(input, inputBytes);
    await writeFile(unlinkSentinel, unlinkBytes);
    const guardSymbol = "shud.contract.authorityGuard";
    // This sole fd-0 probe supplies controlled stdin; the shared guarded launcher remains stdin-free.
    async function guardedCommandWithControlledStdin(script: string): Promise<GuardedCommand> {
      const child = Bun.spawn(
        [process.execPath, "--preload", authorityPreloadPath, "--eval", script],
        {
          stdin: new Blob([inputBytes]),
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env }
        }
      );
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
      ]);
      return { exit, stdout, stderr };
    }
    try {
      const probes = [
        {
          script: `// Intentional child-loader probe: only a dynamic import resolves the mocked facade from --eval.
const fs = await import("node:fs");
const fd = fs.openSync(${JSON.stringify(input)}, "r");
const state = globalThis[Symbol.for(${JSON.stringify(guardSymbol)})];
state.phase = "post_admission";
let denied = "";
try { fs.readFileSync(fd); } catch (error) { denied = error instanceof Error ? error.message : String(error); }
const cursor = Buffer.alloc(0);
const cursorBytes = 0;
process.stdout.write(JSON.stringify({ denied, cursorBytes, cursor: cursor.subarray(0, cursorBytes).toString("utf8"), events: state.events, rawEvents: state.rawEvents }));`,
          expected: {
            denied: "CONTRACT_TEST_AUTHORITY_DENIED:node_fs_readFileSync",
            cursorBytes: 0,
            cursor: "",
            events: ["node_fs_readFileSync:"],
            rawEvents: []
          }
        },
        {
          script: `// Intentional child-loader probe: only a dynamic import resolves the mocked facade from --eval.
const fs = await import("node:fs");
const fd = fs.openSync(${JSON.stringify(input)}, "r");
const state = globalThis[Symbol.for(${JSON.stringify(guardSymbol)})];
state.rawInversion = "node_fs_readFileSync";
state.phase = "post_admission";
let denied = "";
try { fs.readFileSync(fd); } catch (error) { denied = error instanceof Error ? error.message : String(error); }
const cursor = Buffer.alloc(0);
const cursorBytes = 0;
process.stdout.write(JSON.stringify({ denied, cursorBytes, cursor: cursor.subarray(0, cursorBytes).toString("utf8"), events: state.events, rawEvents: state.rawEvents }));`,
          expected: {
            denied: "CONTRACT_TEST_AUTHORITY_DENIED:node_fs_readFileSync",
            cursorBytes: 0,
            cursor: "",
            events: ["node_fs_readFileSync:"],
            rawEvents: []
          }
        },
        {
          script: `// Intentional child-loader probe: only a dynamic import resolves the mocked facade from --eval.
const fs = await import("node:fs");
const fd = fs.openSync(${JSON.stringify(input)}, "r");
const state = globalThis[Symbol.for(${JSON.stringify(guardSymbol)})];
state.phase = "post_admission";
let denied = "";
let text = "";
try { text = await Bun.file(fd).text(); } catch (error) { denied = error instanceof Error ? error.message : String(error); }
process.stdout.write(JSON.stringify({ denied, text, events: state.events, rawEvents: state.rawEvents }));`,
          expected: {
            denied: "CONTRACT_TEST_AUTHORITY_DENIED:bun_file",
            text: "",
            events: ["bun_file:"],
            rawEvents: []
          }
        },
        {
          script: `// Intentional child-loader probe: only a dynamic import resolves the mocked facade from --eval.
const ffi = await import("bun:ffi");
const library = ffi.dlopen(${JSON.stringify(systemLibraryPath)}, { getpid: { args: [], returns: "i32" } });
const state = globalThis[Symbol.for(${JSON.stringify(guardSymbol)})];
state.phase = "post_admission";
let denied = "";
let result = null;
try { result = library.symbols.getpid(); } catch (error) { denied = error instanceof Error ? error.message : String(error); }
process.stdout.write(JSON.stringify({ denied, result, events: state.events, rawEvents: state.rawEvents }));`,
          expected: {
            denied: "CONTRACT_TEST_AUTHORITY_DENIED:ffi_getpid",
            result: null,
            events: ["ffi_getpid:"],
            rawEvents: []
          }
        },
        {
          script: `// Intentional child-loader probe: only a dynamic import resolves the mocked facade from --eval.
const ffi = await import("bun:ffi");
const library = ffi.dlopen(${JSON.stringify(systemLibraryPath)}, { open: { args: ["cstring", "i32"], returns: "i32" } });
const state = globalThis[Symbol.for(${JSON.stringify(guardSymbol)})];
state.phase = "post_admission";
let denied = "";
let descriptor = null;
try { descriptor = library.symbols.open(Buffer.from("relative\\0"), 0); } catch (error) { denied = error instanceof Error ? error.message : String(error); }
process.stdout.write(JSON.stringify({ denied, descriptor, events: state.events, rawEvents: state.rawEvents }));`,
          expected: {
            denied: "CONTRACT_TEST_AUTHORITY_DENIED:ffi_open",
            descriptor: null,
            events: ["ffi_open:relative"],
            rawEvents: []
          }
        },
        {
          script: `// Intentional child-loader probe: only a dynamic import resolves the mocked facade from --eval.
const ffi = await import("bun:ffi");
const library = ffi.dlopen(${JSON.stringify(systemLibraryPath)}, { unlink: { args: ["cstring"], returns: "i32" } });
const state = globalThis[Symbol.for(${JSON.stringify(guardSymbol)})];
state.phase = "post_admission";
let denied = "";
let result = null;
try { result = library.symbols.unlink(Buffer.from(${JSON.stringify(`${unlinkSentinel}\0`)})); } catch (error) { denied = error instanceof Error ? error.message : String(error); }
process.stdout.write(JSON.stringify({ denied, result, events: state.events, rawEvents: state.rawEvents }));`,
          expected: {
            denied: "CONTRACT_TEST_AUTHORITY_DENIED:ffi_unlink",
            result: null,
            events: ["ffi_unlink:"],
            rawEvents: []
          }
        }
      ] as const;
      for (const probe of probes) {
        expect(await guardedCommand(["--eval", probe.script])).toEqual({
          exit: 0,
          stdout: JSON.stringify(probe.expected),
          stderr: ""
        });
      }
      const stdinProbe = `// Intentional child-loader probe: only a dynamic import resolves the mocked facade from --eval.
const fs = await import("node:fs");
const state = globalThis[Symbol.for(${JSON.stringify(guardSymbol)})];
state.phase = "post_admission";
let denied = "";
try { fs.readFileSync(0); } catch (error) { denied = error instanceof Error ? error.message : String(error); }
const cursor = Buffer.alloc(0);
const cursorBytes = 0;
process.stdout.write(JSON.stringify({ denied, cursorBytes, cursor: cursor.subarray(0, cursorBytes).toString("utf8"), events: state.events, rawEvents: state.rawEvents }));`;
      expect(await guardedCommandWithControlledStdin(stdinProbe)).toEqual({
        exit: 0,
        stdout: JSON.stringify({
          denied: "CONTRACT_TEST_AUTHORITY_DENIED:node_fs_readFileSync",
          cursorBytes: 0,
          cursor: "",
          events: ["node_fs_readFileSync:"],
          rawEvents: []
        }),
        stderr: ""
      });
      expect(await readFile(input)).toEqual(inputBytes);
      expect(await readFile(unlinkSentinel)).toEqual(unlinkBytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps reflected Worker constructors and FFI close descriptors behind the guard", async () => {
    const root = await mkdtemp(join(tmpdir(), "shud-authority-reflection-"));
    const workerSentinel = join(root, "worker.sentinel");
    const workerPath = join(root, "worker.ts");
    await writeFile(workerPath, `await Bun.write(${JSON.stringify(workerSentinel)}, "worker-reflection");`);
    const guardSymbol = "shud.contract.authorityGuard";
    try {
      const workerProbe = `// Intentional child-loader probe: only dynamic imports resolve the mocked Worker facades from --eval.
const node = await import("node:worker_threads");
const bare = await import("worker_threads");
const state = globalThis[Symbol.for(${JSON.stringify(guardSymbol)})];
const workerUrl = new URL(${JSON.stringify(`file://${workerPath}`)});
const constructors = [globalThis.Worker, node.Worker, bare.Worker];
const denials = [];
const constructed = [];
const routesGuarded = [];
state.phase = "post_admission";
for (const constructor of constructors) {
  const routes = [
    constructor.prototype.constructor,
    Object.getOwnPropertyDescriptor(constructor.prototype, "constructor").value,
    Reflect.getOwnPropertyDescriptor(constructor.prototype, "constructor").value,
    Object.getOwnPropertyDescriptor(constructor, "prototype").value.constructor,
    Reflect.getOwnPropertyDescriptor(constructor, "prototype").value.constructor
  ];
  routesGuarded.push(...routes.map((route) => route === constructor));
  for (const route of routes) {
    try {
      const worker = new route(workerUrl);
      constructed.push(true);
      if (worker && typeof worker.terminate === "function") {
        const completion = worker.terminate();
        if (completion && typeof completion.then === "function") await completion;
      }
    } catch (error) {
      denials.push(error instanceof Error ? error.message : String(error));
    }
  }
}
process.stdout.write(JSON.stringify({ denials, constructed, routesGuarded, events: state.events, rawEvents: state.rawEvents }));`;
      expect(await guardedCommand(["--eval", workerProbe])).toEqual({
        exit: 0,
        stdout: JSON.stringify({
          denials: [
            "CONTRACT_TEST_AUTHORITY_DENIED:global_worker",
            "CONTRACT_TEST_AUTHORITY_DENIED:global_worker",
            "CONTRACT_TEST_AUTHORITY_DENIED:global_worker",
            "CONTRACT_TEST_AUTHORITY_DENIED:global_worker",
            "CONTRACT_TEST_AUTHORITY_DENIED:global_worker",
            "CONTRACT_TEST_AUTHORITY_DENIED:node_worker",
            "CONTRACT_TEST_AUTHORITY_DENIED:node_worker",
            "CONTRACT_TEST_AUTHORITY_DENIED:node_worker",
            "CONTRACT_TEST_AUTHORITY_DENIED:node_worker",
            "CONTRACT_TEST_AUTHORITY_DENIED:node_worker",
            "CONTRACT_TEST_AUTHORITY_DENIED:node_worker",
            "CONTRACT_TEST_AUTHORITY_DENIED:node_worker",
            "CONTRACT_TEST_AUTHORITY_DENIED:node_worker",
            "CONTRACT_TEST_AUTHORITY_DENIED:node_worker",
            "CONTRACT_TEST_AUTHORITY_DENIED:node_worker"
          ],
          constructed: [],
          routesGuarded: [
            true, true, true, true, true,
            true, true, true, true, true,
            true, true, true, true, true
          ],
          events: [
            "global_worker:", "global_worker:", "global_worker:", "global_worker:", "global_worker:",
            "node_worker:", "node_worker:", "node_worker:", "node_worker:", "node_worker:",
            "node_worker:", "node_worker:", "node_worker:", "node_worker:", "node_worker:"
          ],
          rawEvents: []
        }),
        stderr: ""
      });
      expect(await Bun.file(workerSentinel).exists()).toBe(false);

      const closeProbe = `// Intentional child-loader probe: only a dynamic import resolves the mocked FFI facade from --eval.
const ffi = await import("bun:ffi");
const library = ffi.dlopen(${JSON.stringify(systemLibraryPath)}, { getpid: { args: [], returns: "i32" } });
const state = globalThis[Symbol.for(${JSON.stringify(guardSymbol)})];
const descriptor = Object.getOwnPropertyDescriptor(library, "close");
const reflectedDescriptor = Reflect.getOwnPropertyDescriptor(library, "close");
if (!descriptor || !reflectedDescriptor || typeof descriptor.value !== "function" || typeof reflectedDescriptor.value !== "function") {
  throw new Error("AUTHORITY_FFI_CLOSE_DESCRIPTOR_MISSING");
}
const close = descriptor.value;
const reflectedClose = reflectedDescriptor.value;
const facade = Object.isFrozen(library) && Object.isFrozen(library.symbols) &&
  !descriptor.configurable && !descriptor.writable &&
  !reflectedDescriptor.configurable && !reflectedDescriptor.writable;
const denials = [];
state.phase = "post_admission";
for (const operation of [close, reflectedClose]) {
  try { operation(); } catch (error) { denials.push(error instanceof Error ? error.message : String(error)); }
}
process.stdout.write(JSON.stringify({ sameClose: close === reflectedClose, facade, denials, events: state.events, rawEvents: state.rawEvents }));`;
      expect(await guardedCommand(["--eval", closeProbe])).toEqual({
        exit: 0,
        stdout: JSON.stringify({
          sameClose: true,
          facade: true,
          denials: [
            "CONTRACT_TEST_AUTHORITY_DENIED:ffi_close",
            "CONTRACT_TEST_AUTHORITY_DENIED:ffi_close"
          ],
          events: [`ffi_close:${systemLibraryPath}`, `ffi_close:${systemLibraryPath}`],
          rawEvents: []
        }),
        stderr: ""
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects admission-created public resources after the one-way closure", async () => {
    const root = await mkdtemp(join(tmpdir(), "shud-authority-retained-public-"));
    const input = join(root, "input");
    const inputBytes = Buffer.from("authority-public-resource");
    await writeFile(input, inputBytes);
    const guardSymbol = "shud.contract.authorityGuard";
    try {
      const probe = `// Intentional child-loader probe: only dynamic imports resolve guarded facades from --eval.
const fs = await import("node:fs");
const promises = await import("node:fs/promises");
const fd = fs.openSync(${JSON.stringify(input)}, "r");
const handle = await promises.open(${JSON.stringify(input)}, "r");
const file = Bun.file(${JSON.stringify(input)});
const state = globalThis[Symbol.for(${JSON.stringify(guardSymbol)})];
state.phase = "post_admission";
const outcomes = [];
for (const [name, consume] of [
  ["bun_array_buffer", () => file.arrayBuffer()],
  ["bun_text", () => file.text()],
  ["file_handle_read", () => handle.read(Buffer.alloc(1))],
  ["file_handle_readv", () => handle.readv([Buffer.alloc(1)])],
  ["file_handle_read_lines", () => handle.readLines().next()],
  ["file_handle_readable_stream", () => handle.readableWebStream()],
  ["file_handle_writev", () => handle.writev([Buffer.alloc(1)])],
  ["raw_read", () => fs.readSync(fd, Buffer.alloc(1), 0, 1, null)],
  ["raw_stat", () => fs.fstatSync(fd)],
  ["raw_close", () => fs.closeSync(fd)]
]) {
  try {
    const value = await consume();
    outcomes.push([name, "returned", typeof value]);
  } catch (error) {
    outcomes.push([name, error instanceof Error ? error.message : String(error)]);
  }
}
process.stdout.write(JSON.stringify({ outcomes, events: state.events, rawEvents: state.rawEvents }));`;
      expect(await guardedCommand(["--eval", probe])).toEqual({
        exit: 0,
        stdout: JSON.stringify({
          outcomes: [
            ["bun_array_buffer", "CONTRACT_TEST_AUTHORITY_DENIED:bun_file"],
            ["bun_text", "CONTRACT_TEST_AUTHORITY_DENIED:bun_file"],
            ["file_handle_read", "CONTRACT_TEST_AUTHORITY_DENIED:node_fs_filehandle_read"],
            ["file_handle_readv", "CONTRACT_TEST_AUTHORITY_DENIED:node_fs_filehandle_read"],
            ["file_handle_read_lines", "CONTRACT_TEST_AUTHORITY_DENIED:node_fs_filehandle_read"],
            ["file_handle_readable_stream", "CONTRACT_TEST_AUTHORITY_DENIED:node_fs_filehandle_read"],
            ["file_handle_writev", "CONTRACT_TEST_AUTHORITY_DENIED:node_fs_filehandle_read"],
            ["raw_read", "CONTRACT_TEST_AUTHORITY_DENIED:node_fs_readSync"],
            ["raw_stat", "CONTRACT_TEST_AUTHORITY_DENIED:node_fs_fstatSync"],
            ["raw_close", "CONTRACT_TEST_AUTHORITY_DENIED:node_fs_closeSync"]
          ],
          events: [
            `bun_file:${normalizedAuthorityTarget(input)}`,
            `bun_file:${normalizedAuthorityTarget(input)}`,
            "node_fs_filehandle_read:",
            "node_fs_filehandle_read:",
            "node_fs_filehandle_read:",
            "node_fs_filehandle_read:",
            "node_fs_filehandle_read:",
            "node_fs_readSync:",
            "node_fs_fstatSync:",
            "node_fs_closeSync:"
          ],
          rawEvents: []
        }),
        stderr: ""
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects every admission-created BunFile consumer after closure", async () => {
    const root = await mkdtemp(join(tmpdir(), "shud-authority-bun-file-consumers-"));
    const names = ["stat", "write", "delete", "unlink"] as const;
    const paths = names.map((name) => join(root, name));
    const guardSymbol = "shud.contract.authorityGuard";
    await Promise.all(paths.map((path) => writeFile(path, "authority-public-resource")));
    try {
      const probe = `const paths = ${JSON.stringify(paths)};
const files = paths.map((path) => Bun.file(path));
const stat = files[0].stat;
const write = files[1].write;
const remove = files[2].delete;
const unlink = files[3].unlink;
const state = globalThis[Symbol.for(${JSON.stringify(guardSymbol)})];
state.phase = "post_admission";
const outcomes = [];
for (const [name, consume] of [
  ["bun_stat", () => stat.call(files[0])],
  ["bun_write", () => write.call(files[1], "changed")],
  ["bun_delete", () => remove.call(files[2])],
  ["bun_unlink", () => unlink.call(files[3])]
]) {
  try {
    const value = await consume();
    outcomes.push([name, "returned", typeof value]);
  } catch (error) {
    outcomes.push([name, error instanceof Error ? error.message : String(error)]);
  }
}
process.stdout.write(JSON.stringify({ outcomes, events: state.events, rawEvents: state.rawEvents }));`;
      expect(await guardedCommand(["--eval", probe])).toEqual({
        exit: 0,
        stdout: JSON.stringify({
          outcomes: [
            ["bun_stat", "CONTRACT_TEST_AUTHORITY_DENIED:bun_file"],
            ["bun_write", "CONTRACT_TEST_AUTHORITY_DENIED:bun_file"],
            ["bun_delete", "CONTRACT_TEST_AUTHORITY_DENIED:bun_file"],
            ["bun_unlink", "CONTRACT_TEST_AUTHORITY_DENIED:bun_file"]
          ],
          events: paths.map((path) => `bun_file:${normalizedAuthorityTarget(path)}`),
          rawEvents: []
        }),
        stderr: ""
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects ABI-shaped raw openat calls after closure", async () => {
    const root = await mkdtemp(join(tmpdir(), "shud-authority-openat-"));
    const guardSymbol = "shud.contract.authorityGuard";
    try {
      const probe = `// Intentional child-loader probe: only dynamic imports resolve guarded facades from --eval.
const fs = await import("node:fs");
const ffi = await import("bun:ffi");
const parent = fs.openSync(${JSON.stringify(root)}, "r");
const library = ffi.dlopen(${JSON.stringify(systemLibraryPath)}, {
  openat: { args: ["i32", "cstring", "i32"], returns: "i32" }
});
const state = globalThis[Symbol.for(${JSON.stringify(guardSymbol)})];
state.phase = "post_admission";
const outcomes = [];
for (const [parentFd, path] of [
  [parent, Buffer.from(".\\0")],
  [-100, Buffer.from(${JSON.stringify(`${root}\0`)})]
]) {
  try {
    outcomes.push(["returned", library.symbols.openat(parentFd, path, 0)]);
  } catch (error) {
    outcomes.push([error instanceof Error ? error.message : String(error)]);
  }
}
process.stdout.write(JSON.stringify({ outcomes, events: state.events, rawEvents: state.rawEvents }));`;
      expect(await guardedCommand(["--eval", probe])).toEqual({
        exit: 0,
        stdout: JSON.stringify({
          outcomes: [
            ["CONTRACT_TEST_AUTHORITY_DENIED:ffi_openat"],
            ["CONTRACT_TEST_AUTHORITY_DENIED:ffi_openat"]
          ],
          events: [`ffi_openat:.`, `ffi_openat:${root}`],
          rawEvents: []
        }),
        stderr: ""
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps phase closed and ignores forged inversion writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "shud-authority-state-"));
    const input = join(root, "input");
    await writeFile(input, "authority-state");
    const guardSymbol = "shud.contract.authorityGuard";
    try {
      const probe = `// Intentional child-loader probe: only dynamic imports resolve guarded facades from --eval.
const fs = await import("node:fs");
const key = Symbol.for(${JSON.stringify(guardSymbol)});
const state = globalThis[key];
const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
state.phase = "post_admission";
state.phase = "admission";
state.rawInversion = "node_fs_readFileSync";
let denial = "";
let text = "";
try { text = fs.readFileSync(${JSON.stringify(input)}, "utf8"); } catch (error) { denial = error instanceof Error ? error.message : String(error); }
state.rawInversion = null;
process.stdout.write(JSON.stringify({
  descriptor: { writable: descriptor?.writable, configurable: descriptor?.configurable, enumerable: descriptor?.enumerable },
  phase: state.phase,
  rawInversion: state.rawInversion,
  denial,
  text,
  events: state.events,
  rawEvents: state.rawEvents
}));`;
      expect(await guardedCommand(["--eval", probe])).toEqual({
        exit: 0,
        stdout: JSON.stringify({
          descriptor: { writable: false, configurable: false, enumerable: false },
          phase: "post_admission",
          rawInversion: null,
          denial: "CONTRACT_TEST_AUTHORITY_DENIED:node_fs_readFileSync",
          text: "",
          events: [`node_fs_readFileSync:${normalizedAuthorityTarget(input)}`],
          rawEvents: []
        }),
        stderr: ""
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("denies Bun.spawnSync after closure without creating its sentinel", async () => {
    const root = await mkdtemp(join(tmpdir(), "shud-authority-bun-spawn-sync-"));
    const sentinel = join(root, "spawn-sync.sentinel");
    const guardSymbol = "shud.contract.authorityGuard";
    try {
      const probe = `const state = globalThis[Symbol.for(${JSON.stringify(guardSymbol)})];
state.phase = "post_admission";
let denial = "";
try {
  Bun.spawnSync([process.execPath, "-e", ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "spawned")`)}]);
} catch (error) {
  denial = error instanceof Error ? error.message : String(error);
}
process.stdout.write(JSON.stringify({ denial, events: state.events, rawEvents: state.rawEvents }));`;
      expect(await guardedCommand(["--eval", probe])).toEqual({
        exit: 0,
        stdout: JSON.stringify({
          denial: "CONTRACT_TEST_AUTHORITY_DENIED:bun_spawn_sync",
          events: ["bun_spawn_sync:"],
          rawEvents: []
        }),
        stderr: ""
      });
      expect(await Bun.file(sentinel).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
