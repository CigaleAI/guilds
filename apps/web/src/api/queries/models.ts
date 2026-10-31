import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../client";
import { builderKeys } from "./builder";
import type {
  CatalogModel,
  ModelProvider,
  OrgModelProvider,
  OrgModels,
  ModelProviderInput,
} from "../types/models";

/**
 * Query keys of the organisation's models. Identity is fixed for the page's life, so keys carry no
 * user or org.
 */
export const modelKeys = {
  orgModels: (orgId: string) => ["org", orgId, "models"] as const,
  providerCatalog: (orgId: string, provider: string) =>
    ["org", orgId, "model-catalog", provider] as const,
};

const orgModelsPath = (orgId: string) => `/api/orgs/${encodeURIComponent(orgId)}`;

/** The organisation's default, its providers, and the models it chose to offer: what every picker lists. */
export function useOrgModels(orgId: string) {
  return useQuery({
    queryKey: modelKeys.orgModels(orgId),
    queryFn: () => api<OrgModels>(`${orgModelsPath(orgId)}/models`),
  });
}

/** A provider's whole catalog, or the local endpoint's live list; read by Model keys alone. */
export function useProviderCatalog(orgId: string, provider: ModelProvider, enabled: boolean) {
  return useQuery({
    queryKey: modelKeys.providerCatalog(orgId, provider),
    queryFn: () =>
      api<{ models: CatalogModel[] }>(
        `${orgModelsPath(orgId)}/model-providers/${provider}/catalog`,
      ).then((body) => body.models),
    enabled,
    retry: false,
  });
}

function useOrgModelsWrite<T>(orgId: string, write: (input: T) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: write,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: modelKeys.orgModels(orgId) });
      void client.invalidateQueries({ queryKey: builderKeys.capabilities });
    },
  });
}

/**
 * Connects a provider, or changes what it offers: the key (kept when left out on a connected
 * provider), the local endpoint's URL, and the chosen models. The key is probed before anything
 * is saved.
 */
export function useConnectModelProvider(orgId: string) {
  return useOrgModelsWrite(
    orgId,
    ({ provider, ...body }: ModelProviderInput) =>
      api<OrgModelProvider>(`${orgModelsPath(orgId)}/model-providers/${provider}`, {
        method: "PUT",
        body,
      }),
  );
}

/** Names the organisation's default model, or clears it with null. */
export function useSetDefaultModel(orgId: string) {
  return useOrgModelsWrite(orgId, (model: string | null) =>
    api<{ default: string | null }>(`${orgModelsPath(orgId)}/default-model`, {
      method: "PUT",
      body: { model },
    }),
  );
}

/** Removes a provider's key and its chosen models; a default among them clears. */
export function useRemoveModelProvider(orgId: string) {
  return useOrgModelsWrite(orgId, (provider: ModelProvider) =>
    api<undefined>(`${orgModelsPath(orgId)}/model-providers/${provider}`, { method: "DELETE" }),
  );
}
