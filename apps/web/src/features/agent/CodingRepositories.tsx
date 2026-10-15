import { Link } from "@tanstack/react-router";
import { useAccess, useGuildRepositories } from "../../api/queries";
import type { GithubSelectedRepository } from "../../api/types";
import { Button } from "@guildsrun/ui";
import { GithubSettings } from "../access/GithubRepositories";
import { useServerConnect } from "../access/ConnectDialogs";
import { GuildRepositories } from "../guild/pages/GuildRepositories";

/** The GitHub login the guild's repositories come from: connect one, or pick repositories on it. */
function GithubBlock({ guildId }: { guildId: string }) {
  const owner = { scope: "guild", id: guildId } as const;
  const access = useAccess(owner);
  const connect = useServerConnect(owner);
  const github = access.data?.mcp.find((server) => server.slug === "github");
  if (!github) return null;
  if (github.oauth_setup_state === "unsupported") {
    return (
      <p className="text-sm text-fg-2">
        The GitHub App is not set up on this box. A platform admin registers it under{" "}
        <Link to="/admin" className="underline">
          Admin
        </Link>
        , Platform keys; until then, repositories are added by URL below.
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
            ? `GitHub · ${github.account_hint}${owned ? "" : " (the organisation's login; connect here to pick for this guild alone)"}`
            : "Install the GitHub App on your account and pick the repositories it may reach; private ones need it."}
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
        Code tasks run in the guild&apos;s repositories, cloned into the agent&apos;s sandbox. Every
        coding agent of {guild.name} shares them. Without one, this agent&apos;s runs fail at start.
      </p>
      <GithubBlock guildId={guild.id} />
      <GuildRepositories guild={guild} />
      {hasRepositories === false ? <p className="text-sm text-t-ochre-fg">{missingNote}</p> : null}
    </>
  );
}
