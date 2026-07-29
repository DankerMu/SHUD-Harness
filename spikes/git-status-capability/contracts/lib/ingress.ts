import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";
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

export async function readBoundedFile(path: string, maximum: number): Promise<Uint8Array> {
  let handle;
  try {
    const absolute = resolve(path);
    const admittedStat = await lstat(absolute);
    if (admittedStat.isSymbolicLink()) throw new ContractError("CONTRACT_SCHEMA_INVALID");
    handle = await open(absolute, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || !admittedStat?.isFile() || stat.dev !== admittedStat.dev || stat.ino !== admittedStat.ino)
      throw new ContractError("CONTRACT_SCHEMA_INVALID");
    if (stat.size > maximum) throw new ContractError("CONTRACT_BYTES_LIMIT");
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maximum) throw new ContractError("CONTRACT_BYTES_LIMIT");
    return buffer.subarray(0, length);
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw new ContractError("CONTRACT_SCHEMA_INVALID");
  } finally {
    await handle?.close();
  }
}
