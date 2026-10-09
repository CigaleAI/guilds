/** Success and info leave on their own; warning and error stay until dismissed. */
export type ToastKind = "success" | "info" | "warning" | "error";

export type ToastAction = {
  /** A short verb, such as Undo or Retry. */
  label: string;
  onClick: () => void;
  /** How to do the same without the toast, read to screen-reader users; defaults to the label. */
  altText?: string;
};

export type ToastOptions = {
  kind?: ToastKind;
  title: string;
  description?: string;
  action?: ToastAction;
};

export type ToastRecord = ToastOptions & {
  id: number;
  open: boolean;
};

/** Toasts beyond this many are dismissed, oldest first. */
const MAX_TOASTS = 5;
/** Closed toasts stay in the store until their exit animation has played. */
const REMOVE_DELAY = 400;

let records: ToastRecord[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function publish(next: ToastRecord[]) {
  records = next;
  for (const listener of listeners) listener();
}

/** Shows a toast in the mounted Toaster and returns its id. */
export function toast(options: ToastOptions): number {
  const id = nextId++;
  const open = records.filter((record) => record.open);
  const overflow = new Set(open.slice(0, Math.max(0, open.length - MAX_TOASTS + 1)).map((record) => record.id));
  publish([...records.map((record) => (overflow.has(record.id) ? { ...record, open: false } : record)), { ...options, id, open: true }]);
  for (const closed of overflow) scheduleRemoval(closed);
  return id;
}

/** Closes a toast, such as one whose action has become moot. */
export function dismissToast(id: number) {
  if (!records.some((record) => record.id === id && record.open)) return;
  publish(records.map((record) => (record.id === id ? { ...record, open: false } : record)));
  scheduleRemoval(id);
}

function scheduleRemoval(id: number) {
  setTimeout(() => publish(records.filter((record) => record.id !== id)), REMOVE_DELAY);
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getToasts(): ToastRecord[] {
  return records;
}
