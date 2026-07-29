import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SYNTHETIC_DIGEST } from "../lib/constants";
import { ContractError } from "../lib/ingress";
import {
  DOMAIN_PREFIX, SYNTHETIC_ENTRIES, decodeSourceInputFrame, encodeSourceInputFrame, validateSyntheticOracle
} from "../lib/source-frame";
import { contractsRoot } from "./helpers";

const framePath = join(contractsRoot, "goldens", "source-input-v1.synthetic.frame");
const sidecarPath = join(contractsRoot, "goldens", "source-input-v1.synthetic.sha256");

function recomputedSidecar(frame: Uint8Array): Buffer {
  return Buffer.from(`${createHash("sha256").update(frame).digest("hex")}\n`, "ascii");
}

function schemaFailure(frame: Uint8Array, sidecar: Uint8Array): void {
  expect(() => validateSyntheticOracle(frame, sidecar)).toThrow(ContractError);
  try {
    validateSyntheticOracle(frame, sidecar);
  } catch (error) {
    expect((error as ContractError).code).toBe("CONTRACT_SCHEMA_INVALID");
  }
}

describe("exact source_input_digest_v1 synthetic oracle", () => {
  test("independent literal construction is exactly three entries, 152 bytes, and the frozen SHA-256", async () => {
    const entries = [
      { path: "a.txt", gitMode: "100644" as const, content: Buffer.from("alpha\n") },
      { path: "bin/run", gitMode: "100755" as const, content: Buffer.from([0, 1, 2, 255]) },
      { path: "unicode/β.txt", gitMode: "100644" as const, content: Buffer.from("water\n") }
    ];
    const independentParts: Buffer[] = [Buffer.from("SHUD-HARNESS\0GIT-STATUS-CAPABILITY\0SOURCE-INPUT-DIGEST\0V1\0", "ascii")];
    const count = Buffer.alloc(4); count.writeUInt32BE(3); independentParts.push(count);
    for (const entry of entries) {
      const path = Buffer.from(entry.path, "utf8");
      const pathLength = Buffer.alloc(4); pathLength.writeUInt32BE(path.length);
      const mode = Buffer.alloc(4); mode.writeUInt32BE(Number.parseInt(entry.gitMode, 8));
      const contentLength = Buffer.alloc(8); contentLength.writeBigUInt64BE(BigInt(entry.content.length));
      independentParts.push(pathLength, path, mode, contentLength, entry.content);
    }
    const independent = Buffer.concat(independentParts);
    const committed = await readFile(framePath);
    const sidecar = await readFile(sidecarPath);
    expect(independent).toHaveLength(152);
    expect(createHash("sha256").update(independent).digest("hex")).toBe(SYNTHETIC_DIGEST);
    expect(committed).toEqual(independent);
    expect(encodeSourceInputFrame([...SYNTHETIC_ENTRIES].reverse())).toEqual(independent);
    expect(decodeSourceInputFrame(committed).map(({ path, gitMode, content }) => ({ path, gitMode, content: [...content] }))).toEqual(
      entries.map(({ path, gitMode, content }) => ({ path, gitMode, content: [...content] }))
    );
    expect(() => validateSyntheticOracle(committed, sidecar)).not.toThrow();
    expect(() => validateSyntheticOracle(committed, sidecar)).not.toThrow();
  });

  test("synchronized 58-byte truncation and same-length frame+sidecar attacks fail", async () => {
    const committed = await readFile(framePath);
    const prefixOnly = committed.subarray(0, DOMAIN_PREFIX.length);
    expect(prefixOnly).toHaveLength(58);
    schemaFailure(prefixOnly, recomputedSidecar(prefixOnly));
    const sameLength = Buffer.from(committed);
    sameLength[sameLength.length - 1] ^= 1;
    expect(sameLength).toHaveLength(152);
    schemaFailure(sameLength, recomputedSidecar(sameLength));
  });

  test("entry count, order, path, mode, content, framing, digest, trailing, and truncation mutations fail independently", async () => {
    const committed = await readFile(framePath);
    const sidecar = await readFile(sidecarPath);
    const mutations: Buffer[] = [];
    const count = Buffer.from(committed); count.writeUInt32BE(2, DOMAIN_PREFIX.length); mutations.push(count);
    const order = Buffer.concat([
      committed.subarray(0, DOMAIN_PREFIX.length + 4),
      committed.subarray(DOMAIN_PREFIX.length + 31, DOMAIN_PREFIX.length + 58),
      committed.subarray(DOMAIN_PREFIX.length + 4, DOMAIN_PREFIX.length + 31),
      committed.subarray(DOMAIN_PREFIX.length + 58)
    ]); mutations.push(order);
    const path = Buffer.from(committed); path[DOMAIN_PREFIX.length + 8] ^= 1; mutations.push(path);
    const mode = Buffer.from(committed); mode[DOMAIN_PREFIX.length + 13] ^= 1; mutations.push(mode);
    const content = Buffer.from(committed); content[DOMAIN_PREFIX.length + 26] ^= 1; mutations.push(content);
    const framing = Buffer.from(committed); framing[0] ^= 1; mutations.push(framing);
    mutations.push(Buffer.concat([committed, Buffer.from([0])]));
    mutations.push(committed.subarray(0, committed.length - 1));
    for (const changed of mutations) schemaFailure(changed, sidecar);
    const wrongDigest = Buffer.from(sidecar); wrongDigest[0] = wrongDigest[0] === 0x30 ? 0x31 : 0x30;
    schemaFailure(committed, wrongDigest);
  });

  test("encoder rejects unsafe, duplicate, and unsupported entries", () => {
    for (const path of ["/absolute", "../escape", "dot/./path", "back\\slash", ""])
      expect(() => encodeSourceInputFrame([{ path, gitMode: "100644", content: new Uint8Array() }])).toThrow();
    expect(() => encodeSourceInputFrame([
      { path: "same", gitMode: "100644", content: new Uint8Array() },
      { path: "same", gitMode: "100755", content: new Uint8Array() }
    ])).toThrow("SOURCE_PATH_DUPLICATE");
    expect(() => encodeSourceInputFrame([{ path: "ok", gitMode: "100600" as "100644", content: new Uint8Array() }])).toThrow("SOURCE_MODE_INVALID");
  });
});
