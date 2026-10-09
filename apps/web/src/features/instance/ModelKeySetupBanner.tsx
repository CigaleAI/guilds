import { Link } from "@tanstack/react-router";
import { useInstance, useOrgModelKeys } from "../../api/queries";
import { useIdentity } from "../../app/identity";
import { Banner, Button } from "@guildsrun/ui";
import { hasModelKey, missingModelKeyPhrase } from "./instance";

/**
 * Whether this organisation can run a model: it has a key, or the server has a model-provider
 * integration on. Null while either is still loading.
 */
export function useHasModelKey(): boolean | null {
  const { org } = useIdentity();
  const modelKeys = useOrgModelKeys(org.id);
  const instance = useInstance();
  return hasModelKey(
    modelKeys.data?.map((item) => item.provider),
    instance.data,
  );
}

/** Above every page when neither the organisation nor the server has a model key. */
export function ModelKeySetupBanner() {
  const hasKey = useHasModelKey();
  const instance = useInstance();
  if (hasKey !== false || !instance.data) return null;
  const phrase = missingModelKeyPhrase(instance.data);
  return (
    <div className="shrink-0 px-4 pt-4 md:px-6">
      <Banner
        tone="error"
        title="No model key yet"
        action={
          <Button asChild variant="outline" size="sm">
            <Link to="/settings" search={{ tab: "keys" }}>
              Open Model keys
            </Link>
          </Button>
        }
      >
        Connect one on Model keys
        {phrase ? `, or set ${phrase} on this server` : ""}. Runs fail until then.
      </Banner>
    </div>
  );
}
