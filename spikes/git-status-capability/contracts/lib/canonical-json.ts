export function hasOnlyUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
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
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new TypeError("JSON_UNSAFE_NUMBER");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    for (const key of keys) if (!hasOnlyUnicodeScalars(key)) throw new TypeError("JSON_NON_SCALAR_KEY");
    return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(record[key])}`).join(",")}}`;
  }
  throw new TypeError("JSON_UNSUPPORTED_VALUE");
}

/** RFC-8785-compatible for this contract's scalar subset (Unicode strings, booleans, null, safe integers). */
export function canonicalJson(value: unknown): string {
  return encode(value);
}

export function canonicalEqual(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}
