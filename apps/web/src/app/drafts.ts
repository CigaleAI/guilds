/**
 * What is left of an editor's draft once `savedText` taken from it is saved: nothing when the draft
 * still holds that text, the draft as it stands otherwise, so text typed while the save ran stays.
 */
export function draftAfterSave(draft: string | null, savedText: string): string | null {
  return draft === savedText ? null : draft;
}
