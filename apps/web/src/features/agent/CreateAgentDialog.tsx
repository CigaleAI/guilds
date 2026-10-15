import { Bot, Code2 } from "lucide-react";
import { useState } from "react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Icon,
} from "@guildsrun/ui";
import { CodingAgentForm } from "./CreateCodingAgent";
import { StandardAgentForm } from "./CreateStandardAgent";

export type CreateAgentGuild = { id: string; name: string };

type Kind = "standard" | "coding";

type CreateAgentDialogProps = {
  guild: CreateAgentGuild | null;
  onClose: () => void;
};

function KindCard({
  icon,
  title,
  hint,
  onPick,
}: {
  icon: typeof Bot;
  title: string;
  hint: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="flex min-w-0 cursor-pointer flex-col items-start gap-2 rounded-xl bg-surface px-4 py-4 text-left inset-ring inset-ring-line-3 transition-colors hover:bg-well focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <span className="flex items-center gap-2 text-base font-semibold text-fg">
        <Icon icon={icon} size={18} />
        {title}
      </span>
      <span className="text-sm text-pretty text-fg-2">{hint}</span>
    </button>
  );
}

/** The first screen: which kind of agent to create, since the two take different settings. */
function KindChooser({ guild, onPick }: { guild: CreateAgentGuild; onPick: (kind: Kind) => void }) {
  return (
    <>
      <DialogHeader title="Create an agent" description={`A new member of ${guild.name}.`} />
      <DialogBody>
        <div className="grid gap-3 sm:grid-cols-2">
          <KindCard
            icon={Bot}
            title="Agent"
            hint="Talks, researches, and works with tools and connectors on one of the organisation's models."
            onPick={() => onPick("standard")}
          />
          <KindCard
            icon={Code2}
            title="Coding agent"
            hint="Leads code work in the guild's repositories, delegated to a coding harness (Claude Code, Codex, or Cursor) on your own subscription."
            onPick={() => onPick("coding")}
          />
        </div>
      </DialogBody>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="ghost">Cancel</Button>
        </DialogClose>
      </DialogFooter>
    </>
  );
}

/**
 * A new agent in a guild. The first screen asks which kind: an agent, whose steps walk through its
 * identity, model, and machine, or a coding agent, whose steps walk through its identity, harness,
 * lead model, and repositories.
 */
export function CreateAgentDialog({ guild, onClose }: CreateAgentDialogProps) {
  const [kind, setKind] = useState<Kind | null>(null);
  const close = () => {
    setKind(null);
    onClose();
  };
  return (
    <Dialog open={guild !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent size="lg">
        {guild === null ? null : kind === null ? (
          <KindChooser guild={guild} onPick={setKind} />
        ) : kind === "standard" ? (
          <StandardAgentForm guild={guild} onClose={close} />
        ) : (
          <CodingAgentForm guild={guild} onClose={close} />
        )}
      </DialogContent>
    </Dialog>
  );
}
