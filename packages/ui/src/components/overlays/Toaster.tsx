import { Check, CircleAlert, Info, TriangleAlert, X } from "lucide-react";
import { Toast as RadixToast } from "radix-ui";
import { useSyncExternalStore } from "react";
import { Icon } from "../../primitives/Icon";
import { Tile } from "../../primitives/Tile";
import { dismissToast, getToasts, subscribeToasts, type ToastKind, type ToastRecord } from "./toast";

const kindStyle = {
  success: { tone: "tide", icon: Check },
  info: { tone: "signal", icon: Info },
  warning: { tone: "ochre", icon: TriangleAlert },
  error: { tone: "plum", icon: CircleAlert },
} as const;

const sticky: Record<ToastKind, boolean> = { success: false, info: false, warning: true, error: true };

/** Where toasts appear: bottom-right, newest on top. Mount once near the app root; F8 focuses the stack. */
export function Toaster() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  return (
    <RadixToast.Provider swipeDirection="right" duration={5000} label="Notifications">
      {toasts.map((record) => (
        <ToastItem key={record.id} record={record} />
      ))}
      <RadixToast.Viewport className="pointer-events-none fixed right-0 bottom-0 z-100 flex w-full max-w-113 flex-col-reverse gap-2 p-4 outline-none" />
    </RadixToast.Provider>
  );
}

function ToastItem({ record }: { record: ToastRecord }) {
  const kind = record.kind ?? "info";
  const style = kindStyle[kind];
  return (
    <RadixToast.Root
      open={record.open}
      onOpenChange={(open) => {
        if (!open) dismissToast(record.id);
      }}
      duration={sticky[kind] ? Infinity : 5000}
      type={sticky[kind] ? "foreground" : "background"}
      className="anim-toast pointer-events-auto flex items-center gap-3 rounded-lg bg-panel py-2.5 pr-2.5 pl-3 text-on-panel shadow-pop select-none"
    >
      <Tile size={32} tone={style.tone}>
        <Icon icon={style.icon} />
      </Tile>
      <div className="flex min-w-0 flex-1 flex-col">
        <RadixToast.Title className="text-md font-semibold">{record.title}</RadixToast.Title>
        {record.description ? (
          <RadixToast.Description className="text-xs text-on-panel-muted">{record.description}</RadixToast.Description>
        ) : null}
      </div>
      {record.action ? (
        <RadixToast.Action
          altText={record.action.altText ?? record.action.label}
          onClick={record.action.onClick}
          className="shrink-0 cursor-pointer rounded-xs px-1.5 text-sm font-bold whitespace-nowrap text-signal-soft hover:underline focus-visible:outline-signal-soft"
        >
          {record.action.label}
        </RadixToast.Action>
      ) : null}
      <RadixToast.Close
        aria-label="Dismiss"
        className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-sm text-on-panel-muted transition-colors hover:text-on-panel focus-visible:outline-signal-soft"
      >
        <Icon icon={X} size={14} />
      </RadixToast.Close>
    </RadixToast.Root>
  );
}
