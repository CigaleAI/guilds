import type { SelectOption, SelectOptionGroup } from "@guildsrun/ui";
import type { ModelProvider, OrgModels } from "../../api/types/models";

/**
 * The picker's options: the organisation's chosen models grouped by provider. Coding rows appear
 * only for an agent with coding on; `marketplaceOnly` leaves them out whatever the agent. A
 * current value the organisation no longer offers stays listed as it is.
 */
export function modelOptions(
  models: OrgModels | undefined,
  options: { current?: string; coding?: boolean; marketplaceOnly?: boolean } = {},
): SelectOptionGroup[] {
  const current = options.current ?? "";
  if (!models) {
    return current ? [{ label: "Current", options: [{ value: current, label: current }] }] : [];
  }
  const groups: SelectOptionGroup[] = models.providers
    .filter((provider) => provider.connected)
    .filter(
      (provider) => provider.kind !== "coding" || (options.coding && !options.marketplaceOnly),
    )
    .map((provider) => ({
      label: provider.label,
      options: models.models
        .filter((model) => model.provider === provider.id)
        .map((model): SelectOption => ({
          value: model.id,
          label: model.label,
          description: model.id,
        })),
    }))
    .filter((group) => group.options.length > 0);
  if (
    current &&
    !groups.some((group) => group.options.some((option) => option.value === current))
  ) {
    groups.unshift({ label: "Not offered", options: [{ value: current, label: current }] });
  }
  return groups;
}

/** A model's label as the organisation's catalog shows it; its id when the catalog does not list it. */
export function modelLabel(models: OrgModels | undefined, modelId: string): string {
  return models?.models.find((model) => model.id === modelId)?.label ?? modelId;
}

/** The organisation's default when the picker may list it, else nothing. */
export function preselectedModel(
  models: OrgModels | undefined,
  options: { coding?: boolean; marketplaceOnly?: boolean } = {},
): string {
  const chosen = models?.default ?? "";
  if (!chosen) return "";
  const listed = modelOptions(models, options).some((group) =>
    group.options.some((option) => option.value === chosen),
  );
  return listed ? chosen : "";
}

/** What a model does not take: reasoning, or a temperature it sets itself. */
export function modelLimits(models: OrgModels | undefined, modelId: string) {
  const model = models?.models.find((item) => item.id === modelId);
  return { thinkingOff: model?.thinking === false, temperatureOff: model?.temperature === false };
}

/** The provider prefix of a stored model id. */
export function providerOf(modelId: string): string {
  return modelId.split("/")[0] ?? "";
}

/** Whether the model's provider is connected, or null while the organisation's models still load. */
export function modelProviderConnected(
  models: OrgModels | undefined,
  modelId: string,
): boolean | null {
  if (!models) return null;
  return models.providers.some(
    (provider) => provider.id === providerOf(modelId) && provider.connected,
  );
}

export function providerLabel(models: OrgModels | undefined, modelId: string): string {
  return (
    models?.providers.find((provider) => provider.id === providerOf(modelId))?.label ??
    providerOf(modelId)
  );
}

/** The three steps of the organisation's model setup, each done or not, as the setup gate shows them. */
export type SetupStep = { id: "provider" | "models" | "default"; label: string; done: boolean };

export function setupProgress(models: OrgModels | undefined): SetupStep[] {
  const connected = models?.providers.some((provider) => provider.connected) ?? false;
  const chosen = (models?.models.length ?? 0) > 0;
  return [
    { id: "provider", label: "Connect a provider with the organisation's key", done: connected },
    { id: "models", label: "Choose the models to offer", done: chosen },
    { id: "default", label: "Mark one as the default", done: Boolean(models?.default) },
  ];
}

/** What a provider is for, and where its key comes from, as the setup shows them. */
export type ProviderMeta = { blurb: string; keyURL: string | null; urlPlaceholder?: string };

export const PROVIDER_META: Record<ModelProvider, ProviderMeta> = {
  openai: {
    blurb: "GPT models, straight from OpenAI.",
    keyURL: "https://platform.openai.com/api-keys",
  },
  anthropic: {
    blurb: "Claude models, straight from Anthropic.",
    keyURL: "https://platform.claude.com/settings/keys",
  },
  openrouter: {
    blurb: "Hundreds of models behind one key, Claude and Gemini included.",
    keyURL: "https://openrouter.ai/settings/keys",
  },
  xai: { blurb: "Grok models from xAI.", keyURL: "https://console.x.ai/" },
  deepinfra: {
    blurb: "Open-weight models, priced low.",
    keyURL: "https://deepinfra.com/dash/api_keys",
  },
  local: {
    blurb: "Ollama, LM Studio, vLLM, or any OpenAI-compatible server you run.",
    keyURL: null,
    urlPlaceholder: "http://127.0.0.1:11434/v1",
  },
  kimi: {
    blurb: "Kimi models on a Kimi Code plan, for coding agents.",
    keyURL: "https://www.kimi.com/code",
  },
};
