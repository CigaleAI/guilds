import type { SelectOption, SelectOptionGroup } from "@guildsrun/ui";
import type { OrgModels } from "../../api/types";

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
    .filter((provider) => provider.kind !== "coding" || (options.coding && !options.marketplaceOnly))
    .map((provider) => ({
      label: provider.label,
      options: models.models
        .filter((model) => model.provider === provider.id)
        .map((model): SelectOption => ({ value: model.id, label: model.label, description: model.id })),
    }))
    .filter((group) => group.options.length > 0);
  if (current && !groups.some((group) => group.options.some((option) => option.value === current))) {
    groups.unshift({ label: "Not offered", options: [{ value: current, label: current }] });
  }
  return groups;
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
export function modelProviderConnected(models: OrgModels | undefined, modelId: string): boolean | null {
  if (!models) return null;
  return models.providers.some((provider) => provider.id === providerOf(modelId) && provider.connected);
}

export function providerLabel(models: OrgModels | undefined, modelId: string): string {
  return models?.providers.find((provider) => provider.id === providerOf(modelId))?.label ?? providerOf(modelId);
}
