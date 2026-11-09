import { readFile } from "node:fs/promises";
import { shudTextNumber, writeBytes } from "@shud-harness/dsh-shud-records";

/** Every value form the solver's `%lf` accepts after a key; no capture groups. */
const NUMBER = String.raw`[+-]?(?:0x(?:[\da-f]+(?:\.[\da-f]*)?|\.[\da-f]+)(?:p[+-]?\d+)?|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|inf(?:inity)?|nan(?:\([^)]*\))?)`;
/** A whole whitespace-delimited value token, as the records cfg parser reads it. */
const TOKEN = String.raw`[^\t\v\f\r ]+`;

/** Interception storage (eleyic) output every submitted run copy writes; an output switch only. */
export const SUBMISSION_OUTPUT_INTERVAL = { key: "DT_YE_IC", minutes: 1440 } as const;

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

/**
 * Match the solver's case-insensitive `fgets` + `sscanf("%s %lf")` key/value parsing without
 * reserializing the file: lines starting with `#`, space or NUL are skipped, and the captured
 * `value` token of each effective `key` line is replaced in place. Latin-1 is a byte-preserving
 * view; comments need not be valid UTF-8.
 */
function scanEffective(
  text: string,
  key: string,
  value: string,
  replace: (token: string) => string,
) {
  if (!/^[a-z_]+$/iu.test(key)) throw new Error(`Invalid parameter key: ${key}`);
  const pattern = new RegExp(String.raw`^([\t\v\f\r ]*${key}[\t\v\f\r ]+)(${value})`, "iu");
  let changed = 0;
  const updated = text.replace(/^[^\n]+/gmu, (line: string) => {
    if (line[0] === " " || line[0] === "#" || line[0] === "\0") return line;
    return line.replace(pattern, (_match: string, leading: string, token: string) => {
      changed += 1;
      return leading + replace(token);
    });
  });
  return { updated, changed };
}

function rewriteEffective(text: string, key: string, value: number) {
  return scanEffective(text, key, NUMBER, () => String(value));
}

export async function updateEnd(path: string, days: number): Promise<void> {
  positiveInteger(days, "end_days");
  const { updated, changed } = rewriteEffective(
    (await readFile(path)).toString("latin1"),
    "END",
    days,
  );
  if (changed === 0) throw new Error(`No effective END parameter in ${path}`);
  await writeBytes(path, Buffer.from(updated, "latin1"));
}

/**
 * Pure byte transform: every effective `key` line gets `minutes`; without one, `key\t<minutes>`
 * is appended with the file's first line ending (`\n` when it has none), after first terminating
 * a non-empty final line.
 */
export function ensureOutputIntervalBytes(bytes: Uint8Array, key: string, minutes: number): Buffer {
  positiveInteger(minutes, `${key} output interval`);
  const text = Buffer.from(bytes).toString("latin1");
  const { updated, changed } = rewriteEffective(text, key, minutes);
  if (changed > 0) return Buffer.from(updated, "latin1");
  const first = text.indexOf("\n");
  const eol = first > 0 && text[first - 1] === "\r" ? "\r\n" : "\n";
  const terminated = text === "" || text.endsWith("\n") ? text : text + eol;
  return Buffer.from(`${terminated}${key}\t${minutes}${eol}`, "latin1");
}

export async function ensureOutputInterval(
  path: string,
  key: string,
  minutes: number,
): Promise<void> {
  positiveInteger(minutes, `${key} output interval`);
  const bytes = await readFile(path);
  const updated = ensureOutputIntervalBytes(bytes, key, minutes);
  if (!updated.equals(bytes)) await writeBytes(path, updated);
}

/** The cfg.para transform every submission applies; the replay oracle derives run copies with it. */
export function submittedParameterBytes(bytes: Uint8Array): Buffer {
  return ensureOutputIntervalBytes(
    bytes,
    SUBMISSION_OUTPUT_INTERVAL.key,
    SUBMISSION_OUTPUT_INTERVAL.minutes,
  );
}

/**
 * Set the single effective calib `key` line to `b * multiplier`. SHUD reads calib with the same
 * first-byte skip and `sscanf(str, "%s %lf")` (SHUD/src/classes/ModelConfigure.cpp:450-455), so the
 * value is the shortest round-trip decimal of the product (`-0` keeps its sign). The baseline `b`
 * is the whole value token parsed like the records cfg parser; zero or several effective lines,
 * or a non-finite baseline/product, fail naming the key. Other bytes are unchanged.
 */
export function calibMultipliedBytes(bytes: Uint8Array, key: string, multiplier: number): Buffer {
  const text = Buffer.from(bytes).toString("latin1");
  const tokens: string[] = [];
  scanEffective(text, key, TOKEN, (token) => {
    tokens.push(token);
    return token;
  });
  if (tokens.length !== 1)
    throw new Error(
      `Expected exactly one effective ${key} calibration line, found ${tokens.length}`,
    );
  const product = (shudTextNumber(tokens[0]) ?? NaN) * multiplier;
  if (!Number.isFinite(product))
    throw new Error(`Calibration ${key} value does not give a finite product`);
  const value = Object.is(product, -0) ? "-0" : String(product);
  return Buffer.from(scanEffective(text, key, TOKEN, () => value).updated, "latin1");
}

export async function applyCalibMultiplier(
  path: string,
  key: string,
  multiplier: number,
): Promise<void> {
  await writeBytes(path, calibMultipliedBytes(await readFile(path), key, multiplier));
}

if (import.meta.main) {
  const [path, days] = process.argv.slice(2);
  if (!path || days === undefined || process.argv.length !== 4) {
    throw new Error("Usage: shud-cfg-rewrite.ts <parameter-file> <end-days>");
  }
  await updateEnd(path, Number(days));
}
