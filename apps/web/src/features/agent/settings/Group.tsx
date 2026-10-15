import type { ReactNode } from "react";

/** A titled group of fields in Settings and the create dialogs. */
export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <h3 className="type-label text-muted">{title}</h3>
      {children}
    </section>
  );
}
