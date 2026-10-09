import { Banner, SkeletonRows, Tag } from "@guildsrun/ui";
import { useInstance } from "../../api/queries";
import type { InstanceIntegration, IntegrationState } from "../../api/types";

const stateTag: Record<IntegrationState, { tone: "tide" | "ochre" | "well"; label: string }> = {
  on: { tone: "tide", label: "On" },
  incomplete: { tone: "ochre", label: "Incomplete" },
  off: { tone: "well", label: "Off" },
};

/** A variable's tag: set, missing from an integration that has some of its others, or just not set. */
function variableTag(
  integration: InstanceIntegration,
  variable: InstanceIntegration["variables"][number],
): { tone: "tide" | "ochre" | "well"; note: string } {
  if (variable.set) return { tone: "tide", note: "set" };
  if (variable.optional) return { tone: "well", note: "optional" };
  return integration.state === "incomplete"
    ? { tone: "ochre", note: "missing" }
    : { tone: "well", note: "not set" };
}

/** The platform's keys: each optional integration of the server, what it switches on, and which of its variables are set. */
export function InstanceTab() {
  const instance = useInstance();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 md:px-10">
      <div className="mx-auto flex max-w-240 flex-col gap-6">
        <p className="text-sm text-fg-2">
          What this server can be given. An integration is on when every variable it requires is set
          in the server's environment, which is read at start. No key is entered or shown here.
        </p>
        {instance.isPending ? (
          <SkeletonRows rows={6} label="Loading integrations" />
        ) : instance.isError ? (
          <Banner
            tone="error"
            title="Couldn't load the integrations"
            meta={instance.error.message}
          />
        ) : (
          <div className="flex flex-col overflow-hidden rounded-xl bg-surface">
            {instance.data.integrations.map((integration) => (
              <div
                key={integration.id}
                className="flex flex-col gap-2 border-b border-line px-4 py-3.5 last:border-b-0"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-md font-semibold">{integration.label}</span>
                  <Tag tone={stateTag[integration.state].tone} font="sans">
                    {stateTag[integration.state].label}
                  </Tag>
                </div>
                <p className="text-sm text-fg-2">{integration.enables}</p>
                <div className="flex flex-wrap gap-1.5">
                  {integration.variables.map((variable) => {
                    const tag = variableTag(integration, variable);
                    return (
                      <Tag key={variable.name} tone={tag.tone}>
                        {variable.name} · {tag.note}
                      </Tag>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
