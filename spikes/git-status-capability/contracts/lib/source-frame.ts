import { createHash } from "node:crypto";
import { SYNTHETIC_DIGEST, SYNTHETIC_FRAME_BYTES } from "./constants";
import { ContractError } from "./ingress";

export const DOMAIN_PREFIX = Buffer.from("SHUD-HARNESS\0GIT-STATUS-CAPABILITY\0SOURCE-INPUT-DIGEST\0V1\0", "ascii");

export type SourceFrameEntry = Readonly<{
  path: string;
  gitMode: "100644" | "100755";
  content: Uint8Array;
}>;

export const SYNTHETIC_ENTRIES: readonly SourceFrameEntry[] = Object.freeze([
  { path: "a.txt", gitMode: "100644", content: Uint8Array.from(Buffer.from("alpha\n")) },
  { path: "bin/run", gitMode: "100755", content: Uint8Array.from([0, 1, 2, 255]) },
  { path: "unicode/β.txt", gitMode: "100644", content: Uint8Array.from(Buffer.from("water\n")) }
]);

function canonicalPathBytes(path: string): Buffer {
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new TypeError("SOURCE_PATH_INVALID");
  }
  if (path.split("/").some((part) => !part || part === "." || part === "..")) throw new TypeError("SOURCE_PATH_INVALID");
  const bytes = Buffer.from(path, "utf8");
  if (new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== path) throw new TypeError("SOURCE_PATH_INVALID");
  return bytes;
}
function compareBytes(left: Uint8Array, right: Uint8Array): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

export function encodeSourceInputFrame(entries: readonly SourceFrameEntry[]): Buffer {
  if (entries.length > 0xffff_ffff) throw new RangeError("SOURCE_ENTRY_COUNT_LIMIT");
  const prepared = entries.map((entry) => ({ ...entry, encodedPath: canonicalPathBytes(entry.path) }))
    .sort((left, right) => compareBytes(left.encodedPath, right.encodedPath));
  const count = Buffer.alloc(4);
  count.writeUInt32BE(prepared.length);
  const parts: Buffer[] = [DOMAIN_PREFIX, count];
  for (let index = 0; index < prepared.length; index += 1) {
    const entry = prepared[index]!;
    if (index > 0 && entry.encodedPath.equals(prepared[index - 1]!.encodedPath)) throw new TypeError("SOURCE_PATH_DUPLICATE");
    if (entry.gitMode !== "100644" && entry.gitMode !== "100755") throw new TypeError("SOURCE_MODE_INVALID");
    const pathLength = Buffer.alloc(4);
    pathLength.writeUInt32BE(entry.encodedPath.length);
    const mode = Buffer.alloc(4);
    mode.writeUInt32BE(Number.parseInt(entry.gitMode, 8));
    const content = Buffer.from(entry.content);
    const contentLength = Buffer.alloc(8);
    contentLength.writeBigUInt64BE(BigInt(content.length));
    parts.push(pathLength, entry.encodedPath, mode, contentLength, content);
  }
  return Buffer.concat(parts);
}

export function decodeSourceInputFrame(frame: Uint8Array): SourceFrameEntry[] {
  const bytes = Buffer.from(frame);
  if (bytes.length < DOMAIN_PREFIX.length + 4 || !bytes.subarray(0, DOMAIN_PREFIX.length).equals(DOMAIN_PREFIX)) {
    throw new ContractError("CONTRACT_SCHEMA_INVALID");
  }
  let cursor = DOMAIN_PREFIX.length;
  const count = bytes.readUInt32BE(cursor);
  cursor += 4;
  const result: SourceFrameEntry[] = [];
  let previous: Buffer | undefined;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 4 > bytes.length) throw new ContractError("CONTRACT_SCHEMA_INVALID");
    const pathLength = bytes.readUInt32BE(cursor);
    cursor += 4;
    if (cursor + pathLength + 12 > bytes.length) throw new ContractError("CONTRACT_SCHEMA_INVALID");
    const pathBytes = bytes.subarray(cursor, cursor + pathLength);
    cursor += pathLength;
    let path: string;
    try {
      path = new TextDecoder("utf-8", { fatal: true }).decode(pathBytes);
    } catch {
      throw new ContractError("CONTRACT_SCHEMA_INVALID");
    }
    try {
      if (!canonicalPathBytes(path).equals(pathBytes)) throw new Error();
    } catch {
      throw new ContractError("CONTRACT_SCHEMA_INVALID");
    }
    if (previous && compareBytes(previous, pathBytes) >= 0) throw new ContractError("CONTRACT_SCHEMA_INVALID");
    previous = Buffer.from(pathBytes);
    const rawMode = bytes.readUInt32BE(cursor);
    cursor += 4;
    const gitMode = rawMode === 0o100644 ? "100644" : rawMode === 0o100755 ? "100755" : undefined;
    if (!gitMode) throw new ContractError("CONTRACT_SCHEMA_INVALID");
    const contentLength = bytes.readBigUInt64BE(cursor);
    cursor += 8;
    if (contentLength > BigInt(bytes.length - cursor)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
    const end = cursor + Number(contentLength);
    result.push({ path, gitMode, content: bytes.subarray(cursor, end) });
    cursor = end;
  }
  if (cursor !== bytes.length) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  return result;
}

export function validateSyntheticOracle(frame: Uint8Array, sidecar: Uint8Array): void {
  if (frame.byteLength !== SYNTHETIC_FRAME_BYTES) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  const expected = encodeSourceInputFrame(SYNTHETIC_ENTRIES);
  if (!Buffer.from(frame).equals(expected)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  const literalSidecar = `${SYNTHETIC_DIGEST}\n`;
  if (!Buffer.from(sidecar).equals(Buffer.from(literalSidecar, "ascii"))) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  if (createHash("sha256").update(frame).digest("hex") !== SYNTHETIC_DIGEST) throw new ContractError("CONTRACT_SCHEMA_INVALID");
}
