/** A nullable numeric column as a number, or null when it is null or absent. */
export function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
