import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../client";
import { guildKeys, guildPath } from "./guilds";
import { refreshMachines } from "./agents";
import type {
  RecipeRow,
  RegistryRecipes,
  AccessEdit,
  AccessEditResult,
  ApplyChoices,
  ApplyPreview,
  ApplyRow,
  GuildApplyState,
  RecipeDocument,
  RecipeValidation,
  RegistryRecipeRef,
  RecipeInput,
  RecipeFieldReview,
  ApplyStepConfirmation,
} from "../types";

/**
 * Query keys of recipes and their applies. Identity is fixed for the page's life, so keys carry no
 * user or org.
 */
export const recipeKeys = {
  recipes: ["recipes"] as const,
  recipeRegistry: ["registry", "recipes"] as const,
  recipe: (id: string) => ["recipes", id] as const,
  recipeValidation: (id: string, version: number) =>
    ["recipes", id, "validation", version] as const,
  recipePreview: (id: string, version: number) => ["recipes", id, "preview", version] as const,
  apply: (id: string) => ["applies", id] as const,
  guildApply: (guildId: string) => ["guilds", guildId, "apply"] as const,
};

/** The organisation's recipes, newest first. */
export function useRecipes() {
  return useQuery({ queryKey: recipeKeys.recipes, queryFn: () => api<RecipeRow[]>("/api/recipes") });
}

/** Imports a recipe file as a draft; secrets and tokens in it are refused. */
export function useImportRecipe() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (recipe: unknown) =>
      api<RecipeRow>("/api/recipes/import", { method: "POST", body: { recipe } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: recipeKeys.recipes }),
  });
}

/** The recipes the registry offers. */
export function useRecipeRegistry() {
  return useQuery({
    queryKey: recipeKeys.recipeRegistry,
    queryFn: () => api<RegistryRecipes>("/api/recipes/registry"),
    retry: false,
  });
}

/** Imports a registry recipe as a draft: its newest version unless `version` names one. */
export function useImportRegistryRecipe() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: RegistryRecipeRef) =>
      api<RecipeRow>("/api/recipes/registry/import", { method: "POST", body: input }),
    onSuccess: () => void client.invalidateQueries({ queryKey: recipeKeys.recipes }),
  });
}

/** Captures a live guild as a draft recipe: its roles, prompts, tools, routines and scripts. */
export function useCaptureRecipe() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (guildId: string) =>
      api<RecipeRow>(`${guildPath(guildId)}/recipes`, { method: "POST", body: {} }),
    onSuccess: () => void client.invalidateQueries({ queryKey: recipeKeys.recipes }),
  });
}

const recipePath = (id: string) => `/api/recipes/${encodeURIComponent(id)}`;

export function useRecipe(id: string) {
  return useQuery({ queryKey: recipeKeys.recipe(id), queryFn: () => api<RecipeRow>(recipePath(id)) });
}

/** The recipe's findings against the organisation as it is now, for one version of its body. */
export function useRecipeValidation(id: string, version: number | undefined) {
  return useQuery({
    queryKey: recipeKeys.recipeValidation(id, version ?? -1),
    queryFn: () =>
      api<RecipeValidation>(`${recipePath(id)}/validate`, { method: "POST", body: {} }),
    enabled: version !== undefined,
  });
}

function useRecipeWrite<T>(id: string, write: (input: T) => Promise<RecipeRow>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: write,
    onSuccess: (row) => {
      client.setQueryData(recipeKeys.recipe(id), row);
      void client.invalidateQueries({ queryKey: recipeKeys.recipes });
    },
  });
}

/** Approves the recipe once nothing blocks it; any later edit returns it to draft. */
export function usePublishRecipe(id: string) {
  return useRecipeWrite(id, () => api<RecipeRow>(`${recipePath(id)}/publish`, { method: "POST" }));
}

/** Renames or redescribes the recipe, refused (409) over a newer body. */
export function useUpdateRecipe(id: string) {
  return useRecipeWrite(
    id,
    (input: RecipeInput) =>
      api<RecipeRow>(recipePath(id), { method: "PUT", body: input }),
  );
}

/** Switches tools per role and removes connectors, returning the recipe with every cut. */
export function useRecipeAccess(id: string) {
  return useRecipeWrite(id, (edits: AccessEdit[]) =>
    api<AccessEditResult>(`${recipePath(id)}/access`, { method: "POST", body: { edits } }),
  );
}

/** Confirms a field the Builder wrote, or replaces it with the operator's text. */
export function useReviewRecipe(id: string) {
  return useRecipeWrite(id, (input: RecipeFieldReview) =>
    api<RecipeRow>(`${recipePath(id)}/review`, { method: "POST", body: input }),
  );
}

export function useDeleteRecipe() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(recipePath(id), { method: "DELETE" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: recipeKeys.recipes }),
  });
}

/** The approved recipe as a portable file; refused (409) while it is a draft. */
export function exportRecipe(id: string) {
  return api<RecipeDocument>(`${recipePath(id)}/export`);
}

/**
 * What applying the recipe would create now, with its findings: live logins to reuse, name
 * collisions, tables that already exist, and the machine the roles go on (the one named, or the
 * organisation's only one). Nothing is written.
 */
export function useRecipePreview(id: string, version: number | undefined, machineId?: string) {
  return useQuery({
    queryKey: [...recipeKeys.recipePreview(id, version ?? -1), machineId ?? ""],
    queryFn: () =>
      api<ApplyPreview>(`${recipePath(id)}/preview`, {
        method: "POST",
        body: {
          connections: [],
          names: [],
          models: [],
          ...(machineId ? { machine_id: machineId } : {}),
        },
      }),
    enabled: version !== undefined,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** Creates the guild from an approved recipe, its routines paused, and returns its checklist. */
export function useApplyRecipe(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (choices: ApplyChoices) =>
      api<ApplyRow>(`${recipePath(id)}/apply`, { method: "POST", body: choices }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: guildKeys.guilds });
      refreshMachines(client);
    },
  });
}

const applyPath = (id: string) => `/api/applies/${encodeURIComponent(id)}`;

export function useApply(id: string) {
  return useQuery({ queryKey: recipeKeys.apply(id), queryFn: () => api<ApplyRow>(applyPath(id)) });
}

function fetchGuildApply(guildId: string) {
  return api<GuildApplyState>(`${guildPath(guildId)}/apply`);
}

/** The guild's apply while its checklist is open; null once it is done or aborted. */
export function useGuildApply(guildId: string) {
  return useQuery({
    queryKey: recipeKeys.guildApply(guildId),
    queryFn: () => fetchGuildApply(guildId),
    select: (body) => body.apply,
  });
}

/** Agents a ready recipe apply still asks to log in by hand. Empty while the checklist is open. */
export function useGuildBrowserLogins(guildId: string) {
  return useQuery({
    queryKey: recipeKeys.guildApply(guildId),
    queryFn: () => fetchGuildApply(guildId),
    select: (body) => body.browser_logins ?? [],
  });
}

function useApplyWrite<T>(id: string, write: (input: T) => Promise<ApplyRow>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: write,
    onSuccess: (row) => {
      client.setQueryData(recipeKeys.apply(id), row);
      void client.invalidateQueries({ queryKey: ["guilds"] });
    },
  });
}

/** Checks a login or secret step against the guild as it is now. */
export function useVerifyStep(id: string) {
  return useApplyWrite(id, (stepId: string) =>
    api<ApplyRow>(`${applyPath(id)}/steps/${encodeURIComponent(stepId)}/verify`, {
      method: "POST",
    }),
  );
}

/** Confirms a step done by hand, or skips a login or secret the guild will do without. */
export function useConfirmStep(id: string) {
  return useApplyWrite(id, ({ stepId, skip }: ApplyStepConfirmation) =>
    api<ApplyRow>(`${applyPath(id)}/steps/${encodeURIComponent(stepId)}/confirm`, {
      method: "POST",
      body: skip ? { skip: true } : {},
    }),
  );
}

/** Starts the paused routines once every required step is closed. */
export function useActivateApply(id: string) {
  return useApplyWrite(id, () => api<ApplyRow>(`${applyPath(id)}/activate`, { method: "POST" }));
}

/** Stops the apply, deleting the guild it created with its agents and tables. */
export function useAbortApply(id: string) {
  return useApplyWrite(id, () => api<ApplyRow>(`${applyPath(id)}/abort`, { method: "POST" }));
}
