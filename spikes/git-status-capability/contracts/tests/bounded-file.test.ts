import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContractError, ingestJsonAgainstLimits } from "../lib/ingestion";
import { readJsonFileBounded } from "../lib/ingestion";
import { readRegularFileBounded } from "../lib/authority";
import { withPathSafetyTestInterlock } from "../lib/path-safety";
import { SCHEMA_DESCRIPTORS } from "../lib/frozen";
import { errorReceipt, invoke, successReceipt } from "./authority-test-helpers";

describe("bounded descriptor-based file admission", () => {
  async function descriptorCount(): Promise<number> {
    return (await readdir("/dev/fd")).length;
  }

  test("rejects symlink and non-regular inputs without following them", async () => {
    const root = await mkdtemp(join(realpathSync(tmpdir()), "shud-no-follow-"));
    try {
      const target = join(root, "target.json");
      const link = join(root, "link.json");
      const directory = join(root, "directory");
      await writeFile(target, JSON.stringify(SCHEMA_DESCRIPTORS.frame));
      await symlink(target, link);
      await mkdir(directory);
      for (const path of [link, directory]) {
        expect(await invoke(["--input", path, "--kind", "schema"])).toEqual({
          exit: 2, stdout: "", stderr: errorReceipt("CONTRACT_SCHEMA_INVALID")
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a symlinked intermediate directory at the standalone authority seam", async () => {
    const root = await mkdtemp(join(realpathSync(tmpdir()), "shud-intermediate-no-follow-"));
    try {
      const nested = join(root, "nested");
      const moved = join(root, "nested-moved");
      await mkdir(nested);
      await writeFile(join(nested, "input.json"), JSON.stringify(SCHEMA_DESCRIPTORS.frame));
      await rename(nested, moved);
      await symlink(moved, nested);
      expect(await invoke(["--input", join(nested, "input.json"), "--kind", "schema"])).toEqual({
        exit: 2, stdout: "", stderr: errorReceipt("CONTRACT_SCHEMA_INVALID")
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects non-canonical or unsafe integer spellings at ingress", () => {
    const limit = { bytes: 128, depth: 8, nodes: 16, items: 16 };
    for (const literal of ["1.0", "1e0", "-0", "9007199254740992"]) {
      try {
        ingestJsonAgainstLimits(new TextEncoder().encode(literal), limit);
        throw new Error("expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(ContractError);
        expect((error as ContractError).code).toBe("CONTRACT_SCHEMA_INVALID");
      }
    }
    expect(ingestJsonAgainstLimits(new TextEncoder().encode("9007199254740991"), limit)).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("admits an exact-bound regular file and rejects bound plus one at the public seam", async () => {
    const root = await mkdtemp(join(realpathSync(tmpdir()), "shud-byte-bound-"));
    try {
      const base = JSON.stringify(SCHEMA_DESCRIPTORS.frame);
      const exactPath = join(root, "exact.json");
      const exceededPath = join(root, "exceeded.json");
      await writeFile(exactPath, `${base}${" ".repeat(256 * 1024 - base.length)}`);
      await writeFile(exceededPath, `${base}${" ".repeat(256 * 1024 + 1 - base.length)}`);
      expect(await invoke(["--input", exactPath, "--kind", "schema"])).toEqual({
        exit: 0, stdout: successReceipt("schema"), stderr: ""
      });
      expect(await invoke(["--input", exceededPath, "--kind", "schema"])).toEqual({
        exit: 2, stdout: "", stderr: errorReceipt("CONTRACT_BYTES_LIMIT")
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a platform character device at both bounded-reader seams", async () => {
    expect(await invoke(["--input", "/dev/null", "--kind", "schema"])).toEqual({
      exit: 2, stdout: "", stderr: errorReceipt("CONTRACT_SCHEMA_INVALID")
    });
    await expect(readRegularFileBounded("/dev/null", 64)).rejects.toMatchObject({ code: "CONTRACT_SCHEMA_INVALID" });
  });

  test("binds the opened handle to the captured terminal across rename-replace-restore attacks", async () => {
    const root = await mkdtemp(join(realpathSync(tmpdir()), "shud-opened-identity-"));
    try {
      const path = join(root, "input.json");
      const parked = join(root, "input.parked.json");
      const original = JSON.stringify(SCHEMA_DESCRIPTORS.frame);
      const replacement = JSON.stringify(SCHEMA_DESCRIPTORS.authority_set);
      await writeFile(path, original);
      const runWithReplacement = async <T>(run: () => Promise<T>): Promise<T> => {
        let replaced = false;
        return await withPathSafetyTestInterlock(async (phase, currentPath) => {
          if (currentPath !== path) return;
          if (phase === "after-capture") {
            expect(replaced).toBe(false);
            await rename(path, parked);
            await writeFile(path, replacement);
            replaced = true;
          } else {
            expect(replaced).toBe(true);
            await rm(path);
            await rename(parked, path);
          }
        }, run);
      };

      const baseline = await descriptorCount();
      await expect(runWithReplacement(() => readRegularFileBounded(path, 256 * 1024)))
        .rejects.toMatchObject({ code: "CONTRACT_SCHEMA_INVALID" });
      expect(await descriptorCount()).toBe(baseline);

      const first = await runWithReplacement(() => invoke(["--input", path, "--kind", "schema"]));
      const second = await runWithReplacement(() => invoke(["--input", path, "--kind", "schema"]));
      expect(first).toEqual({ exit: 2, stdout: "", stderr: errorReceipt("CONTRACT_SCHEMA_INVALID") });
      expect(second).toEqual(first);
      expect(await descriptorCount()).toBe(baseline);
      expect(await Bun.file(path).text()).toBe(original);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("restores the descriptor baseline after bounded-reader success and every failure class", async () => {
    const root = await mkdtemp(join(realpathSync(tmpdir()), "shud-descriptor-cleanup-"));
    try {
      const valid = join(root, "valid.json");
      const malformed = join(root, "malformed.json");
      const oversized = join(root, "oversized.json");
      const link = join(root, "link.json");
      const directory = join(root, "directory");
      const missing = join(root, "missing.json");
      await writeFile(valid, JSON.stringify(SCHEMA_DESCRIPTORS.frame));
      await writeFile(malformed, "{");
      await writeFile(oversized, Buffer.alloc(256 * 1024 + 1));
      await symlink(valid, link);
      await mkdir(directory);
      const baseline = await descriptorCount();
      const operations = [
        async () => { await readRegularFileBounded(valid, 256 * 1024); },
        async () => { await readJsonFileBounded(valid, "schema"); },
        async () => { await readRegularFileBounded(oversized, 256 * 1024).catch(() => undefined); },
        async () => { await readJsonFileBounded(oversized, "schema").catch(() => undefined); },
        async () => { await readJsonFileBounded(malformed, "schema").catch(() => undefined); },
        async () => { await readRegularFileBounded(link, 256 * 1024).catch(() => undefined); },
        async () => { await readJsonFileBounded(link, "schema").catch(() => undefined); },
        async () => { await readRegularFileBounded(directory, 256 * 1024).catch(() => undefined); },
        async () => { await readJsonFileBounded(directory, "schema").catch(() => undefined); },
        async () => { await readRegularFileBounded(missing, 256 * 1024).catch(() => undefined); },
        async () => { await readJsonFileBounded(missing, "schema").catch(() => undefined); },
        async () => { await readRegularFileBounded("/dev/null", 64).catch(() => undefined); },
        async () => { await readJsonFileBounded("/dev/null", "schema").catch(() => undefined); }
      ];
      for (const operation of operations) {
        await operation();
        expect(await descriptorCount()).toBe(baseline);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
