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
import { useState } from "react";
import {
  useAbortApply,
  useActivateApply,
  useApply,
  useConfirmStep,
  useVerifyStep,
} from "../../api/queries/recipes";
import { useAccess } from "../../api/queries/access";
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
import { connectorSetupGap, setupSearch } from "../instance/instance";
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

function Checklist({ apply }: { apply: ApplyRow }) {
  const navigate = useNavigate();
  const owner = { scope: "guild" as const, id: apply.guild_id };
  const access = useAccess(owner);
  const instance = useInstance();
  const { user } = useIdentity();
  const location = useLocation();
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
        <header className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-60 flex-1 flex-col gap-1">
            <span className="type-label text-muted">Apply</span>
            <h1 className="type-h1">{guildName}</h1>
            <p className="text-sm text-fg-2">
              {!open
                ? apply.status === "ready"
                  ? "Done: the guild is live and its routines run."
                  : "Aborted: the guild this apply created was deleted."
                : workOpen(apply.checklist)
                  ? "Connect the remaining logins, then activate."
                  : "Everything required is done. Activate to start the routines."}
            </p>
          </div>
          {open ? (
            <>
              <Button variant="ghost" size="md" disabled={busy} onClick={() => setAborting(true)}>
                <Icon icon={X} size={14} />
                Abort
              </Button>
              <Button size="md" disabled={busy || workOpen(apply.checklist)} onClick={start}>
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
            const { server, connected: isConnected } = stepConnector(step, servers);
            const gap = server ? connectorSetupGap(server, instance.data) : null;
            const closed = stepClosed(step);
            const hint = problems[step.id] ?? stepHint(step, isConnected, gap?.text ?? null);
            return (
              <li
                key={step.id}
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
                  <span className="shrink-0 text-xs text-muted">
                    {stepStatus(step, isConnected)}
                  </span>
                </div>
                {hint ? (
                  <p className={cn("text-xs", problems[step.id] ? "text-plum-t" : "text-muted")}>
                    {hint}
                  </p>
                ) : null}
                {open && !closed ? (
                  <div className="flex flex-wrap gap-2">
                    {step.kind === "connection" && !isConnected && server ? (
                      <>
                        <Button
                          size="sm"
                          disabled={busy || connect.busy || gap !== null}
                          {...(gap ? { title: gap.text } : {})}
                          onClick={() => connect.start(server)}
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
                    ) : null}
                    {step.closure === "verified" ? (
                      <Button
                        variant={step.kind === "connection" && !isConnected ? "outline" : "primary"}
                        size="sm"
                        disabled={busy}
                        onClick={() => check(step.id)}
                      >
                        Check
                      </Button>
                    ) : step.kind === "activate" ? (
                      <Button
                        size="sm"
                        disabled={busy || workOpen(apply.checklist)}
                        onClick={start}
                      >
                        Activate routines
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          confirm.mutate(
                            { stepId: step.id },
                            { onError: (error) => problem(step.id, error.message) },
                          )
                        }
                      >
                        <Icon icon={Check} size={14} />
                        Done
                      </Button>
                    )}
                    {step.kind === "connection" ||
                    step.kind === "secret" ||
                    step.kind === "repository" ? (
                      <Button asChild variant="ghost" size="sm">
                        <Link
                          to={
                            step.kind === "connection"
                              ? "/guilds/$guildId/tools"
                              : step.kind === "secret"
                                ? "/guilds/$guildId/secrets"
                                : "/guilds/$guildId/settings"
                          }
                          params={{ guildId: apply.guild_id }}
                        >
                          <Icon icon={ExternalLink} size={14} />
                          {step.kind === "connection"
                            ? "Guild tools"
                            : step.kind === "secret"
                              ? "Guild secrets"
                              : "Guild settings"}
                        </Link>
                      </Button>
                    ) : null}
                    {skippable(step) ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => setSkipping(step)}
                      >
                        Skip
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
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

function Milestone({ title, detail }: { title: string; detail: string }) {
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

function StepMark({ step }: { step: ApplyStep }) {
  if (step.status === "skipped") {
    return <Icon icon={CircleSlash} size={20} className="shrink-0 text-muted" />;
  }
  if (stepClosed(step))
    return <Icon icon={CircleCheck} size={20} className="shrink-0 text-tide-t" />;
  return <Icon icon={Circle} size={20} className="shrink-0 text-muted" />;
}
