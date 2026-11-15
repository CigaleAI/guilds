import { Plus, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  useAddGuildRepository,
  useGuildRepositories,
  useRemoveGuildRepository,
} from "../../api/queries/guilds";
import { useSecrets } from "../../api/queries/secrets";
import type { GithubLogin, Guild, GuildRepository } from "../../api/types/guilds";
import type { Secret } from "../../api/types/secrets";
import { Button, IconButton, TextField, Banner, Select, toast, Icon, Tag } from "@guildsrun/ui";
import { useIdentity } from "../../app/identity";
import { repositoryNameError } from "../../app/names";
import {
  ACCESS_TOKEN,
  accessTokenSecrets,
  credentialChoice,
  credentialRequest,
  isCredentialComplete,
  isGithubUrl,
  NO_CREDENTIAL,
  repositoryCredential,
  type RepositoryCredential,
} from "./repositories";

type Draft = {
  name: string;
  url: string;
  branch: string;
  /** A GitHub login's id, `ACCESS_TOKEN`, `NO_CREDENTIAL`, or empty for the default. */
  credential: string;
  secretId: string;
  username: string;
};

const emptyDraft: Draft = {
  name: "",
  url: "",
  branch: "",
  credential: "",
  secretId: "",
  username: "",
};

/** What the repository is cloned with, as its row shows it. */
function credentialLabel(repository: GuildRepository): ReactNode {
  if (repository.secret)
    return (
      <Tag tone="tide" font="sans">
        Token · {repository.secret.name}
      </Tag>
    );
  if (!repository.connection) return <Tag font="sans">anonymous</Tag>;
  if (repository.connection.status === "disconnected")
    return (
      <Tag tone="ochre" font="sans">
        {repository.connection.account_hint || "GitHub"} disconnected
      </Tag>
    );
  return (
    <Tag tone="tide" font="sans">
      GitHub · {repository.connection.account_hint}
    </Tag>
  );
}

type GuildRepositoriesProps = { guild: Pick<Guild, "id"> };

/**
 * Extra git URLs this guild's coding agents clone, on any HTTPS host, besides the repositories
 * picked on a GitHub login (Tools → GitHub).
 */
export function GuildRepositories({ guild }: GuildRepositoriesProps) {
  return (
    <section id="repositories" aria-label="Repositories" className="flex flex-col gap-3">
      <h3 className="type-label text-muted">Repositories</h3>
      <p className="text-sm text-fg-2">Other git repositories, added by URL.</p>
      <RepositoryList guildId={guild.id} />
      <AddRepositoryForm guildId={guild.id} />
    </section>
  );
}

type RepositoryListProps = { guildId: string };

/** The guild's extra repositories, each with the credential it clones with, to remove. */
function RepositoryList({ guildId }: RepositoryListProps) {
  const listed = useGuildRepositories(guildId);
  const remove = useRemoveGuildRepository(guildId);
  const repositories = listed.data?.repositories ?? [];
  if (!repositories.length) {
    return listed.isSuccess ? (
      <p className="text-sm text-muted">No extra repositories yet.</p>
    ) : null;
  }
  return (
    <div className="flex flex-col overflow-hidden rounded-xl bg-surface">
      {repositories.map((repository) => (
        <div
          key={repository.id}
          className="flex items-center gap-3 border-b border-line px-3.5 py-2.5 last:border-b-0"
        >
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-mono text-sm font-medium">{repository.name}</span>
            <span className="truncate text-xs text-muted">
              {repository.url} · {repository.default_branch}
            </span>
          </div>
          {credentialLabel(repository)}
          <IconButton
            type="button"
            icon={Trash2}
            label={`Remove ${repository.name}`}
            variant="ghost"
            size={28}
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(repository.id, {
                onError: (error) =>
                  toast({
                    kind: "error",
                    title: `Couldn't remove ${repository.name}`,
                    description: error.message,
                  }),
              })
            }
          />
        </div>
      ))}
    </div>
  );
}

type AddRepositoryFormProps = { guildId: string };

/** A new repository: its folder name, URL, default branch, and the credential it is cloned with. */
function AddRepositoryForm({ guildId }: AddRepositoryFormProps) {
  const listed = useGuildRepositories(guildId);
  const add = useAddGuildRepository(guildId);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const logins = (listed.data?.github_connections ?? []).filter(
    (login) => login.status === "connected",
  );
  const credential = repositoryCredential(draft.url, draft.credential, logins);
  const nameError = repositoryNameError(draft.name);

  const submit = () => {
    add.mutate(
      {
        name: draft.name.trim(),
        url: draft.url.trim(),
        ...(draft.branch.trim() ? { default_branch: draft.branch.trim() } : {}),
        ...credentialRequest(credential, draft.secretId, draft.username),
      },
      {
        onSuccess: (repository) => {
          setDraft(emptyDraft);
          toast({ kind: "success", title: `${repository.name} added` });
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl bg-surface p-4">
      <div className="grid gap-3 md:grid-cols-3">
        <TextField
          tone="paper"
          label="Name"
          mono
          placeholder="shop"
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
          {...(nameError ? { error: nameError } : {})}
        />
        <TextField
          tone="paper"
          label="URL"
          placeholder="https://git.example.com/owner/shop.git"
          value={draft.url}
          onChange={(event) => setDraft({ ...draft, url: event.currentTarget.value })}
        />
        <TextField
          tone="paper"
          label="Default branch"
          aside="optional"
          placeholder="main"
          value={draft.branch}
          onChange={(event) => setDraft({ ...draft, branch: event.currentTarget.value })}
        />
      </div>
      <CredentialFields
        logins={logins}
        credential={credential}
        draft={draft}
        onDraftChange={setDraft}
      />
      {add.isError ? (
        <Banner tone="error" title="Couldn't add the repository">
          {add.error.message}
        </Banner>
      ) : null}
      <div>
        <Button
          type="button"
          variant="outline"
          disabled={
            add.isPending ||
            !draft.name.trim() ||
            !draft.url.trim() ||
            Boolean(nameError) ||
            !isCredentialComplete(credential, draft.secretId, draft.username)
          }
          onClick={submit}
        >
          <Icon icon={Plus} size={14} />
          {add.isPending ? "Adding…" : "Add repository"}
        </Button>
      </div>
    </div>
  );
}

type CredentialFieldsProps = {
  /** The guild's connected GitHub logins. */
  logins: readonly GithubLogin[];
  credential: RepositoryCredential;
  draft: Draft;
  onDraftChange: (draft: Draft) => void;
};

/**
 * The credential a repository is added with: the choice, offering the GitHub logins only for a
 * GitHub URL, and for an access token the secret that holds it and its username.
 */
function CredentialFields({ logins, credential, draft, onDraftChange }: CredentialFieldsProps) {
  const { org } = useIdentity();
  const secrets = useSecrets({ scope: "org", id: org.id });
  return (
    <div className="grid gap-3 md:grid-cols-3">
      <CredentialSelect
        logins={isGithubUrl(draft.url) ? logins : []}
        credential={credential}
        onCredentialChange={(next) => onDraftChange({ ...draft, credential: next })}
      />
      {credential.kind === "access_token" ? (
        <AccessTokenFields
          secrets={accessTokenSecrets(secrets.data ?? [])}
          draft={draft}
          onDraftChange={onDraftChange}
        />
      ) : null}
    </div>
  );
}

type CredentialSelectProps = {
  /** The guild's connected GitHub logins a GitHub URL may use; none for another host. */
  logins: readonly GithubLogin[];
  credential: RepositoryCredential;
  onCredentialChange: (credential: string) => void;
};

/** What a repository is cloned with: a GitHub login for a GitHub URL, an access token, or nothing for a public one. */
function CredentialSelect({ logins, credential, onCredentialChange }: CredentialSelectProps) {
  const hints: Record<RepositoryCredential["kind"], string> = {
    github: "Its coding agents get a GitHub token for this repository at each run.",
    access_token: "A token the git host issued, kept as a secret of the organisation.",
    none: "Without a credential, only a public repository can be cloned.",
  };
  return (
    <Select
      tone="paper"
      label="Credential"
      value={credentialChoice(credential)}
      onValueChange={onCredentialChange}
      options={[
        ...logins.map((item) => ({ value: item.id, label: `GitHub · ${item.account_hint}` })),
        { value: ACCESS_TOKEN, label: "Access token" },
        { value: NO_CREDENTIAL, label: "None: clone anonymously" },
      ]}
      hint={hints[credential.kind]}
    />
  );
}

type AccessTokenFieldsProps = {
  /** The organisation's secrets the operator manages. */
  secrets: readonly Secret[];
  draft: Draft;
  onDraftChange: (draft: Draft) => void;
};

/** The secret that holds a repository's access token, and the username git sends with it. */
function AccessTokenFields({ secrets, draft, onDraftChange }: AccessTokenFieldsProps) {
  return (
    <>
      <Select
        tone="paper"
        label="Secret"
        mono
        placeholder="Choose a secret"
        value={draft.secretId}
        onValueChange={(secretId) => onDraftChange({ ...draft, secretId })}
        options={secrets.map((secret) => ({ value: secret.id, label: secret.name }))}
        hint={
          secrets.length
            ? "Its value is the token. It is read at each run and given to git only."
            : "Add the token under Secrets first: only a secret you manage can be used."
        }
      />
      <TextField
        tone="paper"
        label="Username"
        mono
        placeholder="oauth2"
        value={draft.username}
        onChange={(event) => onDraftChange({ ...draft, username: event.currentTarget.value })}
        hint="The one the host asks for with this token, such as oauth2 on GitLab."
      />
    </>
  );
}
