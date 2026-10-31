import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Banner, Button, cn, Icon, Select, StatusBadge, toast } from "@guildsrun/ui";
import { useAgent, useAgentHarness, useCheckHarness } from "../../../api/queries/agents";
import { useSecrets } from "../../../api/queries/secrets";
import type { Harness, HarnessCredential } from "../../../api/types/agents";
import type { Secret } from "../../../api/types/secrets";
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
import {
  harnessCredentialNote,
  type AgentTab,
  type CredentialNote,
  type NotePart,
} from "./credentialNote";

const tabLinks = {
  secrets: { to: "/guilds/$guildId/agents/$agentId/secrets", label: "Secrets" },
  cli: { to: "/guilds/$guildId/agents/$agentId/cli", label: "CLI" },
} as const;

type TabLinkProps = { tab: AgentTab; agent: SettingsAgent };

function TabLink({ tab, agent }: TabLinkProps) {
  return (
    <Link to={tabLinks[tab].to} params={agent} className="underline">
      {tabLinks[tab].label}
    </Link>
  );
}

type NotePartViewProps = { part: NotePart; agent: SettingsAgent };

function NotePartView({ part, agent }: NotePartViewProps) {
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
      <Button size="xl" variant="outline" className="gap-1.5" onClick={() => setOpen(true)}>
        <Icon icon={Plus} size={16} />
        Add token
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
    <div className="flex flex-col gap-1.5">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Select
            tone="surface"
            label="Subscription token"
            value={chosen}
            onValueChange={(value) => onAliasesChange(withTokenAlias(aliases, variable, value))}
            options={tokenOptions(variable, secrets)}
          />
        </div>
        <AddTokenButton {...choice} />
      </div>
      {shadowed ? (
        <p className="text-xs text-muted">
          Replaces the <code className="font-mono">{variable}</code> that also reaches this agent.
        </p>
      ) : null}
    </div>
  );
}

type CheckLoginProps = { agent: SettingsAgent; harness: Harness };

/** Looks for the harness's login in the agent's home, waking its machine, and records what it finds. */
function CheckLogin({ agent, harness }: CheckLoginProps) {
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

function statusBadgeProps(entry: HarnessCredential | null, muted: boolean) {
  if (muted) return { status: "warning" as const, label: "Check failed" };
  if (entry?.secret_granted) return { status: "ok" as const, label: "Active token" };
  if (entry?.login_seen_at) return { status: "ok" as const, label: "Logged in" };
  return { status: "warning" as const, label: "Setup needed" };
}

type CredentialStatusCardProps = {
  note: CredentialNote;
  entry: HarnessCredential | null;
  agent: SettingsAgent;
  harness: Harness;
};

/** A reassuring status card showing credential status, active secret, and login checks. */
function CredentialStatusCard({ note, entry, agent, harness }: CredentialStatusCardProps) {
  const badge = statusBadgeProps(entry, note.muted);
  const showLoginCheck = Boolean(entry && !entry.secret_granted);
  const showDetails = !entry?.secret_granted;

  return (
    <div
      className={cn(
        "flex rounded-xl border border-line bg-surface/60 p-3",
        showDetails ? "flex-col gap-2" : "items-center justify-between",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <StatusBadge status={badge.status}>{badge.label}</StatusBadge>
          <span className="text-xs font-medium text-fg">
            {badge.status === "ok" ? "Ready for code tasks" : "Authentication required"}
          </span>
        </div>
        {showLoginCheck ? <CheckLogin agent={agent} harness={harness} /> : null}
      </div>
      {showDetails ? (
        <p className="text-xs text-muted leading-relaxed">
          {note.parts.map((part, index) => (
            <NotePartView key={index} part={part} agent={agent} />
          ))}
        </p>
      ) : null}
    </div>
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

type HarnessReadinessProps = {
  agent: SettingsAgent;
  harness: Harness;
  aliases: Record<string, string>;
  onAliasesChange: (aliases: Record<string, string>) => void;
};

/**
 * What the picked harness still needs before the agent's code tasks run: the token its variable
 * reads, with a picker among the secrets reaching the agent; its credential status as
 * `harnessCredentialNote` words it; and a check for a login in the agent's home.
 */
export function HarnessReadiness({
  agent,
  harness,
  aliases,
  onAliasesChange,
}: HarnessReadinessProps) {
  const status = useAgentHarness(agent.agentId);
  const secrets = useSecrets({ scope: "agent", id: agent.agentId });
  const entry = liveEntry(status.data?.harnesses, secrets.data, harness, aliases);
  const note = harnessCredentialNote(
    {
      credentials: entry ? [entry] : undefined,
      error: status.isError ? status.error.message : null,
      harness,
    },
    new Date(),
  );
  const variable = harnessSecrets[harness];
  return (
    <div className="flex flex-col gap-3">
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
        <CredentialStatusCard note={note} entry={entry} agent={agent} harness={harness} />
      ) : null}
    </div>
  );
}
