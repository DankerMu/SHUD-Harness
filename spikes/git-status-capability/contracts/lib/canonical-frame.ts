import { createHash } from "node:crypto";
import { FRAME_EVIDENCE_FIELD_ORDER } from "./frozen";

export type CanonicalJsonRecord = Record<string, any>;

const FRAME_HEADER_FIELD_ORDER = Object.freeze([
  "schema_version", "catalog_version", "row_id", "observation_id", "checkout_capability_identity",
  "git_state_generation_digest", "body_length", "body_digest"
]);

const FRAME_BODY_FIELD_ORDER = Object.freeze([
  "index", "head_tree", "effective_config", "exclude_state", "attribute_state", "nested_state", "limit_stimulus"
]);

function orderedObject(value: CanonicalJsonRecord, fields: readonly string[]): CanonicalJsonRecord {
  return Object.fromEntries(fields.filter((field) => Object.hasOwn(value, field))
    .map((field) => [field, canonicalJsonValue(value[field])]));
}

export function canonicalJsonValue(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
    .map((key) => [key, canonicalJsonValue(value[key])]));
}

export function canonicalJsonBytes(value: any): Buffer {
  return Buffer.from(JSON.stringify(canonicalJsonValue(value)), "utf8");
}

export function canonicalJsonDigest(value: any): string {
  return createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");
}

export function canonicalFrameBody(frame: CanonicalJsonRecord): CanonicalJsonRecord {
  return orderedObject(frame, FRAME_BODY_FIELD_ORDER);
}

export function canonicalFrameBodyBytes(frame: CanonicalJsonRecord): Buffer {
  return Buffer.from(JSON.stringify(canonicalFrameBody(frame)), "utf8");
}

export function canonicalFrameBodyDigest(frame: CanonicalJsonRecord): string {
  return createHash("sha256").update(canonicalFrameBodyBytes(frame)).digest("hex");
}

export function canonicalFrameHeader(frame: CanonicalJsonRecord): CanonicalJsonRecord {
  return orderedObject(frame, FRAME_HEADER_FIELD_ORDER);
}

export function canonicalFrameChecksum(frame: CanonicalJsonRecord): string {
  const envelope = { header: canonicalFrameHeader(frame), body: canonicalFrameBody(frame) };
  return createHash("sha256").update(JSON.stringify(envelope)).digest("hex");
}

export function canonicalFrameBytes(frame: CanonicalJsonRecord): Buffer {
  return Buffer.from(JSON.stringify(orderedObject(frame, FRAME_EVIDENCE_FIELD_ORDER)), "utf8");
}

export function canonicalFrameDigest(frame: CanonicalJsonRecord): string {
  return createHash("sha256").update(canonicalFrameBytes(frame)).digest("hex");
}

export function sealFrame<T extends CanonicalJsonRecord>(frame: T): T {
  const bodyBytes = canonicalFrameBodyBytes(frame);
  const bodyDigest = createHash("sha256").update(bodyBytes).digest("hex");
  frame.body_length = bodyBytes.length;
  frame.body_digest = bodyDigest;
  frame.git_state_generation_digest = bodyDigest;
  frame.checksum = canonicalFrameChecksum(frame);
  return frame;
}
