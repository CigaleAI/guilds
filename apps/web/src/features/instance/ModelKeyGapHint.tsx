import { useInstance, useModels, useOrgModelKeys } from "../../api/queries";
import type { InstanceIntegration } from "../../api/types";
import { useIdentity } from "../../app/identity";
import { ModelKeysLink } from "../settings/ModelKeysLink";
import { missingVariablesPhrase, modelKeyGap } from "./instance";

/**
 * The integration whose key a model would run on, when the organisation has no key for the
 * model's provider and this server has none either.
 */
export function useModelKeyGap(modelId: string): InstanceIntegration | null {
  const models = useModels();
  const { org } = useIdentity();
  const modelKeys = useOrgModelKeys(org.id);
  const instance = useInstance();
  return modelKeyGap(
    models.data?.models.find((item) => item.id === modelId),
    modelKeys.data?.map((item) => item.provider),
    instance.data,
  );
}

/** Says a model has no key to run on and the two ways to give it one. */
export function ModelKeyGapHint({ integration }: { integration: InstanceIntegration }) {
  return (
    <>
      No {integration.label} key yet: connect one on <ModelKeysLink />, or set{" "}
      {missingVariablesPhrase(integration)} on this server. Runs on this model fail until then.
    </>
  );
}
