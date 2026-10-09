import { cva } from "class-variance-authority";
import type { LucideIcon } from "lucide-react";
import { Tabs as RadixTabs } from "radix-ui";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type Ref,
  type RefObject,
} from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";
import { PillCount } from "../../primitives/Pill";
import { track, trackItem } from "../../primitives/Track";

export type TabsLook = "track" | "bar";

const LookContext = createContext<TabsLook>("track");

/** A set of views switched by tabs: guild pages, agent inspector pages, chat / files / issues. */
export function Tabs({ className, ...props }: ComponentProps<typeof RadixTabs.Root>) {
  return <RadixTabs.Root className={cn("flex min-w-0 flex-col", className)} {...props} />;
}

/** Also styles a row of links that navigate between pages like tabs. */
export const tabsList = cva(
  "relative flex w-full max-w-full min-w-0 shrink-0 overflow-x-auto overscroll-x-contain",
  {
    variants: {
      look: {
        track: [track({ size: "md" }), "scrollbar-none"],
        bar: "gap-1 border-y border-line bg-surface px-3 py-1.5 text-fg md:px-6 md:py-2",
      },
    },
  },
);

export type TabsListProps = ComponentProps<typeof RadixTabs.List> & {
  /** `track`: pills in a well track. `bar`: the page tab strip under a guild or agent header. */
  look?: TabsLook;
};

/** The row of tab triggers. Scrolls sideways when the tabs outgrow it. */
export function TabsList({ look = "track", className, ...props }: TabsListProps) {
  const row = useRef<HTMLDivElement>(null);
  useTabRow(row);
  return (
    <LookContext value={look}>
      <RadixTabs.List ref={row} className={cn(tabsList({ look }), className)} {...props} />
    </LookContext>
  );
}

export type TabsNavProps = ComponentProps<"nav"> & {
  /** `track`: pills in a well track. `bar`: the page tab strip under a guild or agent header. */
  look?: TabsLook;
};

/** A row of tab links. Scrolls sideways when they outgrow it, and keeps the current page in view. */
export function TabsNav({ look = "bar", className, ...props }: TabsNavProps) {
  const row = useRef<HTMLElement>(null);
  useTabRow(row);
  return <nav ref={row} className={cn(tabsList({ look }), className)} {...props} />;
}

/** Links styled as tabs mark the current page with `aria-current="page"`. */
export const tabsTrigger = cva("", {
  variants: {
    look: {
      track: [trackItem({ size: "lg" }), "px-3"],
      bar: [
        "inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 text-sm font-semibold whitespace-nowrap select-none transition-colors md:h-9 md:px-3.5 md:text-md",
        "hover:bg-well selected:bg-ink-fill selected:text-on-ink disabled:cursor-default disabled:text-faint",
      ],
    },
  },
});

export type TabsTriggerProps = ComponentProps<typeof RadixTabs.Trigger> & {
  icon?: LucideIcon;
  /** A count carried on the tab, such as open issues. */
  count?: number | string;
};

/** Vertical wheel moves an overflowing tab row sideways so a mouse can reach every tab. */
function useTabRow(row: RefObject<HTMLElement | null>) {
  const lastCurrent = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = row.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      el.scrollLeft += event.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [row]);

  useLayoutEffect(() => {
    const current = row.current?.querySelector<HTMLElement>(
      '[aria-current="page"], [data-state="active"]',
    );
    if (current && current !== lastCurrent.current) {
      revealInRow(current, lastCurrent.current !== null);
      lastCurrent.current = current;
    }
  });
}

/** Keeps a newly selected tab inside the scrolled row. */
function revealInRow(tab: HTMLElement, animate: boolean) {
  const row = tab.parentElement;
  if (!row || row.scrollWidth <= row.clientWidth) return;
  const inset = 16;
  const start = tab.offsetLeft;
  const end = start + tab.offsetWidth;
  const behavior =
    animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "smooth"
      : "instant";
  if (start < row.scrollLeft + inset) {
    row.scrollTo({ left: start - inset, behavior });
  } else if (end > row.scrollLeft + row.clientWidth - inset) {
    row.scrollTo({ left: end - row.clientWidth + inset, behavior });
  }
}

function assignRef<T>(ref: Ref<T> | undefined, node: T | null) {
  if (typeof ref === "function") ref(node);
  else if (ref) ref.current = node;
}

/** One tab: its label with an optional icon and count. Selected is an ink pill. */
export function TabsTrigger({ icon, count, className, children, ref, ...props }: TabsTriggerProps) {
  const look = useContext(LookContext);
  const node = useRef<HTMLButtonElement | null>(null);
  const wasActive = useRef<boolean | null>(null);

  useEffect(() => {
    const tab = node.current;
    const active = tab?.dataset.state === "active";
    if (tab && active && !wasActive.current) revealInRow(tab, wasActive.current !== null);
    wasActive.current = active;
  });

  return (
    <RadixTabs.Trigger
      ref={(el) => {
        node.current = el;
        assignRef(ref, el);
      }}
      className={cn(tabsTrigger({ look }), className)}
      {...props}
    >
      {icon ? <Icon icon={icon} size={look === "bar" ? 16 : 14} /> : null}
      {children}
      {count !== undefined ? <PillCount>{count}</PillCount> : null}
    </RadixTabs.Trigger>
  );
}

/** One tab's view. */
export function TabsContent({ className, ...props }: ComponentProps<typeof RadixTabs.Content>) {
  return <RadixTabs.Content className={cn("min-w-0", className)} {...props} />;
}
