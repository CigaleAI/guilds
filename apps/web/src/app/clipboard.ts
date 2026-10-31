/**
 * How a copy to the clipboard ended: copied, or unavailable when the browser has no clipboard or
 * does not let the page write it.
 */
export type ClipboardCopy = "copied" | "unavailable";

/** Puts text on the operator's clipboard. */
export async function copyText(text: string): Promise<ClipboardCopy> {
  try {
    await navigator.clipboard.writeText(text);
    return "copied";
  } catch {
    return "unavailable";
  }
}
