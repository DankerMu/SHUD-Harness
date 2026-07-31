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
  type DescriptorAuthorityDenial
} from "../lib/capabilities";
import { failure, validSourcePath } from "./helpers";
import { withProductionTree } from "./authority-descriptor-vocabulary";

type ActiveMode = "fd0" | "at_fdcwd";
type ChildResult = Readonly<{ exit: number | null; stdout: string; stderr: string; elapsedMs: number }>;
type RetainedFixture = Readonly<{
  root: string;
  directory: CapabilityDescriptor;
  file: CapabilityDescriptor;
  fileGeneration: number;
  bytes: Buffer;
  dispose: () => Promise<void>;
}>;

const preloadPath = join(import.meta.dir, "authority-descriptor-preload.ts");
const ACTIVE_PROOF_TIMEOUT_MS = 900;
const FIFO_BLOCK_INTERVAL_MS = 150;

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
): void {
  const count = denials.length;
  expect(() => { action(); }).toThrow("CONTRACT_CAPABILITY_DESCRIPTOR_DENIED");
  expect(denials).toHaveLength(count + 1);
  expect(denials[count]).toEqual(expected);
  expect(Object.isFrozen(denials[count]!)).toBe(true);
}

async function createRetainedFile(capabilities: ContractCapabilities): Promise<RetainedFixture> {
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
  expectedEvent: Readonly<Record<string, unknown>>
): Promise<void> {
  expect(result).toEqual(expect.objectContaining({
    exit: 2,
    stdout: "",
    stderr: failure("CONTRACT_SCHEMA_INVALID")
  }));
  const events = (await readFile(eventPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(events).toEqual([expectedEvent]);
  expect(await readFile(sideEffectPath, "utf8")).toBe("0\n");
}

describe("retained descriptor runtime authority", () => {
  test("policy and issued descriptors are frozen while a retained and verification chain stays usable", async () => {
    expect(Object.isFrozen(DESCRIPTOR_OPERATION_POLICY)).toBe(true);
    expect(Object.values(DESCRIPTOR_OPERATION_POLICY).every((policy) => Object.isFrozen(policy))).toBe(true);

    const denials: DescriptorAuthorityDenial[] = [];
    const capabilities = new ContractCapabilities({ onDescriptorAuthorityDenial: (denial) => { denials.push(denial); } });
    const fixture = await createRetainedFile(capabilities);
    try {
      expect(Object.isFrozen(fixture.file)).toBe(true);
      expect(Object.keys(fixture.file)).toEqual(["fd"]);
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
    try {
      for (const [operation, action] of [
        ["fstat_sync", () => capabilities.stat(foreign)],
        ["openat", () => capabilities.openRelative(foreign, "tmp", DIRECTORY_OPEN_FLAGS, "admission")],
        ["read_sync", () => capabilities.readRetained(foreign, Buffer.alloc(1), 0, 1, 0, "post_admission")],
        ["close_sync", () => capabilities.close(foreign, "unretained")]
      ] as const) {
        expectDenial(denials, action, {
          schema_version: "shud.contract.descriptor-denial.v1",
          operation,
          reason: "foreign_descriptor",
          descriptor: foreign.fd,
          generation: 1,
          phase: "admission"
        });
      }
      expect(foreignCapabilities.stat(foreign).isDirectory()).toBe(true);
    } finally {
      foreignCapabilities.close(foreign, "unretained");
    }
  });

  test("closed generations remain closed and become stale when the same numeric descriptor is reused", () => {
    const denials: DescriptorAuthorityDenial[] = [];
    const capabilities = new ContractCapabilities({ onDescriptorAuthorityDenial: (denial) => { denials.push(denial); } });
    const first = capabilities.openRoot("/", "admission");
    capabilities.close(first, "unretained");
    expectDenial(denials, () => capabilities.stat(first), {
      schema_version: "shud.contract.descriptor-denial.v1",
      operation: "fstat_sync",
      reason: "closed_descriptor",
      descriptor: first.fd,
      generation: 1,
      phase: "admission"
    });

    const current = capabilities.openRoot("/", "admission");
    try {
      expect(current.fd).toBe(first.fd);
      expect(capabilities.stat(current).isDirectory()).toBe(true);
      expectDenial(denials, () => capabilities.stat(first), {
        schema_version: "shud.contract.descriptor-denial.v1",
        operation: "fstat_sync",
        reason: "stale_descriptor",
        descriptor: first.fd,
        generation: 1,
        phase: "admission"
      });
    } finally {
      capabilities.close(current, "unretained");
    }
  });

  test("invalid flags, kind, owner, phase, and range are denied while the legitimate sibling remains usable", async () => {
    const denials: DescriptorAuthorityDenial[] = [];
    const capabilities = new ContractCapabilities({ onDescriptorAuthorityDenial: (denial) => { denials.push(denial); } });
    const root = capabilities.openRoot("/", "admission");
    expect(capabilities.stat(root).isDirectory()).toBe(true);
    expectDenial(denials, () => capabilities.markRetained(root, "file"), {
      schema_version: "shud.contract.descriptor-denial.v1",
      operation: "mark_retained",
      reason: "kind_mismatch",
      descriptor: root.fd,
      generation: 1,
      phase: "admission"
    });
    capabilities.markRetained(root, "directory");
    expectDenial(denials, () => capabilities.openRelative(root, "tmp", FILE_OPEN_FLAGS | (constants.O_APPEND ?? 1), "admission"), {
      schema_version: "shud.contract.descriptor-denial.v1",
      operation: "openat",
      reason: "flags_invalid",
      descriptor: root.fd,
      generation: 1,
      phase: "admission"
    });
    expectDenial(denials, () => capabilities.close(root, "verification"), {
      schema_version: "shud.contract.descriptor-denial.v1",
      operation: "close_sync",
      reason: "owner_mismatch",
      descriptor: root.fd,
      generation: 1,
      phase: "admission"
    });
    expect(capabilities.stat(root).isDirectory()).toBe(true);
    capabilities.close(root, "retained");

    const fileCapabilities = new ContractCapabilities({ onDescriptorAuthorityDenial: (denial) => { denials.push(denial); } });
    const fixture = await createRetainedFile(fileCapabilities);
    try {
      expectDenial(denials, () => fileCapabilities.readRetained(
        fixture.file,
        Buffer.alloc(1),
        0,
        1,
        0,
        "admission"
      ), {
        schema_version: "shud.contract.descriptor-denial.v1",
        operation: "read_sync",
        reason: "phase_invalid",
        descriptor: fixture.file.fd,
        generation: fixture.fileGeneration,
        phase: "admission"
      });
      expectDenial(denials, () => fileCapabilities.readRetained(
        fixture.file,
        Buffer.alloc(1),
        1,
        1,
        0,
        "post_admission"
      ), {
        schema_version: "shud.contract.descriptor-denial.v1",
        operation: "read_sync",
        reason: "range_invalid",
        descriptor: fixture.file.fd,
        generation: fixture.fileGeneration,
        phase: "admission"
      });
      const buffer = Buffer.alloc(fixture.bytes.length);
      expect(fileCapabilities.readRetained(fixture.file, buffer, 0, buffer.length, 0, "post_admission"))
        .toBe(fixture.bytes.length);
      expect(buffer).toEqual(fixture.bytes);
    } finally {
      await fixture.dispose();
    }
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
        });
      } finally {
        await chmod(join(proofRoot, "ambient-secret"), 0o600).catch(() => undefined);
        await rm(proofRoot, { recursive: true, force: true });
      }
    });
  });
});
