import { Plus, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  useAddGuildRepository,
  useGuildRepositories,
  useRemoveGuildRepository,
} from "../../api/queries/guilds";
import type { GithubLogin, Guild, GuildRepository } from "../../api/types/guilds";
import { Button, IconButton, TextField, Banner, Select, toast, Icon, Tag } from "@guildsrun/ui";
import { repositoryNameError } from "../../app/names";
import { isGithubUrl, NO_LOGIN, repositoryLogin } from "./repositories";

type Draft = { name: string; url: string; branch: string; login: string };

const emptyDraft: Draft = { name: "", url: "", branch: "", login: "" };

function loginLabel(repository: GuildRepository): ReactNode {
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
 * Extra git URLs this guild's coding agents clone, besides the repositories picked on a GitHub
 * login (Tools → GitHub).
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

/** The guild's extra repositories, each with the login it clones with, to remove. */
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
          {loginLabel(repository)}
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

/** A new repository: its folder name, URL, default branch and, for GitHub, the login it uses. */
function AddRepositoryForm({ guildId }: AddRepositoryFormProps) {
  const listed = useGuildRepositories(guildId);
  const add = useAddGuildRepository(guildId);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const logins = (listed.data?.github_connections ?? []).filter(
    (login) => login.status === "connected",
  );
  const login = repositoryLogin(draft.url, draft.login, logins);
  const nameError = repositoryNameError(draft.name);

  const submit = () => {
    add.mutate(
      {
        name: draft.name.trim(),
        url: draft.url.trim(),
        ...(draft.branch.trim() ? { default_branch: draft.branch.trim() } : {}),
        ...(login ? { connection_id: login } : {}),
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
          placeholder="https://github.com/owner/shop"
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
      {isGithubUrl(draft.url) ? (
        <RepositoryLoginSelect
          logins={logins}
          login={login}
          onLoginChange={(next) => setDraft({ ...draft, login: next })}
        />
      ) : null}
      {add.isError ? (
        <Banner tone="error" title="Couldn't add the repository">
          {add.error.message}
        </Banner>
      ) : null}
      <div>
        <Button
          type="button"
          variant="outline"
          disabled={add.isPending || !draft.name.trim() || !draft.url.trim() || Boolean(nameError)}
          onClick={submit}
        >
          <Icon icon={Plus} size={14} />
          {add.isPending ? "Adding…" : "Add repository"}
        </Button>
      </div>
    </div>
  );
}

type RepositoryLoginSelectProps = {
  /** The guild's connected GitHub logins. */
  logins: readonly GithubLogin[];
  /** The login the repository is added with; null clones it anonymously. */
  login: string | null;
  onLoginChange: (login: string) => void;
};

/** The GitHub login a repository is added with, or none to clone a public one anonymously. */
function RepositoryLoginSelect({ logins, login, onLoginChange }: RepositoryLoginSelectProps) {
  return (
    <Select
      tone="paper"
      label="GitHub login"
      className="md:w-1/3"
      value={login ?? NO_LOGIN}
      onValueChange={onLoginChange}
      options={[
        ...logins.map((item) => ({ value: item.id, label: `GitHub · ${item.account_hint}` })),
        { value: NO_LOGIN, label: "None: clone anonymously" },
      ]}
      hint={
        login
          ? "Its coding agents get a token for this repository at each run."
          : logins.length
            ? "Without a login, only a public repository can be cloned."
            : "Without a login, only a public repository can be cloned. Connect GitHub under Tools to add a private one."
      }
    />
  );
}
