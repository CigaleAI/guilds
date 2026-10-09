import { CircleHelp, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import { AlertDialog } from "radix-ui";
import { useId, useState, type ReactNode } from "react";
import { Field, FieldInput } from "../../primitives/Field";
import { Icon } from "../../primitives/Icon";
import { Tile } from "../../primitives/Tile";
import { Button } from "../actions/Button";
import { dialogScrim } from "./Dialog";

/** Confirm asks before an ordinary action; destructive asks before an irreversible one; alert only informs. */
export type ConfirmKind = "confirm" | "destructive" | "alert";

const kindTile = {
  confirm: { tone: "well", icon: CircleHelp },
  destructive: { tone: "plum-tint", icon: TriangleAlert },
  alert: { tone: "signal-tint", icon: Info },
} as const;

const defaultConfirmLabel: Record<ConfirmKind, string> = {
  confirm: "Confirm",
  destructive: "Delete",
  alert: "Got it",
};

export type ConfirmDialogProps = {
  kind?: ConfirmKind;
  title: ReactNode;
  /** What happens, in one or two sentences: what is removed, what stops, whether it can be undone. */
  description?: ReactNode;
  /** The action's label, naming what it does, such as "Delete database". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive only: text the operator types before the action enables, such as the database name. */
  confirmText?: string;
  /**
   * Runs on confirm. While a returned promise is pending the buttons are disabled; the dialog closes
   * when it resolves and stays open when it rejects, so report the error from here (a toast).
   */
  onConfirm?: () => void | Promise<unknown>;
  /** Replaces the kind's icon. */
  icon?: LucideIcon;
  /** The element that opens the dialog, such as a Delete button. Omit it and control `open` instead. */
  trigger?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/**
 * Asks the operator to confirm, or tells them something they must acknowledge. Stands in for the
 * browser's confirm and alert. Focus starts on Cancel (or the type-to-confirm field), never on the
 * action.
 */
export function ConfirmDialog({
  kind = "confirm",
  trigger,
  open,
  defaultOpen,
  onOpenChange,
  ...panel
}: ConfirmDialogProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen ?? false);
  const isOpen = open ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (open === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  return (
    <AlertDialog.Root open={isOpen} onOpenChange={setOpen}>
      {trigger ? <AlertDialog.Trigger asChild>{trigger}</AlertDialog.Trigger> : null}
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={dialogScrim()}>
          <AlertDialog.Content className="anim-modal flex max-h-full w-full max-w-100 flex-col overflow-hidden rounded-xl bg-paper text-fg shadow-modal outline-none">
            <ConfirmPanel kind={kind} onClose={() => setOpen(false)} {...panel} />
          </AlertDialog.Content>
        </AlertDialog.Overlay>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

type ConfirmPanelProps = Omit<ConfirmDialogProps, "trigger" | "open" | "defaultOpen" | "onOpenChange"> & {
  kind: ConfirmKind;
  onClose: () => void;
};

function ConfirmPanel({
  kind,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  confirmText,
  onConfirm,
  icon,
  onClose,
}: ConfirmPanelProps) {
  const fieldId = useId();
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const typeToConfirm = kind === "destructive" && confirmText ? confirmText : null;
  const ready = !pending && (typeToConfirm === null || typed.trim() === typeToConfirm);

  const confirm = async () => {
    setPending(true);
    try {
      await onConfirm?.();
      onClose();
    } catch {
      setPending(false);
    }
  };

  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) void confirm();
      }}
    >
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-6 pt-5 pb-5">
        <Tile size={44} tone={kindTile[kind].tone}>
          <Icon icon={icon ?? kindTile[kind].icon} size={20} />
        </Tile>
        <AlertDialog.Title className="text-2xl font-semibold text-fg">{title}</AlertDialog.Title>
        {description ? (
          <AlertDialog.Description className="text-md text-pretty text-fg-2">{description}</AlertDialog.Description>
        ) : null}
        {typeToConfirm ? (
          <div className="flex flex-col gap-1.5 pt-2">
            <label htmlFor={fieldId} className="text-sm font-semibold">
              Type <b className="font-mono">{typeToConfirm}</b> to confirm
            </label>
            <Field shape="box" tone="surface" className="font-mono">
              <FieldInput
                id={fieldId}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                autoFocus
              />
            </Field>
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 bg-surface px-6 py-4">
        {kind === "alert" ? (
          <AlertDialog.Cancel asChild>
            <Button size="lg" onClick={() => void onConfirm?.()}>{confirmLabel ?? defaultConfirmLabel.alert}</Button>
          </AlertDialog.Cancel>
        ) : (
          <>
            <AlertDialog.Cancel asChild>
              <Button size="lg" variant="ghost" disabled={pending}>
                {cancelLabel}
              </Button>
            </AlertDialog.Cancel>
            <Button size="lg" type="submit" variant={kind === "destructive" ? "destructive" : "primary"} disabled={!ready}>
              {confirmLabel ?? defaultConfirmLabel[kind]}
            </Button>
          </>
        )}
      </div>
    </form>
  );
}
