import type { AccessTarget } from "../../api/types/access";
import {
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "@guildsrun/ui";
import { AccessListPanel } from "./AccessListPanel";

type AccessListDialogProps = {
  target: AccessTarget;
  /** The item's name, as its list shows it. */
  name: string;
  /** What the list decides for this kind of item. */
  intro: string;
  onClose: () => void;
};

/** Who reaches a note or a file: its access list, in a dialog over the list that shows the item. */
export function AccessListDialog({ target, name, intro, onClose }: AccessListDialogProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg">
        <DialogHeader title={`Access to ${name}`} />
        <DialogBody>
          <AccessListPanel target={target} intro={intro} />
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Done</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
