import { Link } from "@tanstack/react-router";
import { Server } from "lucide-react";
import type { ReactNode } from "react";
import type { MachineRef } from "../../api/types";
import { Button, EmptyState } from "@guildsrun/ui";

/** An inline link to Settings → Machines, where owners and admins add and resize machines. */
export function MachinesSettingsLink() {
  return (
    <Link to="/settings" search={{ tab: "machines" }} className="underline">
      Settings → Machines
    </Link>
  );
}

/**
 * The organisation has no machine, so no agent can be placed yet. The next step is a button to
 * Settings → Machines unless `action` replaces it; `null` shows none.
 */
export function NoMachines({ action }: { action?: ReactNode }) {
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

/** Why Coding is greyed out: the agent's machine is standard, with where to get another. */
export function StandardMachineNote({ machine }: { machine: MachineRef }) {
  return (
    <p className="text-sm text-muted">
      <span className="font-mono">{machine.name}</span> is a standard machine, without coding. Pick
      another machine, or resize one under <MachinesSettingsLink />.
    </p>
  );
}
