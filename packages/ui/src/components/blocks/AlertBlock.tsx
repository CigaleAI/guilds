import { useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "../../cn";
import { StatBand, type Stat } from "./StatBand";

export type AlertBlockProps = Omit<ComponentProps<"section">, "title"> & {
  /** Mono caps line above the title, such as "BLOCKED · 3 RUNS". */
  eyebrow?: ReactNode;
  title: ReactNode;
  /** Who is blocked and what stops until it is fixed. */
  description?: ReactNode;
  /** Top-right buttons: `on-plum` outline for the dismissive one, `accent` for the fix. */
  actions?: ReactNode;
  /** The facts of the blocker in the cyan band underneath. */
  stats?: Stat[];
};

/** The blocker that matters most in a view, on plum, with its facts in a cyan band and the fix beside it. */
export function AlertBlock({
  eyebrow,
  title,
  description,
  actions,
  stats,
  className,
  ...props
}: AlertBlockProps) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className={cn("flex flex-col overflow-hidden rounded-xl", className)}
      {...props}
    >
      <div className="flex flex-wrap items-start gap-4 bg-plum px-6 py-5 text-on-plum">
        <div className="flex min-w-60 flex-1 flex-col gap-1.5">
          {eyebrow !== undefined ? (
            <span className="type-label text-on-plum-muted">{eyebrow}</span>
          ) : null}
          <h2 id={titleId} className="text-3xl font-medium tracking-tight">
            {title}
          </h2>
          {description !== undefined ? (
            <p className="text-md text-pretty text-on-plum-muted">{description}</p>
          ) : null}
        </div>
        {actions !== undefined ? (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
      {stats && stats.length > 0 ? <StatBand stats={stats} /> : null}
    </section>
  );
}
