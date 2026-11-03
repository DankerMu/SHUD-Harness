import { createHash } from "node:crypto";
import { readSync } from "node:fs";

/** Hash only the verified descriptor, reusing one bounded buffer for the complete binary. */
export function hashDescriptor(fd: number): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (;;) {
    const count = readSync(fd, buffer, 0, buffer.length, null);
    if (count === 0) return hash.digest("hex");
    hash.update(count === buffer.length ? buffer : buffer.subarray(0, count));
  }
}
