import { INGESTION_LIMITS } from "./frozen";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

export type InputKind = keyof typeof INGESTION_LIMITS;
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

export type IngestionLimit = (typeof INGESTION_LIMITS)[InputKind];

class StrictJsonParser {
  private index = 0;
  private nodes = 0;
  private items = 0;

  constructor(private readonly input: string, private readonly limit: IngestionLimit) {}

  parse(): unknown {
    this.space();
    const value = this.value(1);
    this.space();
    if (this.index !== this.input.length) this.fail("CONTRACT_JSON_MALFORMED");
    return value;
  }

  private value(depth: number): unknown {
    if (depth > this.limit.depth) this.fail("CONTRACT_JSON_DEPTH_LIMIT");
    this.nodes += 1;
    if (this.nodes > this.limit.nodes) this.fail("CONTRACT_JSON_NODE_LIMIT");
    const char = this.input[this.index];
    if (char === "{") return this.object(depth);
    if (char === "[") return this.array(depth);
    if (char === '"') return this.string();
    if (char === "t" && this.take("true")) return true;
    if (char === "f" && this.take("false")) return false;
    if (char === "n" && this.take("null")) return null;
    return this.number();
  }

  private object(depth: number): Record<string, unknown> {
    this.index += 1;
    // Null-prototype objects preserve every JSON key as inert data. In
    // particular, assigning `__proto__` must neither invoke an inherited setter
    // nor hide the key from strict unknown-field validation.
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    this.space();
    if (this.input[this.index] === "}") {
      this.index += 1;
      return result;
    }
    for (;;) {
      if (this.input[this.index] !== '"') this.fail("CONTRACT_JSON_MALFORMED");
      const key = this.string();
      if (keys.has(key)) this.fail("CONTRACT_JSON_DUPLICATE_KEY");
      keys.add(key);
      this.items += 1;
      if (this.items > this.limit.items) this.fail("CONTRACT_JSON_ITEM_LIMIT");
      this.space();
      if (this.input[this.index] !== ":") this.fail("CONTRACT_JSON_MALFORMED");
      this.index += 1;
      this.space();
      result[key] = this.value(depth + 1);
      this.space();
      const delimiter = this.input[this.index++];
      if (delimiter === "}") return result;
      if (delimiter !== ",") this.fail("CONTRACT_JSON_MALFORMED");
      this.space();
    }
  }

  private array(depth: number): unknown[] {
    this.index += 1;
    const result: unknown[] = [];
    this.space();
    if (this.input[this.index] === "]") {
      this.index += 1;
      return result;
    }
    for (;;) {
      result.push(this.value(depth + 1));
      this.space();
      const delimiter = this.input[this.index++];
      if (delimiter === "]") return result;
      if (delimiter !== ",") this.fail("CONTRACT_JSON_MALFORMED");
      this.space();
    }
  }

  private string(): string {
    const start = this.index;
    this.index += 1;
    for (;;) {
      const char = this.input.charCodeAt(this.index);
      if (!Number.isFinite(char) || char < 0x20) this.fail("CONTRACT_JSON_MALFORMED");
      if (char === 0x22) {
        this.index += 1;
        try {
          return JSON.parse(this.input.slice(start, this.index)) as string;
        } catch {
          this.fail("CONTRACT_JSON_MALFORMED");
        }
      }
      if (char === 0x5c) {
        this.index += 1;
        const escape = this.input[this.index];
        if (!escape || !'"\\/bfnrtu'.includes(escape)) this.fail("CONTRACT_JSON_MALFORMED");
        if (escape === "u") {
          const hex = this.input.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("CONTRACT_JSON_MALFORMED");
          this.index += 4;
        }
      }
      this.index += 1;
    }
  }

  private number(): number {
    const rest = this.input.slice(this.index);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(rest);
    if (!match) this.fail("CONTRACT_JSON_MALFORMED");
    this.index += match[0].length;
    const lexeme = match[0];
    const value = Number(lexeme);
    if (!Number.isFinite(value)) this.fail("CONTRACT_SCHEMA_INVALID");
    // Every numeric field in the frozen contract is an integer. Accept only the
    // unique base-10 spelling that round-trips without IEEE-754 precision loss.
    if (!/^-?(?:0|[1-9][0-9]*)$/.test(lexeme) || !Number.isSafeInteger(value) || String(value) !== lexeme)
      this.fail("CONTRACT_SCHEMA_INVALID");
    return value;
  }

  private take(token: string): boolean {
    if (!this.input.startsWith(token, this.index)) return false;
    this.index += token.length;
    return true;
  }

  private space(): void {
    while (/\s/.test(this.input[this.index] ?? "") && /[\u0009\u000a\u000d\u0020]/.test(this.input[this.index]!)) this.index += 1;
  }

  private fail(code: ContractErrorCode): never {
    throw new ContractError(code);
  }
}

export async function readJsonFileBounded(
  path: string,
  kind: InputKind,
  validate: (value: unknown) => boolean = () => true
): Promise<unknown> {
  const limit = INGESTION_LIMITS[kind];
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit.bytes) throw new ContractError("CONTRACT_BYTES_LIMIT");
    const buffer = Buffer.alloc(limit.bytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > limit.bytes) throw new ContractError("CONTRACT_BYTES_LIMIT");
    return ingestJson(buffer.subarray(0, offset), kind, validate);
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw new ContractError("CONTRACT_SCHEMA_INVALID");
  } finally {
    await handle?.close();
  }
}

export function ingestJson(
  bytes: Uint8Array,
  kind: InputKind,
  validate: (value: unknown) => boolean = () => true
): unknown {
  const limit = INGESTION_LIMITS[kind];
  if (bytes.byteLength > limit.bytes) throw new ContractError("CONTRACT_BYTES_LIMIT");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ContractError("CONTRACT_UTF8_INVALID");
  }
  const value = new StrictJsonParser(text, limit).parse();
  if (!validate(value)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  return value;
}

export function ingestJsonAgainstLimits(
  bytes: Uint8Array,
  limit: IngestionLimit,
  validate: (value: unknown) => boolean = () => true
): unknown {
  if (bytes.byteLength > limit.bytes) throw new ContractError("CONTRACT_BYTES_LIMIT");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ContractError("CONTRACT_UTF8_INVALID");
  }
  const value = new StrictJsonParser(text, limit).parse();
  if (!validate(value)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  return value;
}

export function canonicalReceipt(receipt: Record<string, unknown>): string {
  return `${JSON.stringify(receipt)}\n`;
}
