import { dlopen } from "bun:ffi";
import { closeSync, constants, fstatSync, openSync, readSync, type BigIntStats } from "node:fs";
import { parse, resolve, sep } from "node:path";
import { hasOnlyUnicodeScalars } from "./canonical-json";

export type ContractErrorCode =
  | "CONTRACT_BYTES_LIMIT"
  | "CONTRACT_UTF8_INVALID"
  | "CONTRACT_JSON_MALFORMED"
  | "CONTRACT_JSON_DUPLICATE_KEY"
  | "CONTRACT_JSON_DEPTH_LIMIT"
  | "CONTRACT_JSON_NODE_LIMIT"
  | "CONTRACT_JSON_ITEM_LIMIT"
  | "CONTRACT_SCHEMA_INVALID";

export class ContractError extends Error {
  constructor(public readonly code: ContractErrorCode) {
    super(code);
    this.name = "ContractError";
  }
}

export type IngressProfile = Readonly<{ bytes: number; depth: number; nodes: number; items: number }>;
export type DescriptorAdmissionHook = (absolutePath: string) => void | Promise<void>;

const FILE_OPEN_FLAGS =
  constants.O_RDONLY |
  (constants.O_CLOEXEC ?? 0) |
  (constants.O_NONBLOCK ?? 0) |
  (constants.O_NOFOLLOW ?? 0);
const DIRECTORY_OPEN_FLAGS = FILE_OPEN_FLAGS | (constants.O_DIRECTORY ?? 0);

type OpenAt = (parentDescriptor: number, path: Buffer, flags: number) => number;
let cachedOpenAt: OpenAt | undefined;

function openAt(): OpenAt {
  if (cachedOpenAt) return cachedOpenAt;
  const symbols = { openat: { args: ["i32", "cstring", "i32"], returns: "i32" } } as const;
  if (process.platform === "darwin") {
    cachedOpenAt = dlopen("/usr/lib/libSystem.B.dylib", symbols).symbols.openat;
  } else if (process.platform === "linux") {
    cachedOpenAt = dlopen("libc.so.6", symbols).symbols.openat;
  } else {
    throw new ContractError("CONTRACT_SCHEMA_INVALID");
  }
  return cachedOpenAt;
}

function cString(value: string): Buffer {
  if (!value || value.includes("\0") || value.includes("/") || value === "." || value === "..") {
    throw new ContractError("CONTRACT_SCHEMA_INVALID");
  }
  return Buffer.from(`${value}\0`, "utf8");
}

function stableEntry(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function closeDescriptor(descriptor: number | undefined): void {
  if (descriptor === undefined) return;
  try {
    closeSync(descriptor);
  } catch {
    throw new ContractError("CONTRACT_SCHEMA_INVALID");
  }
}

function normalizedAbsolutePath(path: string): string {
  const absolute = resolve(path);
  if (process.platform !== "darwin") return absolute;
  // Darwin exposes normal user paths through these fixed system aliases; begin the no-follow walk at their real root.
  for (const alias of ["/etc", "/tmp", "/var"] as const) {
    if (absolute === alias || absolute.startsWith(`${alias}/`)) return `/private${absolute}`;
  }
  return absolute;
}

function absoluteSegments(path: string): readonly string[] {
  const root = parse(path).root;
  return path.slice(root.length).split(sep).filter(Boolean);
}

type DescriptorAdmission = Readonly<{
  descriptor: number;
  pathStats: readonly BigIntStats[];
  absolutePath: string;
}>;

function openDescriptorBoundPath(path: string): DescriptorAdmission {
  const absolutePath = normalizedAbsolutePath(path);
  const root = parse(absolutePath).root;
  const segments = absoluteSegments(absolutePath);
  if (segments.length === 0) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  const pathStats: BigIntStats[] = [];
  let descriptor: number | undefined;
  try {
    descriptor = openSync(root, DIRECTORY_OPEN_FLAGS);
    for (let index = 0; index < segments.length; index += 1) {
      const final = index === segments.length - 1;
      const child = openAt()(descriptor, cString(segments[index]!), final ? FILE_OPEN_FLAGS : DIRECTORY_OPEN_FLAGS);
      if (child < 0) throw new ContractError("CONTRACT_SCHEMA_INVALID");
      closeDescriptor(descriptor);
      descriptor = child;
      const stat = fstatSync(descriptor, { bigint: true });
      if (final ? !stat.isFile() : !stat.isDirectory()) throw new ContractError("CONTRACT_SCHEMA_INVALID");
      pathStats.push(stat);
    }
    const admitted = { descriptor, pathStats: Object.freeze(pathStats), absolutePath };
    descriptor = undefined;
    return admitted;
  } finally {
    closeDescriptor(descriptor);
  }
}

function assertDescriptorPathUnchanged(admission: DescriptorAdmission): void {
  const segments = absoluteSegments(admission.absolutePath);
  const root = parse(admission.absolutePath).root;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(root, DIRECTORY_OPEN_FLAGS);
    for (let index = 0; index < segments.length; index += 1) {
      const final = index === segments.length - 1;
      const child = openAt()(descriptor, cString(segments[index]!), final ? FILE_OPEN_FLAGS : DIRECTORY_OPEN_FLAGS);
      if (child < 0) throw new ContractError("CONTRACT_SCHEMA_INVALID");
      closeDescriptor(descriptor);
      descriptor = child;
      const stat = fstatSync(descriptor, { bigint: true });
      const expected = admission.pathStats[index];
      if (!expected || !stableEntry(expected, stat) || (final ? !stat.isFile() : !stat.isDirectory())) {
        throw new ContractError("CONTRACT_SCHEMA_INVALID");
      }
    }
    const finalStat = fstatSync(admission.descriptor, { bigint: true });
    if (!stableEntry(finalStat, admission.pathStats.at(-1)!)) {
      throw new ContractError("CONTRACT_SCHEMA_INVALID");
    }
  } finally {
    closeDescriptor(descriptor);
  }
}

class StrictJsonParser {
  private cursor = 0;
  private nodes = 0;
  private items = 0;

  constructor(private readonly text: string, private readonly profile: IngressProfile) {}

  parse(): unknown {
    this.whitespace();
    const result = this.value(1);
    this.whitespace();
    if (this.cursor !== this.text.length) this.fail("CONTRACT_JSON_MALFORMED");
    return result;
  }

  private value(depth: number): unknown {
    if (depth > this.profile.depth) this.fail("CONTRACT_JSON_DEPTH_LIMIT");
    this.nodes += 1;
    if (this.nodes > this.profile.nodes) this.fail("CONTRACT_JSON_NODE_LIMIT");
    const current = this.text[this.cursor];
    if (current === "{") return this.object(depth);
    if (current === "[") return this.array(depth);
    if (current === '"') return this.string();
    if (this.take("true")) return true;
    if (this.take("false")) return false;
    if (this.take("null")) return null;
    return this.number();
  }

  private object(depth: number): Record<string, unknown> {
    this.cursor += 1;
    const result = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    this.whitespace();
    if (this.text[this.cursor] === "}") {
      this.cursor += 1;
      return result;
    }
    for (;;) {
      if (this.text[this.cursor] !== '"') this.fail("CONTRACT_JSON_MALFORMED");
      const key = this.string();
      if (keys.has(key)) this.fail("CONTRACT_JSON_DUPLICATE_KEY");
      keys.add(key);
      this.countItem();
      this.whitespace();
      if (this.text[this.cursor] !== ":") this.fail("CONTRACT_JSON_MALFORMED");
      this.cursor += 1;
      this.whitespace();
      result[key] = this.value(depth + 1);
      this.whitespace();
      const delimiter = this.text[this.cursor++];
      if (delimiter === "}") return result;
      if (delimiter !== ",") this.fail("CONTRACT_JSON_MALFORMED");
      this.whitespace();
    }
  }

  private array(depth: number): unknown[] {
    this.cursor += 1;
    const result: unknown[] = [];
    this.whitespace();
    if (this.text[this.cursor] === "]") {
      this.cursor += 1;
      return result;
    }
    for (;;) {
      this.countItem();
      result.push(this.value(depth + 1));
      this.whitespace();
      const delimiter = this.text[this.cursor++];
      if (delimiter === "]") return result;
      if (delimiter !== ",") this.fail("CONTRACT_JSON_MALFORMED");
      this.whitespace();
    }
  }

  private string(): string {
    const start = this.cursor++;
    for (;;) {
      const unit = this.text.charCodeAt(this.cursor);
      if (!Number.isFinite(unit) || unit < 0x20) this.fail("CONTRACT_JSON_MALFORMED");
      if (unit === 0x22) {
        this.cursor += 1;
        try {
          const decoded = JSON.parse(this.text.slice(start, this.cursor)) as string;
          if (!hasOnlyUnicodeScalars(decoded)) this.fail("CONTRACT_JSON_MALFORMED");
          return decoded;
        } catch (error) {
          if (error instanceof ContractError) throw error;
          this.fail("CONTRACT_JSON_MALFORMED");
        }
      }
      if (unit === 0x5c) {
        this.cursor += 1;
        const escape = this.text[this.cursor];
        if (!escape || !'"\\/bfnrtu'.includes(escape)) this.fail("CONTRACT_JSON_MALFORMED");
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(this.text.slice(this.cursor + 1, this.cursor + 5))) this.fail("CONTRACT_JSON_MALFORMED");
          this.cursor += 4;
        }
      }
      this.cursor += 1;
    }
  }

  private number(): number {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.text.slice(this.cursor));
    if (!match) this.fail("CONTRACT_JSON_MALFORMED");
    this.cursor += match[0].length;
    const result = Number(match[0]);
    if (!Number.isFinite(result)) this.fail("CONTRACT_SCHEMA_INVALID");
    return result;
  }

  private countItem(): void {
    this.items += 1;
    if (this.items > this.profile.items) this.fail("CONTRACT_JSON_ITEM_LIMIT");
  }

  private take(token: string): boolean {
    if (!this.text.startsWith(token, this.cursor)) return false;
    this.cursor += token.length;
    return true;
  }

  private whitespace(): void {
    while (/^[\u0009\u000a\u000d\u0020]$/.test(this.text[this.cursor] ?? "")) this.cursor += 1;
  }

  private fail(code: ContractErrorCode): never {
    throw new ContractError(code);
  }
}

export function parseBoundedJson(bytes: Uint8Array, profile: IngressProfile): unknown {
  if (bytes.byteLength > profile.bytes) throw new ContractError("CONTRACT_BYTES_LIMIT");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ContractError("CONTRACT_UTF8_INVALID");
  }
  return new StrictJsonParser(text, profile).parse();
}

export async function readBoundedFile(
  path: string,
  maximum: number,
  afterAdmission?: DescriptorAdmissionHook
): Promise<Uint8Array> {
  let descriptor: number | undefined;
  try {
    const logicalAbsolutePath = resolve(path);
    const admission = openDescriptorBoundPath(logicalAbsolutePath);
    descriptor = admission.descriptor;
    const stat = admission.pathStats.at(-1)!;
    await afterAdmission?.(logicalAbsolutePath);
    assertDescriptorPathUnchanged(admission);
    if (stat.size > maximum) throw new ContractError("CONTRACT_BYTES_LIMIT");
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maximum) throw new ContractError("CONTRACT_BYTES_LIMIT");
    assertDescriptorPathUnchanged(admission);
    return buffer.subarray(0, length);
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw new ContractError("CONTRACT_SCHEMA_INVALID");
  } finally {
    closeDescriptor(descriptor);
  }
}
