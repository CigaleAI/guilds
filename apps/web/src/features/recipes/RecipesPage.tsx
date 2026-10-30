import { Link, useNavigate } from "@tanstack/react-router";
import { BookOpen, Download, Package, Sparkles, Upload } from "lucide-react";
import { useRef, useState } from "react";
import {
  useCaptureRecipe,
  useImportRecipe,
  useImportRegistryRecipe,
  useRecipeRegistry,
  useRecipes,
} from "../../api/queries/recipes";
import { useGuilds } from "../../api/queries/guilds";
import type { RecipeRow } from "../../api/types/recipes";
import { relativeTime } from "../../app/format";
import {
  Button,
  Banner,
  EmptyState,
  SkeletonRows,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  toast,
  Icon,
  Row,
  Tag,
} from "@guildsrun/ui";
import { readRecipeFile } from "./recipeFile";

const sourceLabel: Record<RecipeRow["source_kind"], string> = {
  builder: "from the Builder",
  guild: "from a guild",
  file: "imported",
};

/** Opens a recipe's page. */
function useOpenRecipe() {
  const navigate = useNavigate();
  return (id: string) => void navigate({ to: "/recipes/$recipeId", params: { recipeId: id } });
}

/**
 * The organisation's recipes: guild blueprints from the Builder, captured from a live guild, or
 * imported from a file or the registry. An approved recipe deploys as a new guild.
 */
export function RecipesPage() {
  const openRecipe = useOpenRecipe();
  const recipes = useRecipes();
  const importRecipe = useImportRecipe();
  const file = useRef<HTMLInputElement>(null);
  const [capturing, setCapturing] = useState(false);
  const [browsing, setBrowsing] = useState(false);

  const onFile = async (picked: File | undefined) => {
    if (!picked) return;
    const read = await readRecipeFile(picked);
    if (file.current) file.current.value = "";
    if (read.kind === "not-json") {
      toast({ kind: "error", title: "That file isn't JSON" });
      return;
    }
    importRecipe.mutate(read.recipe, {
      onSuccess: (row) => {
        toast({ kind: "success", title: `Imported ${row.name}` });
        openRecipe(row.id);
      },
      onError: (error) =>
        toast({ kind: "error", title: "Couldn't import the recipe", description: error.message }),
    });
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8 md:px-10">
      <div className="mx-auto flex max-w-240 flex-col gap-5">
        <header className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-60 flex-1 flex-col gap-1">
            <h1 className="type-h1">Recipes</h1>
            <p className="text-sm text-fg-2">
              Blueprints for whole guilds: roles with their prompts, tools, routines and scripts,
              and the tables and notes they share. Approve one to deploy it as a new guild.
            </p>
          </div>
          <Button variant="outline" size="md" onClick={() => setCapturing(true)}>
            <Icon icon={Download} size={14} />
            From a guild
          </Button>
          <Button
            variant="outline"
            size="md"
            onClick={() => file.current?.click()}
            disabled={importRecipe.isPending}
          >
            <Icon icon={Upload} size={14} />
            Import JSON
          </Button>
          <Button variant="outline" size="md" onClick={() => setBrowsing(true)}>
            <Icon icon={Package} size={14} />
            From the registry
          </Button>
          <Button asChild size="md">
            <Link to="/builder">
              <Icon icon={Sparkles} size={14} />
              Open the Builder
            </Link>
          </Button>
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => void onFile(event.currentTarget.files?.[0])}
          />
        </header>

        {recipes.isPending ? (
          <SkeletonRows rows={4} label="Loading recipes" />
        ) : recipes.isError ? (
          <Banner tone="error" title="Couldn't load the recipes" meta={recipes.error.message} />
        ) : recipes.data.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            title="No recipes yet"
            description="Capture a guild you like, import a recipe file, or describe one to the Builder."
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {recipes.data.map((recipe) => (
              <Link
                key={recipe.id}
                to="/recipes/$recipeId"
                params={{ recipeId: recipe.id }}
                className="flex cursor-pointer flex-col gap-2 rounded-xl bg-surface p-4 text-left transition-colors hover:bg-paper-hi"
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-md font-medium">
                    {recipe.name}
                  </span>
                  <Tag tone={recipe.status === "ready" ? "tide" : "ochre"} font="sans">
                    {recipe.status === "ready" ? "approved" : "draft"}
                  </Tag>
                </div>
                <p className="line-clamp-2 text-sm text-fg-2">
                  {recipe.description || "No description."}
                </p>
                <span className="text-xs text-muted">
                  {sourceLabel[recipe.source_kind]} · v{recipe.body_version} · updated{" "}
                  {relativeTime(recipe.updated_at)}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
      <CaptureDialog open={capturing} onOpenChange={setCapturing} />
      <RegistryDialog open={browsing} onOpenChange={setBrowsing} />
    </div>
  );
}

type CaptureDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function CaptureDialog({ open, onOpenChange }: CaptureDialogProps) {
  const guilds = useGuilds();
  const capture = useCaptureRecipe();
  const openRecipe = useOpenRecipe();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader
          title="Capture a guild"
          description="Its roles, prompts, tools, routines and scripts become a draft recipe; secrets and logins stay behind."
        />
        <DialogBody className="gap-1">
          {(guilds.data ?? []).map((guild) => (
            <Row
              key={guild.id}
              asChild
              interactive
              title={guild.name}
              meta={guild.about || undefined}
            >
              <button
                type="button"
                disabled={capture.isPending}
                onClick={() =>
                  capture.mutate(guild.id, {
                    onSuccess: (row) => {
                      toast({ kind: "success", title: `Captured ${guild.name}` });
                      onOpenChange(false);
                      openRecipe(row.id);
                    },
                    onError: (error) =>
                      toast({
                        kind: "error",
                        title: "Couldn't capture the guild",
                        description: error.message,
                      }),
                  })
                }
              />
            </Row>
          ))}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

type RegistryDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function RegistryDialog({ open, onOpenChange }: RegistryDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader
          title="Import from the registry"
          description="Recipes the registry publishes. One imports as a draft to review and approve."
        />
        {open ? <RegistryRecipes onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

type RegistryRecipesProps = { onDone: () => void };

function RegistryRecipes({ onDone }: RegistryRecipesProps) {
  const registry = useRecipeRegistry();
  const importRecipe = useImportRegistryRecipe();
  const openRecipe = useOpenRecipe();
  return (
    <DialogBody className="gap-1">
      {registry.isPending ? (
        <SkeletonRows rows={4} label="Loading the registry" />
      ) : registry.isError ? (
        <Banner tone="error" title="Couldn't read the registry">
          {registry.error.message}
        </Banner>
      ) : registry.data.offline ? (
        <Banner tone="info" title="The box is offline">
          REGISTRY_URL is set empty, so nothing imports from the registry.
        </Banner>
      ) : registry.data.recipes.length === 0 ? (
        <p className="text-sm text-muted">The registry offers no recipes.</p>
      ) : (
        registry.data.recipes.map((recipe) => (
          <Row
            key={recipe.name}
            asChild
            interactive
            title={recipe.display_name || recipe.name}
            meta={[`${recipe.name} v${recipe.version}`, recipe.publisher, recipe.description]
              .filter(Boolean)
              .join(" · ")}
            trail={
              recipe.verified ? undefined : (
                <Tag tone="ochre" font="sans">
                  unverified
                </Tag>
              )
            }
          >
            <button
              type="button"
              disabled={importRecipe.isPending}
              onClick={() =>
                importRecipe.mutate(
                  { name: recipe.name },
                  {
                    onSuccess: (row) => {
                      toast({ kind: "success", title: `Imported ${row.name}` });
                      onDone();
                      openRecipe(row.id);
                    },
                    onError: (error) =>
                      toast({
                        kind: "error",
                        title: "Couldn't import the recipe",
                        description: error.message,
                      }),
                  },
                )
              }
            />
          </Row>
        ))
      )}
    </DialogBody>
  );
}
