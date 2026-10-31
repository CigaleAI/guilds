import { Eye } from "lucide-react";
import type { ReactNode } from "react";
import { useStudioEdits } from "../../api/queries/studio";
import type { StudioEdit } from "../../api/types/studio";
import { Button, DiffView, diffLines, Icon, Tag, cn, toast } from "@guildsrun/ui";
import {
  applyLabel,
  connectionLabel,
  editTargetLabel,
  type AccessWidget,
  type DraftWidget,
  type EditWidget,
} from "./chatModel";
import type { Proposal } from "./pendingModel";
import { useStudio } from "./StudioContext";

type CardProps = {
  proposal: Proposal;
  /** Whether the card offers its answers; a request of an earlier turn shows only its outcome. */
  actionable: boolean;
  /** Opens the request where it lives in the workspace; left out where the card already is there. */
  showable?: boolean;
};

/** One coach request as a card: what it changes, why, and its answer or the buttons to give one. */
export function ProposalCard(props: CardProps) {
  const widget = props.proposal.widget;
  if (widget.kind === "draft") return <DraftCard {...props} widget={widget} />;
  if (widget.kind === "access") return <AccessCard {...props} widget={widget} />;
  return <EditCard {...props} widget={widget} />;
}

type ProposalPanelProps = { proposals: readonly Proposal[] };

/** The requests that change what is open here, decided in place. */
export function ProposalPanel({ proposals }: ProposalPanelProps) {
  if (!proposals.length) return null;
  return (
    <div className="flex max-h-[45vh] shrink-0 flex-col gap-3 overflow-y-auto border-b border-line bg-surface px-4 py-3">
      {proposals.map((proposal) => (
        <ProposalCard key={proposal.seq} proposal={proposal} actionable />
      ))}
    </div>
  );
}

type SettleAllProps = { open: readonly Proposal[]; disabled: boolean };

/**
 * Apply all and Decline all over the open requests. Apply all leaves a login grant or an access
 * change that widens to be decided on its own, and says how many it left.
 */
export function SettleAll({ open, disabled }: SettleAllProps) {
  const { approvals } = useStudio();
  const together = open.filter((proposal) => !proposal.alone).length;
  const applyAll = async () => {
    const left = await approvals.applyAll();
    if (left) {
      toast({
        kind: "info",
        title: `Left ${left} to decide on ${left === 1 ? "its" : "their"} own`,
        description: "A login grant or a change that widens access needs its own Apply.",
      });
    }
  };
  const refused = (error: Error) =>
    toast({ kind: "error", title: "Couldn't record the decision", description: error.message });
  return (
    <>
      <Button
        size="sm"
        disabled={disabled || !together}
        onClick={() => void applyAll().catch(refused)}
      >
        Apply all {together}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled}
        onClick={() => void approvals.declineAll().catch(refused)}
      >
        Decline all
      </Button>
    </>
  );
}

type RequestCardProps = {
  title: string;
  reason: string | undefined;
  show: ReactNode;
  children: ReactNode;
};

function RequestCard({ title, reason, show, children }: RequestCardProps) {
  return (
    <article className="flex flex-col gap-3 self-start rounded-xl bg-t-sig p-4 text-fg">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-md font-semibold">{title}</span>
          {reason ? <p className="text-sm text-fg-2">{reason}</p> : null}
        </div>
        {show}
      </div>
      {children}
    </article>
  );
}

type ShowButtonProps = { proposal: Proposal; showable: boolean | undefined };

/** Opens a request where it is decided: the agent's tab, the State item, Tools, or the guild. */
function ShowButton({ proposal, showable }: ShowButtonProps) {
  const { go } = useStudio();
  const where = proposal.location;
  if (!showable || !where) return null;
  return (
    <Button variant="ghost" size="xs" onClick={() => go(where)}>
      <Icon icon={Eye} size={14} />
      Show
    </Button>
  );
}

/** Records one answer and says so when it is refused. */
function useAnswer(proposal: Proposal) {
  const { approvals } = useStudio();
  return {
    disabled: !approvals.live || approvals.busy,
    answer: (accept: boolean) =>
      void approvals.decide(proposal, accept).catch((error: Error) =>
        toast({
          kind: "error",
          title: "Couldn't record the decision",
          description: error.message,
        }),
      ),
  };
}

type OutcomeProps = { accepted: boolean; children: ReactNode };

function Outcome({ accepted, children }: OutcomeProps) {
  return (
    <Tag tone={accepted ? "tide" : "well"} font="sans" className="self-start">
      {children}
    </Tag>
  );
}

type EditCardProps = CardProps & { widget: EditWidget };

function EditCard({ proposal, actionable, showable, widget }: EditCardProps) {
  const { session } = useStudio();
  const view = useStudioEdits(session.id, [proposal.seq])[0]?.data;
  const { disabled, answer } = useAnswer(proposal);
  const target = editTargetLabel(widget.edit);
  const pending = proposal.state === "open";

  return (
    <RequestCard
      title={widget.title ?? `Edit ${target}`}
      reason={widget.reason}
      show={<ShowButton proposal={proposal} showable={showable} />}
    >
      <EditSummary edit={widget.edit} target={target} />
      <EditStatus proposal={proposal} view={view} />
      {widget.edit.widens && pending ? (
        <p className="text-sm text-fg-2">
          This widens what the agent can do, so it is decided on its own.
        </p>
      ) : null}
      {pending && view ? <EditPreview view={view} /> : null}
      {pending && actionable ? (
        <EditAnswers
          edit={widget.edit}
          disabled={disabled}
          stale={Boolean(view?.stale)}
          onAnswer={answer}
        />
      ) : null}
    </RequestCard>
  );
}

type EditAnswersProps = {
  edit: EditWidget["edit"];
  disabled: boolean;
  /** Whether the live content changed under the edit, which can then only be declined. */
  stale: boolean;
  onAnswer: (accept: boolean) => void;
};

/** Apply, or create or delete for an edit that does, and Decline. */
function EditAnswers({ edit, disabled, stale, onAnswer }: EditAnswersProps) {
  return (
    <div className="flex gap-2">
      <Button
        size="sm"
        variant={edit.action === "delete" ? "destructive" : "primary"}
        disabled={disabled || stale}
        onClick={() => onAnswer(true)}
      >
        {applyLabel(edit)}
      </Button>
      <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onAnswer(false)}>
        Decline
      </Button>
    </div>
  );
}

type EditSummaryProps = { edit: EditWidget["edit"]; target: string };

/** What an edit changes, how many lines it adds and removes, and the version it starts from. */
function EditSummary({ edit, target }: EditSummaryProps) {
  const lines = edit.lines ?? {};
  return (
    <span className="font-mono text-xs text-fg-2">
      {target} · +{lines.added ?? 0} −{lines.removed ?? 0} lines
      {edit.base_version !== undefined ? ` · from v${edit.base_version}` : ""}
    </span>
  );
}

type EditStatusProps = { proposal: Proposal; view: StudioEdit | undefined };

/** How an edit was answered, or, while it waits, that the live content changed under it. */
function EditStatus({ proposal, view }: EditStatusProps) {
  if (proposal.decision) {
    return (
      <Outcome accepted={proposal.decision.accepted}>
        {proposal.decision.accepted
          ? `Applied${view?.applied_version ? ` as v${view.applied_version}` : ""}`
          : "Declined"}
      </Outcome>
    );
  }
  if (!view?.stale) return null;
  return (
    <p className="text-sm text-plum-t">
      The live content changed since this proposal; ask the coach to rebuild it, or decline.
    </p>
  );
}

type EditPreviewProps = { view: StudioEdit };

/** What applying a pending edit does, then its text beside the live text. */
function EditPreview({ view }: EditPreviewProps) {
  const effects = view.effects ?? [];
  return (
    <>
      {effects.length ? (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-fg-2">
          {effects.map((effect) => (
            <li key={effect}>{effect}</li>
          ))}
        </ul>
      ) : null}
      <EditDiff view={view} />
    </>
  );
}

type EditDiffProps = { view: StudioEdit };

/**
 * What a pending edit changes: the live text beside the proposal, per guild field for guild edits;
 * a table's definition and access written out line by line.
 */
function EditDiff({ view }: EditDiffProps) {
  if (view.error) return <p className="text-sm text-plum-t">{view.error}</p>;
  const { live, proposed } = view;
  if (typeof live === "string" || typeof proposed === "string" || !live || !proposed) {
    return (
      <DiffView
        lines={diffLines(
          typeof live === "string" ? live : "",
          typeof proposed === "string" ? proposed : "",
        )}
        title="live → proposed"
        className="max-h-96 overflow-y-auto"
      />
    );
  }
  return (
    <>
      {(["about", "description"] as const)
        .filter((field) => live[field] !== proposed[field])
        .map((field) => (
          <DiffView
            key={field}
            lines={diffLines(live[field], proposed[field])}
            title={`${field} · live → proposed`}
            className="max-h-96 overflow-y-auto"
          />
        ))}
    </>
  );
}

type AccessCardProps = CardProps & { widget: AccessWidget };

function AccessCard({ proposal, actionable, widget }: AccessCardProps) {
  const { disabled, answer } = useAnswer(proposal);
  const connection = widget.connection;
  const decision = proposal.decision;

  return (
    <RequestCard title={widget.title ?? "Grant read access"} reason={widget.reason} show={null}>
      <span className="font-mono text-xs text-fg-2">
        {connectionLabel(connection)}
        {connection.owner_scope ? ` · ${connection.owner_scope} login` : ""}
      </span>
      {decision ? (
        <Outcome accepted={decision.accepted}>{decision.accepted ? "Granted" : "Declined"}</Outcome>
      ) : !actionable ? (
        <Outcome accepted={false}>Answered</Outcome>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" disabled={disabled || !connection.id} onClick={() => answer(true)}>
            Grant read access
          </Button>
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => answer(false)}>
            Decline
          </Button>
        </div>
      )}
    </RequestCard>
  );
}

const draftOutcomeLabel: Record<string, string> = {
  published: "Published",
  unchanged: "Published unchanged",
  discarded: "Discarded",
  superseded: "Replaced by a later draft",
};

type DraftCardProps = CardProps & { widget: DraftWidget };

/** A Task draft: decided in its agent's Draft tab, where its diff, Publish, Edit and Discard are. */
function DraftCard({ proposal, showable, widget }: DraftCardProps) {
  const status = proposal.draft?.status;
  return (
    <RequestCard
      title={`Task draft for ${widget.agent.name}`}
      reason={widget.rationale}
      show={<ShowButton proposal={proposal} showable={showable} />}
    >
      {proposal.draft ? (
        <span className="font-mono text-xs text-fg-2">
          draft {proposal.draft.draft_number} · from v{proposal.draft.base_version}
        </span>
      ) : null}
      {status && draftOutcomeLabel[status] ? (
        <Outcome accepted={status !== "discarded"}>{draftOutcomeLabel[status]}</Outcome>
      ) : (
        <p className={cn("text-sm text-fg-2", status === "conflicted" && "text-plum-t")}>
          {status === "conflicted"
            ? "The Task changed since this draft; review it in the Draft tab."
            : "Review the diff in the Draft tab, then publish, edit or discard it."}
        </p>
      )}
    </RequestCard>
  );
}
