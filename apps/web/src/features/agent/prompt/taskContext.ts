import type { TaskFile } from "../../../api/types/notes";
import { draftAfterSave } from "../../../app/drafts";

/** What the operator is writing in the Task, and the version it started from. */
export type TaskDraft = { text: string; base: number | undefined };

/**
 * The Task editor against the saved Task: the saved text, the text shown, whether they differ, and
 * whether the edit started from a version older than the one saved since.
 */
type TaskEdit = { saved: string; value: string; dirty: boolean; conflict: boolean };

/** Where the operator's draft stands against the saved Task, which is undefined while it loads. */
export function taskEdit(draft: TaskDraft | null, task: TaskFile | undefined): TaskEdit {
  const saved = task?.content ?? "";
  const value = draft?.text ?? saved;
  const dirty = value !== saved;
  const conflict =
    dirty &&
    draft?.base !== undefined &&
    task?.version !== undefined &&
    draft.base !== task.version;
  return { saved, value, dirty, conflict };
}

/**
 * The Task's draft once `savedText` from it is stored as `saved`: none when the draft still holds
 * that text; otherwise the text typed while the save ran, started from the version just saved.
 */
export function taskDraftAfterSave(
  draft: TaskDraft | null,
  savedText: string,
  saved: TaskFile,
): TaskDraft | null {
  const text = draftAfterSave(draft?.text ?? null, savedText);
  return text === null ? null : { text, base: saved.version };
}
