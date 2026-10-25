import { execFileSync, spawnSync } from "node:child_process";
import { appendFile, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import type * as NodeFs from "node:fs";
import { stdoutSource } from "./file-output.ts";
import { createHarness } from "./test-harness.ts";

const reads = vi.hoisted(() => ({
  maximum: Infinity,
  remaining: Infinity,
  positions: [] as Array<number | null>,
  opened: [] as Array<{ path: NodeFs.PathLike; fd: number }>,
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return {
    ...actual,
    openSync(...args: Parameters<typeof NodeFs.openSync>) {
      const fd = actual.openSync(...args);
      reads.opened.push({ path: args[0], fd });
      return fd;
    },
    readSync(
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ) {
      reads.positions.push(position);
      if (reads.remaining === 0) return 0;
      reads.remaining -= 1;
      return actual.readSync(fd, buffer, offset, Math.min(length, reads.maximum), position);
    },
  };
});
beforeEach(() => {
  reads.maximum = Infinity;
  reads.remaining = Infinity;
  reads.positions = [];
  reads.opened = [];
});

test("split UTF-8 stays unconsumed until complete and every read reports the spill file", async () => {
  const h = await createHarness();
  const path = join(h.root, "stdout.log");
  try {
    await writeFile(path, Buffer.from([0x41, 0xf0, 0x90]));
    const source = stdoutSource(path);
    expect(source.read(0)).toEqual({ text: "A", nextOffset: 1, lossy: false, spillPath: path });
    expect(source.read(1)).toEqual({ text: "", nextOffset: 1, lossy: false, spillPath: path });
    await appendFile(path, Buffer.from([0x90, 0x80, 0x0a]));
    expect(source.read(1)).toEqual({
      text: "\u{10400}\n",
      nextOffset: 6,
      lossy: false,
      spillPath: path,
    });
    expect(source.read(6)).toEqual({ text: "", nextOffset: 6, lossy: false, spillPath: path });
    expect(reads.positions).toEqual([0, 1, 1]);
  } finally {
    await h.dispose();
  }
});

test("short reads consume only initialized bytes and subsequent reads resume at the actual offset", async () => {
  const h = await createHarness();
  const path = join(h.root, "stdout.log");
  try {
    await writeFile(path, "abcdef");
    reads.maximum = 2;
    reads.remaining = 1;
    const source = stdoutSource(path);
    expect(source.read(0)).toEqual({ text: "ab", nextOffset: 2, lossy: false, spillPath: path });
    reads.remaining = Infinity;
    expect(source.read(2)).toEqual({ text: "cdef", nextOffset: 6, lossy: false, spillPath: path });
    expect(reads.positions).toEqual([0, 2, 2, 4]);
  } finally {
    await h.dispose();
  }
});

test("truncation is lossy while a missing log is an error, not empty output", async () => {
  const h = await createHarness();
  const path = join(h.root, "stdout.log");
  try {
    await writeFile(path, "abcdef");
    const source = stdoutSource(path);
    expect(source.read(0).nextOffset).toBe(6);
    await writeFile(path, "x");
    expect(source.read(6)).toEqual({ text: "x", nextOffset: 1, lossy: true, spillPath: path });
    await rm(path);
    expect(() => source.read(1)).toThrow();
  } finally {
    await h.dispose();
  }
});

test.each([false, true])(
  "symlink replacement throws without returning external bytes (prior read: %s)",
  async (priorRead) => {
    const h = await createHarness();
    const path = join(h.cwd, "stdout.log");
    const external = join(h.root, "external.txt");
    try {
      await writeFile(path, "prior\n");
      await writeFile(external, "prior\nHARMLESS_EXTERNAL_SENTINEL\n");
      const source = stdoutSource(path);
      if (priorRead) expect(source.read(0).text).toBe("prior\n");
      await rm(path);
      await symlink(external, path);
      expect(() => source.read(priorRead ? 6 : 0)).toThrow();
    } finally {
      await h.dispose();
    }
  },
);

test("a directory is rejected even at its apparent end and its opened descriptor is closed", async () => {
  const h = await createHarness();
  const path = join(h.root, "stdout.log");
  const actual = await vi.importActual<typeof NodeFs>("node:fs");
  try {
    await mkdir(path);
    const offset = (await stat(path)).size;
    expect(() => stdoutSource(path).read(offset)).toThrow();
    const opened = reads.opened.filter((entry) => entry.path === path);
    expect(opened).toHaveLength(1);
    expect(() => actual.fstatSync(opened[0].fd)).toThrow(
      expect.objectContaining({ code: "EBADF" }),
    );
  } finally {
    await h.dispose();
  }
});

test("a writerless FIFO is rejected without blocking or leaking descriptors", async () => {
  const h = await createHarness();
  const path = join(h.root, "stdout.log");
  try {
    execFileSync("mkfifo", [path]);
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          import assert from "node:assert/strict";
          import { readdirSync } from "node:fs";
          const { stdoutSource } = await import(process.argv[1]);
          const descriptors = readdirSync("/dev/fd").sort();
          assert.throws(() => stdoutSource(process.argv[2]).read(0));
          assert.deepEqual(readdirSync("/dev/fd").sort(), descriptors);
        `,
        new URL("./file-output.ts", import.meta.url).href,
        path,
      ],
      { encoding: "utf8", timeout: 2000, killSignal: "SIGKILL" },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stderr).toBe(0);
  } finally {
    await h.dispose();
  }
});
