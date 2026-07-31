import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  ContractCapabilities,
  DESCRIPTOR_OPERATION_POLICY,
  DIRECTORY_OPEN_FLAGS,
  FILE_OPEN_FLAGS,
  type CapabilityDescriptor,
  type DescriptorAuthorityDenial,
  type DescriptorOperation
} from "../lib/capabilities";
import type { DescriptorIngressOperation } from "../lib/ingress";
import { failure, validSourcePath } from "./helpers";
import { withProductionTree } from "./authority-descriptor-vocabulary";

type ActiveMode = "fd0" | "at_fdcwd" | "fstat0" | "close0" | "lifecycle";
type ChildResult = Readonly<{ exit: number | null; stdout: string; stderr: string; elapsedMs: number }>;
type RawCallCounters = Readonly<{
  attempted: Readonly<Record<"openat" | "fstat_sync" | "read_sync" | "close_sync", number>>;
  intercepted: Readonly<Record<"openat" | "fstat_sync" | "read_sync" | "close_sync", number>>;
  native: Readonly<Record<"openat" | "fstat_sync" | "read_sync" | "close_sync", number>>;
  target_bytes: number;
}>;
type RetainedFixture = Readonly<{
  root: string;
  directory: CapabilityDescriptor;
  file: CapabilityDescriptor;
  fileGeneration: number;
  bytes: Buffer;
  dispose: () => Promise<void>;
}>;

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Value extends true> = Value;
type CanonicalDescriptorOperationVocabulary = Assert<Equal<
  DescriptorOperation,
  keyof typeof DESCRIPTOR_OPERATION_POLICY
>>;
type DescriptorIngressOperationVocabulary = Assert<Equal<
  DescriptorIngressOperation["operation"],
  "open_root" | "open_relative" | "read_retained"
>>;
const descriptorOperationVocabularyWitness: readonly [
  CanonicalDescriptorOperationVocabulary,
  DescriptorIngressOperationVocabulary
] = [true, true];

const preloadPath = join(import.meta.dir, "authority-descriptor-preload.ts");
const ACTIVE_PROOF_TIMEOUT_MS = 900;
const FIFO_BLOCK_INTERVAL_MS = 150;
const ZERO_RAW_CALL_COUNTERS: RawCallCounters = Object.freeze({
  attempted: Object.freeze({ openat: 0, fstat_sync: 0, read_sync: 0, close_sync: 0 }),
  intercepted: Object.freeze({ openat: 0, fstat_sync: 0, read_sync: 0, close_sync: 0 }),
  native: Object.freeze({ openat: 0, fstat_sync: 0, read_sync: 0, close_sync: 0 }),
  target_bytes: 0
});

const FD0_RAW_CALL_COUNTERS: RawCallCounters = Object.freeze({
  attempted: Object.freeze({ openat: 0, fstat_sync: 0, read_sync: 1, close_sync: 0 }),
  intercepted: Object.freeze({ openat: 0, fstat_sync: 0, read_sync: 1, close_sync: 0 }),
  native: ZERO_RAW_CALL_COUNTERS.native,
  target_bytes: 0
});
const AT_FDCWD_RAW_CALL_COUNTERS: RawCallCounters = Object.freeze({
  attempted: Object.freeze({ openat: 1, fstat_sync: 0, read_sync: 0, close_sync: 0 }),
  intercepted: Object.freeze({ openat: 1, fstat_sync: 0, read_sync: 0, close_sync: 0 }),
  native: ZERO_RAW_CALL_COUNTERS.native,
  target_bytes: 0
});
const FSTAT_RAW_CALL_COUNTERS: RawCallCounters = Object.freeze({
  attempted: Object.freeze({ openat: 0, fstat_sync: 1, read_sync: 0, close_sync: 0 }),
  intercepted: Object.freeze({ openat: 0, fstat_sync: 1, read_sync: 0, close_sync: 0 }),
  native: ZERO_RAW_CALL_COUNTERS.native,
  target_bytes: 0
});
const CLOSE_RAW_CALL_COUNTERS: RawCallCounters = Object.freeze({
  attempted: Object.freeze({ openat: 0, fstat_sync: 0, read_sync: 0, close_sync: 1 }),
  intercepted: Object.freeze({ openat: 0, fstat_sync: 0, read_sync: 0, close_sync: 1 }),
  native: ZERO_RAW_CALL_COUNTERS.native,
  target_bytes: 0
});

async function expectUnpreloadedFdZeroReadToBlock(
  checkPath: string,
  input: string,
  stdin: number
): Promise<void> {
  const child = spawn(
    process.execPath,
    [checkPath, "--input", input, "--kind", "source_input_record"],
    { stdio: [stdin, "ignore", "ignore"] }
  );
  let childExit: number | null | undefined;
  const reaped = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exit) => {
      childExit = exit;
      resolve();
    });
  });
  try {
    // This integration control observes a separate process blocked in readSync;
    // fake timers cannot advance that FIFO read.
    const remainedBlocked = await new Promise<boolean>((resolve, reject) => {
      const blockTimer = setTimeout(() => { resolve(true); }, FIFO_BLOCK_INTERVAL_MS);
      reaped.then(
        () => {
          clearTimeout(blockTimer);
          resolve(false);
        },
        (error) => {
          clearTimeout(blockTimer);
          reject(error);
        }
      );
    });
    if (!remainedBlocked) {
      throw new Error(`unpreloaded fd-zero control exited ${childExit ?? "without an exit code"} before the FIFO blocking interval`);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await reaped;
  }
}

function expectDenial(
  denials: DescriptorAuthorityDenial[],
  action: () => unknown,
  expected: Readonly<Record<string, unknown>>
): DescriptorAuthorityDenial {
  const count = denials.length;
  expect(() => { action(); }).toThrow("CONTRACT_CAPABILITY_DESCRIPTOR_DENIED");
  expect(denials).toHaveLength(count + 1);
  expect(denials[count]).toEqual(expected);
  expect(Object.isFrozen(denials[count]!)).toBe(true);
  return denials[count]!;
}

function opaqueDenial(
  operation: DescriptorOperation,
  reason: DescriptorAuthorityDenial["reason"],
  generation: number,
  phase: DescriptorAuthorityDenial["phase"],
  descriptor?: number
): Readonly<Record<string, unknown>> {
  return {
    schema_version: "shud.contract.descriptor-denial.v1",
    operation,
    reason,
    descriptor: descriptor ?? expect.any(Number),
    generation,
    phase
  };
}

async function createRetainedFile(
  capabilities: ContractCapabilities,
  sealAdmission = true
): Promise<RetainedFixture> {
  const root = await mkdtemp(join(tmpdir(), "shud-retained-descriptor-"));
  const bytes = Buffer.from('{"retained":"descriptor"}\n');
  const fileName = "retained.json";
  const physicalRoot = process.platform === "darwin" && ["/etc", "/tmp", "/var"].some(
    (alias) => root === alias || root.startsWith(`${alias}/`)
  ) ? `/private${root}` : root;
  const segments = [...physicalRoot.split("/").filter(Boolean), fileName];
  const retained: CapabilityDescriptor[] = [];
  try {
    await writeFile(join(root, fileName), bytes);
    let parent = capabilities.openRoot("/", "admission");
    if (!capabilities.stat(parent).isDirectory()) throw new Error("retained root is not a directory");
    capabilities.markRetained(parent, "directory");
    retained.push(parent);
    let directory = parent;
    let file = parent;
    for (let index = 0; index < segments.length; index += 1) {
      const final = index === segments.length - 1;
      const descriptor = capabilities.openRelative(
        parent,
        segments[index]!,
        final ? FILE_OPEN_FLAGS : DIRECTORY_OPEN_FLAGS,
        "admission"
      );
      const stats = capabilities.stat(descriptor);
      if (final ? !stats.isFile() : !stats.isDirectory()) throw new Error("retained fixture type changed");
      capabilities.markRetained(descriptor, final ? "file" : "directory");
      retained.push(descriptor);
      if (final) file = descriptor;
      else directory = descriptor;
      parent = descriptor;
    }
    if (sealAdmission) capabilities.sealAdmission();
    return Object.freeze({
      root,
      directory,
      file,
      fileGeneration: retained.length,
      bytes,
      dispose: async () => {
        for (let index = retained.length - 1; index >= 0; index -= 1) {
          capabilities.close(retained[index]!, "retained");
        }
        await rm(root, { recursive: true, force: true });
      }
    });
  } catch (error) {
    for (let index = retained.length - 1; index >= 0; index -= 1) {
      try {
        capabilities.close(retained[index]!, "retained");
      } catch {
        // Test-fixture cleanup must not hide the original setup error.
      }
    }
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function runBinary(command: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}`));
    });
  });
}

async function withConnectedNoWriterFifo(action: (stdinDescriptor: number) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "shud-descriptor-fifo-"));
  const fifo = join(root, "stdin");
  let holder: number | undefined;
  let reader: number | undefined;
  try {
    await runBinary("mkfifo", [fifo]);
    holder = openSync(fifo, constants.O_RDWR | (constants.O_NONBLOCK ?? 0));
    reader = openSync(fifo, constants.O_RDONLY);
    await action(reader);
  } finally {
    try {
      if (reader !== undefined) closeSync(reader);
    } finally {
      try {
        if (holder !== undefined) closeSync(holder);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
}

async function runPreloadedCheck(
  mode: ActiveMode,
  checkPath: string,
  input: string,
  eventPath: string,
  sideEffectPath: string,
  stdin: number | "ignore",
  cwd?: string
): Promise<ChildResult> {
  const started = performance.now();
  return await new Promise<ChildResult>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--preload", preloadPath, checkPath, "--input", input, "--kind", "source_input_record"],
      {
        cwd,
        env: {
          ...process.env,
          SHUD_DESCRIPTOR_PRELOAD_MODE: mode,
          SHUD_DESCRIPTOR_PRELOAD_EVENT_PATH: eventPath,
          SHUD_DESCRIPTOR_PRELOAD_SIDE_EFFECT_PATH: sideEffectPath
        },
        stdio: [stdin, "pipe", "pipe"]
      }
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    // This is the required live FIFO safety bound; fake timers cannot advance a blocked child process.
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, ACTIVE_PROOF_TIMEOUT_MS);
    let childError: Error | undefined;
    child.once("error", (error) => {
      childError = error;
    });
    child.stdout!.on("data", (chunk: Buffer) => { stdout.push(Buffer.from(chunk)); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr.push(Buffer.from(chunk)); });
    child.once("close", (exit) => {
      clearTimeout(timeout);
      if (childError) {
        reject(childError);
        return;
      }
      if (timedOut) {
        reject(new Error("descriptor active proof exceeded one second"));
        return;
      }
      resolve({
        exit,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        elapsedMs: performance.now() - started
      });
    });
  });
}

async function expectActiveDenial(
  result: ChildResult,
  eventPath: string,
  sideEffectPath: string,
  expectedEvent: Readonly<Record<string, unknown>>,
  expectedCounters: RawCallCounters
): Promise<void> {
  expect(result).toEqual(expect.objectContaining({
    exit: 2,
    stdout: "",
    stderr: failure("CONTRACT_SCHEMA_INVALID")
  }));
  const events = (await readFile(eventPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(events).toEqual([expectedEvent]);
  expect(JSON.parse(await readFile(sideEffectPath, "utf8"))).toEqual(expectedCounters);
}

describe("retained descriptor runtime authority", () => {
  test("policy has the canonical vocabulary while issued descriptors are opaque and a retained chain stays usable", async () => {
    expect(descriptorOperationVocabularyWitness).toEqual([true, true]);
    expect(Object.keys(DESCRIPTOR_OPERATION_POLICY).sort()).toEqual([
      "close_sync", "fstat_sync", "mark_retained", "open_root", "openat", "read_sync"
    ]);
    expect(Object.isFrozen(DESCRIPTOR_OPERATION_POLICY)).toBe(true);
    expect(Object.values(DESCRIPTOR_OPERATION_POLICY).every((policy) => Object.isFrozen(policy))).toBe(true);

    const denials: DescriptorAuthorityDenial[] = [];
    const capabilities = new ContractCapabilities({ onDescriptorAuthorityDenial: (denial) => { denials.push(denial); } });
    const fixture = await createRetainedFile(capabilities);
    try {
      expect(Object.isFrozen(fixture.file)).toBe(true);
      expect(Reflect.ownKeys(fixture.file)).toEqual([]);
      expect(Object.getOwnPropertyNames(fixture.file)).toEqual([]);
      expect(Object.getOwnPropertySymbols(fixture.file)).toEqual([]);
      expect(JSON.stringify(fixture.file)).toBe("{}");
      const buffer = Buffer.alloc(fixture.bytes.length);
      expect(capabilities.readRetained(fixture.file, buffer, 0, buffer.length, 0, "post_admission")).toBe(buffer.length);
      expect(buffer).toEqual(fixture.bytes);

      const verification = capabilities.openRelative(
        fixture.directory,
        basename(join(fixture.root, "retained.json")),
        FILE_OPEN_FLAGS,
        "post_admission"
      );
      expect(capabilities.stat(verification).isFile()).toBe(true);
      capabilities.close(verification, "verification");
      expect(denials).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  test("raw descriptors and an unproven AT_FDCWD parent are denied before every raw primitive", () => {
    const denials: DescriptorAuthorityDenial[] = [];
    const capabilities = new ContractCapabilities({ onDescriptorAuthorityDenial: (denial) => { denials.push(denial); } });
    const raw = 0 as unknown as CapabilityDescriptor;
    expectDenial(denials, () => capabilities.stat(raw), {
      schema_version: "shud.contract.descriptor-denial.v1",
      operation: "fstat_sync",
      reason: "unproven_descriptor",
      descriptor: 0,
      generation: null,
      phase: null
    });
    expectDenial(denials, () => capabilities.openRelative(
      -100 as unknown as CapabilityDescriptor,
      "ambient-secret",
      FILE_OPEN_FLAGS,
      "post_admission"
    ), {
      schema_version: "shud.contract.descriptor-denial.v1",
      operation: "openat",
      reason: "unproven_parent",
      descriptor: -100,
      generation: null,
      phase: "post_admission"
    });
    expectDenial(denials, () => capabilities.readRetained(raw, Buffer.alloc(1), 0, 1, 0, "post_admission"), {
      schema_version: "shud.contract.descriptor-denial.v1",
      operation: "read_sync",
      reason: "unproven_descriptor",
      descriptor: 0,
      generation: null,
      phase: "post_admission"
    });
    expectDenial(denials, () => capabilities.close(raw, "unretained"), {
      schema_version: "shud.contract.descriptor-denial.v1",
      operation: "close_sync",
      reason: "unproven_descriptor",
      descriptor: 0,
      generation: null,
      phase: null
    });
  });

  test("foreign handles are rejected by stat, open, read, and close without consuming the foreign capability", () => {
    const foreignCapabilities = new ContractCapabilities();
    const foreign = foreignCapabilities.openRoot("/", "admission");
    const denials: DescriptorAuthorityDenial[] = [];
    const capabilities = new ContractCapabilities({ onDescriptorAuthorityDenial: (denial) => { denials.push(denial); } });
    let foreignDescriptor: number | undefined;
    try {
      for (const [operation, action] of [
        ["fstat_sync", () => capabilities.stat(foreign)],
        ["openat", () => capabilities.openRelative(foreign, "tmp", DIRECTORY_OPEN_FLAGS, "admission")],
        ["read_sync", () => capabilities.readRetained(foreign, Buffer.alloc(1), 0, 1, 0, "post_admission")],
        ["close_sync", () => capabilities.close(foreign, "unretained")]
      ] as const) {
        const denial = expectDenial(
          denials,
          action,
          opaqueDenial(operation, "foreign_descriptor", 1, "admission", foreignDescriptor)
        );
        if (foreignDescriptor === undefined) {
          if (typeof denial.descriptor !== "number") throw new Error("foreign denial must retain its numeric descriptor");
          foreignDescriptor = denial.descriptor;
        }
      }
      expect(foreignCapabilities.stat(foreign).isDirectory()).toBe(true);
    } finally {
      foreignCapabilities.close(foreign, "unretained");
    }
  });

  test("closed and stale generations reject every applicable primitive while the current same-number sibling remains usable", () => {
    const denials: DescriptorAuthorityDenial[] = [];
    const capabilities = new ContractCapabilities({ onDescriptorAuthorityDenial: (denial) => { denials.push(denial); } });
    const first = capabilities.openRoot("/", "admission");
    capabilities.close(first, "unretained");
    let closedDescriptor: number | undefined;
    for (const [operation, action] of [
      ["fstat_sync", () => capabilities.stat(first)],
      ["openat", () => capabilities.openRelative(first, "tmp", DIRECTORY_OPEN_FLAGS, "admission")],
      ["read_sync", () => capabilities.readRetained(first, Buffer.alloc(1), 0, 1, 0, "post_admission")],
      ["close_sync", () => capabilities.close(first, "unretained")]
    ] as const) {
      const denial = expectDenial(
        denials,
        action,
        opaqueDenial(operation, "closed_descriptor", 1, "admission", closedDescriptor)
      );
      if (closedDescriptor === undefined) {
        if (typeof denial.descriptor !== "number") throw new Error("closed denial must retain its numeric descriptor");
        closedDescriptor = denial.descriptor;
      }
    }

    const current = capabilities.openRoot("/", "admission");
    try {
      const currentOwnerDenial = expectDenial(
        denials,
        () => capabilities.close(current, "retained"),
        opaqueDenial("close_sync", "owner_mismatch", 2, "admission")
      );
      expect(currentOwnerDenial.descriptor).toBe(closedDescriptor);
      expect(capabilities.stat(current).isDirectory()).toBe(true);
      for (const [operation, action] of [
        ["fstat_sync", () => capabilities.stat(first)],
        ["openat", () => capabilities.openRelative(first, "tmp", DIRECTORY_OPEN_FLAGS, "admission")],
        ["read_sync", () => capabilities.readRetained(first, Buffer.alloc(1), 0, 1, 0, "post_admission")],
        ["close_sync", () => capabilities.close(first, "unretained")]
      ] as const) {
        expectDenial(
          denials,
          action,
          opaqueDenial(operation, "stale_descriptor", 1, "admission", closedDescriptor)
        );
      }
    } finally {
      capabilities.close(current, "unretained");
    }
  });

  test("invalid flags, kind, owner, phase, and range deny while the legitimate retained sibling remains usable", async () => {
    const denials: DescriptorAuthorityDenial[] = [];
    const capabilities = new ContractCapabilities({ onDescriptorAuthorityDenial: (denial) => { denials.push(denial); } });
    const root = capabilities.openRoot("/", "admission");
    expect(capabilities.stat(root).isDirectory()).toBe(true);
    const kindDenial = expectDenial(
      denials,
      () => capabilities.markRetained(root, "file"),
      opaqueDenial("mark_retained", "kind_mismatch", 1, "admission")
    );
    if (typeof kindDenial.descriptor !== "number") throw new Error("kind denial must retain its numeric descriptor");
    capabilities.markRetained(root, "directory");
    expectDenial(
      denials,
      () => capabilities.openRelative(root, "tmp", FILE_OPEN_FLAGS | (constants.O_APPEND ?? 1), "admission"),
      opaqueDenial("openat", "flags_invalid", 1, "admission", kindDenial.descriptor)
    );
    expectDenial(
      denials,
      () => capabilities.close(root, "verification"),
      opaqueDenial("close_sync", "owner_mismatch", 1, "admission", kindDenial.descriptor)
    );
    expect(capabilities.stat(root).isDirectory()).toBe(true);
    capabilities.close(root, "retained");

    const fileCapabilities = new ContractCapabilities({ onDescriptorAuthorityDenial: (denial) => { denials.push(denial); } });
    const fixture = await createRetainedFile(fileCapabilities);
    try {
      const phaseDenial = expectDenial(
        denials,
        () => fileCapabilities.readRetained(fixture.file, Buffer.alloc(1), 0, 1, 0, "admission"),
        opaqueDenial("read_sync", "phase_invalid", fixture.fileGeneration, "admission")
      );
      if (typeof phaseDenial.descriptor !== "number") throw new Error("phase denial must retain its numeric descriptor");
      expectDenial(
        denials,
        () => fileCapabilities.readRetained(fixture.file, Buffer.alloc(1), 1, 1, 0, "post_admission"),
        opaqueDenial("read_sync", "range_invalid", fixture.fileGeneration, "admission", phaseDenial.descriptor)
      );
      const buffer = Buffer.alloc(fixture.bytes.length);
      expect(fileCapabilities.readRetained(fixture.file, buffer, 0, buffer.length, 0, "post_admission"))
        .toBe(fixture.bytes.length);
      expect(buffer).toEqual(fixture.bytes);
    } finally {
      await fixture.dispose();
    }
  });

  test("the admission seal rejects phase spoofing, late promotion, and nonretained reads while retained siblings stay usable", async () => {
    const denials: DescriptorAuthorityDenial[] = [];
    const capabilities = new ContractCapabilities({ onDescriptorAuthorityDenial: (denial) => { denials.push(denial); } });
    const fixture = await createRetainedFile(capabilities, false);
    let pending: CapabilityDescriptor | undefined;
    let verification: CapabilityDescriptor | undefined;
    try {
      const prematurePostOpen = expectDenial(
        denials,
        () => capabilities.openRelative(
          fixture.directory,
          basename(join(fixture.root, "retained.json")),
          FILE_OPEN_FLAGS,
          "post_admission"
        ),
        opaqueDenial("openat", "phase_invalid", fixture.fileGeneration - 1, "admission")
      );
      if (typeof prematurePostOpen.descriptor !== "number") {
        throw new Error("premature post-admission open must retain its numeric parent descriptor");
      }
      const prematureRead = expectDenial(
        denials,
        () => capabilities.readRetained(fixture.file, Buffer.alloc(1), 0, 1, 0, "post_admission"),
        opaqueDenial("read_sync", "phase_invalid", fixture.fileGeneration, "admission")
      );
      if (typeof prematureRead.descriptor !== "number") {
        throw new Error("premature post-admission read must retain its numeric descriptor");
      }

      pending = capabilities.openRelative(
        fixture.directory,
        basename(join(fixture.root, "retained.json")),
        FILE_OPEN_FLAGS,
        "admission"
      );
      expect(capabilities.stat(pending).isFile()).toBe(true);
      capabilities.sealAdmission();

      expectDenial(denials, () => capabilities.openRoot("/", "admission"), {
        schema_version: "shud.contract.descriptor-denial.v1",
        operation: "open_root",
        reason: "phase_invalid",
        descriptor: null,
        generation: null,
        phase: null
      });
      expectDenial(
        denials,
        () => capabilities.openRelative(
          fixture.directory,
          basename(join(fixture.root, "retained.json")),
          FILE_OPEN_FLAGS,
          "admission"
        ),
        opaqueDenial(
          "openat",
          "phase_invalid",
          fixture.fileGeneration - 1,
          "admission",
          prematurePostOpen.descriptor
        )
      );
      const latePromotion = expectDenial(
        denials,
        () => capabilities.markRetained(pending!, "file"),
        opaqueDenial("mark_retained", "phase_invalid", fixture.fileGeneration + 1, "admission")
      );
      if (typeof latePromotion.descriptor !== "number") {
        throw new Error("late promotion must retain its numeric descriptor");
      }

      verification = capabilities.openRelative(
        fixture.directory,
        basename(join(fixture.root, "retained.json")),
        FILE_OPEN_FLAGS,
        "post_admission"
      );
      expect(capabilities.stat(verification).isFile()).toBe(true);
      const verificationPromotion = expectDenial(
        denials,
        () => capabilities.markRetained(verification!, "file"),
        opaqueDenial("mark_retained", "state_invalid", fixture.fileGeneration + 2, "post_admission")
      );
      if (typeof verificationPromotion.descriptor !== "number") {
        throw new Error("verification promotion must retain its numeric descriptor");
      }
      expectDenial(
        denials,
        () => capabilities.readRetained(verification!, Buffer.alloc(1), 0, 1, 0, "post_admission"),
        opaqueDenial(
          "read_sync",
          "state_invalid",
          fixture.fileGeneration + 2,
          "post_admission",
          verificationPromotion.descriptor
        )
      );
      expectDenial(
        denials,
        () => capabilities.readRetained(fixture.directory, Buffer.alloc(1), 0, 1, 0, "post_admission"),
        opaqueDenial(
          "read_sync",
          "kind_mismatch",
          fixture.fileGeneration - 1,
          "admission",
          prematurePostOpen.descriptor
        )
      );
      expectDenial(
        denials,
        () => capabilities.close(fixture.file, "verification"),
        opaqueDenial(
          "close_sync",
          "owner_mismatch",
          fixture.fileGeneration,
          "admission",
          prematureRead.descriptor
        )
      );
      expectDenial(
        denials,
        () => capabilities.close(pending!, "retained"),
        opaqueDenial("close_sync", "owner_mismatch", fixture.fileGeneration + 1, "admission", latePromotion.descriptor)
      );
      capabilities.close(pending, "unretained");
      pending = undefined;
      expectDenial(
        denials,
        () => capabilities.close(verification!, "retained"),
        opaqueDenial(
          "close_sync",
          "owner_mismatch",
          fixture.fileGeneration + 2,
          "post_admission",
          verificationPromotion.descriptor
        )
      );
      capabilities.close(verification, "verification");
      verification = undefined;

      const buffer = Buffer.alloc(fixture.bytes.length);
      expect(capabilities.readRetained(fixture.file, buffer, 0, buffer.length, 0, "post_admission"))
        .toBe(fixture.bytes.length);
      expect(buffer).toEqual(fixture.bytes);
    } finally {
      if (verification) {
        try {
          capabilities.close(verification, "verification");
        } catch {
          // Test-fixture cleanup must not hide a lifecycle assertion failure.
        }
      }
      if (pending) {
        try {
          capabilities.close(pending, "unretained");
        } catch {
          // Test-fixture cleanup must not hide a lifecycle assertion failure.
        }
      }
      await fixture.dispose();
    }
  });

  test("a reported close failure invalidates its generation before same-number reuse", () => {
    const denials: DescriptorAuthorityDenial[] = [];
    const capabilities = new ContractCapabilities({
      closeFault: () => true,
      onDescriptorAuthorityDenial: (denial) => { denials.push(denial); }
    });
    const first = capabilities.openRoot("/", "admission");
    expect(() => capabilities.close(first, "unretained")).toThrow("CONTRACT_CAPABILITY_CLOSE_FAILED");
    const closed = expectDenial(
      denials,
      () => capabilities.stat(first),
      opaqueDenial("fstat_sync", "closed_descriptor", 1, "admission")
    );
    if (typeof closed.descriptor !== "number") throw new Error("closed generation must retain its numeric descriptor");

    const current = capabilities.openRoot("/", "admission");
    try {
      const currentOwnerDenial = expectDenial(
        denials,
        () => capabilities.close(current, "retained"),
        opaqueDenial("close_sync", "owner_mismatch", 2, "admission")
      );
      expect(currentOwnerDenial.descriptor).toBe(closed.descriptor);
      expect(capabilities.stat(current).isDirectory()).toBe(true);
      expectDenial(
        denials,
        () => capabilities.stat(first),
        opaqueDenial("fstat_sync", "stale_descriptor", 1, "admission", closed.descriptor)
      );
    } finally {
      expect(() => capabilities.close(current, "unretained")).toThrow("CONTRACT_CAPABILITY_CLOSE_FAILED");
    }
  });

  test("raw, foreign, stale, and owner-mismatch lifecycle denials make zero native descriptor calls", async () => {
    await withProductionTree(undefined, async (tree) => {
      const runnerPath = join(tree.root, "lifecycle-denials.ts");
      const proofRoot = await mkdtemp(join(tmpdir(), "shud-descriptor-lifecycle-counters-"));
      try {
        const eventPath = join(proofRoot, "events.jsonl");
        const sideEffectPath = join(proofRoot, "side-effects.json");
        await writeFile(runnerPath, `
import { ContractCapabilities } from "./lib/capabilities";

const denials = [];
const capabilities = new ContractCapabilities({
  onDescriptorAuthorityDenial: (denial) => { denials.push(denial); }
});
const foreignCapabilities = new ContractCapabilities();
const foreign = foreignCapabilities.openRoot("/", "admission");
const first = capabilities.openRoot("/", "admission");
capabilities.close(first, "unretained");
const current = capabilities.openRoot("/", "admission");
const owner = capabilities.openRoot("/", "admission");
const rejected = (action: () => unknown): void => {
  try {
    action();
  } catch {
    // The parent assertion validates the complete denial sequence.
  }
};

process.env.SHUD_DESCRIPTOR_PRELOAD_COUNTER_PHASE = "action";
rejected(() => capabilities.stat(0 as never));
rejected(() => capabilities.close(0 as never, "unretained"));
rejected(() => capabilities.stat(foreign));
rejected(() => capabilities.close(foreign, "unretained"));
rejected(() => capabilities.stat(first));
rejected(() => capabilities.close(first, "unretained"));
rejected(() => capabilities.close(owner, "retained"));
process.env.SHUD_DESCRIPTOR_PRELOAD_COUNTER_PHASE = "cleanup";

capabilities.close(current, "unretained");
capabilities.close(owner, "unretained");
foreignCapabilities.close(foreign, "unretained");
process.stdout.write(JSON.stringify(denials));
`);
        const result = await runPreloadedCheck(
          "lifecycle",
          runnerPath,
          "/dev/null",
          eventPath,
          sideEffectPath,
          "ignore"
        );
        expect(result).toEqual(expect.objectContaining({ exit: 0, stderr: "" }));
        const denials = (JSON.parse(result.stdout) as DescriptorAuthorityDenial[]).map(
          ({ operation, reason }) => ({ operation, reason })
        );
        expect(denials).toEqual([
          { operation: "fstat_sync", reason: "unproven_descriptor" },
          { operation: "close_sync", reason: "unproven_descriptor" },
          { operation: "fstat_sync", reason: "foreign_descriptor" },
          { operation: "close_sync", reason: "foreign_descriptor" },
          { operation: "fstat_sync", reason: "stale_descriptor" },
          { operation: "close_sync", reason: "stale_descriptor" },
          { operation: "close_sync", reason: "owner_mismatch" }
        ]);
        expect(JSON.parse(await readFile(sideEffectPath, "utf8"))).toEqual(ZERO_RAW_CALL_COUNTERS);
      } finally {
        await rm(proofRoot, { recursive: true, force: true });
      }
    });
  });

  test("unpreloaded fd-zero mutation remains blocked on a connected no-writer FIFO", async () => {
    await withProductionTree("fd0", async (tree) => {
      const proofRoot = await mkdtemp(join(tmpdir(), "shud-descriptor-control-fd0-"));
      try {
        const input = join(proofRoot, "input.json");
        await writeFile(input, await readFile(validSourcePath));
        await withConnectedNoWriterFifo((stdin) =>
          expectUnpreloadedFdZeroReadToBlock(tree.checkPath, input, stdin)
        );
      } finally {
        await rm(proofRoot, { recursive: true, force: true });
      }
    });
  });

  test("active fd-zero mutation denies before a connected no-writer FIFO read within one second", async () => {
    await withProductionTree("fd0", async (tree) => {
      const proofRoot = await mkdtemp(join(tmpdir(), "shud-descriptor-active-fd0-"));
      try {
        const input = join(proofRoot, "input.json");
        const eventPath = join(proofRoot, "events.jsonl");
        const sideEffectPath = join(proofRoot, "side-effects.txt");
        await writeFile(input, await readFile(validSourcePath));
        await withConnectedNoWriterFifo(async (stdin) => {
          const result = await runPreloadedCheck("fd0", tree.checkPath, input, eventPath, sideEffectPath, stdin);
          expect(result.elapsedMs).toBeLessThanOrEqual(1_000);
          await expectActiveDenial(result, eventPath, sideEffectPath, {
            schema_version: "shud.contract.descriptor-denial.v1",
            operation: "read_sync",
            reason: "unproven_descriptor",
            descriptor: 0,
            generation: null,
            phase: "post_admission"
          }, FD0_RAW_CALL_COUNTERS);
        });
      } finally {
        await rm(proofRoot, { recursive: true, force: true });
      }
    });
  });

  test("active fstat and close mutations are independently intercepted before native descriptor calls", async () => {
    for (const [mutation, mode, expectedEvent, expectedCounters] of [
      [
        "fstat0",
        "fstat0",
        {
          schema_version: "shud.contract.descriptor-denial.v1",
          operation: "fstat_sync",
          reason: "unproven_descriptor",
          descriptor: 0,
          generation: null,
          phase: "post_admission"
        },
        FSTAT_RAW_CALL_COUNTERS
      ],
      [
        "close0",
        "close0",
        {
          schema_version: "shud.contract.descriptor-denial.v1",
          operation: "close_sync",
          reason: "unproven_descriptor",
          descriptor: 0,
          generation: null,
          phase: "post_admission"
        },
        CLOSE_RAW_CALL_COUNTERS
      ]
    ] as const) {
      await withProductionTree(mutation, async (tree) => {
        const proofRoot = await mkdtemp(join(tmpdir(), `shud-descriptor-active-${mutation}-`));
        try {
          const input = join(proofRoot, "input.json");
          const eventPath = join(proofRoot, "events.jsonl");
          const sideEffectPath = join(proofRoot, "side-effects.json");
          await writeFile(input, await readFile(validSourcePath));
          const result = await runPreloadedCheck(mode, tree.checkPath, input, eventPath, sideEffectPath, "ignore");
          await expectActiveDenial(result, eventPath, sideEffectPath, expectedEvent, expectedCounters);
        } finally {
          await rm(proofRoot, { recursive: true, force: true });
        }
      });
    }
  });

  test("a native raw call before the interception turns the active counter proof red", async () => {
    await withProductionTree("before_deny_fstat", async (tree) => {
      const proofRoot = await mkdtemp(join(tmpdir(), "shud-descriptor-active-before-deny-"));
      try {
        const input = join(proofRoot, "input.json");
        const eventPath = join(proofRoot, "events.jsonl");
        const sideEffectPath = join(proofRoot, "side-effects.json");
        await writeFile(input, await readFile(validSourcePath));
        await withConnectedNoWriterFifo(async (stdin) => {
          const result = await runPreloadedCheck("fd0", tree.checkPath, input, eventPath, sideEffectPath, stdin);
          await expect(expectActiveDenial(
            result,
            eventPath,
            sideEffectPath,
            {
              schema_version: "shud.contract.descriptor-denial.v1",
              operation: "read_sync",
              reason: "unproven_descriptor",
              descriptor: 0,
              generation: null,
              phase: "post_admission"
            },
            FD0_RAW_CALL_COUNTERS
          )).rejects.toThrow();
          expect(JSON.parse(await readFile(sideEffectPath, "utf8"))).toEqual({
            attempted: { openat: 0, fstat_sync: 1, read_sync: 1, close_sync: 0 },
            intercepted: { openat: 0, fstat_sync: 0, read_sync: 1, close_sync: 0 },
            native: { openat: 0, fstat_sync: 1, read_sync: 0, close_sync: 0 },
            target_bytes: 0
          });
        });
      } finally {
        await rm(proofRoot, { recursive: true, force: true });
      }
    });
  });

  const linuxTest = process.platform === "linux" ? test : test.skip;
  linuxTest("active AT_FDCWD mutation denies before opening the unread cwd sentinel", async () => {
    await withProductionTree("at_fdcwd", async (tree) => {
      const proofRoot = await mkdtemp(join(tmpdir(), "shud-descriptor-active-at-fdcwd-"));
      try {
        const input = join(proofRoot, "input.json");
        const eventPath = join(proofRoot, "events.jsonl");
        const sideEffectPath = join(proofRoot, "side-effects.txt");
        const sentinel = join(proofRoot, "ambient-secret");
        await writeFile(input, await readFile(validSourcePath));
        await writeFile(sentinel, "unread cwd sentinel");
        await chmod(sentinel, 0o000);
        const result = await runPreloadedCheck(
          "at_fdcwd",
          tree.checkPath,
          input,
          eventPath,
          sideEffectPath,
          "ignore",
          proofRoot
        );
        await expectActiveDenial(result, eventPath, sideEffectPath, {
          schema_version: "shud.contract.descriptor-denial.v1",
          operation: "openat",
          reason: "unproven_parent",
          descriptor: -100,
          generation: null,
          phase: "post_admission"
        }, AT_FDCWD_RAW_CALL_COUNTERS);
      } finally {
        await chmod(join(proofRoot, "ambient-secret"), 0o600).catch(() => undefined);
        await rm(proofRoot, { recursive: true, force: true });
      }
    });
  });
});
