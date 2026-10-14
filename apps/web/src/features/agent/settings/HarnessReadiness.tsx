import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Banner, Button, Select, toast } from "@guildsrun/ui";
import { useAgent, useAgentHarness, useCheckHarness, useSecrets } from "../../../api/queries";
import type { Harness, HarnessCredential, Secret } from "../../../api/types";
import { useIdentity } from "../../../app/identity";
import { AddSecretDialog } from "../../access/AccessSecrets";
import { managesSecrets } from "../../access/secrets";
import {
  freeTokenName,
  harnessSecrets,
  harnessTokenDescription,
  NO_TOKEN_ALIAS,
  tokenOptions,
  withTokenAlias,
} from "../harness";
import type { SettingsAgent } from "./configForm";
import { harnessCredentialNote, type AgentTab, type NotePart } from "./credentialNote";

const tabLinks = {
  secrets: { to: "/guilds/$guildId/agents/$agentId/secrets", label: "Secrets" },
  cli: { to: "/guilds/$guildId/agents/$agentId/cli", label: "CLI" },
} as const;

function TabLink({ tab, agent }: { tab: AgentTab; agent: SettingsAgent }) {
  return (
    <Link to={tabLinks[tab].to} params={agent} className="underline">
      {tabLinks[tab].label}
    </Link>
  );
}

function NotePartView({ part, agent }: { part: NotePart; agent: SettingsAgent }) {
  if (typeof part === "string") return part;
  if ("code" in part) return <code className="font-mono">{part.code}</code>;
  return <TabLink tab={part.tab} agent={agent} />;
}

/** The aliases and the secrets reaching the agent, as the token picker edits them. */
type TokenChoice = {
  agent: SettingsAgent;
  harness: Harness;
  variable: string;
  secrets: readonly Secret[];
  aliases: Record<string, string>;
  onAliasesChange: (aliases: Record<string, string>) => void;
};

/** Opens the add-secret dialog, granted to this agent and named for the harness's variable, and picks the result. */
function AddTokenButton({
  agent,
  harness,
  variable,
  secrets,
  aliases,
  onAliasesChange,
}: TokenChoice) {
  const { org } = useIdentity();
  const detail = useAgent(agent.agentId);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Add a token
      </Button>
      {open ? (
        <AddSecretDialog
          open
          onOpenChange={setOpen}
          manager={managesSecrets(org.role)}
          initialAccess={{ org_wide: false, guild_ids: [], agent_ids: [agent.agentId] }}
          initialName={freeTokenName(variable, detail.data?.name ?? "", secrets)}
          initialDescription={harnessTokenDescription[harness] ?? ""}
          onCreated={(secret) => onAliasesChange(withTokenAlias(aliases, variable, secret.name))}
        />
      ) : null}
    </>
  );
}

/**
 * Which secret the harness's token variable reads: the one of its own name by default, or any
 * other secret reaching the agent, through a secret alias. A new token is added granted to this
 * agent and picked at once; the choice is saved with the settings.
 */
function TokenPicker(choice: TokenChoice) {
  const { variable, secrets, aliases, onAliasesChange } = choice;
  const chosen = aliases[variable] ?? NO_TOKEN_ALIAS;
  const shadowed = chosen !== NO_TOKEN_ALIAS && secrets.some((secret) => secret.name === variable);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Select
            tone="surface"
            label="Subscription token"
            hint={`The secret read as ${variable}. Your own token keeps the work on your subscription.`}
            value={chosen}
            onValueChange={(value) => onAliasesChange(withTokenAlias(aliases, variable, value))}
            options={tokenOptions(variable, secrets)}
          />
        </div>
        <AddTokenButton {...choice} />
      </div>
      {shadowed ? (
        <p className="text-sm text-muted">
          Replaces the <code className="font-mono">{variable}</code> that also reaches this agent.
        </p>
      ) : null}
    </div>
  );
}

/** Looks for the harness's login in the agent's home, waking its machine, and records what it finds. */
function CheckLogin({ agent, harness }: { agent: SettingsAgent; harness: Harness }) {
  const check = useCheckHarness(agent.agentId);
  const run = () =>
    check.mutate(harness, {
      onSuccess: (result) =>
        toast(
          result.credential === "login"
            ? {
                kind: "success",
                title: result.account ? `Logged in as ${result.account}` : "Login found",
              }
            : {
                kind: "error",
                title: result.installed
                  ? "No login found"
                  : "The harness isn't in this machine's image",
              },
        ),
    });
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button size="sm" variant="ghost" disabled={check.isPending} onClick={run}>
          {check.isPending ? "Checking…" : "Check login"}
        </Button>
      </div>
      {check.isError ? (
        <Banner tone="error" title="Couldn't check the login">
          {check.error.message}
        </Banner>
      ) : null}
    </div>
  );
}

/** The guild repositories code tasks work in; a coding run of a guild without one fails at start. */
function RepositoriesLine({
  agent,
  repositories,
}: {
  agent: SettingsAgent;
  repositories: readonly string[];
}) {
  if (repositories.length) {
    return <p className="text-sm text-fg-2">Code tasks work in {repositories.join(", ")}.</p>;
  }
  return (
    <p className="text-sm text-t-ochre-fg">
      This guild has no repositories, so its coding runs fail at start. Add one in the guild&apos;s{" "}
      <Link
        to="/guilds/$guildId/settings"
        params={{ guildId: agent.guildId }}
        hash="repositories"
        className="underline"
      >
        Repositories
      </Link>
      .
    </p>
  );
}

/**
 * The harness's credential entry as the form has it: the secret its variable reads under the
 * form's aliases, whether that secret reaches the agent, and whether it replaces one of the
 * variable's own name. Null until the agent's harnesses and secrets are known.
 */
function liveEntry(
  entries: readonly HarnessCredential[] | undefined,
  secrets: readonly Secret[] | undefined,
  harness: Harness,
  aliases: Record<string, string>,
): HarnessCredential | null {
  const entry = entries?.find((item) => item.harness === harness);
  if (!entry || !secrets) return null;
  if (entry.secret === null) return entry;
  const source = aliases[entry.secret] ?? entry.secret;
  const reaches = (name: string) => secrets.some((secret) => secret.name === name);
  return {
    ...entry,
    secret_source: source,
    secret_granted: reaches(source),
    secret_shadowed: source !== entry.secret && reaches(entry.secret),
  };
}

/**
 * What the picked harness still needs before the agent's code tasks run: the token its variable
 * reads, with a picker among the secrets reaching the agent; its credential status as
 * `harnessCredentialNote` words it; a check for a login in the agent's home; and the guild's
 * repositories.
 */
export function HarnessReadiness({
  agent,
  harness,
  cli,
  aliases,
  onAliasesChange,
}: {
  agent: SettingsAgent;
  harness: Harness;
  /** Whether the form has the CLI on; a login needs it. */
  cli: boolean;
  aliases: Record<string, string>;
  onAliasesChange: (aliases: Record<string, string>) => void;
}) {
  const status = useAgentHarness(agent.agentId);
  const secrets = useSecrets({ scope: "agent", id: agent.agentId });
  const entry = liveEntry(status.data?.harnesses, secrets.data, harness, aliases);
  const note = harnessCredentialNote(
    {
      credentials: entry ? [entry] : undefined,
      error: status.isError ? status.error.message : null,
      harness,
      cli,
    },
    new Date(),
  );
  const variable = harnessSecrets[harness];
  return (
    <div className="flex flex-col gap-2">
      {variable && secrets.data ? (
        <TokenPicker
          agent={agent}
          harness={harness}
          variable={variable}
          secrets={secrets.data}
          aliases={aliases}
          onAliasesChange={onAliasesChange}
        />
      ) : null}
      {note ? (
        <p className={note.muted ? "text-sm text-muted" : "text-sm text-fg-2"}>
          {note.parts.map((part, index) => (
            <NotePartView key={index} part={part} agent={agent} />
          ))}
        </p>
      ) : null}
      {entry?.login && !entry.secret_granted ? (
        <CheckLogin agent={agent} harness={harness} />
      ) : null}
      {status.data ? (
        <RepositoriesLine agent={agent} repositories={status.data.repositories} />
      ) : null}
    </div>
  );
}
