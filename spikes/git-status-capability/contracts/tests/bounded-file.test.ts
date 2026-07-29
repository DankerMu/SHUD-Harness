import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContractError, ingestJsonAgainstLimits } from "../lib/ingestion";
import { SCHEMA_DESCRIPTORS } from "../lib/frozen";
import { errorReceipt, invoke, successReceipt } from "./authority-test-helpers";

describe("bounded descriptor-based file admission", () => {
  test("rejects symlink and non-regular inputs without following them", async () => {
    const root = await mkdtemp(join(tmpdir(), "shud-no-follow-"));
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
    const root = await mkdtemp(join(tmpdir(), "shud-byte-bound-"));
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
});
