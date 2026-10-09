import { Check, X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";

export type RunTraceLine = {
  id?: string;
  status: "ok" | "failed" | "running";
  label: ReactNode;
  /** Trailing mono value, such as a duration. */
  meta?: ReactNode;
};

export type RunTraceProps = Omit<ComponentProps<"div">, "title"> & {
  /** Usually the run id. */
  title: ReactNode;
  /** Right of the title, such as "4 steps · 2.4s · $0.03". */
  meta?: ReactNode;
  lines: RunTraceLine[];
};

const statusName: Record<RunTraceLine["status"], string> = {
  ok: "Succeeded",
  failed: "Failed",
  running: "Running",
};

function Glyph({ status }: { status: RunTraceLine["status"] }) {
  if (status === "running") {
    return <span className="size-2 rounded-full bg-signal motion-safe:animate-pulse" />;
  }
  return (
    <Icon
      icon={status === "ok" ? Check : X}
      size={16}
      className={status === "ok" ? "text-signal-soft" : "text-plum-soft"}
    />
  );
}

/** A run's steps as terse machine output: one mono line each, ticked or crossed. */
export function RunTrace({ title, meta, lines, className, ...props }: RunTraceProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-lg bg-panel px-4 py-3.5 font-mono text-xs text-on-panel",
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 justify-between gap-3 text-on-panel-muted">
        <span className="truncate">{title}</span>
        {meta !== undefined ? <span className="shrink-0">{meta}</span> : null}
      </div>
      <ul className="flex flex-col gap-1.5">
        {lines.map((line, index) => (
          <li key={line.id ?? index} className="flex min-w-0 items-center gap-2">
            <span
              role="img"
              aria-label={statusName[line.status]}
              className="flex size-4.5 shrink-0 items-center justify-center"
            >
              <Glyph status={line.status} />
            </span>
            <span className="min-w-0 flex-1 truncate">{line.label}</span>
            {line.meta !== undefined ? (
              <span className="shrink-0 text-on-panel-muted">{line.meta}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
