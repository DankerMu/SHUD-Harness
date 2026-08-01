import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DIRECTORY_OPEN_FLAGS, FILE_OPEN_FLAGS } from "../lib/capabilities";

type RawReceipt = Readonly<{
  open_sync: readonly Readonly<{ active: boolean; path: string; flags: number; result: number }>[];
  openat: readonly Readonly<{ active: boolean; parent: number; path: readonly number[]; flags: number; result: number }>[];
  fstat_sync: readonly Readonly<{
    active: boolean;
    descriptor: number;
    directory: boolean;
    file: boolean;
    result: Readonly<{ dev: string; ino: string; size: string }>;
  }>[];
  read_sync: readonly Readonly<{
    active: boolean;
    descriptor: number;
    bufferLength: number;
    offset: number;
    length: number;
    position: number;
    result: number;
  }>[];
  close_sync: readonly Readonly<{ active: boolean; descriptor: number }>[];
}>;
type Receipt = Readonly<{
  bytes: number;
  text: string;
  contents: string;
  segments: readonly string[];
  operations: readonly string[];
  raw: RawReceipt;
}>;

const childPath = join(import.meta.dir, "authority-descriptor-callback-active-round-3-child.ts");

async function runProbe(): Promise<Receipt> {
  const child = Bun.spawn([process.execPath, childPath], { stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  expect(exit).toBe(0);
  expect(stderr).toBe("");
  return JSON.parse(stdout) as Receipt;
}

describe("callback-active raw primitive receipts", () => {
  test("all five normal raw primitives execute exactly once per matching active callback with exact operands and lifecycle", async () => {
    const receipt = await runProbe();
    const descriptorCount = receipt.segments.length + 2;
    const expectedOperations = [
      "open_root",
      ...Array.from({ length: receipt.segments.length }, () => ["fstat_sync", "openat"]).flat(),
      "fstat_sync",
      "openat",
      "fstat_sync",
      "read_sync",
      ...Array.from({ length: descriptorCount }, () => "close_sync")
    ];
    expect(receipt.operations).toEqual(expectedOperations);
    expect(receipt.bytes).toBe(Buffer.byteLength(receipt.contents));
    expect(receipt.text).toBe(receipt.contents);

    expect(receipt.raw.open_sync).toHaveLength(1);
    expect(receipt.raw.open_sync[0]).toMatchObject({ active: true, path: "/", flags: DIRECTORY_OPEN_FLAGS });
    expect(receipt.raw.open_sync[0]!.result).toBeGreaterThanOrEqual(0);

    expect(receipt.raw.openat).toHaveLength(receipt.segments.length + 1);
    expect(receipt.raw.openat.every((entry) => entry.active && entry.result >= 0)).toBe(true);
    expect(receipt.raw.openat.map((entry) => Buffer.from(entry.path).toString("utf8"))).toEqual([
      ...receipt.segments.map((segment) => `${segment}\0`),
      "payload\0"
    ]);
    expect(receipt.raw.openat.map((entry) => entry.flags)).toEqual([
      ...receipt.segments.map(() => DIRECTORY_OPEN_FLAGS),
      FILE_OPEN_FLAGS
    ]);
    const issuedDescriptors = [
      receipt.raw.open_sync[0]!.result,
      ...receipt.raw.openat.map((entry) => entry.result)
    ];
    expect(receipt.raw.openat.map((entry) => entry.parent)).toEqual(issuedDescriptors.slice(0, -1));

    expect(receipt.raw.fstat_sync.map((entry) => entry.descriptor)).toEqual(issuedDescriptors);
    expect(receipt.raw.fstat_sync.every((entry) => entry.active)).toBe(true);
    expect(receipt.raw.fstat_sync.slice(0, -1).every((entry) => entry.directory && !entry.file)).toBe(true);
    expect(receipt.raw.fstat_sync.at(-1)).toMatchObject({ directory: false, file: true });
    expect(receipt.raw.fstat_sync.every((entry) => entry.result.dev !== "" && entry.result.ino !== "")).toBe(true);

    expect(receipt.raw.read_sync).toEqual([{
      active: true,
      descriptor: receipt.raw.fstat_sync.at(-1)!.descriptor,
      bufferLength: Buffer.byteLength(receipt.contents),
      offset: 0,
      length: Buffer.byteLength(receipt.contents),
      position: 0,
      result: Buffer.byteLength(receipt.contents)
    }]);

    expect(receipt.raw.close_sync).toEqual(
      [...issuedDescriptors].reverse().map((descriptor) => ({ active: true, descriptor }))
    );
  });
});
