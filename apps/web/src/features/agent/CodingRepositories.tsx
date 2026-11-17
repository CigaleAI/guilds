import { Link, useLocation } from "@tanstack/react-router";
import { useAccess } from "../../api/queries/access";
import type { McpServerAccess } from "../../api/types/access";
import { DocsLink } from "../../app/docs";
import { useIdentity } from "../../app/identity";
import { Button, Checkbox, SkeletonRows, Tag, Toggle } from "@guildsrun/ui";
import { GithubSettings } from "../access/GithubRepositories";
import { useServerConnect } from "../access/ConnectDialogs";
import { GuildRepositories } from "./GuildRepositories";
import {
  picksUsableRepository,
  repositoryChoices,
  togglePickedRepository,
  toggleReadOnlyRepository,
  type RepositoryPicks,
} from "./repositories";
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
  /** The repositories the agent can use, at least one. */
  usable: readonly string[];
  picks: RepositoryPicks;
  onPick: (next: RepositoryPicks) => void;
};

/**
 * A box for each repository the agent can use, and for each it picks and can no longer use,
 * tagged so; each one picked has a read-only switch beside it.
 */
function RepositoryPicker({ usable, picks, onPick }: RepositoryPickerProps) {
  return (
    <section aria-label="Repositories this agent works on" className="flex flex-col gap-1">
      <h3 className="type-label text-muted">This agent works on</h3>
      {repositoryChoices(usable, picks).map((choice) => (
        <div key={choice.name} className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-2">
          <Checkbox
            label={<span className="font-mono">{choice.name}</span>}
            checked={choice.picked}
            onCheckedChange={() => onPick(togglePickedRepository(picks, choice.name))}
          />
          {choice.usable ? null : (
            <Tag tone="ochre" font="sans">
              no longer in the guild
            </Tag>
          )}
          {choice.picked ? (
            <Toggle
              label="Read-only"
              checked={choice.readOnly}
              onCheckedChange={() => onPick(toggleReadOnlyRepository(picks, choice.name))}
            />
          ) : null}
        </div>
      ))}
    </section>
  );
}

/** How to give the guild a repository to pick: through a repository host's login, or by URL. */
function RepositorySetup() {
  return (
    <section aria-label="Set up a repository" className="flex flex-col gap-1">
      <h3 className="type-label text-muted">No repository to pick yet</h3>
      <p className="text-sm text-fg-2">
        Give the guild a repository first. Connect GitHub below and pick repositories on its login,
        or add a repository by its HTTPS URL, on any git host, under Repositories. Each one then
        shows here to pick.
      </p>
    </section>
  );
}

type CodingRepositoriesProps = {
  guild: { id: string; name: string };
  /** The repositories the agent can use; undefined while they load. */
  usable: readonly string[] | undefined;
  /** The repositories the agent works on, and those of them it only reads, as the form holds them. */
  picks: RepositoryPicks;
  onPick: (next: RepositoryPicks) => void;
  /** What picking none means for this agent, said while it picks none it can use; null when it means nothing. */
  missingNote: string | null;
};

/**
 * The repositories an agent works on, on a key or a subscription, picked among those it can use,
 * each writable or read-only, then the guild's repositories it picks from: its GitHub login and
 * the repositories picked on it, then those added by URL. While the guild has none to pick, the
 * section says how to set one up with those. While the agent picks none it can use, `missingNote`
 * says what that means where it shows.
 */
export function CodingRepositories({ guild, usable, picks, onPick, missingNote }: CodingRepositoriesProps) {
  const pickable = usable !== undefined && repositoryChoices(usable, picks).length > 0;
  return (
    <>
      <p className="text-sm text-fg-2">
        This agent works in the repositories it picks, if any: each is cloned into its home before
        each of its turns. A read-only one is fetched and never pushed to. The repositories of{" "}
        {guild.name} below are shared by its agents; each picks the ones it works on.
      </p>
      {usable === undefined ? <SkeletonRows rows={2} label="Loading repositories" /> : null}
      {usable !== undefined && pickable ? <RepositoryPicker usable={usable} picks={picks} onPick={onPick} /> : null}
      {usable !== undefined && !pickable ? <RepositorySetup /> : null}
      {usable && missingNote !== null && !picksUsableRepository(usable, picks.repositories) ? (
        <p className="text-sm text-t-ochre-fg">{missingNote}</p>
      ) : null}
      <GithubBlock guildId={guild.id} />
      <GuildRepositories guild={guild} />
    </>
  );
}
