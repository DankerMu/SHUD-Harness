const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const HEX = /^([+-]?)0x([\da-f]+(?:\.[\da-f]*)?|\.[\da-f]+)(?:p([+-]?\d+))?$/i;
const NONFINITE = /^[+-]?(?:inf(?:inity)?|nan(?:\([\da-z_]*\))?)$/i;

/**
 * Whole-token C numeric syntax, without C's prefix/stale-value recovery. Decimal
 * conversion is native binary64. Hexadecimal conversion rounds the exact integer
 * significand once, ties-to-even, including the subnormal boundary. No scientific
 * finiteness/range policy belongs here; undefined means a lexical failure only.
 */
export function shudTextNumber(token: string): number | undefined {
  if (DECIMAL.test(token)) return Number(token);
  if (NONFINITE.test(token)) {
    if (/nan/i.test(token)) return NaN;
    return token.startsWith("-") ? -Infinity : Infinity;
  }
  const hex = HEX.exec(token);
  if (hex === null) return undefined;
  const significand = hex[2];
  const point = significand.indexOf(".");
  const fractionDigits = point < 0 ? 0 : significand.length - point - 1;
  const digits = significand.replace(".", "").replace(/^0+/, "");
  const negative = hex[1] === "-";
  if (digits.length === 0) return negative ? -0 : 0;

  // Input string lengths are bounded by the JS runtime, so an exponent too large
  // for Number cannot cancel against the finite significand length. It can be
  // classified before allocating/shifting a potentially very large BigInt.
  const exponent = Number(hex[3] ?? "0") - 4 * fractionDigits;
  const bits = 4 * (digits.length - 1) + 32 - Math.clz32(Number.parseInt(digits[0], 16));
  const highest = exponent + bits - 1;
  if (highest > 1023) return negative ? -Infinity : Infinity;
  if (highest < -1075) return negative ? -0 : 0;

  const integer = BigInt(`0x${digits}`);
  // A normal result has 53 significant bits; subnormals share the 2^-1074 grid.
  const unit = Math.max(highest - 52, -1074);
  const shift = unit - exponent;
  let rounded: bigint;
  if (shift <= 0) {
    rounded = integer << BigInt(-shift);
  } else {
    const distance = BigInt(shift);
    rounded = integer >> distance;
    const remainder = integer - (rounded << distance);
    const halfway = 1n << (distance - 1n);
    if (remainder > halfway || (remainder === halfway && (rounded & 1n) !== 0n)) rounded += 1n;
  }
  // rounded is at most 2^53, hence exact as a Number. Multiplying by a binary
  // power is exact on the chosen grid, or overflows to Infinity at the upper tie.
  const value = Number(rounded) * 2 ** unit;
  return negative ? -value : value;
}
