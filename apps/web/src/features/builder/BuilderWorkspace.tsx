import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, Check, Rocket } from "lucide-react";
import { useState } from "react";
import {
  useBuilderAccess,
  useBuilderMessages,
  useBuilderReview,
  useBuilderSession,
  useBuilderValidation,
  useCapabilities,
  usePostBuilderMessage,
  usePublishBuilder,
} from "../../api/queries/builder";
import { useRecipePreview } from "../../api/queries/recipes";
import { useBuilderStream } from "../../api/streams";
import type { BuilderSession } from "../../api/types/builder";
import { useMediaQuery } from "../../app/media";
import {
  Button,
  Segmented,
  PageError,
  SkeletonRows,
  WorkspaceHeader,
  toast,
  cn,
  Icon,
} from "@guildsrun/ui";
import { Splitter, useSplitShare } from "../coach/Splitter";
import { PendingAccessBar } from "../recipes/plan/PendingAccessBar";
import {
  emptyPendingAccess,
  isRecipeApproved,
  pendingAccessEdits,
  planFromRecipe,
  recipeStatusLabel,
  toolKey,
  type PendingAccess,
} from "../recipes/plan/planModel";
import { PlanView } from "../recipes/plan/PlanView";
import { BuilderChat, openRequest } from "./BuilderChat";
import { accessCutMessage } from "./widgets";

const splitScreen = "(min-width: 64rem)";
const splitKey = "builder.split";

/**
 * One Builder session: the recipe blueprint as the coach writes it, beside the conversation that
 * designs it. The operator rewrites Tasks and cuts access in the blueprint, approves the draft,
 * and deploys it as a new guild.
 */
export function BuilderWorkspace() {
  const { sessionId } = useParams({ from: "/builder/$sessionId" });
  const session = useBuilderSession(sessionId);

  if (session.isError) {
    return (
      <div className="grid flex-1 place-items-center p-6">
        <PageError title="Couldn't open this session" description={session.error.message} />
      </div>
    );
  }
  if (!session.data) {
    return (
      <div className="p-8">
        <SkeletonRows rows={6} label="Loading the session" />
      </div>
    );
  }
  return <Workspace key={sessionId} session={session.data} />;
}

function Workspace({ session }: { session: BuilderSession }) {
  const navigate = useNavigate();
  const messages = useBuilderMessages(session.id, session.generation_state !== "idle");
  const live = useBuilderStream(session.id, (detail) =>
    toast({ kind: "error", title: "The coach stopped", description: detail }),
  );
  const recipe = session.recipe;
  const capabilities = useCapabilities();
  const preview = useRecipePreview(recipe.id, recipe.body_version);
  const validation = useBuilderValidation(session.id, recipe.body_version, preview.isError);
  const publish = usePublishBuilder(session.id);
  const review = useBuilderReview(session.id);
  const access = useBuilderAccess(session.id);
  const post = usePostBuilderMessage(session.id);
  const [pending, setPending] = useState<PendingAccess>(emptyPendingAccess);
  const split = useMediaQuery(splitScreen);
  const [pane, setPane] = useState<"blueprint" | "coach">("coach");
  const [share, setShare] = useSplitShare(splitKey, 0.58);

  const approved = isRecipeApproved(recipe.status);
  const generating = session.generation_state !== "idle";
  const waiting = !generating && openRequest(messages.data ?? []);
  const findings = preview.data?.findings ?? validation.data?.findings;
  const plan = planFromRecipe(recipe.body, preview.data ? { creates: preview.data.creates } : {});
  const title = recipe.body.meta.name || "Untitled guild";

  const approve = () =>
    publish.mutateAsync().then(
      () => toast({ kind: "success", title: `Approved ${title}` }),
      (error: Error) => {
        toast({ kind: "error", title: "Couldn't approve the draft", description: error.message });
        throw error;
      },
    );

  const deploy = () => {
    const ready = approved ? Promise.resolve() : approve();
    void ready.then(
      () => navigate({ to: "/recipes/$recipeId/apply", params: { recipeId: recipe.id } }),
      () => undefined,
    );
  };

  const saveAccess = () => {
    const edits = pendingAccessEdits(pending);
    access.mutate(edits, {
      onSuccess: () => {
        setPending(emptyPendingAccess());
        const message = accessCutMessage(edits);
        if (message) post.mutate(message);
      },
      onError: (error) =>
        toast({ kind: "error", title: "Couldn't save the access", description: error.message }),
    });
  };

  const blueprint = (
    <section
      aria-label="Blueprint"
      className={cn("flex min-h-0 min-w-0 flex-col", split ? "flex-none" : "flex-1")}
      style={split ? { width: `${share * 100}%` } : undefined}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        {preview.isPending && !findings ? (
          <SkeletonRows rows={6} label="Reading the draft" />
        ) : (
          <PlanView
            plan={plan}
            findings={findings}
            catalog={capabilities.data?.catalog}
            onEditTask={(role, text) =>
              review
                .mutateAsync({ path: `roles.${role}.task`, action: "edit", value: text })
                .catch((error: Error) => {
                  toast({
                    kind: "error",
                    title: "Couldn't save the Task",
                    description: error.message,
                  });
                  throw error;
                })
            }
            access={{
              pending,
              disabled: access.isPending,
              onToolChange: (server, role, tool, enabled) =>
                setPending((current) => {
                  const tools = new Map(current.tools);
                  tools.set(toolKey(server, role, tool), enabled);
                  return { ...current, tools };
                }),
              onRemoveConnection: (server, removed) =>
                setPending((current) => {
                  const next = new Set(current.removed);
                  if (removed) next.add(server);
                  else next.delete(server);
                  return { ...current, removed: next };
                }),
            }}
          />
        )}
        <PendingAccessBar
          pending={pending}
          saving={access.isPending}
          onSave={saveAccess}
          onDiscard={() => setPending(emptyPendingAccess())}
          saveLabel="Save and tell the coach"
        />
      </div>
    </section>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <WorkspaceHeader
        eyebrow="Builder"
        title={title}
        meta={`body v${recipe.body_version}`}
        status={{
          label: `${recipeStatusLabel(recipe.status)} · ${
            generating ? "coach designing…" : waiting ? "waiting for you" : "coach ready"
          }`,
          live: generating,
          ...(approved
            ? {
                hint: "Approved. Keep talking to the coach to revise it; that returns it to draft.",
              }
            : {}),
        }}
        actions={
          <>
            <Button asChild variant="on-panel" size="sm">
              <Link to="/builder">
                <Icon icon={ArrowLeft} size={14} />
                Builder
              </Link>
            </Button>
            {approved ? null : (
              <Button
                variant="on-panel"
                size="sm"
                disabled={publish.isPending}
                title="Approve the draft so it can be applied"
                onClick={() => void approve().catch(() => undefined)}
              >
                <Icon icon={Check} size={14} />
                Approve
              </Button>
            )}
            <Button variant="accent" size="sm" disabled={publish.isPending} onClick={deploy}>
              <Icon icon={Rocket} size={14} />
              Deploy guild
            </Button>
          </>
        }
      />

      {!split ? (
        <div className="border-b border-line px-4 py-2">
          <Segmented
            size="sm"
            label="Show"
            value={pane}
            onValueChange={setPane}
            options={[
              { value: "coach", label: "Coach" },
              { value: "blueprint", label: "Blueprint" },
            ]}
          />
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {split || pane === "blueprint" ? blueprint : null}
        {split ? (
          <Splitter
            storageKey={splitKey}
            share={share}
            onShareChange={setShare}
            label="Resize the blueprint"
          />
        ) : null}
        {split || pane === "coach" ? (
          <section aria-label="Coach" className="flex min-h-0 min-w-0 flex-1 flex-col">
            <BuilderChat session={session} messages={messages.data} live={live} />
          </section>
        ) : null}
      </div>
    </div>
  );
}
