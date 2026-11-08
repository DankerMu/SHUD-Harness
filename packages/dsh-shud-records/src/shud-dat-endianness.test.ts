import * as fs from "node:fs";
import * as os from "node:os";
import { expect, test, vi } from "vitest";
import { readShudDat } from "./index.ts";
import { expectInputError } from "./shud-text-test-harness.ts";

vi.mock("node:os", async (original) => ({
  ...(await original<typeof os>()),
  endianness: vi.fn(() => "BE"),
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    statSync: vi.fn(actual.statSync),
    realpathSync: Object.assign(vi.fn(actual.realpathSync), {
      native: vi.fn(actual.realpathSync.native),
    }),
    openSync: vi.fn(actual.openSync),
    fstatSync: vi.fn(actual.fstatSync),
    readSync: vi.fn(actual.readSync),
    readFileSync: vi.fn(actual.readFileSync),
    createReadStream: vi.fn(actual.createReadStream),
    closeSync: vi.fn(actual.closeSync),
  };
});

test("rejects a native big-endian platform before filesystem IO, without a public override", () => {
  vi.clearAllMocks();
  const path = "mini.rivqdown.dat";
  const error = expectInputError(() => readShudDat("/unused-shud-output", path), path, "parse");
  expect(error.message).toMatch(/endian|platform/iu);
  expect(os.endianness).toHaveBeenCalled();
  for (const operation of [
    fs.lstatSync,
    fs.statSync,
    fs.realpathSync,
    fs.realpathSync.native,
    fs.openSync,
    fs.fstatSync,
    fs.readSync,
    fs.readFileSync,
    fs.createReadStream,
    fs.closeSync,
  ])
    expect(operation).not.toHaveBeenCalled();
});
