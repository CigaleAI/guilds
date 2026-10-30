import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, Check, Download, Rocket } from "lucide-react";
import { useState } from "react";
import {
  exportRecipe,
  usePublishRecipe,
  useRecipe,
  useRecipeAccess,
  useRecipePreview,
  useRecipeValidation,
  useReviewRecipe,
} from "../../api/queries/recipes";
import { useCapabilities } from "../../api/queries/builder";
import type { RecipeRow } from "../../api/types";
import { Button, PageError, SkeletonRows, toast, Icon, Tag } from "@guildsrun/ui";
import { PendingAccessBar } from "./plan/PendingAccessBar";
import {
  emptyPendingAccess,
  isRecipeApproved,
  pendingAccessEdits,
  planFromRecipe,
  recipeStatusLabel,
  toolKey,
  type PendingAccess,
} from "./plan/planModel";
import { PlanView } from "./plan/PlanView";

const sourceLabel: Record<RecipeRow["source_kind"], string> = {
  builder: "from the Builder",
  guild: "from a guild",
  file: "imported",
};

/** Saves the recipe as a JSON file named after it. */
function download(name: string, body: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name || "recipe"}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * One recipe: everything it creates and needs, with what applying it now would reuse or collide
 * with. The operator rewrites Tasks, switches connector tools per agent or drops connectors,
 * approves it, exports it once approved, and applies it to a new guild.
 */
export function RecipePage() {
  const { recipeId } = useParams({ from: "/recipes/$recipeId" });
  const navigate = useNavigate();
  const recipe = useRecipe(recipeId);
  const capabilities = useCapabilities();
  const preview = useRecipePreview(recipeId, recipe.data?.body_version);
  const validation = useRecipeValidation(
    recipeId,
    preview.isError ? recipe.data?.body_version : undefined,
  );
  const publish = usePublishRecipe(recipeId);
  const review = useReviewRecipe(recipeId);
  const access = useRecipeAccess(recipeId);
  const [pending, setPending] = useState<PendingAccess>(emptyPendingAccess);
  const [exporting, setExporting] = useState(false);

  if (recipe.isError) {
    return (
      <div className="grid flex-1 place-items-center p-6">
        <PageError title="Couldn't open this recipe" description={recipe.error.message} />
      </div>
    );
  }
  if (!recipe.data) {
    return (
      <div className="p-8">
        <SkeletonRows rows={8} label="Loading the recipe" />
      </div>
    );
  }

  const row = recipe.data;
  const approved = isRecipeApproved(row.status);
  const findings = preview.data?.findings ?? validation.data?.findings;
  const plan = planFromRecipe(row.body, preview.data ? { creates: preview.data.creates } : {});
  const busy = publish.isPending || access.isPending || review.isPending;

  const approve = () =>
    publish.mutateAsync().then(
      () => toast({ kind: "success", title: `Approved ${row.name}` }),
      (error: Error) => {
        toast({ kind: "error", title: "Couldn't approve the recipe", description: error.message });
        throw error;
      },
    );

  const apply = () => {
    const ready = approved ? Promise.resolve() : approve();
    void ready.then(
      () => navigate({ to: "/recipes/$recipeId/apply", params: { recipeId } }),
      () => undefined,
    );
  };

  const saveAccess = () =>
    access.mutate(pendingAccessEdits(pending), {
      onSuccess: () => {
        setPending(emptyPendingAccess());
        toast({ kind: "success", title: "Access saved" });
      },
      onError: (error) =>
        toast({ kind: "error", title: "Couldn't save the access", description: error.message }),
    });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8 md:px-10">
      <div className="mx-auto flex max-w-240 flex-col gap-6">
        <header className="flex flex-col gap-3">
          <Button asChild variant="ghost" size="sm" className="self-start">
            <Link to="/recipes">
              <Icon icon={ArrowLeft} size={14} />
              Recipes
            </Link>
          </Button>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-60 flex-1 flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <Tag tone={approved ? "tide" : "ochre"} font="sans">
                  {recipeStatusLabel(row.status)}
                </Tag>
                <Tag tone="well" font="sans">
                  {sourceLabel[row.source_kind]}
                </Tag>
                <span className="font-mono text-xs text-muted">body v{row.body_version}</span>
              </div>
              <h1 className="type-h1">{row.name}</h1>
              {row.description && row.description !== row.body.guild.about ? (
                <p className="text-sm text-fg-2">{row.description}</p>
              ) : null}
            </div>
            {!approved ? (
              <Button variant="outline" size="md" disabled={busy} onClick={() => void approve()}>
                <Icon icon={Check} size={14} />
                Approve
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="md"
              disabled={!approved || exporting}
              title={approved ? "Save the recipe as a file" : "Approve the recipe before export"}
              onClick={() => {
                setExporting(true);
                exportRecipe(recipeId)
                  .then(
                    (body) => download(row.name, body),
                    (error: Error) =>
                      toast({
                        kind: "error",
                        title: "Couldn't export the recipe",
                        description: error.message,
                      }),
                  )
                  .finally(() => setExporting(false));
              }}
            >
              <Icon icon={Download} size={14} />
              Export
            </Button>
            <Button size="md" disabled={busy} onClick={apply}>
              <Icon icon={Rocket} size={14} />
              {approved ? "Apply" : "Approve and apply"}
            </Button>
          </div>
          {!approved ? (
            <p className="text-xs text-muted">
              A draft can be edited freely; approving checks it against the organisation. Any later
              edit returns it to draft.
            </p>
          ) : null}
        </header>

        {preview.isPending ? (
          <SkeletonRows rows={6} label="Checking the recipe" />
        ) : (
          <PlanView
            plan={plan}
            findings={findings}
            catalog={capabilities.data?.catalog}
            hideName
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
              disabled: busy,
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
      </div>
      <PendingAccessBar
        pending={pending}
        saving={access.isPending}
        onSave={saveAccess}
        onDiscard={() => setPending(emptyPendingAccess())}
      />
    </div>
  );
}
