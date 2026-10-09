import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";
import { CardStack, CardStackItem } from "../../primitives/Card";
import { pill } from "../../primitives/Pill";

/** Live items lead in ink; plum needs attention; cyan is healthy or scheduled. */
export type QueueItemState = "live" | "attention" | "healthy";

export type StackedQueueItem = {
  id: string;
  title: ReactNode;
  /** Mono detail: agent, schedule, run id. */
  meta?: ReactNode;
  state: QueueItemState;
};

const tone = { live: "panel", attention: "plum", healthy: "signal" } as const;

const metaTone: Record<QueueItemState, string> = {
  live: "text-on-panel-muted",
  attention: "text-on-plum-muted",
  healthy: "text-on-signal",
};

export type StackedQueueProps = Omit<ComponentProps<"div">, "children"> & {
  /** Front to back; the first item gets the full card. */
  items: StackedQueueItem[];
  /** Opens an item; each card becomes a button. */
  onSelect?: (id: string) => void;
};

/** A short queue as cards tucked behind each other: what is live in front, then what needs attention, then what is fine. */
export function StackedQueue({ items, onSelect, className, ...props }: StackedQueueProps) {
  return (
    <CardStack role="list" className={className} {...props}>
      {items.map((item, level) => {
        const front = level === 0;
        const body = front ? (
          <div className="flex flex-col gap-3.5">
            <div className="flex items-start justify-between gap-3">
              <span className="min-w-0 text-xl font-semibold">{item.title}</span>
              {item.state === "live" ? (
                <span
                  className={cn(pill({ fill: "accent" }), "h-auto px-2 py-0.5 text-2xs font-bold")}
                >
                  LIVE
                </span>
              ) : null}
            </div>
            {item.meta !== undefined ? (
              <span className={cn("font-mono text-2xs", metaTone[item.state])}>{item.meta}</span>
            ) : null}
          </div>
        ) : (
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-sm font-semibold">{item.title}</span>
            {item.meta !== undefined ? (
              <span className={cn("shrink-0 font-mono text-2xs", metaTone[item.state])}>
                {item.meta}
              </span>
            ) : null}
          </div>
        );
        return (
          <CardStackItem
            key={item.id}
            role="listitem"
            level={level}
            tone={tone[item.state]}
            className={front ? "rounded-xl px-5 py-4" : "-mt-6 rounded-b-xl px-5 pt-8 pb-3"}
          >
            {onSelect ? (
              <button
                type="button"
                className="block w-full cursor-pointer text-left"
                onClick={() => onSelect(item.id)}
              >
                {body}
              </button>
            ) : (
              body
            )}
          </CardStackItem>
        );
      })}
    </CardStack>
  );
}
