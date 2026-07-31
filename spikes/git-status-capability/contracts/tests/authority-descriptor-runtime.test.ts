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
import { failure, validSourcePath } from "./helpers";
import {
  withProductionTree,
  type AuditIdentityMutation,
  type GuardOrderMutation
} from "./authority-descriptor-vocabulary";

type ActiveMode = "fd0" | "at_fdcwd" | "fstat0" | "close0" | "lifecycle" | "guard_order";
type ChildResult = Readonly<{ exit: number | null; stdout: string; stderr: string; elapsedMs: number }>;
type RawCallCounters = Readonly<{
  attempted: Readonly<Record<"openat" | "fstat_sync" | "read_sync" | "close_sync", number>>;
  intercepted: Readonly<Record<"openat" | "fstat_sync" | "read_sync" | "close_sync", number>>;
  native: Readonly<Record<"openat" | "fstat_sync" | "read_sync" | "close_sync", number>>;
  target_bytes: number;
}>;

type GuardOrderScenario =
  | "sealed_open_root"
  | "open_relative_preseal_post"
  | "open_relative_sealed_admission"
  | "open_relative_invalid_flags"
  | "open_relative_invalid_state"
  | "read_premature_post"
  | "read_verification"
  | "read_nonretained"
  | "read_wrong_phase";
type GuardOrderCounters = Readonly<{
  attempted: Readonly<Record<"open_sync" | "openat" | "read_sync", number>>;
  intercepted: Readonly<Record<"open_sync" | "openat" | "read_sync", number>>;
  native: Readonly<Record<"open_sync" | "openat" | "read_sync", number>>;
  target_bytes: number;
}>;
type GuardOrderReceipt = Readonly<{
  denials: readonly DescriptorAuthorityDenial[];
  sibling: boolean;
  targetLabel: string | null;
  targetGeneration: number | null;
}>;
type GuardOrderProof = Readonly<{
  result: ChildResult;
  receipt: GuardOrderReceipt;
  counters: GuardOrderCounters;
  audit: readonly Readonly<{ label: string; descriptor: number }>[];
}>;
type AuditIdentityProof = Readonly<{
  result: ChildResult;
  denials: readonly DescriptorAuthorityDenial[];
  audit: readonly Readonly<{ label: string; descriptor: number }>[];
}>;
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

const ZERO_GUARD_ORDER_COUNTERS: GuardOrderCounters = Object.freeze({
  attempted: Object.freeze({ open_sync: 0, openat: 0, read_sync: 0 }),
  intercepted: Object.freeze({ open_sync: 0, openat: 0, read_sync: 0 }),
  native: Object.freeze({ open_sync: 0, openat: 0, read_sync: 0 }),
  target_bytes: 0
});
const GUARD_ORDER_EXPECTATIONS: Readonly<Record<GuardOrderScenario, Readonly<{
  mutation: GuardOrderMutation;
  operation: DescriptorOperation;
  reason: DescriptorAuthorityDenial["reason"];
  phase: DescriptorAuthorityDenial["phase"];
  native: keyof GuardOrderCounters["native"];
}>>> = Object.freeze({
  sealed_open_root: {
    mutation: "guard_open_root",
    operation: "open_root",
    reason: "phase_invalid",
    phase: null,
    native: "open_sync"
  },
  open_relative_preseal_post: {
    mutation: "guard_open_relative",
    operation: "openat",
    reason: "phase_invalid",
    phase: "admission",
    native: "openat"
  },
  open_relative_sealed_admission: {
    mutation: "guard_open_relative",
    operation: "openat",
    reason: "phase_invalid",
    phase: "admission",
    native: "openat"
  },
  open_relative_invalid_flags: {
    mutation: "guard_open_relative",
    operation: "openat",
    reason: "flags_invalid",
    phase: "admission",
    native: "openat"
  },
  open_relative_invalid_state: {
    mutation: "guard_open_relative",
    operation: "openat",
    reason: "state_invalid",
    phase: "admission",
    native: "openat"
  },
  read_premature_post: {
    mutation: "guard_read_retained",
    operation: "read_sync",
    reason: "phase_invalid",
    phase: "admission",
    native: "read_sync"
  },
  read_verification: {
    mutation: "guard_read_retained",
    operation: "read_sync",
    reason: "state_invalid",
    phase: "post_admission",
    native: "read_sync"
  },
  read_nonretained: {
    mutation: "guard_read_retained",
    operation: "read_sync",
    reason: "state_invalid",
    phase: "admission",
    native: "read_sync"
  },
  read_wrong_phase: {
    mutation: "guard_read_retained",
    operation: "read_sync",
    reason: "phase_invalid",
    phase: "admission",
    native: "read_sync"
  }
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

/**
 * Exact numeric receipt identity is bound independently by the preloaded
 * audit fixture below. These direct behavior rows retain the other frozen
 * fields and require a numeric issued-handle descriptor without deriving it
 * from an earlier denial.
 */
function expectIssuedDenial(
  denials: DescriptorAuthorityDenial[],
  action: () => unknown,
  operation: DescriptorOperation,
  reason: DescriptorAuthorityDenial["reason"],
  generation: number,
  phase: DescriptorAuthorityDenial["phase"]
): DescriptorAuthorityDenial {
  const count = denials.length;
  expect(() => { action(); }).toThrow("CONTRACT_CAPABILITY_DESCRIPTOR_DENIED");
  expect(denials).toHaveLength(count + 1);
  const denial = denials[count]!;
  expect(denial.schema_version).toBe("shud.contract.descriptor-denial.v1");
  expect(denial.operation).toBe(operation);
  expect(denial.reason).toBe(reason);
  expect(typeof denial.descriptor).toBe("number");
  expect(denial.generation).toBe(generation);
  expect(denial.phase).toBe(phase);
  expect(Object.isFrozen(denial)).toBe(true);
  return denial;
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

async function runPreloadedProgram(
  mode: ActiveMode,
  programPath: string,
  eventPath: string,
  sideEffectPath: string,
  auditPath: string,
  scenario: string
): Promise<ChildResult> {
  const started = performance.now();
  return await new Promise<ChildResult>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--preload", preloadPath, programPath],
      {
        env: {
          ...process.env,
          SHUD_DESCRIPTOR_PRELOAD_MODE: mode,
          SHUD_DESCRIPTOR_PRELOAD_EVENT_PATH: eventPath,
          SHUD_DESCRIPTOR_PRELOAD_SIDE_EFFECT_PATH: sideEffectPath,
          SHUD_DESCRIPTOR_PRELOAD_AUDIT_PATH: auditPath,
          SHUD_DESCRIPTOR_GUARD_SCENARIO: scenario
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let childError: Error | undefined;
    child.once("error", (error) => { childError = error; });
    child.stdout!.on("data", (chunk: Buffer) => { stdout.push(Buffer.from(chunk)); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr.push(Buffer.from(chunk)); });
    child.once("close", (exit) => {
      if (childError) {
        reject(childError);
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

async function runGuardOrderProof(
  mutation: GuardOrderMutation | undefined,
  scenario: GuardOrderScenario
): Promise<GuardOrderProof> {
  let proof: GuardOrderProof | undefined;
  await withProductionTree(mutation, async (tree) => {
    const proofRoot = await mkdtemp(join(tmpdir(), "shud-descriptor-guard-order-"));
    try {
      const runnerPath = join(tree.root, "guard-order.ts");
      const eventPath = join(proofRoot, "events.jsonl");
      const sideEffectPath = join(proofRoot, "side-effects.json");
      const auditPath = join(proofRoot, "audit.jsonl");
      await writeFile(runnerPath, `
import { ContractCapabilities, DIRECTORY_OPEN_FLAGS, FILE_OPEN_FLAGS } from "./lib/capabilities";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scenario = process.env.SHUD_DESCRIPTOR_GUARD_SCENARIO;
const denials = [];
const capabilities = new ContractCapabilities({
  onDescriptorAuthorityDenial: (denial) => { denials.push(denial); }
});
const retained = [];
let pending;
let verification;
const root = await mkdtemp(join(tmpdir(), "shud-descriptor-guard-fixture-"));
const fileName = "retained.txt";
const filePath = join(root, fileName);
const physicalRoot = process.platform === "darwin" && ["/etc", "/tmp", "/var"].some(
  (alias) => root === alias || root.startsWith(alias + "/")
) ? "/private" + root : root;
const segments = [...physicalRoot.split("/").filter(Boolean), fileName];
const rejected = (action) => {
  try {
    action();
  } catch {
    // The parent assertion validates the exact frozen denial receipt.
  }
};
const statAndBind = (label, descriptor) => {
  process.env.SHUD_DESCRIPTOR_PRELOAD_AUDIT_LABEL = label;
  try {
    return capabilities.stat(descriptor);
  } finally {
    delete process.env.SHUD_DESCRIPTOR_PRELOAD_AUDIT_LABEL;
  }
};
try {
  await writeFile(filePath, "guard-order retained bytes\\n");
  let parent = capabilities.openRoot("/", "admission");
  if (!statAndBind("root", parent).isDirectory()) throw new Error("guard root is not a directory");
  capabilities.markRetained(parent, "directory");
  retained.push(parent);
  let directory = parent;
  let file = parent;
  for (let index = 0; index < segments.length; index += 1) {
    const final = index === segments.length - 1;
    const descriptor = capabilities.openRelative(
      parent,
      segments[index],
      final ? FILE_OPEN_FLAGS : DIRECTORY_OPEN_FLAGS,
      "admission"
    );
    const label = final ? "file" : "directory-" + index;
    const stats = statAndBind(label, descriptor);
    if (final ? !stats.isFile() : !stats.isDirectory()) throw new Error("guard fixture type changed");
    capabilities.markRetained(descriptor, final ? "file" : "directory");
    retained.push(descriptor);
    if (final) file = descriptor;
    else directory = descriptor;
    parent = descriptor;
  }

  let action;
  let targetLabel = null;
  let targetGeneration = null;
  if (scenario === "sealed_open_root") {
    capabilities.sealAdmission();
    action = () => capabilities.openRoot("/", "admission");
  } else if (scenario === "open_relative_preseal_post") {
    targetLabel = "directory-" + (segments.length - 2);
    targetGeneration = retained.length - 1;
    action = () => capabilities.openRelative(directory, fileName, FILE_OPEN_FLAGS, "post_admission");
  } else if (scenario === "open_relative_sealed_admission") {
    capabilities.sealAdmission();
    targetLabel = "directory-" + (segments.length - 2);
    targetGeneration = retained.length - 1;
    action = () => capabilities.openRelative(directory, fileName, FILE_OPEN_FLAGS, "admission");
  } else if (scenario === "open_relative_invalid_flags") {
    targetLabel = "directory-" + (segments.length - 2);
    targetGeneration = retained.length - 1;
    action = () => capabilities.openRelative(directory, fileName, FILE_OPEN_FLAGS | 1, "admission");
  } else if (scenario === "open_relative_invalid_state") {
    pending = capabilities.openRelative(directory, fileName, FILE_OPEN_FLAGS, "admission");
    targetLabel = "pending";
    targetGeneration = retained.length + 1;
    statAndBind(targetLabel, pending);
    action = () => capabilities.openRelative(pending, fileName, FILE_OPEN_FLAGS, "admission");
  } else if (scenario === "read_premature_post") {
    targetLabel = "file";
    targetGeneration = retained.length;
    action = () => capabilities.readRetained(file, Buffer.alloc(1), 0, 1, 0, "post_admission");
  } else if (scenario === "read_verification") {
    capabilities.sealAdmission();
    verification = capabilities.openRelative(directory, fileName, FILE_OPEN_FLAGS, "post_admission");
    targetLabel = "verification";
    targetGeneration = retained.length + 1;
    statAndBind(targetLabel, verification);
    action = () => capabilities.readRetained(verification, Buffer.alloc(1), 0, 1, 0, "post_admission");
  } else if (scenario === "read_nonretained") {
    pending = capabilities.openRelative(directory, fileName, FILE_OPEN_FLAGS, "admission");
    targetLabel = "pending";
    targetGeneration = retained.length + 1;
    statAndBind(targetLabel, pending);
    capabilities.sealAdmission();
    action = () => capabilities.readRetained(pending, Buffer.alloc(1), 0, 1, 0, "post_admission");
  } else if (scenario === "read_wrong_phase") {
    capabilities.sealAdmission();
    targetLabel = "file";
    targetGeneration = retained.length;
    action = () => capabilities.readRetained(file, Buffer.alloc(1), 0, 1, 0, "admission");
  } else {
    throw new Error("unknown guard-order scenario: " + scenario);
  }

  process.env.SHUD_DESCRIPTOR_PRELOAD_COUNTER_PHASE = "action";
  rejected(action);
  process.env.SHUD_DESCRIPTOR_PRELOAD_COUNTER_PHASE = "cleanup";
  const sibling = capabilities.stat(file).isFile();
  process.stdout.write(JSON.stringify({ denials, sibling, targetLabel, targetGeneration }));
} finally {
  delete process.env.SHUD_DESCRIPTOR_PRELOAD_COUNTER_PHASE;
  for (const descriptor of [verification, pending].filter(Boolean).reverse()) {
    try {
      capabilities.close(descriptor, descriptor === verification ? "verification" : "unretained");
    } catch {
      // Fixture teardown must not hide the proof result.
    }
  }
  for (const descriptor of retained.reverse()) {
    try {
      capabilities.close(descriptor, "retained");
    } catch {
      // Fixture teardown must not hide the proof result.
    }
  }
  await rm(root, { recursive: true, force: true });
}
`);
      const result = await runPreloadedProgram(
        "guard_order",
        runnerPath,
        eventPath,
        sideEffectPath,
        auditPath,
        scenario
      );
      const audit = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Readonly<{ label: string; descriptor: number }>);
      proof = Object.freeze({
        result,
        receipt: JSON.parse(result.stdout) as GuardOrderReceipt,
        counters: JSON.parse(await readFile(sideEffectPath, "utf8")) as GuardOrderCounters,
        audit
      });
    } finally {
      await rm(proofRoot, { recursive: true, force: true });
    }
  });
  if (!proof) throw new Error("guard-order proof did not produce a receipt");
  return proof;
}

function assertGuardOrderReceipt(proof: GuardOrderProof, scenario: GuardOrderScenario): void {
  const expected = GUARD_ORDER_EXPECTATIONS[scenario];
  expect(proof.result).toEqual(expect.objectContaining({ exit: 0, stderr: "" }));
  const binding = proof.receipt.targetLabel
    ? proof.audit.filter((entry) => entry.label === proof.receipt.targetLabel)
    : [];
  expect(binding).toHaveLength(proof.receipt.targetLabel ? 1 : 0);
  expect(proof.receipt.denials).toEqual([{
    schema_version: "shud.contract.descriptor-denial.v1",
    operation: expected.operation,
    reason: expected.reason,
    descriptor: binding[0]?.descriptor ?? null,
    generation: proof.receipt.targetGeneration,
    phase: expected.phase
  }]);
  expect(proof.receipt.sibling).toBe(true);
  expect(proof.counters).toEqual(ZERO_GUARD_ORDER_COUNTERS);
}

async function runAuditIdentityProof(mutation: AuditIdentityMutation | undefined): Promise<AuditIdentityProof> {
  let proof: AuditIdentityProof | undefined;
  await withProductionTree(mutation, async (tree) => {
    const proofRoot = await mkdtemp(join(tmpdir(), "shud-descriptor-audit-identity-"));
    try {
      const runnerPath = join(tree.root, "audit-identity.ts");
      const eventPath = join(proofRoot, "events.jsonl");
      const sideEffectPath = join(proofRoot, "side-effects.json");
      const auditPath = join(proofRoot, "audit.jsonl");
      await writeFile(runnerPath, `
import { ContractCapabilities, DIRECTORY_OPEN_FLAGS } from "./lib/capabilities";

const denials = [];
const capabilities = new ContractCapabilities({
  onDescriptorAuthorityDenial: (denial) => { denials.push(denial); }
});
const foreignCapabilities = new ContractCapabilities();
const rejected = (action) => {
  try {
    action();
  } catch {
    // The parent assertion validates the exact frozen denial receipt.
  }
};
const statAndBind = (label, owner, descriptor) => {
  process.env.SHUD_DESCRIPTOR_PRELOAD_AUDIT_LABEL = label;
  try {
    return owner.stat(descriptor);
  } finally {
    delete process.env.SHUD_DESCRIPTOR_PRELOAD_AUDIT_LABEL;
  }
};
let issued;
let foreign;
let current;
try {
  rejected(() => capabilities.stat(0));
  rejected(() => capabilities.openRelative(-100, "tmp", DIRECTORY_OPEN_FLAGS, "post_admission"));

  issued = capabilities.openRoot("/", "admission");
  statAndBind("issued", capabilities, issued);
  capabilities.markRetained(issued, "directory");
  rejected(() => capabilities.openRelative(issued, "tmp", DIRECTORY_OPEN_FLAGS, "post_admission"));

  foreign = foreignCapabilities.openRoot("/", "admission");
  statAndBind("foreign", foreignCapabilities, foreign);
  rejected(() => capabilities.stat(foreign));

  const closed = capabilities.openRoot("/", "admission");
  statAndBind("closed", capabilities, closed);
  capabilities.close(closed, "unretained");
  rejected(() => capabilities.stat(closed));

  current = capabilities.openRoot("/", "admission");
  statAndBind("current", capabilities, current);
  rejected(() => capabilities.stat(closed));
  rejected(() => capabilities.close(current, "retained"));

  process.stdout.write(JSON.stringify(denials));
} finally {
  if (current) {
    try {
      capabilities.close(current, "unretained");
    } catch {
      // Fixture teardown must not hide the proof result.
    }
  }
  if (issued) {
    try {
      capabilities.close(issued, "retained");
    } catch {
      // Fixture teardown must not hide the proof result.
    }
  }
  if (foreign) {
    try {
      foreignCapabilities.close(foreign, "unretained");
    } catch {
      // Fixture teardown must not hide the proof result.
    }
  }
}
`);
      const result = await runPreloadedProgram(
        "lifecycle",
        runnerPath,
        eventPath,
        sideEffectPath,
        auditPath,
        "audit_identity"
      );
      const audit = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Readonly<{ label: string; descriptor: number }>);
      proof = Object.freeze({
        result,
        denials: JSON.parse(result.stdout) as DescriptorAuthorityDenial[],
        audit
      });
    } finally {
      await rm(proofRoot, { recursive: true, force: true });
    }
  });
  if (!proof) throw new Error("audit identity proof did not produce a receipt");
  return proof;
}

function assertRawDescriptorBaseline(denials: readonly DescriptorAuthorityDenial[]): void {
  expect(denials.slice(0, 2)).toEqual([
    {
      schema_version: "shud.contract.descriptor-denial.v1",
      operation: "fstat_sync",
      reason: "unproven_descriptor",
      descriptor: 0,
      generation: null,
      phase: null
    },
    {
      schema_version: "shud.contract.descriptor-denial.v1",
      operation: "openat",
      reason: "unproven_parent",
      descriptor: -100,
      generation: null,
      phase: "post_admission"
    }
  ]);
}

function assertAuditIdentityReceipt(proof: AuditIdentityProof): void {
  expect(proof.result).toEqual(expect.objectContaining({ exit: 0, stderr: "" }));
  assertRawDescriptorBaseline(proof.denials);
  const descriptor = (label: string): number => {
    const bindings = proof.audit.filter((entry) => entry.label === label);
    expect(bindings).toHaveLength(1);
    return bindings[0]!.descriptor;
  };
  expect(proof.denials.slice(2)).toEqual([
    {
      schema_version: "shud.contract.descriptor-denial.v1",
      operation: "openat",
      reason: "phase_invalid",
      descriptor: descriptor("issued"),
      generation: 1,
      phase: "admission"
    },
    {
      schema_version: "shud.contract.descriptor-denial.v1",
      operation: "fstat_sync",
      reason: "foreign_descriptor",
      descriptor: descriptor("foreign"),
      generation: 1,
      phase: "admission"
    },
    {
      schema_version: "shud.contract.descriptor-denial.v1",
      operation: "fstat_sync",
      reason: "closed_descriptor",
      descriptor: descriptor("closed"),
      generation: 2,
      phase: "admission"
    },
    {
      schema_version: "shud.contract.descriptor-denial.v1",
      operation: "fstat_sync",
      reason: "stale_descriptor",
      descriptor: descriptor("closed"),
      generation: 2,
      phase: "admission"
    },
    {
      schema_version: "shud.contract.descriptor-denial.v1",
      operation: "close_sync",
      reason: "owner_mismatch",
      descriptor: descriptor("current"),
      generation: 3,
      phase: "admission"
    }
  ]);
}

describe("retained descriptor runtime authority", () => {
  test("policy has the canonical vocabulary while issued descriptors are opaque and a retained chain stays usable", async () => {
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
    try {
      for (const [operation, action] of [
        ["fstat_sync", () => capabilities.stat(foreign)],
        ["openat", () => capabilities.openRelative(foreign, "tmp", DIRECTORY_OPEN_FLAGS, "admission")],
        ["read_sync", () => capabilities.readRetained(foreign, Buffer.alloc(1), 0, 1, 0, "post_admission")],
        ["close_sync", () => capabilities.close(foreign, "unretained")]
      ] as const) {
        expectIssuedDenial(denials, action, operation, "foreign_descriptor", 1, "admission");
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
    for (const [operation, action] of [
      ["fstat_sync", () => capabilities.stat(first)],
      ["openat", () => capabilities.openRelative(first, "tmp", DIRECTORY_OPEN_FLAGS, "admission")],
      ["read_sync", () => capabilities.readRetained(first, Buffer.alloc(1), 0, 1, 0, "post_admission")],
      ["close_sync", () => capabilities.close(first, "unretained")]
    ] as const) {
      expectIssuedDenial(denials, action, operation, "closed_descriptor", 1, "admission");
    }

    const current = capabilities.openRoot("/", "admission");
    try {
      expectIssuedDenial(denials, () => capabilities.close(current, "retained"), "close_sync", "owner_mismatch", 2, "admission");
      expect(capabilities.stat(current).isDirectory()).toBe(true);
      for (const [operation, action] of [
        ["fstat_sync", () => capabilities.stat(first)],
        ["openat", () => capabilities.openRelative(first, "tmp", DIRECTORY_OPEN_FLAGS, "admission")],
        ["read_sync", () => capabilities.readRetained(first, Buffer.alloc(1), 0, 1, 0, "post_admission")],
        ["close_sync", () => capabilities.close(first, "unretained")]
      ] as const) {
        expectIssuedDenial(denials, action, operation, "stale_descriptor", 1, "admission");
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
    expectIssuedDenial(denials, () => capabilities.markRetained(root, "file"), "mark_retained", "kind_mismatch", 1, "admission");
    capabilities.markRetained(root, "directory");
    expectIssuedDenial(
      denials,
      () => capabilities.openRelative(root, "tmp", FILE_OPEN_FLAGS | (constants.O_APPEND ?? 1), "admission"),
      "openat",
      "flags_invalid",
      1,
      "admission"
    );
    expectIssuedDenial(denials, () => capabilities.close(root, "verification"), "close_sync", "owner_mismatch", 1, "admission");
    expect(capabilities.stat(root).isDirectory()).toBe(true);
    capabilities.close(root, "retained");

    const fileCapabilities = new ContractCapabilities({ onDescriptorAuthorityDenial: (denial) => { denials.push(denial); } });
    const fixture = await createRetainedFile(fileCapabilities);
    try {
      expectIssuedDenial(
        denials,
        () => fileCapabilities.readRetained(fixture.file, Buffer.alloc(1), 0, 1, 0, "admission"),
        "read_sync",
        "phase_invalid",
        fixture.fileGeneration,
        "admission"
      );
      expectIssuedDenial(
        denials,
        () => fileCapabilities.readRetained(fixture.file, Buffer.alloc(1), 1, 1, 0, "post_admission"),
        "read_sync",
        "range_invalid",
        fixture.fileGeneration,
        "admission"
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
      expectIssuedDenial(
        denials,
        () => capabilities.openRelative(
          fixture.directory,
          basename(join(fixture.root, "retained.json")),
          FILE_OPEN_FLAGS,
          "post_admission"
        ),
        "openat",
        "phase_invalid",
        fixture.fileGeneration - 1,
        "admission"
      );
      expectIssuedDenial(
        denials,
        () => capabilities.readRetained(fixture.file, Buffer.alloc(1), 0, 1, 0, "post_admission"),
        "read_sync",
        "phase_invalid",
        fixture.fileGeneration,
        "admission"
      );

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
      expectIssuedDenial(
        denials,
        () => capabilities.openRelative(
          fixture.directory,
          basename(join(fixture.root, "retained.json")),
          FILE_OPEN_FLAGS,
          "admission"
        ),
        "openat",
        "phase_invalid",
        fixture.fileGeneration - 1,
        "admission"
      );
      expectIssuedDenial(
        denials,
        () => capabilities.markRetained(pending!, "file"),
        "mark_retained",
        "phase_invalid",
        fixture.fileGeneration + 1,
        "admission"
      );

      verification = capabilities.openRelative(
        fixture.directory,
        basename(join(fixture.root, "retained.json")),
        FILE_OPEN_FLAGS,
        "post_admission"
      );
      expect(capabilities.stat(verification).isFile()).toBe(true);
      expectIssuedDenial(
        denials,
        () => capabilities.markRetained(verification!, "file"),
        "mark_retained",
        "state_invalid",
        fixture.fileGeneration + 2,
        "post_admission"
      );
      expectIssuedDenial(
        denials,
        () => capabilities.readRetained(verification!, Buffer.alloc(1), 0, 1, 0, "post_admission"),
        "read_sync",
        "state_invalid",
        fixture.fileGeneration + 2,
        "post_admission"
      );
      expectIssuedDenial(
        denials,
        () => capabilities.readRetained(fixture.directory, Buffer.alloc(1), 0, 1, 0, "post_admission"),
        "read_sync",
        "kind_mismatch",
        fixture.fileGeneration - 1,
        "admission"
      );
      expectIssuedDenial(
        denials,
        () => capabilities.close(fixture.file, "verification"),
        "close_sync",
        "owner_mismatch",
        fixture.fileGeneration,
        "admission"
      );
      expectIssuedDenial(
        denials,
        () => capabilities.close(pending!, "retained"),
        "close_sync",
        "owner_mismatch",
        fixture.fileGeneration + 1,
        "admission"
      );
      capabilities.close(pending, "unretained");
      pending = undefined;
      expectIssuedDenial(
        denials,
        () => capabilities.close(verification!, "retained"),
        "close_sync",
        "owner_mismatch",
        fixture.fileGeneration + 2,
        "post_admission"
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
    expectIssuedDenial(denials, () => capabilities.stat(first), "fstat_sync", "closed_descriptor", 1, "admission");

    const current = capabilities.openRoot("/", "admission");
    try {
      expectIssuedDenial(denials, () => capabilities.close(current, "retained"), "close_sync", "owner_mismatch", 2, "admission");
      expect(capabilities.stat(current).isDirectory()).toBe(true);
      expectIssuedDenial(denials, () => capabilities.stat(first), "fstat_sync", "stale_descriptor", 1, "admission");
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

  test("guard-order proofs keep invalid root, relative-open, and read rows before native authority", async () => {
    for (const scenario of Object.keys(GUARD_ORDER_EXPECTATIONS) as GuardOrderScenario[]) {
      assertGuardOrderReceipt(await runGuardOrderProof(undefined, scenario), scenario);
    }
  });

  test("guard-order production mutations turn each zero-native proof red after preserving its denial", async () => {
    for (const scenario of Object.keys(GUARD_ORDER_EXPECTATIONS) as GuardOrderScenario[]) {
      const expected = GUARD_ORDER_EXPECTATIONS[scenario];
      const proof = await runGuardOrderProof(expected.mutation, scenario);
      expect(() => assertGuardOrderReceipt(proof, scenario)).toThrow();
      expect(proof.result).toEqual(expect.objectContaining({ exit: 0, stderr: "" }));
      expect(proof.receipt.denials).toHaveLength(1);
      expect(proof.counters.native[expected.native]).toBeGreaterThan(0);
    }
  });

  test("issued, foreign, closed, stale, and wrong-owner receipts bind to intercepted descriptor identity", async () => {
    assertAuditIdentityReceipt(await runAuditIdentityProof(undefined));
  });

  test("fixed #denyRecord descriptor mutations make every issued-handle receipt audit red without changing raw baselines", async () => {
    for (const mutation of ["deny_record_zero", "deny_record_fd_plus_one"] as const) {
      const proof = await runAuditIdentityProof(mutation);
      expect(() => assertAuditIdentityReceipt(proof)).toThrow();
      assertRawDescriptorBaseline(proof.denials);
    }
  });
});
