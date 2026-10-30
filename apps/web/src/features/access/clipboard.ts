/** How copying to the clipboard went: copied, or refused by a browser that offers no clipboard. */
export type CopyOutcome = "copied" | "unavailable";

/** Copies text to the system clipboard; `unavailable` when the browser has none or refuses it. */
export async function copyText(text: string): Promise<CopyOutcome> {
  try {
    await navigator.clipboard.writeText(text);
    return "copied";
  } catch {
    return "unavailable";
  }
}
