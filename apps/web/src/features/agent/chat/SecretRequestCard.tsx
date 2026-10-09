import { KeyRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import {
  useCreateSecret,
  useSecrets,
  useSendRunMessage,
  useSetSecretAccess,
} from "../../../api/queries";
import type { AgentDetail, Run, SecretAccessChoice } from "../../../api/types";
import { useIdentity } from "../../../app/identity";
import { Button, Segmented, TextField, Banner, toast, Icon } from "@guildsrun/ui";
import { SecretReach } from "../../access/AccessSecrets";
import {
  managesSecrets,
  requestState,
  secretDescriptionMax,
  withAgent,
  type SecretRequest,
} from "../../access/secrets";

type Target = "agent" | "guild" | "org";

function accessFor(target: Target, agent: AgentDetail): SecretAccessChoice {
  if (target === "org") return { org_wide: true, guild_ids: [], agent_ids: [] };
  if (target === "guild") return { org_wide: false, guild_ids: [agent.guild_id], agent_ids: [] };
  return { org_wide: false, guild_ids: [], agent_ids: [agent.id] };
}

/**
 * An agent's secret_request in its chat. The card keeps no state: it reads the name in the
 * organisation and offers to provide it, grant it, or says it is set. The value goes straight to
 * the secrets API and never into the transcript; once it lands, an idle run hears "Secret NAME is set."
 */
export function SecretRequestCard({
  agent,
  run,
  request,
}: {
  agent: AgentDetail;
  run: Run;
  request: SecretRequest;
}) {
  const { org } = useIdentity();
  const manager = managesSecrets(org.role);
  const orgSecrets = useSecrets({ scope: "org", id: org.id });
  const environment = useSecrets({ scope: "agent", id: agent.id });
  const create = useCreateSecret();
  const grant = useSetSecretAccess();
  const send = useSendRunMessage(agent.id);
  const [description, setDescription] = useState(
    request.description.slice(0, secretDescriptionMax),
  );
  const [value, setValue] = useState("");
  const [target, setTarget] = useState<Target>("agent");

  const tellAgent = () => {
    if (run.generating || run.status !== "active") return;
    send.mutate({ runId: run.id, content: `Secret ${request.name} is set.` });
  };

  const provide = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      {
        name: request.name,
        value,
        description: description.trim(),
        ...accessFor(manager ? target : "agent", agent),
      },
      {
        onSuccess: () => {
          setValue("");
          toast({ kind: "success", title: `${request.name} provided` });
          tellAgent();
        },
      },
    );
  };

  const state =
    orgSecrets.data && environment.data
      ? requestState(request.name, orgSecrets.data, environment.data)
      : null;

  return (
    <section
      aria-label={`${agent.name} asks for ${request.name}`}
      className="flex flex-col gap-3 self-stretch rounded-xl bg-surface px-4 py-3.5 inset-ring inset-ring-line-3"
    >
      <header className="flex flex-wrap items-center gap-2">
        <Icon icon={KeyRound} size={16} />
        <span className="text-sm font-semibold text-fg">{agent.name} asks for a secret</span>
        <span className="font-mono text-sm font-medium text-fg">{request.name}</span>
      </header>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted">Use</dt>
        <dd className="whitespace-pre-wrap text-fg-2">{request.description}</dd>
        <dt className="text-muted">Why now</dt>
        <dd className="whitespace-pre-wrap text-fg-2">{request.reason}</dd>
      </dl>
      <p className="text-xs text-muted">
        Written by the agent. The value becomes an environment variable in this agent's sandbox. Its
        scripts can read and send it.
      </p>

      {state === null ? (
        <p className="text-sm text-muted">Checking {request.name}…</p>
      ) : state.kind === "set" ? (
        <p className="text-sm font-semibold text-fg">{request.name} is set</p>
      ) : state.kind === "elsewhere" ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-fg-2">
          <span>{request.name} exists, available to</span>
          <SecretReach secret={state.secret} />
          {manager ? (
            <Button
              size="sm"
              disabled={grant.isPending}
              onClick={() =>
                grant.mutate(
                  { secretId: state.secret.id, access: withAgent(state.secret, agent.id) },
                  {
                    onSuccess: () => {
                      toast({ kind: "success", title: `${request.name} granted to ${agent.name}` });
                      tellAgent();
                    },
                  },
                )
              }
            >
              {grant.isPending ? "Granting…" : "Grant to this agent"}
            </Button>
          ) : (
            <span className="text-muted">An org owner or admin can grant it to this agent.</span>
          )}
          {grant.isError ? (
            <Banner tone="error" title="Couldn't grant the secret">
              {grant.error.message}
            </Banner>
          ) : null}
        </div>
      ) : (
        <form onSubmit={provide} className="flex flex-col gap-3">
          <TextField
            tone="paper"
            label="Description"
            required
            maxLength={secretDescriptionMax}
            showCount
            value={description}
            onChange={(event) => setDescription(event.currentTarget.value)}
          />
          <TextField
            tone="paper"
            label="Value"
            type="password"
            required
            autoComplete="off"
            value={value}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
          {manager ? (
            <Segmented
              label="Who gets it"
              size="sm"
              value={target}
              onValueChange={setTarget}
              options={[
                { value: "agent", label: "This agent" },
                { value: "guild", label: "Its guild" },
                { value: "org", label: "The organisation" },
              ]}
            />
          ) : null}
          {create.isError ? (
            <Banner tone="error" title="Couldn't provide the secret">
              {create.error.message}
            </Banner>
          ) : null}
          <div>
            <Button
              type="submit"
              size="sm"
              disabled={create.isPending || !value || !description.trim()}
            >
              {create.isPending ? "Providing…" : "Provide"}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
