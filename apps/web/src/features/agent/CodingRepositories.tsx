import { Link, useLocation } from "@tanstack/react-router";
import { useAccess } from "../../api/queries/access";
import type { McpServerAccess } from "../../api/types/access";
import { DocsLink } from "../../app/docs";
import { useIdentity } from "../../app/identity";
import { Button, Checkbox, SkeletonRows, Tag } from "@guildsrun/ui";
import { GithubSettings } from "../access/GithubRepositories";
import { useServerConnect } from "../access/ConnectDialogs";
import { GuildRepositories } from "./GuildRepositories";
import { picksUsableRepository, repositoryChoices, togglePickedRepository } from "./repositories";
import { setupSearch } from "../instance/instance";

/** GitHub without its app on this box: a link to set it up for a platform admin, a note for anyone else. */
function GithubUnsupported() {
  const { user } = useIdentity();
  const location = useLocation();
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-fg-2">
      GitHub is not set up on this box.
      {user.platform_admin ? (
        <Link to="/admin" search={setupSearch("github-app", location.href)} className="underline">
          Set up
        </Link>
      ) : (
        "Ask a platform admin to set it up."
      )}
      <DocsLink path="/tools-and-connectors/github">Learn more</DocsLink>
    </p>
  );
}

/** What the block says of the guild's GitHub login: whose it is once connected, else why to connect one. */
function githubLoginNote(
  github: McpServerAccess,
  connected: boolean,
  owned: string | null,
): string {
  if (!connected) return "Connect GitHub to pick repositories, private ones included.";
  return `GitHub · ${github.account_hint}${owned ? "" : " (the organisation's login)"}`;
}

type GithubBlockProps = { guildId: string };

/** The GitHub login the guild's repositories come from: connect one, or pick repositories on it. */
function GithubBlock({ guildId }: GithubBlockProps) {
  const owner = { scope: "guild", id: guildId } as const;
  const access = useAccess(owner);
  const connect = useServerConnect(owner);
  const github = access.data?.mcp.find((server) => server.slug === "github");
  if (!github) return null;
  if (github.oauth_setup_state === "unsupported") return <GithubUnsupported />;
  const connected = github.connection_id !== null && github.status === "connected";
  const owned = github.connection_owner_scope === "guild" ? github.connection_id : null;
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-surface p-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-60 flex-1 text-sm text-fg-2">
          {githubLoginNote(github, connected, owned)}
        </p>
        {!connected || !owned ? (
          <Button
            size="sm"
            variant="outline"
            disabled={connect.busy}
            onClick={() => connect.start(github)}
          >
            {connect.busy ? "Connecting…" : "Connect GitHub"}
          </Button>
        ) : null}
      </div>
      {connected ? <GithubSettings server={github} owned={owned} /> : null}
      {connect.dialogs}
    </div>
  );
}

type RepositoryPickerProps = {
  /** The repositories the agent can use; undefined while they load. */
  usable: readonly string[] | undefined;
  picked: readonly string[];
  onPick: (next: string[]) => void;
};

/** A box for each repository the agent can use, and for each it picks and can no longer use, tagged so. */
function RepositoryPicker({ usable, picked, onPick }: RepositoryPickerProps) {
  if (!usable) return <SkeletonRows rows={2} label="Loading repositories" />;
  const choices = repositoryChoices(usable, picked);
  return (
    <section aria-label="Repositories this agent works on" className="flex flex-col gap-1">
      <h3 className="type-label text-muted">This agent works on</h3>
      {choices.length ? (
        choices.map((choice) => (
          <div key={choice.name} className="flex flex-wrap items-center gap-2">
            <Checkbox
              label={<span className="font-mono">{choice.name}</span>}
              checked={choice.picked}
              onCheckedChange={() => onPick(togglePickedRepository(picked, choice.name))}
            />
            {choice.usable ? null : (
              <Tag tone="ochre" font="sans">
                no longer in the guild
              </Tag>
            )}
          </div>
        ))
      ) : (
        <p className="text-sm text-muted">The guild has no repository yet. Add one below.</p>
      )}
    </section>
  );
}

type CodingRepositoriesProps = {
  guild: { id: string; name: string };
  /** The repositories the agent can use; undefined while they load. */
  usable: readonly string[] | undefined;
  /** The repositories the agent works on, as the form holds them. */
  picked: readonly string[];
  onPick: (next: string[]) => void;
  missingNote: string;
};

/**
 * The repositories a coding or subscription agent works on, picked among those it can use, then the guild's
 * repositories it picks from: its GitHub login and the repositories picked on it, then those added
 * by URL. While the agent picks none it can use, `missingNote` says what that means where it shows.
 */
export function CodingRepositories({ guild, usable, picked, onPick, missingNote }: CodingRepositoriesProps) {
  return (
    <>
      <p className="text-sm text-fg-2">
        This agent works in the repositories it picks. The repositories of {guild.name} below are
        shared by its agents; each picks the ones it works on.
      </p>
      <RepositoryPicker usable={usable} picked={picked} onPick={onPick} />
      {usable && !picksUsableRepository(usable, picked) ? (
        <p className="text-sm text-t-ochre-fg">{missingNote}</p>
      ) : null}
      <GithubBlock guildId={guild.id} />
      <GuildRepositories guild={guild} />
    </>
  );
}
