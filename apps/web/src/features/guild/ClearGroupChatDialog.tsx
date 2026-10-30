import { ConfirmDialog, toast } from "@guildsrun/ui";
import { useClearGroupChat } from "../../api/queries/chat";
import type { Guild } from "../../api/types";

type ClearGroupChatDialogProps = {
  guild: Pick<Guild, "id" | "name">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Confirms deleting every group chat message, for everyone in the guild. */
export function ClearGroupChatDialog({ guild, open, onOpenChange }: ClearGroupChatDialogProps) {
  const clear = useClearGroupChat(guild.id);
  return (
    <ConfirmDialog
      kind="destructive"
      open={open}
      onOpenChange={onOpenChange}
      title={`Clear the ${guild.name} group chat?`}
      description="Every message is deleted for everyone in the guild, so agents start from an empty chat. Their memory, notes and past sessions stay. An agent run already under way can't post its reply. This can't be undone."
      confirmLabel="Clear group chat"
      onConfirm={() =>
        clear.mutateAsync().then(
          () => toast({ kind: "success", title: "Group chat cleared" }),
          (error: Error) => {
            toast({
              kind: "error",
              title: "Couldn't clear the group chat",
              description: error.message,
            });
            throw error;
          },
        )
      }
    />
  );
}
