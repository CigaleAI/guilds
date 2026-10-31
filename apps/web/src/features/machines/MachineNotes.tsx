import { Link } from "@tanstack/react-router";
import { Server } from "lucide-react";
import type { ReactNode } from "react";
import type { Machine } from "../../api/types/agents";
import { machineSizeLabel, type MachineSize } from "./machines";
import { Button, EmptyState } from "@guildsrun/ui";

/** An inline link to Settings → Machines, where owners and admins add and resize machines. */
export function MachinesSettingsLink() {
  return (
    <Link to="/settings" search={{ tab: "machines" }} className="underline">
      Settings → Machines
    </Link>
  );
}

type NoMachinesProps = { action?: ReactNode };

/**
 * The organisation has no machine, so no agent can be placed yet. The next step is a button to
 * Settings → Machines unless `action` replaces it; `null` shows none.
 */
export function NoMachines({ action }: NoMachinesProps) {
  return (
    <EmptyState
      icon={Server}
      title="No machines yet"
      description="Every agent runs on one of the organisation's machines. Owners and admins add them under Settings → Machines."
      action={
        action === undefined ? (
          <Button asChild size="sm">
            <Link to="/settings" search={{ tab: "machines" }}>
              Open Settings → Machines
            </Link>
          </Button>
        ) : (
          action
        )
      }
    />
  );
}

type TooSmallNoteProps = {
  machine: Pick<Machine, "name" | "cpu" | "memory_mib">;
  minimum: MachineSize;
  /** Who needs the minimum: "This agent", "Coding". */
  what: string;
};

/** Why an agent cannot go on a machine: it is below the agent's minimum, with where to get another. */
export function TooSmallNote({ machine, minimum, what }: TooSmallNoteProps) {
  return (
    <p className="text-sm text-plum-t">
      {what} needs a machine with at least {machineSizeLabel(minimum)};{" "}
      <span className="font-mono">{machine.name}</span> has {machineSizeLabel(machine)}. Pick
      another machine, or resize one under <MachinesSettingsLink />.
    </p>
  );
}
