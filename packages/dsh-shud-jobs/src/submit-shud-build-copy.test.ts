import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { dirname, join } from "node:path";
import type * as NodeFs from "node:fs";
import type * as NodeIo from "node:fs/promises";
import { beforeEach, expect, test, vi } from "vitest";
import { ShudJobRegistry } from "./index.ts";
import { createHarness } from "./test-harness.ts";
import { barrier } from "./state-indexes/test-harness.ts";
import { actualRegistry, submissionProducer } from "./submit-shud/test-harness.ts";
import {
  binaryBytes,
  buildFixture,
  fileSnapshot,
  names,
} from "./submit-shud-build/test-harness.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    rename: vi.fn(actual.rename),
    readFile: vi.fn(actual.readFile),
  };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
const native = await vi.importActual<typeof NodeIo>("node:fs/promises");
const nativeFs = await vi.importActual<typeof NodeFs>("node:fs");
beforeEach(() => {
  vi.mocked(io.open).mockReset().mockImplementation(native.open);
  vi.mocked(io.rename).mockReset().mockImplementation(native.rename);
  vi.mocked(io.readFile).mockReset().mockImplementation(native.readFile);
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(nativeFs.readFileSync);
});

interface CopyHandle {
  handle: io.FileHandle;
  source: boolean;
  closed: boolean;
  closes: number;
  reads: number[];
  writes: number[];
  restoreClose: () => void;
}

function observeCopy(sourcePath: string, phase = "success") {
  const handles: CopyHandle[] = [];
  let faults = 0;
  function deny() {
    faults++;
    throw Object.assign(new Error("private copier IO payload"), { code: "EIO" });
  }
  vi.mocked(io.open).mockImplementation(async (path, flags, mode) => {
    const source = path === sourcePath;
    const destination = typeof path === "string" && dirname(path).endsWith("/bin");
    if (!source && !destination) return native.open(path, flags, mode);
    if ((source && phase === "source-open") || (destination && phase === "destination-open"))
      deny();
    const handle = await native.open(path, flags, mode);
    const close = handle.close.bind(handle);
    const closeSpy = vi.spyOn(handle, "close");
    const entry: CopyHandle = {
      handle,
      source,
      closed: false,
      closes: 0,
      reads: [],
      writes: [],
      restoreClose: () => closeSpy.mockRestore(),
    };
    handles.push(entry);
    const read = handle.read.bind(handle);
    const write = handle.write.bind(handle);
    const chmod = handle.chmod.bind(handle);
    vi.spyOn(handle, "read").mockImplementation(async (...args) => {
      if ((source && phase === "source-read") || (!source && phase === "copied-read")) deny();
      const length = args[2];
      if (typeof length !== "number") throw new Error("Expected a bounded descriptor read length");
      entry.reads.push(length);
      return read(...args);
    });
    vi.spyOn(handle, "write").mockImplementation(async (...args) => {
      if (phase === "destination-write") deny();
      const [buffer, offset, length, position] = args;
      if (!Buffer.isBuffer(buffer) || typeof offset !== "number" || typeof length !== "number")
        throw new Error("Expected a bounded descriptor write");
      entry.writes.push(length);
      if (phase === "write-no-progress") {
        faults++;
        return { bytesWritten: 0, buffer };
      }
      // Short writes are a legal OS outcome; exercise the real remainder loop with real bytes.
      return write(
        buffer,
        offset,
        phase === "short-write" ? Math.min(length, 7) : length,
        position,
      );
    });
    vi.spyOn(handle, "chmod").mockImplementation(async (mode) => {
      if (phase === "chmod") deny();
      await chmod(mode);
      if (phase === "copied-hash") {
        faults++;
        await write(Buffer.from("!"), 0, 1, 0);
      }
    });
    closeSpy.mockImplementation(async () => {
      entry.closes++;
      if ((source && phase === "source-close") || (!source && phase === "destination-close"))
        deny();
      await close();
      entry.closed = true;
    });
    return handle;
  });
  return {
    handles,
    get faults() {
      return faults;
    },
    async cleanup() {
      // Only test-owned handles whose injected close failed are released here, after assertions.
      for (const entry of handles) {
        if (!entry.closed) {
          entry.restoreClose();
          await entry.handle.close();
          entry.closed = true;
        }
      }
    },
  };
}

test.each([
  "source-open",
  "destination-open",
  "source-read",
  "destination-write",
  "write-no-progress",
  "chmod",
  "copied-read",
  "copied-hash",
  "source-close",
  "destination-close",
])(
  "copier %s failure closes every other resource once and rolls back before capture",
  async (phase) => {
    const h = await buildFixture();
    const execution = submissionProducer();
    const observed = observeCopy(h.source, phase);
    let publications = 0;
    try {
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      vi.mocked(io.rename).mockImplementation(async (source, target) => {
        if (String(target).endsWith("/bin/shud")) publications++;
        await native.rename(source, target);
      });
      const outcome: unknown = await registry
        .submitShud(h.buildRequest, execution.start)
        .catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(Error);
      if (!(outcome instanceof Error)) throw new Error("Copy failure unexpectedly executed");
      expect(outcome.message).toContain(h.build.build_id);
      expect(outcome.message).not.toContain("private copier IO payload");
      if (phase === "copied-hash") expect(outcome.message).toMatch(/copied.*sha256/iu);
      expect(observed.faults).toBe(1);
      expect(publications).toBe(0);
      expect(execution.handles).toEqual([]);
      for (const entry of observed.handles) {
        expect(entry.closes).toBe(1);
        const failedClose = phase === (entry.source ? "source-close" : "destination-close");
        expect(entry.closed).toBe(!failedClose);
        if (failedClose) expect(nativeFs.fstatSync(entry.handle.fd).isFile()).toBe(true);
        else expect(entry.handle.fd).toBe(-1);
      }
      expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
      expect(await names(join(h.cwd, "runs"))).toEqual([]);
      expect(await names(join(h.cwd, "stacks"))).toEqual([]);
      expect(await names(join(h.cwd, "provenance"))).toEqual([]);
      await h.assertReadonly();
    } finally {
      await observed.cleanup();
      await execution.finish();
      await h.dispose();
    }
  },
);

test.each(["bounded", "short-write"])(
  "%s copy publishes exact bytes only after both descriptors close",
  async (phase) => {
    const h = await buildFixture();
    const execution = submissionProducer();
    const observed = observeCopy(h.source, phase);
    try {
      const bytes =
        phase === "bounded"
          ? Buffer.concat([binaryBytes, Buffer.from(`#${"a".repeat(2 * 1024 * 1024)}\n`)])
          : binaryBytes;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      await io.writeFile(h.source, bytes);
      await io.writeFile(h.recordPath, JSON.stringify({ ...h.build, binary_sha256: sha256 }));
      const sourceBefore = await fileSnapshot(h.source);
      const recordBefore = await fileSnapshot(h.recordPath);
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      const isBinary = (path: unknown) =>
        path === h.source || (typeof path === "string" && dirname(path).endsWith("/bin"));
      vi.mocked(io.readFile).mockImplementation(async (...args) => {
        if (isBinary(args[0])) throw new Error("Whole binary buffering is forbidden");
        return native.readFile(...args);
      });
      vi.mocked(fs.readFileSync).mockImplementation((...args) => {
        if (isBinary(args[0])) throw new Error("Whole binary buffering is forbidden");
        return nativeFs.readFileSync(...args);
      });
      let published = 0;
      vi.mocked(io.rename).mockImplementation(async (source, target) => {
        if (String(target).endsWith("/bin/shud")) {
          published++;
          expect(observed.handles).toHaveLength(2);
          for (const entry of observed.handles) {
            expect(entry.closed).toBe(true);
            expect(entry.closes).toBe(1);
            expect(entry.handle.fd).toBe(-1);
          }
          expect((await native.readFile(source)).equals(bytes)).toBe(true);
          expect((await native.stat(source)).mode & 0o777).toBe(0o755);
        }
        await native.rename(source, target);
      });
      const job = await registry.submitShud(h.buildRequest, execution.start);
      expect(published).toBe(1);
      expect(job.binary_sha256).toBe(sha256);
      expect((await native.readFile(join(job.run_dir, "bin", "shud"))).equals(bytes)).toBe(true);
      for (const entry of observed.handles) {
        expect(entry.reads.length).toBeGreaterThan(0);
        for (const size of [...entry.reads, ...entry.writes])
          expect(size).toBeLessThanOrEqual(64 * 1024);
      }
      const destination = observed.handles.find((entry) => !entry.source);
      expect(destination?.writes.length).toBeGreaterThan(1);
      expect((await native.readFile(h.source)).equals(sourceBefore.bytes)).toBe(true);
      vi.mocked(io.readFile).mockImplementation(native.readFile);
      const { bytes: sourceBytes, ...sourceMetadata } = await fileSnapshot(h.source);
      const { bytes: originalBytes, ...originalMetadata } = sourceBefore;
      expect(sourceBytes.equals(originalBytes)).toBe(true);
      expect(sourceMetadata).toEqual(originalMetadata);
      expect(await fileSnapshot(h.recordPath)).toEqual(recordBefore);
    } finally {
      await observed.cleanup();
      await execution.finish();
      await h.dispose();
    }
  },
  15000,
);

test.each(["source-read", "destination-write", "destination-close"])(
  "accepted %s drains before state ownership release",
  async (phase) => {
    const h = await buildFixture();
    const contender = await createHarness();
    const execution = submissionProducer();
    const entered = barrier();
    const release = barrier();
    const handles: io.FileHandle[] = [];
    let pending: Promise<unknown> | undefined;
    let disposing: Promise<void> | undefined;
    try {
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      vi.mocked(io.open).mockImplementation(async (...args) => {
        const handle = await native.open(...args);
        const source = args[0] === h.source;
        const destination = typeof args[0] === "string" && dirname(args[0]).endsWith("/bin");
        if (!source && !destination) return handle;
        handles.push(handle);
        const hold = async () => {
          entered.release();
          await release.waiting;
        };
        if (source && phase === "source-read") {
          const read = handle.read.bind(handle);
          vi.spyOn(handle, "read").mockImplementationOnce(async (...readArgs) => {
            await hold();
            return read(...readArgs);
          });
        }
        if (destination && phase === "destination-write") {
          const write = handle.write.bind(handle);
          vi.spyOn(handle, "write").mockImplementationOnce(async (...writeArgs) => {
            await hold();
            return write(...writeArgs);
          });
        }
        if (destination && phase === "destination-close") {
          const close = handle.close.bind(handle);
          vi.spyOn(handle, "close").mockImplementationOnce(async () => {
            await hold();
            await close();
          });
        }
        return handle;
      });
      pending = registry
        .submitShud(h.buildRequest, () => {
          throw new Error("producer refuses start after drain");
        })
        .catch((error: unknown) => error);
      expect(
        await Promise.race([entered.waiting.then(() => "held"), pending.then(() => "settled")]),
      ).toBe("held");
      disposing = Promise.resolve(h.ctx.fiber.dispose());
      await expect
        .poll(async () => {
          try {
            await registry.submitShud({ ...h.request, project: "../invalid" }, execution.start);
            return "accepted";
          } catch (error) {
            return error instanceof Error ? error.message : "unknown";
          }
        })
        .toContain("admission is closed");
      expect(await io.readdir(h.stateDir)).toContain("lock");
      await expect(contender.apply(ShudJobRegistry, h.config)).rejects.toThrow(h.stateDir);
      expect(await names(join(h.cwd, "stacks"))).toEqual([]);
      expect(await names(join(h.cwd, "provenance"))).toEqual([]);
      release.release();
      expect(await pending).toBeInstanceOf(Error);
      await disposing;
      expect(handles).toHaveLength(2);
      expect(handles.every((handle) => handle.fd === -1)).toBe(true);
      expect(await names(join(h.cwd, "runs"))).toEqual([]);
      expect(await names(join(h.cwd, "provenance"))).toEqual([]);
      expect(await io.readdir(h.stateDir)).not.toContain("lock");
      await h.assertReadonly();
    } finally {
      release.release();
      await pending;
      await disposing;
      await contender.dispose();
      await execution.finish();
      await h.dispose();
    }
  },
  15000,
);
