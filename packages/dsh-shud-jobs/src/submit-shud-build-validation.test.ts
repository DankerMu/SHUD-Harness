import * as io from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import type * as NodeFs from "node:fs";
import type * as NodeIo from "node:fs/promises";
import { ShudJobRegistry, type SubmitShudRequest } from "./index.ts";
import {
  actualRegistry,
  submissionFixture,
  submissionProducer,
} from "./submit-shud/test-harness.ts";

const guard = vi.hoisted(() => ({ all: false, builds: "", calls: [] as string[] }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  function wrap(value: unknown, name: string): unknown {
    if (typeof value !== "function") return value;
    return new Proxy(value, {
      apply(target, receiver, args: unknown[]): unknown {
        if (
          guard.all ||
          (guard.builds &&
            args.some(
              (arg) =>
                typeof arg === "string" &&
                (arg === guard.builds || arg.startsWith(`${guard.builds}/`)),
            ))
        ) {
          guard.calls.push(name);
          throw new Error(`unexpected filesystem access: ${name}`);
        }
        return Reflect.apply(target, receiver, args);
      },
      get(target, property, receiver): unknown {
        const child: unknown = Reflect.get(target, property, receiver);
        return property === "native" ? wrap(child, `${name}.native`) : child;
      },
    });
  }
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [name, wrap(value, name)]),
  );
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      typeof value !== "function"
        ? value
        : new Proxy(value, {
            apply(target, receiver, args: unknown[]): unknown {
              if (
                guard.all ||
                (guard.builds &&
                  args.some(
                    (arg) =>
                      typeof arg === "string" &&
                      (arg === guard.builds || arg.startsWith(`${guard.builds}/`)),
                  ))
              ) {
                guard.calls.push(name);
                throw new Error(`unexpected filesystem access: ${name}`);
              }
              return Reflect.apply(target, receiver, args);
            },
          }),
    ]),
  );
});
beforeEach(() => {
  guard.all = false;
  guard.builds = "";
  guard.calls = [];
});

test.each([
  ...[null, "", "BUILD-0001", "BUILD-20261102T090000-A7B8", "TASK-20261102T090000-a7b8", 7, {}].map(
    (value) => ({ field: "build_id", value }),
  ),
  ...[null, 0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "2", {}].map(
    (value) => ({ field: "threads", value }),
  ),
])(
  "invalid $field=$value is rejected before any filesystem operation",
  async ({ field, value }) => {
    const h = await submissionFixture();
    const execution = submissionProducer();
    try {
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      const request = { ...h.request, [field]: value } as unknown as SubmitShudRequest;
      guard.all = true;
      try {
        await expect(registry.submitShud(request, execution.start)).rejects.toThrow(field);
        expect(guard.calls).toEqual([]);
      } finally {
        guard.all = false;
      }
      expect(await io.readdir(h.cwd)).toEqual([]);
      expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
      expect(execution.handles).toEqual([]);
    } finally {
      guard.all = false;
      await execution.finish();
      await h.dispose();
    }
  },
);

test.each(["missing", "broken-link"])(
  "no-build submission never accesses %s builds",
  async (kind) => {
    const h = await submissionFixture();
    const execution = submissionProducer();
    const builds = join(h.cwd, "builds");
    try {
      if (kind === "broken-link") await io.symlink(join(h.root, "absent-builds"), builds);
      await h.apply(ShudJobRegistry, h.config);
      guard.builds = join(await io.realpath(h.cwd), "builds");
      const job = await actualRegistry(h.ctx).submitShud(h.request, execution.start);
      expect(guard.calls).toEqual([]);
      expect(job).toMatchObject({ build_id: null, binary_sha256: null, threads: null });
      expect(job.command).toEqual([h.shudBin, "-o", "output/tiny.out", "tiny"]);
      expect(await io.readdir(job.run_dir)).not.toContain("bin");
      guard.builds = "";
      if (kind === "broken-link") {
        expect((await io.lstat(builds)).isSymbolicLink()).toBe(true);
        expect(await io.readlink(builds)).toBe(join(h.root, "absent-builds"));
      } else await expect(io.lstat(builds)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      guard.builds = "";
      await execution.finish();
      await h.dispose();
    }
  },
);
