const DOMAIN_PREFIX = Buffer.from("SHUD-HARNESS\0GIT-STATUS-CAPABILITY\0SOURCE-INPUT-DIGEST\0V1\0", "ascii");

export type SourceFrameEntry = {
  path: string;
  gitMode: "100644" | "100755";
  content: Uint8Array;
};

function pathBytes(path: string): Buffer {
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) throw new TypeError("SOURCE_PATH_INVALID");
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new TypeError("SOURCE_PATH_INVALID");
  const bytes = Buffer.from(path, "utf8");
  if (bytes.toString("utf8") !== path || bytes.length > 0xffff_ffff) throw new TypeError("SOURCE_PATH_INVALID");
  return bytes;
}

export function encodeSourceInputFrame(entries: readonly SourceFrameEntry[]): Buffer {
  if (entries.length > 0xffff_ffff) throw new RangeError("SOURCE_ENTRY_COUNT_LIMIT");
  const prepared = entries.map((entry) => ({ ...entry, pathBytes: pathBytes(entry.path) }))
    .sort((left, right) => left.pathBytes.compare(right.pathBytes));
  for (let index = 1; index < prepared.length; index += 1) {
    if (prepared[index - 1]!.pathBytes.equals(prepared[index]!.pathBytes)) throw new TypeError("SOURCE_PATH_DUPLICATE");
  }
  const count = Buffer.alloc(4);
  count.writeUInt32BE(prepared.length);
  const pieces: Buffer[] = [DOMAIN_PREFIX, count];
  for (const entry of prepared) {
    if (entry.gitMode !== "100644" && entry.gitMode !== "100755") throw new TypeError("SOURCE_MODE_INVALID");
    const content = Buffer.from(entry.content);
    const pathLength = Buffer.alloc(4);
    pathLength.writeUInt32BE(entry.pathBytes.length);
    const mode = Buffer.alloc(4);
    mode.writeUInt32BE(Number.parseInt(entry.gitMode, 8));
    const contentLength = Buffer.alloc(8);
    contentLength.writeBigUInt64BE(BigInt(content.length));
    pieces.push(pathLength, entry.pathBytes, mode, contentLength, content);
  }
  return Buffer.concat(pieces);
}
