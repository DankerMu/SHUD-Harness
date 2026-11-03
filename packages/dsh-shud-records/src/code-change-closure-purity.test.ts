import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { codeChangeClosure, evaluateClosure } from "./index.ts";
import {
  closureEvidence,
  evidenceLoaders,
  freezeEvidence,
} from "./code-change-closure-test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    readdirSync: vi.fn(actual.readdirSync),
    lstatSync: vi.fn(actual.lstatSync),
    statSync: vi.fn(actual.statSync),
    openSync: vi.fn(actual.openSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
    linkSync: vi.fn(actual.linkSync),
    unlinkSync: vi.fn(actual.unlinkSync),
    rmSync: vi.fn(actual.rmSync),
  };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof io>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    readdir: vi.fn(actual.readdir),
    lstat: vi.fn(actual.lstat),
    stat: vi.fn(actual.stat),
    open: vi.fn(actual.open),
    mkdir: vi.fn(actual.mkdir),
    writeFile: vi.fn(actual.writeFile),
    rename: vi.fn(actual.rename),
    link: vi.fn(actual.link),
    unlink: vi.fn(actual.unlink),
    rm: vi.fn(actual.rm),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test.each([true, false])(
  "closure success=%s owns no filesystem, logging, clock or mutation",
  (success) => {
    const input = closureEvidence();
    if (!success) input.draft.limitations = [];
    const { loaders } = evidenceLoaders(input);
    const before = structuredClone(input);
    freezeEvidence(input);
    freezeEvidence(loaders);
    const clock = vi.fn(function () {
      throw new Error("Closure must not read the clock");
    });
    // Preserve static parse for schema datetime validation, not wall-clock observation.
    Object.assign(clock, {
      parse: Date.parse,
      UTC: Date.UTC,
      now: vi.fn(() => {
        throw new Error("Closure must not read time");
      }),
    });
    vi.stubGlobal("Date", clock);
    const logs = ["log", "info", "warn", "error", "debug"] as const;
    const logSpies = logs.map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    vi.clearAllMocks();

    const direct = codeChangeClosure(input.card, loaders);
    const facade = evaluateClosure(input.card, input.runJobs, input.records, input.draft, loaders);

    expect(direct.ok).toBe(success);
    expect(facade).toStrictEqual(direct);
    expect(input).toStrictEqual(before);
    expect(clock).not.toHaveBeenCalled();
    expect(Date.now).not.toHaveBeenCalled();
    for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
    for (const operation of [
      fs.readFileSync,
      fs.readdirSync,
      fs.lstatSync,
      fs.statSync,
      fs.openSync,
      fs.mkdirSync,
      fs.writeFileSync,
      fs.renameSync,
      fs.linkSync,
      fs.unlinkSync,
      fs.rmSync,
      io.readFile,
      io.readdir,
      io.lstat,
      io.stat,
      io.open,
      io.mkdir,
      io.writeFile,
      io.rename,
      io.link,
      io.unlink,
      io.rm,
    ])
      expect(operation).not.toHaveBeenCalled();
  },
);
