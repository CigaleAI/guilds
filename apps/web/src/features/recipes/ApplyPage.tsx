import { Link, useLocation, useNavigate, useParams } from "@tanstack/react-router";
import {
  Check,
  CircleCheck,
  Circle,
  CircleSlash,
  ExternalLink,
  Link2,
  Play,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  useAbortApply,
  useActivateApply,
  useApply,
  useConfirmStep,
  useVerifyStep,
} from "../../api/queries/recipes";
import { useAccess } from "../../api/queries/access";
import type { McpServerAccess } from "../../api/types/access";
import { useInstance } from "../../api/queries/admin";
import type { ApplyRow, ApplyStep } from "../../api/types/recipes";
import { useIdentity } from "../../app/identity";
import {
  Button,
  Banner,
  PageError,
  SkeletonRows,
  ConfirmDialog,
  toast,
  cn,
  Icon,
} from "@guildsrun/ui";
import { useServerConnect, type ConnectableServer } from "../access/ConnectDialogs";
import { connectorSetupGap, setupSearch, type ConnectorSetupGap } from "../instance/instance";
import {
  applyOpen,
  checklistProgress,
  checklistSteps,
  createdSummary,
  skippable,
  skippedSteps,
  stepClosed,
  stepConnector,
  stepDetail,
  stepHint,
  stepStatus,
  workOpen,
} from "./applySteps";

/**
 * What is left once a recipe has created its guild: the logins and secrets to add, the setup to do
 * outside the platform, and activating the paused routines. Aborting deletes what the apply made.
 */
export function ApplyPage() {
  const { applyId } = useParams({ from: "/applies/$applyId" });
  const apply = useApply(applyId);

  if (apply.isError) {
    return (
      <div className="grid flex-1 place-items-center p-6">
        <PageError title="Couldn't open this apply" description={apply.error.message} />
      </div>
    );
  }
  if (!apply.data) {
    return (
      <div className="p-8">
        <SkeletonRows rows={8} label="Loading the checklist" />
      </div>
    );
  }
  return <Checklist apply={apply.data} />;
}

type ChecklistProps = { apply: ApplyRow };

function Checklist({ apply }: ChecklistProps) {
  const navigate = useNavigate();
  const owner = { scope: "guild" as const, id: apply.guild_id };
  const access = useAccess(owner);
  const instance = useInstance();
  const verify = useVerifyStep(apply.id);
  const confirm = useConfirmStep(apply.id);
  const activate = useActivateApply(apply.id);
  const abort = useAbortApply(apply.id);
  const [aborting, setAborting] = useState(false);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [skipping, setSkipping] = useState<ApplyStep | null>(null);

  const open = applyOpen(apply);
  const steps = checklistSteps(apply.checklist);
  const progress = checklistProgress(apply.checklist);
  const busy = verify.isPending || confirm.isPending || activate.isPending || abort.isPending;
  const guildName = apply.preview.creates.guild.name || "the guild";
  const skipped = skippedSteps(apply.checklist);
  const servers = access.data?.mcp;

  const problem = (stepId: string, message: string | null) =>
    setProblems((current) => {
      const next = { ...current };
      if (message) next[stepId] = message;
      else delete next[stepId];
      return next;
    });

  const check = (stepId: string) =>
    verify.mutate(stepId, {
      onSuccess: () => problem(stepId, null),
      onError: (error) => problem(stepId, error.message),
    });

  /** A login made on its step is checked at once. */
  const connect = useServerConnect(owner, (server: ConnectableServer) => {
    const step = apply.checklist.find((item) => item.id === `conn:${server.slug}`);
    if (step) check(step.id);
  });

  const start = () =>
    activate.mutate(undefined, {
      onSuccess: (row) => {
        toast({ kind: "success", title: `${guildName} is live` });
        void navigate({ to: "/guilds/$guildId", params: { guildId: row.guild_id } });
      },
      onError: (error) =>
        toast({ kind: "error", title: "Couldn't activate", description: error.message }),
    });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8 md:px-10">
      <div className="mx-auto flex max-w-200 flex-col gap-6">
        <ChecklistHeader
          apply={apply}
          guildName={guildName}
          open={open}
          busy={busy}
          onAbort={() => setAborting(true)}
          onActivate={start}
        />

        <section className="flex flex-col gap-2 rounded-xl bg-surface p-5">
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-semibold">
              {progress.done} of {progress.total}
            </span>
            <span className="text-sm text-muted">complete</span>
          </div>
          <div
            role="progressbar"
            aria-label="Checklist progress"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.done}
            className="h-2 overflow-hidden rounded-full bg-well"
          >
            <div
              className="h-full rounded-full bg-signal transition-all"
              style={{ width: `${(progress.done / progress.total) * 100}%` }}
            />
          </div>
        </section>

        <ol className="flex flex-col gap-2">
          <Milestone
            title="Recipe validated"
            detail="The recipe passed its checks and is approved to apply."
          />
          <Milestone title="Guild created" detail={createdSummary(apply.preview.creates)} />
          {steps.map((step) => {
            const { server, connected } = stepConnector(step, servers);
            const gap = server ? connectorSetupGap(server, instance.data) : null;
            return (
              <ChecklistStep
                key={step.id}
                step={step}
                connected={connected}
                gap={gap}
                problem={problems[step.id]}
              >
                {open && !stepClosed(step) ? (
                  <StepActions
                    step={step}
                    server={server}
                    connected={connected}
                    gap={gap}
                    busy={busy}
                    connecting={connect.busy}
                    workLeft={workOpen(apply.checklist)}
                    guildId={apply.guild_id}
                    onConnect={connect.start}
                    onCheck={() => check(step.id)}
                    onDone={() =>
                      confirm.mutate(
                        { stepId: step.id },
                        { onError: (error) => problem(step.id, error.message) },
                      )
                    }
                    onSkip={() => setSkipping(step)}
                    onActivate={start}
                  />
                ) : null}
              </ChecklistStep>
            );
          })}
        </ol>

        {skipped.length ? (
          <Banner
            tone="info"
            title={`Skipped ${skipped.length} step${skipped.length === 1 ? "" : "s"}`}
          >
            Agents that need {skipped.map((step) => step.title).join(", ")} fail those tasks until
            it is added from the guild's Tools, Secrets, or Settings.
          </Banner>
        ) : null}
      </div>

      {connect.dialogs}
      <ConfirmDialog
        open={skipping !== null}
        onOpenChange={(value) => !value && setSkipping(null)}
        title={`Skip ${skipping?.title ?? "this step"}?`}
        description="Agents that need this access fail those tasks until it is added from the guild's Tools, Secrets, or Settings."
        confirmLabel="Skip"
        onConfirm={() =>
          skipping
            ? confirm.mutateAsync({ stepId: skipping.id, skip: true }).then(
                () => setSkipping(null),
                (error: Error) => {
                  toast({ kind: "error", title: "Couldn't skip", description: error.message });
                  throw error;
                },
              )
            : undefined
        }
      />
      <ConfirmDialog
        kind="destructive"
        open={aborting}
        onOpenChange={setAborting}
        title="Abort this apply?"
        description={`${guildName} and everything this apply created are deleted: its agents and the tables it made.`}
        confirmLabel="Abort and delete"
        onConfirm={() =>
          abort.mutateAsync().then(
            () => void navigate({ to: "/recipes" }),
            (error: Error) => {
              toast({ kind: "error", title: "Couldn't abort", description: error.message });
              throw error;
            },
          )
        }
      />
    </div>
  );
}

type ChecklistHeaderProps = {
  apply: ApplyRow;
  guildName: string;
  /** True while the apply is open: neither activated nor aborted. */
  open: boolean;
  busy: boolean;
  onAbort: () => void;
  onActivate: () => void;
};

/**
 * The checklist's title and where the apply stands, with Abort and Activate while it is open and
 * the way to the guild once it is live.
 */
function ChecklistHeader({
  apply,
  guildName,
  open,
  busy,
  onAbort,
  onActivate,
}: ChecklistHeaderProps) {
  const workLeft = workOpen(apply.checklist);
  return (
    <header className="flex flex-wrap items-end gap-3">
      <div className="flex min-w-60 flex-1 flex-col gap-1">
        <span className="type-label text-muted">Apply</span>
        <h1 className="type-h1">{guildName}</h1>
        <p className="text-sm text-fg-2">
          {!open
            ? apply.status === "ready"
              ? "Done: the guild is live and its routines run."
              : "Aborted: the guild this apply created was deleted."
            : workLeft
              ? "Connect the remaining logins, then activate."
              : "Everything required is done. Activate to start the routines."}
        </p>
      </div>
      {open ? (
        <>
          <Button variant="ghost" size="md" disabled={busy} onClick={onAbort}>
            <Icon icon={X} size={14} />
            Abort
          </Button>
          <Button size="md" disabled={busy || workLeft} onClick={onActivate}>
            <Icon icon={Play} size={14} />
            Activate
          </Button>
        </>
      ) : apply.status === "ready" ? (
        <Button asChild size="md">
          <Link to="/guilds/$guildId" params={{ guildId: apply.guild_id }}>
            Open the guild
          </Link>
        </Button>
      ) : null}
    </header>
  );
}

type ChecklistStepProps = {
  step: ApplyStep;
  connected: boolean;
  gap: ConnectorSetupGap | null;
  /** Why the step's last check or confirm failed; undefined when it has not. */
  problem: string | undefined;
  /** What the operator can do on the step while it is open. */
  children: ReactNode;
};

/** One step of the checklist: its mark, title, detail and status, its hint or problem, and its actions. */
function ChecklistStep({ step, connected, gap, problem, children }: ChecklistStepProps) {
  const closed = stepClosed(step);
  const hint = problem ?? stepHint(step, connected, gap?.text ?? null);
  return (
    <li
      className={cn(
        "flex flex-col gap-3 rounded-xl p-4",
        closed ? "bg-surface" : "bg-paper-hi inset-ring-[1.5px] inset-ring-line",
      )}
    >
      <div className="flex items-start gap-3">
        <StepMark step={step} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-md font-semibold">{step.title}</span>
          <span className="text-sm text-fg-2">{stepDetail(step)}</span>
        </div>
        <span className="shrink-0 text-xs text-muted">{stepStatus(step, connected)}</span>
      </div>
      {hint ? (
        <p className={cn("text-xs", problem ? "text-plum-t" : "text-muted")}>{hint}</p>
      ) : null}
      {children}
    </li>
  );
}

type StepActionsProps = {
  step: ApplyStep;
  /** The connector a connection step logs into, when the guild's access lists it. */
  server: McpServerAccess | null;
  connected: boolean;
  gap: ConnectorSetupGap | null;
  busy: boolean;
  connecting: boolean;
  /** True while a required step is open, which keeps the routines from being activated. */
  workLeft: boolean;
  guildId: string;
  onConnect: (server: McpServerAccess) => void;
  onCheck: () => void;
  onDone: () => void;
  onSkip: () => void;
  onActivate: () => void;
};

/**
 * What the operator can do on an open step: connect its connector, close it by a check, a
 * confirmation or activating the routines, open the guild page that adds its access, and skip it.
 */
function StepActions({
  step,
  server,
  connected,
  gap,
  busy,
  connecting,
  workLeft,
  guildId,
  onConnect,
  onCheck,
  onDone,
  onSkip,
  onActivate,
}: StepActionsProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {step.kind === "connection" && !connected && server ? (
        <ConnectStepButtons
          server={server}
          gap={gap}
          disabled={busy || connecting}
          onConnect={onConnect}
        />
      ) : null}
      <StepCloseButton
        step={step}
        connected={connected}
        busy={busy}
        workLeft={workLeft}
        onCheck={onCheck}
        onDone={onDone}
        onActivate={onActivate}
      />
      <GuildPageLink kind={step.kind} guildId={guildId} />
      {skippable(step) ? (
        <Button variant="ghost" size="sm" disabled={busy} onClick={onSkip}>
          Skip
        </Button>
      ) : null}
    </div>
  );
}

type ConnectStepButtonsProps = {
  server: McpServerAccess;
  gap: ConnectorSetupGap | null;
  disabled: boolean;
  onConnect: (server: McpServerAccess) => void;
};

/** Connecting a step's connector, and the way to set its platform key up when a platform admin must. */
function ConnectStepButtons({ server, gap, disabled, onConnect }: ConnectStepButtonsProps) {
  const { user } = useIdentity();
  const location = useLocation();
  return (
    <>
      <Button
        size="sm"
        disabled={disabled || gap !== null}
        {...(gap ? { title: gap.text } : {})}
        onClick={() => onConnect(server)}
      >
        <Icon icon={Link2} size={14} />
        Connect {server.name}
      </Button>
      {gap?.integration && user.platform_admin ? (
        <Button asChild variant="outline" size="sm">
          <Link to="/admin" search={setupSearch(gap.integration, location.href)}>
            Set up
          </Link>
        </Button>
      ) : null}
    </>
  );
}

type StepCloseButtonProps = {
  step: ApplyStep;
  connected: boolean;
  busy: boolean;
  workLeft: boolean;
  onCheck: () => void;
  onDone: () => void;
  onActivate: () => void;
};

/** How a step closes: a check apply verifies, activating the routines, or the operator's Done. */
function StepCloseButton({
  step,
  connected,
  busy,
  workLeft,
  onCheck,
  onDone,
  onActivate,
}: StepCloseButtonProps) {
  if (step.closure === "verified") {
    return (
      <Button
        variant={step.kind === "connection" && !connected ? "outline" : "primary"}
        size="sm"
        disabled={busy}
        onClick={onCheck}
      >
        Check
      </Button>
    );
  }
  if (step.kind === "activate") {
    return (
      <Button size="sm" disabled={busy || workLeft} onClick={onActivate}>
        Activate routines
      </Button>
    );
  }
  return (
    <Button size="sm" disabled={busy} onClick={onDone}>
      <Icon icon={Check} size={14} />
      Done
    </Button>
  );
}

/** A guild page where the access a step asks for is added. */
type GuildPage = {
  to: "/guilds/$guildId/tools" | "/guilds/$guildId/secrets" | "/guilds/$guildId/settings";
  label: string;
};

/** The guild page that adds each kind of step's access, for the kinds that add one. */
const guildPageOf: Partial<Record<ApplyStep["kind"], GuildPage>> = {
  connection: { to: "/guilds/$guildId/tools", label: "Guild tools" },
  secret: { to: "/guilds/$guildId/secrets", label: "Guild secrets" },
  repository: { to: "/guilds/$guildId/settings", label: "Guild settings" },
};

type GuildPageLinkProps = { kind: ApplyStep["kind"]; guildId: string };

/** The link to the guild page that adds a step's access; nothing for a step that adds none. */
function GuildPageLink({ kind, guildId }: GuildPageLinkProps) {
  const page = guildPageOf[kind];
  if (!page) return null;
  return (
    <Button asChild variant="ghost" size="sm">
      <Link to={page.to} params={{ guildId }}>
        <Icon icon={ExternalLink} size={14} />
        {page.label}
      </Link>
    </Button>
  );
}

type MilestoneProps = { title: string; detail: string };

function Milestone({ title, detail }: MilestoneProps) {
  return (
    <li className="flex items-start gap-3 rounded-xl bg-surface p-4">
      <Icon icon={CircleCheck} size={20} className="shrink-0 text-tide-t" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-md font-semibold">{title}</span>
        <span className="text-sm text-fg-2">{detail}</span>
      </div>
      <span className="shrink-0 text-xs text-muted">Done</span>
    </li>
  );
}

type StepMarkProps = { step: ApplyStep };

function StepMark({ step }: StepMarkProps) {
  if (step.status === "skipped") {
    return <Icon icon={CircleSlash} size={20} className="shrink-0 text-muted" />;
  }
  if (stepClosed(step))
    return <Icon icon={CircleCheck} size={20} className="shrink-0 text-tide-t" />;
  return <Icon icon={Circle} size={20} className="shrink-0 text-muted" />;
}
