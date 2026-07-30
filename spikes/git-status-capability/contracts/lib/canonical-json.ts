export function hasOnlyUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!Number.isFinite(low) || low < 0xdc00 || low > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function encode(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    if (!hasOnlyUnicodeScalars(value)) throw new TypeError("JSON_NON_SCALAR_STRING");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON_NON_FINITE_NUMBER");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    for (const key of keys) if (!hasOnlyUnicodeScalars(key)) throw new TypeError("JSON_NON_SCALAR_KEY");
    return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(record[key])}`).join(",")}}`;
  }
  throw new TypeError("JSON_UNSUPPORTED_VALUE");
}

/** RFC 8785 compatible for JSON values admitted by this contract. */
export function canonicalJson(value: unknown): string {
  return encode(value);
}
