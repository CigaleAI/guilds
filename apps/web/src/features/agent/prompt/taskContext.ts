import type { TaskFile } from "../../../api/types/notes";

/** What the operator is writing in the Task, and the version it started from. */
export type TaskDraft = { text: string; base: number | undefined };

/**
 * The Task editor against the saved Task: the saved text, the text shown, whether they differ, and
 * whether the edit started from a version older than the one saved since.
 */
export type TaskEdit = { saved: string; value: string; dirty: boolean; conflict: boolean };

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
