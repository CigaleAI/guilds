import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../client";
import { generatingPollMs } from "./runs";
import { recipeKeys } from "./recipes";
import type { StudioMessage } from "../types/studio";
import type {
  RecipeRow,
  AccessEdit,
  AccessEditResult,
  RecipeValidation,
  RecipeFieldReview,
} from "../types/recipes";
import type {
  BuilderCapabilities,
  BuilderSession,
  BuilderSessionSummary,
  NewBuilderSession,
} from "../types/builder";

/**
 * Query keys of the Builder. Identity is fixed for the page's life, so keys carry no user or org.
 */
export const builderKeys = {
  capabilities: ["capabilities"] as const,
  builderSessions: ["builder", "sessions"] as const,
  builder: (id: string) => ["builder", id] as const,
  builderMessages: (id: string) => ["builder", id, "messages"] as const,
  builderValidation: (id: string, version: number) =>
    ["builder", id, "validation", version] as const,
};

/** The connector catalog, models and plan room the recipe pages and the Builder read. */
export function useCapabilities() {
  return useQuery({
    queryKey: builderKeys.capabilities,
    queryFn: () => api<BuilderCapabilities>("/api/builder/capabilities"),
    staleTime: 60_000,
  });
}

const builderPath = (id: string) => `/api/builder/sessions/${encodeURIComponent(id)}`;

/** The operator's own Builder sessions, most recently active first. */
export function useBuilderSessions() {
  return useQuery({
    queryKey: builderKeys.builderSessions,
    queryFn: () => api<BuilderSessionSummary[]>("/api/builder/sessions"),
  });
}

/**
 * Starts a Builder session on an empty draft recipe and sends the operator's description as its
 * first message. The session exists even when that message fails, so the error comes back with it.
 */
export function useStartBuilder() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ model, brief }: NewBuilderSession) => {
      const session = await api<BuilderSession>("/api/builder/sessions", {
        method: "POST",
        body: { model },
      });
      try {
        await api(`${builderPath(session.id)}/messages`, {
          method: "POST",
          body: { content: brief },
        });
        return { session, error: null };
      } catch (error) {
        return { session, error: error instanceof Error ? error : new Error(String(error)) };
      }
    },
    onSuccess: () => void client.invalidateQueries({ queryKey: builderKeys.builderSessions }),
  });
}

/** While the coach works, the session and its conversation are re-read every few seconds, in case the stream falls silent. */
export function useBuilderSession(id: string) {
  return useQuery({
    queryKey: builderKeys.builder(id),
    queryFn: () => api<BuilderSession>(builderPath(id)),
    refetchInterval: (query) =>
      query.state.data && query.state.data.generation_state !== "idle" ? generatingPollMs : false,
  });
}

export function useBuilderMessages(id: string, generating: boolean) {
  return useQuery({
    queryKey: builderKeys.builderMessages(id),
    queryFn: () => api<StudioMessage[]>(`${builderPath(id)}/messages`),
    refetchInterval: generating ? generatingPollMs : false,
  });
}

function useBuilderRefresh(id: string) {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: builderKeys.builder(id) });
    void client.invalidateQueries({ queryKey: recipeKeys.recipes });
  };
}

export function usePostBuilderMessage(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (content: string) =>
      api<BuilderSession>(`${builderPath(id)}/messages`, { method: "POST", body: { content } }),
    onMutate: async () => {
      await client.cancelQueries({ queryKey: builderKeys.builder(id) });
      const previous = client.getQueryData<BuilderSession>(builderKeys.builder(id));
      if (previous) {
        client.setQueryData(builderKeys.builder(id), { ...previous, generation_state: "generating" });
      }
      return { previous };
    },
    onError: (_error, _content, context) => {
      if (context?.previous) client.setQueryData(builderKeys.builder(id), context.previous);
    },
    onSuccess: (session) => {
      client.setQueryData(builderKeys.builder(id), session);
      void client.invalidateQueries({ queryKey: builderKeys.builderMessages(id) });
    },
  });
}

export function useCancelBuilder(id: string) {
  const refresh = useBuilderRefresh(id);
  return useMutation({
    mutationFn: () => api(`${builderPath(id)}/cancel`, { method: "POST" }),
    onSettled: refresh,
  });
}

/** The draft's findings, for the version of its body the session holds. */
export function useBuilderValidation(id: string, version: number | undefined, enabled: boolean) {
  return useQuery({
    queryKey: builderKeys.builderValidation(id, version ?? -1),
    queryFn: () =>
      api<RecipeValidation>(`${builderPath(id)}/validate`, { method: "POST", body: {} }),
    enabled: enabled && version !== undefined,
  });
}

/** Confirms a field the coach wrote, or replaces it with the operator's text. */
export function useBuilderReview(id: string) {
  const refresh = useBuilderRefresh(id);
  return useMutation({
    mutationFn: (input: RecipeFieldReview) =>
      api<RecipeRow>(`${builderPath(id)}/review`, { method: "POST", body: input }),
    onSuccess: refresh,
  });
}

/** Switches connector tools per role and removes connectors in the draft. */
export function useBuilderAccess(id: string) {
  const refresh = useBuilderRefresh(id);
  return useMutation({
    mutationFn: (edits: AccessEdit[]) =>
      api<AccessEditResult>(`${builderPath(id)}/access`, { method: "POST", body: { edits } }),
    onSuccess: refresh,
  });
}

/** Approves the draft once nothing blocks it; the next write by the coach returns it to draft. */
export function usePublishBuilder(id: string) {
  const refresh = useBuilderRefresh(id);
  return useMutation({
    mutationFn: () => api<RecipeRow>(`${builderPath(id)}/publish`, { method: "POST" }),
    onSuccess: refresh,
  });
}
