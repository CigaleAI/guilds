/** An email address trimmed and lower-cased, or null when the text is not one. */
export function normalizeEmail(value: string): string | null {
  const text = value.trim().toLowerCase();
  return text.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(text) ? text : null;
}
