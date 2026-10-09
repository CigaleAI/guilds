const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const ID_ALPHABET = CROCKFORD;
export const ID_PATTERN = /^[a-z]+_[0-9A-HJKMNPQRSTVWXYZ]{26}$/;

export function newId(prefix: string): string {
  const timestampMs = BigInt(Date.now());
  const entropy = BigInt(
    `0x${crypto.getRandomValues(new Uint8Array(10)).reduce((hex, byte) => hex + byte.toString(16).padStart(2, "0"), "")}`,
  );
  let value = (timestampMs << 80n) | entropy;
  const chars = Array.from({ length: 26 }, () => "");
  for (let index = 25; index >= 0; index -= 1) {
    chars[index] = CROCKFORD[Number(value & 31n)] ?? "0";
    value >>= 5n;
  }
  return `${prefix}_${chars.join("")}`;
}

export function isId(value: string, prefix?: string): boolean {
  if (!ID_PATTERN.test(value)) {
    return false;
  }
  if (prefix && !value.startsWith(`${prefix}_`)) {
    return false;
  }
  return true;
}
