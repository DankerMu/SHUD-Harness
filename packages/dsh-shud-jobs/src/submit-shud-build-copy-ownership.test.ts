import * as io from "node:fs/promises";
import { dirname, join } from "node:path";
import type * as NodeIo from "node:fs/promises";
import { beforeEach, expect, test, vi, type MockInstance } from "vitest";
import { ShudJobRegistry } from "./index.ts";
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
    mkdir: vi.fn(actual.mkdir),
    rename: vi.fn(actual.rename),
  };
});
const native = await vi.importActual<typeof NodeIo>("node:fs/promises");
beforeEach(() => {
  vi.mocked(io.open).mockReset().mockImplementation(native.open);
  vi.mocked(io.mkdir).mockReset().mockImplementation(native.mkdir);
  vi.mocked(io.rename).mockReset().mockImplementation(native.rename);
});

test.each(["source-open", "before-read", "after-read", "after-write"])(
  "run replacement at %s stops copied-binary work and retains foreign bytes",
  async (phase) => {
    const h = await buildFixture();
    const execution = submissionProducer();
    const handles: io.FileHandle[] = [];
    let replacement = "";
    let writes = 0;
    let writesAtReplacement = 0;
    try {
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      async function replaceRun() {
        const runs = await io.readdir(join(h.cwd, "runs"));
        expect(runs).toHaveLength(1);
        replacement = join(h.cwd, "runs", runs[0]);
        await io.rename(replacement, join(h.root, "owned-run"));
        await io.mkdir(replacement);
        await io.writeFile(join(replacement, "foreign-sentinel"), "foreign bytes\n");
        writesAtReplacement = writes;
      }
      vi.mocked(io.open).mockImplementation(async (...args) => {
        const handle = await native.open(...args);
        const source = args[0] === h.source;
        const destination = typeof args[0] === "string" && dirname(args[0]).endsWith("/bin");
        if (!source && !destination) return handle;
        handles.push(handle);
        if (source && phase === "source-open") await replaceRun();
        if (source && (phase === "before-read" || phase === "after-read")) {
          const read = handle.read.bind(handle);
          vi.spyOn(handle, "read").mockImplementationOnce(async (...readArgs) => {
            if (phase === "before-read") await replaceRun();
            const result = await read(...readArgs);
            if (phase === "after-read") await replaceRun();
            return result;
          });
        }
        if (destination) {
          const write = handle.write.bind(handle);
          vi.spyOn(handle, "write").mockImplementation(async (...writeArgs) => {
            writes++;
            const result = await write(...writeArgs);
            if (phase === "after-write" && replacement === "") await replaceRun();
            return result;
          });
        }
        return handle;
      });
      await expect(registry.submitShud(h.buildRequest, execution.start)).rejects.toThrow(
        /retained run path/iu,
      );
      expect(replacement).not.toBe("");
      expect(await io.readdir(replacement)).toEqual(["foreign-sentinel"]);
      expect(await io.readFile(join(replacement, "foreign-sentinel"), "utf8")).toBe(
        "foreign bytes\n",
      );
      expect(writes).toBe(writesAtReplacement);
      expect(handles).toHaveLength(phase === "source-open" ? 1 : 2);
      expect(handles.every((handle) => handle.fd === -1)).toBe(true);
      expect(execution.handles).toEqual([]);
      expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
      expect(await names(join(h.cwd, "stacks"))).toEqual([]);
      expect(await names(join(h.cwd, "provenance"))).toEqual([]);
      await h.assertReadonly();
    } finally {
      await execution.finish();
      await h.dispose();
    }
  },
);

test.each(["symlink", "different-file"])(
  "source replacement after verification (%s) cannot bypass copier identity checks",
  async (kind) => {
    const h = await buildFixture();
    const execution = submissionProducer();
    const handles: io.FileHandle[] = [];
    let acquisitions = 0;
    try {
      const foreign = join(h.root, "foreign-executable");
      await io.writeFile(foreign, binaryBytes, { mode: 0o755 });
      const before = await fileSnapshot(foreign);
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      vi.mocked(io.open).mockImplementation(async (...args) => {
        if (args[0] === h.source) {
          acquisitions++;
          await io.rename(h.source, join(h.buildDir, "original-source"));
          if (kind === "symlink") await io.symlink(foreign, h.source);
          else await io.copyFile(foreign, h.source);
          const handle = await native.open(...args);
          handles.push(handle);
          return handle;
        }
        return native.open(...args);
      });
      await expect(registry.submitShud(h.buildRequest, execution.start)).rejects.toThrow(
        h.build.build_id,
      );
      expect(acquisitions).toBe(1);
      expect(handles.every((handle) => handle.fd === -1)).toBe(true);
      expect(await fileSnapshot(foreign)).toEqual(before);
      expect(execution.handles).toEqual([]);
      expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
      expect(await names(join(h.cwd, "runs"))).toEqual([]);
      expect(await names(join(h.cwd, "stacks"))).toEqual([]);
      expect(await names(join(h.cwd, "provenance"))).toEqual([]);
    } finally {
      await execution.finish();
      await h.dispose();
    }
  },
);

test.each(["bin", "temporary", "target"])(
  "foreign %s survives recursive run rollback",
  async (kind) => {
    const h = await buildFixture();
    const execution = submissionProducer();
    const handles: io.FileHandle[] = [];
    let foreign = "";
    try {
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      vi.mocked(io.open).mockImplementation(async (...args) => {
        const handle = await native.open(...args);
        if (args[0] === h.source) handles.push(handle);
        if (typeof args[0] === "string" && dirname(args[0]).endsWith("/bin")) {
          handles.push(handle);
          const temporary = args[0];
          const chmod = handle.chmod.bind(handle);
          vi.spyOn(handle, "chmod").mockImplementationOnce(async (mode) => {
            await chmod(mode);
            if (kind === "bin") {
              const bin = dirname(temporary);
              await io.rename(bin, join(h.root, "owned-bin"));
              await io.mkdir(bin);
              foreign = join(bin, "foreign-sentinel");
            } else if (kind === "target") {
              foreign = join(dirname(temporary), "shud");
            } else {
              await io.rename(temporary, join(h.root, "owned-temporary"));
              foreign = temporary;
            }
            await io.writeFile(foreign, "foreign replacement\n");
          });
        }
        return handle;
      });
      await expect(registry.submitShud(h.buildRequest, execution.start)).rejects.toThrow(
        /retained run path/iu,
      );
      expect(foreign).not.toBe("");
      expect(await io.readFile(foreign, "utf8")).toBe("foreign replacement\n");
      expect(handles).toHaveLength(2);
      expect(handles.every((handle) => handle.fd === -1)).toBe(true);
      expect(execution.handles).toEqual([]);
      expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
      expect(await names(join(h.cwd, "stacks"))).toEqual([]);
      expect(await names(join(h.cwd, "provenance"))).toEqual([]);
      await h.assertReadonly();
    } finally {
      await execution.finish();
      await h.dispose();
    }
  },
);

test.each(["bin-collision", "temporary-collision", "replacement-read-error"])(
  "%s preserves observed foreign bytes when binary acquisition or copying fails",
  async (phase) => {
    const h = await buildFixture();
    const execution = submissionProducer();
    const handles: io.FileHandle[] = [];
    let foreign = "";
    let temporary = "";
    let injections = 0;
    let failureCode: unknown;
    try {
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      vi.mocked(io.mkdir).mockImplementation(async (...args) => {
        if (phase !== "bin-collision" || typeof args[0] !== "string" || !args[0].endsWith("/bin"))
          return native.mkdir(...args);
        injections++;
        await native.mkdir(args[0]);
        foreign = join(args[0], "foreign-sentinel");
        await native.writeFile(foreign, "foreign acquisition bytes\n");
        try {
          return await native.mkdir(...args);
        } catch (error) {
          if (error instanceof Error && "code" in error) failureCode = error.code;
          throw error;
        }
      });
      vi.mocked(io.open).mockImplementation(async (...args) => {
        const source = args[0] === h.source;
        const destination = typeof args[0] === "string" && dirname(args[0]).endsWith("/bin");
        if (destination && typeof args[0] === "string") {
          temporary = args[0];
          if (phase === "temporary-collision") {
            injections++;
            foreign = temporary;
            await native.writeFile(foreign, "foreign acquisition bytes\n");
            try {
              return await native.open(...args);
            } catch (error) {
              if (error instanceof Error && "code" in error) failureCode = error.code;
              throw error;
            }
          }
        }
        const handle = await native.open(...args);
        if (source || destination) handles.push(handle);
        if (source && phase === "replacement-read-error") {
          vi.spyOn(handle, "read").mockImplementationOnce(async () => {
            expect(temporary).not.toBe("");
            expect(handles).toHaveLength(2);
            await native.rename(temporary, join(h.root, "owned-temporary-before-read"));
            foreign = temporary;
            await native.writeFile(foreign, "foreign acquisition bytes\n");
            injections++;
            failureCode = "EIO";
            throw Object.assign(new Error("injected source read failure after replacement"), {
              code: "EIO",
            });
          });
        }
        return handle;
      });
      const outcome: unknown = await registry
        .submitShud(h.buildRequest, execution.start)
        .catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(Error);
      expect(injections).toBe(1);
      expect(failureCode).toBe(phase === "replacement-read-error" ? "EIO" : "EEXIST");
      expect(handles).toHaveLength(
        phase === "bin-collision" ? 0 : phase === "temporary-collision" ? 1 : 2,
      );
      expect(handles.every((handle) => handle.fd === -1)).toBe(true);
      expect(execution.handles).toEqual([]);
      expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
      expect(await names(join(h.cwd, "stacks"))).toEqual([]);
      expect(await names(join(h.cwd, "provenance"))).toEqual([]);
      expect(foreign).not.toBe("");
      expect(await native.readFile(foreign, "utf8")).toBe("foreign acquisition bytes\n");
      expect(await names(join(h.cwd, "runs"))).toHaveLength(1);
      if (!(outcome instanceof Error)) throw new Error("Expected failed binary preparation");
      expect(outcome.message).toContain("retained run path");
      await h.assertReadonly();
    } finally {
      for (const handle of handles) {
        if (handle.fd !== -1) await handle.close();
      }
      await execution.finish();
      await h.dispose();
    }
  },
);

test.each(["stat-replacement-error", "target-read-error", "sibling-read-error"])(
  "%s retains foreign children while closing owned descriptors once",
  async (phase) => {
    const h = await buildFixture();
    const execution = submissionProducer();
    const handles: io.FileHandle[] = [];
    const closes: MockInstance<() => Promise<void>>[] = [];
    let temporary = "";
    let foreign = "";
    let injections = 0;
    try {
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      vi.mocked(io.open).mockImplementation(async (...args) => {
        const handle = await native.open(...args);
        const source = args[0] === h.source;
        const destination = typeof args[0] === "string" && dirname(args[0]).endsWith("/bin");
        if (source || destination) {
          handles.push(handle);
          closes.push(vi.spyOn(handle, "close"));
        }
        if (destination && typeof args[0] === "string") {
          temporary = args[0];
          if (phase === "stat-replacement-error") {
            vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
              await native.rename(temporary, join(h.root, "owned-before-stat"));
              foreign = temporary;
              await native.writeFile(foreign, "foreign failure-path bytes\n");
              injections++;
              throw Object.assign(new Error("injected descriptor stat failure"), { code: "EIO" });
            });
          }
        }
        if (source && phase !== "stat-replacement-error") {
          vi.spyOn(handle, "read").mockImplementationOnce(async () => {
            expect(temporary).not.toBe("");
            foreign = join(
              dirname(temporary),
              phase === "target-read-error" ? "shud" : "foreign-sibling",
            );
            await native.writeFile(foreign, "foreign failure-path bytes\n");
            injections++;
            throw Object.assign(new Error("injected read failure with foreign child"), {
              code: "EIO",
            });
          });
        }
        return handle;
      });
      const outcome: unknown = await registry
        .submitShud(h.buildRequest, execution.start)
        .catch((error: unknown) => error);
      expect(injections).toBe(1);
      expect(handles).toHaveLength(2);
      for (const handle of handles) {
        expect(handle.fd).toBe(-1);
      }
      for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
      expect(await native.readFile(foreign, "utf8")).toBe("foreign failure-path bytes\n");
      expect(outcome).toBeInstanceOf(AggregateError);
      if (!(outcome instanceof AggregateError)) throw new Error("Expected ownership failure");
      expect(outcome.message).toContain("retained run path");
      const primary: unknown = outcome.errors[0];
      expect(primary).toBeInstanceOf(AggregateError);
      if (!(primary instanceof AggregateError)) throw new Error("Expected build ownership causes");
      expect(primary.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: expect.stringContaining("EIO") as unknown }),
        ]),
      );
      expect(execution.handles).toEqual([]);
      expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
      expect(await names(join(h.cwd, "stacks"))).toEqual([]);
      expect(await names(join(h.cwd, "provenance"))).toEqual([]);
      await h.assertReadonly();
    } finally {
      for (const handle of handles) {
        if (handle.fd !== -1) await handle.close();
      }
      await execution.finish();
      await h.dispose();
    }
  },
);

test("an error reported after the binary rename removes only the still-owned published inode", async () => {
  const h = await buildFixture();
  const execution = submissionProducer();
  const handles: io.FileHandle[] = [];
  const closes: MockInstance<() => Promise<void>>[] = [];
  let injections = 0;
  try {
    await h.apply(ShudJobRegistry, h.config);
    const registry = actualRegistry(h.ctx);
    vi.mocked(io.open).mockImplementation(async (...args) => {
      const handle = await native.open(...args);
      if (
        args[0] === h.source ||
        (typeof args[0] === "string" && dirname(args[0]).endsWith("/bin"))
      ) {
        handles.push(handle);
        closes.push(vi.spyOn(handle, "close"));
      }
      return handle;
    });
    vi.mocked(io.rename).mockImplementation(async (source, target) => {
      await native.rename(source, target);
      if (typeof target === "string" && target.endsWith("/bin/shud")) {
        injections++;
        expect((await native.readFile(target)).equals(binaryBytes)).toBe(true);
        throw Object.assign(new Error("injected post-rename failure"), { code: "EIO" });
      }
    });
    const outcome: unknown = await registry
      .submitShud(h.buildRequest, execution.start)
      .catch((error: unknown) => error);
    expect(injections).toBe(1);
    expect(handles).toHaveLength(2);
    for (const handle of handles) {
      expect(handle.fd).toBe(-1);
    }
    for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
    expect(outcome).toBeInstanceOf(Error);
    if (!(outcome instanceof Error)) throw new Error("Expected publication failure");
    expect(outcome.message).toMatch(/binary publication.*EIO/u);
    expect(outcome.message).not.toContain("retained run path");
    expect(execution.handles).toEqual([]);
    expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
    expect(await names(join(h.cwd, "runs"))).toEqual([]);
    expect(await names(join(h.cwd, "stacks"))).toEqual([]);
    expect(await names(join(h.cwd, "provenance"))).toEqual([]);
    await h.assertReadonly();
  } finally {
    for (const handle of handles) {
      if (handle.fd !== -1) await handle.close();
    }
    await execution.finish();
    await h.dispose();
  }
});
