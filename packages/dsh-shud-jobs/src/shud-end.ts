import { readFile } from "node:fs/promises";
import { writeBytes } from "@shud-harness/dsh-shud-records";

/** Match the solver's case-insensitive sscanf key/value parsing without reserializing the file. */
export async function updateEnd(path: string, days: number): Promise<void> {
  if (!Number.isInteger(days) || days <= 0) throw new Error("end_days must be a positive integer");
  const bytes = await readFile(path);
  let changed = 0;
  // Latin-1 is a byte-preserving view; parameter comments need not be valid UTF-8.
  const updated = bytes.toString("latin1").replace(/^[^\n]+/gmu, (line: string) => {
    if (line[0] === " " || line[0] === "#" || line[0] === "\0") return line;
    return line.replace(
      /^([\t\v\f\r ]*end[\t\v\f\r ]+)([+-]?(?:0x(?:[\da-f]+(?:\.[\da-f]*)?|\.[\da-f]+)(?:p[+-]?\d+)?|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|inf(?:inity)?|nan(?:\([^)]*\))?))/iu,
      (_match: string, leading: string) => {
        changed += 1;
        return leading + String(days);
      },
    );
  });
  if (changed === 0) throw new Error(`No effective END parameter in ${path}`);
  await writeBytes(path, Buffer.from(updated, "latin1"));
}

if (import.meta.main) {
  const [path, days] = process.argv.slice(2);
  if (!path || days === undefined || process.argv.length !== 4) {
    throw new Error("Usage: shud-end.ts <parameter-file> <end-days>");
  }
  await updateEnd(path, Number(days));
}
