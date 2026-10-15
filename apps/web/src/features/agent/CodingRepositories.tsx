import { Link, useLocation } from "@tanstack/react-router";
import { useAccess, useGuildRepositories } from "../../api/queries";
import type { GithubSelectedRepository } from "../../api/types";
import { DocsLink } from "../../app/docs";
import { useIdentity } from "../../app/identity";
import { Button } from "@guildsrun/ui";
import { GithubSettings } from "../access/GithubRepositories";
import { useServerConnect } from "../access/ConnectDialogs";
import { GuildRepositories } from "../guild/pages/GuildRepositories";
import { setupSearch } from "../instance/instance";

/** The GitHub login the guild's repositories come from: connect one, or pick repositories on it. */
function GithubBlock({ guildId }: { guildId: string }) {
  const owner = { scope: "guild", id: guildId } as const;
  const access = useAccess(owner);
  const connect = useServerConnect(owner);
  const { user } = useIdentity();
  const location = useLocation();
  const github = access.data?.mcp.find((server) => server.slug === "github");
  if (!github) return null;
  if (github.oauth_setup_state === "unsupported") {
    return (
      <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-fg-2">
        GitHub is not set up on this box.
        {user.platform_admin ? (
          <Link
            to="/admin"
            search={setupSearch("github-app", location.href)}
            className="underline"
          >
            Set up
          </Link>
        ) : (
          "Ask a platform admin to set it up."
        )}
        <DocsLink path="/tools-and-connectors/github">Learn more</DocsLink>
      </p>
    );
  }
  const connected = github.connection_id !== null && github.status === "connected";
  const owned = github.connection_owner_scope === "guild" ? github.connection_id : null;
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-surface p-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-60 flex-1 text-sm text-fg-2">
          {connected
            ? `GitHub · ${github.account_hint}${owned ? "" : " (the organisation's login)"}`
            : "Connect GitHub to pick repositories, private ones included."}
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

/** Whether the guild has a repository for code tasks: one picked on its GitHub login, or one added by URL. */
export function useGuildHasRepositories(guildId: string): boolean | null {
  const listed = useGuildRepositories(guildId);
  const access = useAccess({ scope: "guild", id: guildId });
  if (!listed.data || !access.data) return null;
  const github = access.data.mcp.find((server) => server.slug === "github");
  const picked = (github?.settings.repositories as GithubSelectedRepository[] | undefined) ?? [];
  return listed.data.repositories.length > 0 || picked.length > 0;
}

/**
 * The guild's repositories, which every coding agent of the guild codes in: its GitHub login and
 * the repositories picked on it, then those added by URL. While it has none, `missingNote` says
 * what that means where it shows.
 */
export function CodingRepositories({
  guild,
  missingNote,
}: {
  guild: { id: string; name: string };
  missingNote: string;
}) {
  const hasRepositories = useGuildHasRepositories(guild.id);
  return (
    <>
      <p className="text-sm text-fg-2">
        Code tasks run in these repositories, shared by every coding agent of {guild.name}.
      </p>
      <GithubBlock guildId={guild.id} />
      <GuildRepositories guild={guild} />
      {hasRepositories === false ? <p className="text-sm text-t-ochre-fg">{missingNote}</p> : null}
    </>
  );
}
