import * as fs from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { extendPrefix, object, requireFact, type CanonicalEvent } from "./shud-restart-evidence.ts";
import {
  BUFFER_LIMIT,
  canonicalLog,
  readFileBounded,
  screen,
  type WebHost,
} from "./shud-web-driver.ts";

export interface SessionLog {
  header: Record<string, unknown>;
  events: CanonicalEvent[];
  asOfSeq: number;
  canonicalLog: string;
  flushedThroughSeq: number;
}
export interface StoredLog extends SessionLog {
  byteLength: number;
}

export function regular(path: string, label: string): void {
  requireFact(
    fs.lstatSync(path).isFile() && fs.realpathSync(path) === path,
    `Unsafe ${label}: regular physical file required`,
  );
}
export function readLog(home: string, id: string, limit = BUFFER_LIMIT): StoredLog {
  const path = canonicalLog(home, id);
  regular(path, "canonical log");
  const input = readFileBounded(path, limit).bytes;
  let bytes: Buffer;
  if (path.endsWith(".zstd")) {
    const chunks: Buffer[] = [];
    let offset = 0;
    let total = 0;
    while (offset < input.length) {
      requireFact(total < limit, "Canonical log exceeds byte budget");
      const decoded: unknown = zstdDecompressSync(input.subarray(offset), {
        info: true,
        maxOutputLength: limit - total,
      });
      const value = object(decoded);
      const chunk = value.buffer;
      const consumed = object(value.engine).bytesWritten;
      requireFact(
        Buffer.isBuffer(chunk) &&
          typeof consumed === "number" &&
          consumed > 0 &&
          consumed <= input.length - offset,
        "Malformed canonical compression frame",
      );
      total += chunk.length;
      requireFact(total <= limit, "Canonical log exceeds byte budget");
      chunks.push(chunk);
      offset += consumed;
    }
    bytes = Buffer.concat(chunks, total);
  } else bytes = input;
  const source = bytes.toString("utf8");
  screen(source);
  const rows = source
    .trimEnd()
    .split("\n")
    .map((line) => object(JSON.parse(line) as unknown));
  const header = rows.shift();
  requireFact(
    header?.type === "session" && header.version === 4 && header.id === id,
    "Canonical stored header identity mismatch",
  );
  const events = rows.map((row): CanonicalEvent => {
    requireFact(
      typeof row.type === "string" &&
        typeof row.seq === "number" &&
        typeof row.time === "number" &&
        "data" in row,
      "Malformed stored canonical event",
    );
    return { type: row.type, seq: row.seq, time: row.time, data: row.data };
  });
  const prefix = { events, asOfSeq: events.length - 1 };
  extendPrefix({ asOfSeq: -1, events: [] }, prefix);
  return { ...prefix, header, canonicalLog: path, flushedThroughSeq: -1, byteLength: bytes.length };
}
export async function storedLog(
  host: WebHost,
  home: string,
  id: string,
  limit = BUFFER_LIMIT,
): Promise<StoredLog> {
  // Export accepts the actual bare child UUID and flushes that live session directly.
  // HEAD of the root with descendants=true alone does NOT flush child logs.
  await host.flush(id);
  const log = readLog(home, id, limit);
  log.flushedThroughSeq = log.asOfSeq;
  return log;
}
