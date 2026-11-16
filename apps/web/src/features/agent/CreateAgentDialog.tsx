import { Dialog, DialogContent } from "@guildsrun/ui";
import { StandardAgentForm } from "./CreateStandardAgent";

export type CreateAgentGuild = { id: string; name: string };

type CreateAgentDialogProps = {
  guild: CreateAgentGuild | null;
  onClose: () => void;
};

/**
 * A new agent in a guild, step by step: its identity, its model source (a model on a key or a
 * subscription on a harness), and its machine.
 */
export function CreateAgentDialog({ guild, onClose }: CreateAgentDialogProps) {
  return (
    <Dialog open={guild !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg">
        {guild === null ? null : <StandardAgentForm guild={guild} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}
