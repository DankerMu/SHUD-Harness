import { createHash } from "node:crypto";
import { canonicalFrameBytes, type CanonicalJsonRecord } from "./canonical-frame";

export const WIRE_FRAME_MAGIC = Buffer.from("SHUDCAP1", "ascii");
export const WIRE_FRAME_VERSION = 1;
export const WIRE_FRAME_HEADER_BYTES = 128;
export const WIRE_FRAME_CHECKSUM_OFFSET = 96;

function digest(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

export function canonicalWireFrameBytes(frame: CanonicalJsonRecord, targetLength?: number): Buffer {
  const body = canonicalFrameBytes(frame);
  const totalLength = targetLength ?? WIRE_FRAME_HEADER_BYTES + body.length;
  if (!Number.isSafeInteger(totalLength) || totalLength < WIRE_FRAME_HEADER_BYTES + body.length) {
    throw new RangeError("wire frame target length is invalid");
  }
  const extensionLength = totalLength - WIRE_FRAME_HEADER_BYTES - body.length;
  const extension = Buffer.alloc(extensionLength);
  const header = Buffer.alloc(WIRE_FRAME_HEADER_BYTES);
  WIRE_FRAME_MAGIC.copy(header, 0);
  header[8] = WIRE_FRAME_VERSION;
  header[9] = 0;
  header.writeUInt16BE(WIRE_FRAME_HEADER_BYTES, 10);
  header.writeBigUInt64BE(BigInt(totalLength), 12);
  header.writeUInt32BE(body.length, 20);
  header.writeBigUInt64BE(BigInt(extensionLength), 24);
  digest(body).copy(header, 32);
  digest(extension).copy(header, 64);
  createHash("sha256")
    .update(header.subarray(0, WIRE_FRAME_CHECKSUM_OFFSET))
    .update(body)
    .update(extension)
    .digest()
    .copy(header, WIRE_FRAME_CHECKSUM_OFFSET);
  return Buffer.concat([header, body, extension]);
}

export function canonicalWireFrameDigest(frame: CanonicalJsonRecord, targetLength?: number): string {
  return createHash("sha256").update(canonicalWireFrameBytes(frame, targetLength)).digest("hex");
}

export function canonicalWireFrameMaterial(frame: CanonicalJsonRecord, targetLength?: number) {
  const bodyLength = canonicalFrameBytes(frame).length;
  const totalLength = targetLength ?? WIRE_FRAME_HEADER_BYTES + bodyLength;
  if (!Number.isSafeInteger(totalLength) || totalLength < WIRE_FRAME_HEADER_BYTES + bodyLength) {
    throw new RangeError("wire frame target length is invalid");
  }
  return {
    kind: "canonical-frame-wire-v1",
    version: WIRE_FRAME_VERSION,
    header_length: WIRE_FRAME_HEADER_BYTES,
    body_length: bodyLength,
    extension_length: totalLength - WIRE_FRAME_HEADER_BYTES - bodyLength
  } as const;
}
