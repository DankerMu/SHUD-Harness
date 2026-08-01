import { mock } from "bun:test";
import * as originalFfi from "bun:ffi";
import * as originalFs from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { BigIntStats, DescriptorOperation, DescriptorPrimitiveMediator } from "../lib/capabilities";

type OpenAt = (parentDescriptor: number, path: Buffer, flags: number) => number;
type StatReceipt = Readonly<{
  active: boolean;
  descriptor: number;
  directory: boolean;
  file: boolean;
  result: Readonly<{ dev: string; ino: string; size: string }>;
}>;
type RawReceipt = {
  open_sync: Array<Readonly<{ active: boolean; path: string; flags: number; result: number }>>;
  openat: Array<Readonly<{ active: boolean; parent: number; path: readonly number[]; flags: number; result: number }>>;
  fstat_sync: StatReceipt[];
  read_sync: Array<Readonly<{
    active: boolean;
    descriptor: number;
    bufferLength: number;
    offset: number;
    length: number;
    position: number;
    result: number;
  }>>;
  close_sync: Array<Readonly<{ active: boolean; descriptor: number }>>;
};
type CapabilitiesModule = Readonly<{
  ContractCapabilities: new () => {
    openRoot: (root: string, phase: "admission") => object;
    openRelative: (parent: object, childName: string, flags: number, phase: "admission") => object;
    stat: (descriptor: object) => BigIntStats;
    markRetained: (descriptor: object, kind: "file" | "directory") => void;
    sealAdmission: () => void;
    readRetained: (
      descriptor: object,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
      phase: "post_admission"
    ) => number;
    close: (descriptor: object, owner: "retained") => void;
  };
  DIRECTORY_OPEN_FLAGS: number;
  FILE_OPEN_FLAGS: number;
  installDescriptorPrimitiveMediator: (mediator: DescriptorPrimitiveMediator) => void;
}>;

const raw: RawReceipt = {
  open_sync: [],
  openat: [],
  fstat_sync: [],
  read_sync: [],
  close_sync: []
};
let callbackActive = false;

function statReceipt(active: boolean, descriptor: number, stats: BigIntStats): StatReceipt {
  return Object.freeze({
    active,
    descriptor,
    directory: stats.isDirectory(),
    file: stats.isFile(),
    result: Object.freeze({ dev: String(stats.dev), ino: String(stats.ino), size: String(stats.size) })
  });
}

function installRawProbe(): void {
  const originalOpenSync = originalFs.openSync;
  const originalFstatSync = originalFs.fstatSync;
  const originalReadSync = originalFs.readSync;
  const originalCloseSync = originalFs.closeSync;
  mock.module("node:fs", () => ({
    ...originalFs,
    openSync(...args: Parameters<typeof originalOpenSync>) {
      const result = originalOpenSync(...args);
      raw.open_sync.push(Object.freeze({ active: callbackActive, path: String(args[0]), flags: Number(args[1]), result }));
      return result;
    },
    fstatSync(...args: Parameters<typeof originalFstatSync>) {
      const result = originalFstatSync(...args);
      raw.fstat_sync.push(statReceipt(callbackActive, Number(args[0]), result));
      return result;
    },
    readSync(...args: Parameters<typeof originalReadSync>) {
      const result = originalReadSync(...args);
      raw.read_sync.push(Object.freeze({
        active: callbackActive,
        descriptor: Number(args[0]),
        bufferLength: args[1].length,
        offset: Number(args[2]),
        length: Number(args[3]),
        position: Number(args[4]),
        result
      }));
      return result;
    },
    closeSync(...args: Parameters<typeof originalCloseSync>) {
      raw.close_sync.push(Object.freeze({ active: callbackActive, descriptor: Number(args[0]) }));
      return originalCloseSync(...args);
    }
  }));

  const originalDlopen = originalFfi.dlopen;
  mock.module("bun:ffi", () => ({
    ...originalFfi,
    dlopen(...args: Parameters<typeof originalDlopen>) {
      const library = originalDlopen(...args);
      const nativeOpenAt = (library.symbols as unknown as Readonly<{ openat: OpenAt }>).openat;
      return {
        ...library,
        symbols: {
          ...library.symbols,
          openat(...openAtArgs: Parameters<OpenAt>): number {
            const result = nativeOpenAt(...openAtArgs);
            raw.openat.push(Object.freeze({
              active: callbackActive,
              parent: openAtArgs[0],
              path: Object.freeze([...openAtArgs[1]]),
              flags: openAtArgs[2],
              result
            }));
            return result;
          }
        }
      } as typeof library;
    }
  }));
}

async function createFixture(): Promise<Readonly<{ root: string; contents: Buffer; segments: readonly string[] }>> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "shud-callback-active-")));
  const contents = Buffer.from("callback-active-receipt");
  await writeFile(join(root, "payload"), contents);
  return Object.freeze({ root, contents, segments: Object.freeze(root.split(sep).filter(Boolean)) });
}

async function exercise(module: CapabilitiesModule, fixture: Readonly<{
  contents: Buffer;
  segments: readonly string[];
}>): Promise<Readonly<{ bytes: number; text: string; operations: readonly DescriptorOperation[] }>> {
  const capabilities = new module.ContractCapabilities();
  const descriptors: object[] = [];
  const operations: DescriptorOperation[] = [];
  module.installDescriptorPrimitiveMediator((operation, invoke) => {
    operations.push(operation);
    callbackActive = true;
    try {
      return invoke();
    } finally {
      callbackActive = false;
    }
  });
  let directory = capabilities.openRoot("/", "admission");
  descriptors.push(directory);
  for (const segment of fixture.segments) {
    if (!capabilities.stat(directory).isDirectory()) throw new Error("fixture directory is not a directory");
    capabilities.markRetained(directory, "directory");
    directory = capabilities.openRelative(directory, segment, module.DIRECTORY_OPEN_FLAGS, "admission");
    descriptors.push(directory);
  }
  if (!capabilities.stat(directory).isDirectory()) throw new Error("fixture root is not a directory");
  capabilities.markRetained(directory, "directory");
  const file = capabilities.openRelative(directory, "payload", module.FILE_OPEN_FLAGS, "admission");
  descriptors.push(file);
  if (!capabilities.stat(file).isFile()) throw new Error("fixture file is not a file");
  capabilities.markRetained(file, "file");
  capabilities.sealAdmission();
  const buffer = Buffer.alloc(fixture.contents.length);
  const bytes = capabilities.readRetained(file, buffer, 0, buffer.length, 0, "post_admission");
  for (const descriptor of [...descriptors].reverse()) capabilities.close(descriptor, "retained");
  return Object.freeze({
    bytes,
    text: buffer.subarray(0, bytes).toString(),
    operations: Object.freeze(operations)
  });
}

try {
  const fixture = await createFixture();
  installRawProbe();
  const module = await import("../lib/capabilities") as CapabilitiesModule;
  try {
    const outcome = await exercise(module, fixture);
    console.log(JSON.stringify({ ...outcome, raw, segments: fixture.segments, contents: fixture.contents.toString() }));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
