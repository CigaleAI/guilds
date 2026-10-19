import { CircleCheck } from "lucide-react";
import { Button, Icon, Popover, PopoverContent, PopoverTrigger, toast } from "@guildsrun/ui";
import { applyLabel } from "./chatModel";
import { studioSectionLabel } from "./location";
import type { Proposal, ProposalPlace } from "./pendingModel";
import { SettleAll } from "./ProposalCards";
import { useStudio } from "./StudioContext";

const placeOrder: readonly ProposalPlace[] = ["guild", "agents", "state", "tools", "logins"];

const placeLabel: Record<ProposalPlace, string> = { ...studioSectionLabel, logins: "Logins" };

/** The words on a request's accept button. */
function acceptLabel(proposal: Proposal): string {
  const widget = proposal.widget;
  if (widget.kind === "draft") return "Publish";
  if (widget.kind === "access") return "Grant";
  return applyLabel(widget.edit);
}

/** Every request the coach is waiting on, grouped by where it lives, to show or answer from here. */
export function ApprovalTray() {
  const { approvals } = useStudio();
  const open = approvals.open;
  if (!open.length) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="accent" size="sm">
          <Icon icon={CircleCheck} size={14} />
          {open.length} to approve
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-[28rem] max-w-full flex-col gap-3 p-4">
        <div className="flex flex-col gap-1">
          <span className="text-md font-semibold">Waiting on your decision</span>
          <span className="text-xs text-muted">
            The coach continues once every request of its turn is decided.
          </span>
        </div>
        {placeOrder.map((place) => (
          <TrayGroup
            key={place}
            place={place}
            proposals={open.filter((proposal) => proposal.place === place)}
          />
        ))}
        {open.length > 1 ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <SettleAll open={open} disabled={!approvals.live || approvals.busy} />
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function TrayGroup({ place, proposals }: { place: ProposalPlace; proposals: Proposal[] }) {
  if (!proposals.length) return null;
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="type-label text-muted">{placeLabel[place]}</h3>
      <ul className="flex flex-col gap-1.5">
        {proposals.map((proposal) => (
          <TrayRow key={proposal.seq} proposal={proposal} />
        ))}
      </ul>
    </section>
  );
}

function TrayRow({ proposal }: { proposal: Proposal }) {
  const { approvals, go } = useStudio();
  const disabled = !approvals.live || approvals.busy;
  const where = proposal.location;
  const answer = (accept: boolean) =>
    void approvals
      .decide(proposal, accept)
      .catch((error: Error) =>
        toast({ kind: "error", title: "Couldn't record the decision", description: error.message }),
      );
  return (
    <li className="flex items-center gap-2 rounded-lg bg-surface px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-sm font-medium" title={proposal.label}>
        {proposal.label}
      </span>
      {where ? (
        <Button variant="ghost" size="xs" onClick={() => go(where)}>
          Show
        </Button>
      ) : null}
      <Button size="xs" disabled={disabled} onClick={() => answer(true)}>
        {acceptLabel(proposal)}
      </Button>
      <Button variant="ghost" size="xs" disabled={disabled} onClick={() => answer(false)}>
        {proposal.widget.kind === "draft" ? "Discard" : "Decline"}
      </Button>
    </li>
  );
}
