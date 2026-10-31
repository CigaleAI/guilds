import { Link, useMatchRoute } from "@tanstack/react-router";
import { Globe } from "lucide-react";
import { useGuildApply, useGuildBrowserLogins } from "../../api/queries/recipes";
import { useStoredFlag } from "../../app/storage";
import { Button, Icon } from "@guildsrun/ui";

/**
 * True after a recipe apply deferred this agent's browser login, until the operator marks it
 * done; false while the guild's apply is in progress, its checklist open or loading.
 */
export function showBrowserLoginStrip(
  agentId: string,
  browserLogins: readonly string[],
  done: boolean,
  applyInProgress: boolean,
): boolean {
  if (done || applyInProgress) return false;
  return browserLogins.includes(agentId);
}

type BrowserLoginStripProps = { guildId: string; agentId: string };

/**
 * A recipe that needs a take-control login leaves this strip on the live agent after activate.
 * Turning the browser on in Settings does not. The operator marks it done; nothing can detect the
 * login. While the guild's recipe checklist is open it waits.
 */
export function BrowserLoginStrip({ guildId, agentId }: BrowserLoginStripProps) {
  const [done, setDone] = useStoredFlag(`guilds-setup-dismissed:${agentId}:browser-login`);
  const apply = useGuildApply(guildId);
  const logins = useGuildBrowserLogins(guildId);
  const onBrowser = useMatchRoute()({ to: "/guilds/$guildId/agents/$agentId/browser" });
  const applyInProgress = Boolean(apply.data) || apply.isPending;
  if (!showBrowserLoginStrip(agentId, logins.data ?? [], done, applyInProgress)) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-t-sig px-6 py-2.5 text-sm text-t-sig-fg">
      <Icon icon={Globe} size={16} />
      <span className="min-w-0 flex-1">
        Browser login needed: take control of this agent's browser and log in to its site before it
        can use it.
      </span>
      {!onBrowser ? (
        <Button asChild variant="outline" size="sm">
          <Link to="/guilds/$guildId/agents/$agentId/browser" params={{ guildId, agentId }}>
            Open Browser
          </Link>
        </Button>
      ) : null}
      <Button variant="ghost" size="sm" onClick={() => setDone(true)}>
        Mark as done
      </Button>
    </div>
  );
}
