import * as fs from "node:fs";
import type { JobOutputSource } from "@deepseek-ai/dsh-jobs";

function completePrefix(bytes: Buffer, length: number): number {
  if (length === 0) return 0;
  let lead = length - 1;
  while (lead >= 0 && length - lead <= 3 && (bytes[lead] & 0xc0) === 0x80) lead -= 1;
  if (lead < 0) return length;
  const first = bytes[lead];
  const width =
    first >= 0xc2 && first <= 0xdf
      ? 2
      : first >= 0xe0 && first <= 0xef
        ? 3
        : first >= 0xf0 && first <= 0xf4
          ? 4
          : 1;
  return length - lead < width ? lead : length;
}

/** Pulls only the newly appended bytes; incomplete trailing UTF-8 remains at the next cursor. */
export function stdoutSource(path: string): JobOutputSource {
  return {
    channel: "stdout",
    read(fromByte) {
      if (!Number.isSafeInteger(fromByte) || fromByte < 0)
        throw new Error("Invalid stdout byte offset");
      const fd = fs.openSync(
        path,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) throw new Error("Stdout source is not a regular file");
        const size = stat.size;
        const lossy = fromByte > size;
        const start = lossy ? 0 : fromByte;
        if (size === start) return { text: "", nextOffset: start, lossy, spillPath: path };
        const bytes = Buffer.allocUnsafe(size - start);
        let length = 0;
        while (length < bytes.length) {
          const count = fs.readSync(fd, bytes, length, bytes.length - length, start + length);
          if (count === 0) break;
          length += count;
        }
        const complete = completePrefix(bytes, length);
        return {
          text: bytes.toString("utf8", 0, complete),
          nextOffset: start + complete,
          lossy,
          spillPath: path,
        };
      } finally {
        fs.closeSync(fd);
      }
    },
  };
}
