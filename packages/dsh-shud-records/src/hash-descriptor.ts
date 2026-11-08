import { createHash } from "node:crypto";
import { readSync } from "node:fs";

/** One bounded loop for hash-only consumers and retained SHUD file bytes. */
function consumeDescriptor(fd: number, retain?: (chunk: Buffer) => void): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (;;) {
    const count = readSync(fd, buffer, 0, buffer.length, null);
    if (count === 0) return hash.digest("hex");
    const chunk = count === buffer.length ? buffer : buffer.subarray(0, count);
    hash.update(chunk);
    retain?.(chunk);
  }
}

/** Hash only the verified descriptor, retaining bounded memory for binary consumers. */
export function hashDescriptor(fd: number): string {
  return consumeDescriptor(fd);
}

/** Digest, observed length and owned parser bytes come from the same descriptor pass. */
export function readDescriptor(fd: number): { bytes: Buffer; sha256: string; size_bytes: number } {
  const chunks: Buffer[] = [];
  let size_bytes = 0;
  const sha256 = consumeDescriptor(fd, (chunk) => {
    chunks.push(Buffer.from(chunk));
    size_bytes += chunk.length;
  });
  // Buffer.concat may expose a larger shared pool through public typed-array views.
  // Exact unpooled storage preserves the same chunk-copy count and is double-aligned.
  const bytes = Buffer.allocUnsafeSlow(size_bytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, sha256, size_bytes };
}
