import { Trash2 } from "lucide-react";
import { useGithubRepositories, useSetGithubRepositories } from "../../api/queries/access";
import type { GithubSelectedRepository, McpServerAccess } from "../../api/types/access";
import { IconButton, Select, Tag, toast } from "@guildsrun/ui";
import { repositoryNameFrom } from "../guild/repositories";

type GithubSettingsProps = {
  server: McpServerAccess;
  owned: string | null;
};

/**
 * The repositories this GitHub login's coding agents clone. Editable on the scope's own login;
 * inherited logins are read-only until the operator connects here.
 */
export function GithubSettings({ server, owned }: GithubSettingsProps) {
  const connectionId = owned ?? server.connection_id ?? "";
  const save = useSetGithubRepositories(connectionId);
  const reachable = useGithubRepositories(connectionId || null);
  const selected =
    (save.isPending ? save.variables : undefined) ??
    (server.settings.repositories as GithubSelectedRepository[] | undefined) ??
    [];
  const added = new Set(selected.map((item) => item.url.toLowerCase()));
  const pickable = (reachable.data ?? []).filter((item) => !added.has(item.url.toLowerCase()));

  const persist = (next: GithubSelectedRepository[]) => {
    if (!owned) return;
    save.mutate(next, {
      onError: (error) =>
        toast({
          kind: "error",
          title: "Couldn't change the repositories",
          description: error.message,
        }),
    });
  };

  return (
    <div className="flex flex-col gap-2">
      {selected.length ? (
        <div className="flex flex-col overflow-hidden rounded-lg bg-paper">
          {selected.map((repository) => (
            <div
              key={`${repository.name}:${repository.url}`}
              className="flex items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-mono text-sm font-medium">{repository.name}</span>
                <span className="truncate text-xs text-muted">
                  {repository.url} · {repository.default_branch}
                </span>
              </div>
              {owned ? (
                <IconButton
                  type="button"
                  icon={Trash2}
                  label={`Remove ${repository.name}`}
                  variant="ghost"
                  size={28}
                  disabled={save.isPending}
                  onClick={() => persist(selected.filter((item) => item.name !== repository.name))}
                />
              ) : (
                <Tag font="sans">inherited</Tag>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted">No repositories on this login yet.</p>
      )}
      {owned ? (
        <Select
          tone="paper"
          label={`From GitHub · ${server.account_hint || "GitHub"}`}
          placeholder={reachable.isLoading ? "Loading repositories…" : "Pick a repository"}
          value=""
          disabled={save.isPending || !pickable.length}
          onValueChange={(value) => {
            const picked = pickable.find((item) => item.full_name === value);
            if (!picked) return;
            persist([
              ...selected,
              {
                name: repositoryNameFrom(picked.name),
                url: picked.url,
                default_branch: picked.default_branch,
              },
            ]);
          }}
          options={pickable.map((item) => ({
            value: item.full_name,
            label: item.full_name,
            description: item.private ? "private" : "public",
          }))}
          {...(reachable.isError ? { error: reachable.error.message } : {})}
        />
      ) : (
        <p className="text-xs text-muted">
          Repositories on the inherited login. Connect here to pick a different set.
        </p>
      )}
    </div>
  );
}
