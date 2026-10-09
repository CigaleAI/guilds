import type { ReactNode } from "react";
import { cn } from "@guildsrun/ui";
type MasterDetailProps = {
  /** Filters and counts over the list. */
  toolbar?: ReactNode;
  list: ReactNode;
  detail: ReactNode;
  listLabel: string;
};

/** A list of items beside the one selected; on narrow panes the list sits above it. */
export function MasterDetail({ toolbar, list, detail, listLabel }: MasterDetailProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <div className="flex max-h-72 shrink-0 flex-col border-b border-line md:max-h-none md:w-64 md:border-r md:border-b-0">
        {toolbar ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
            {toolbar}
          </div>
        ) : null}
        <nav
          aria-label={listLabel}
          className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2"
        >
          {list}
        </nav>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-5">{detail}</div>
    </div>
  );
}

type DetailHeaderProps = {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
};

/** The selected item's title, facts and actions. */
export function DetailHeader({ title, meta, actions, className }: DetailHeaderProps) {
  return (
    <header className={cn("flex flex-col gap-3", className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="text-lg font-semibold">{title}</h2>
        {meta ? <div className="text-xs text-muted">{meta}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

/** Text shown where a list or its selection is empty. */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-2 py-6 text-center text-sm text-muted">{children}</p>;
}
