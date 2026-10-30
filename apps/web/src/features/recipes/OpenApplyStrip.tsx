import { Link } from "@tanstack/react-router";
import { ListChecks } from "lucide-react";
import { useGuildApply } from "../../api/queries/recipes";
import { Button, Icon } from "@guildsrun/ui";
type OpenApplyStripProps = { guildId: string };

/** A guild whose recipe checklist is still open: its routines wait on it. */
export function OpenApplyStrip({ guildId }: OpenApplyStripProps) {
  const apply = useGuildApply(guildId);
  if (!apply.data) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-t-sig px-6 py-2.5 text-sm text-t-sig-fg">
      <Icon icon={ListChecks} size={16} />
      <span className="min-w-0 flex-1">
        Recipe setup is open: the routines stay paused until its checklist is done.
      </span>
      <Button asChild variant="outline" size="sm">
        <Link to="/applies/$applyId" params={{ applyId: apply.data.id }}>
          Open checklist
        </Link>
      </Button>
    </div>
  );
}
