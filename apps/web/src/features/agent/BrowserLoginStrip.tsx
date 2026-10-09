import { Link, useMatchRoute } from "@tanstack/react-router";
import { Globe } from "lucide-react";
import { useGuildApply } from "../../api/queries";
import { useStoredFlag } from "../../app/storage";
import { Button, Icon } from "@guildsrun/ui";
/**
 * A browser agent needs the operator to log it in to its site by hand, which nothing can detect;
 * the strip asks until the operator marks it done. While the guild's recipe checklist is open it
 * waits: logins come once the guild is activated.
 */
export function BrowserLoginStrip({ guildId, agentId }: { guildId: string; agentId: string }) {
  const [done, setDone] = useStoredFlag(`guilds-setup-dismissed:${agentId}:browser-login`);
  const apply = useGuildApply(guildId);
  const onBrowser = useMatchRoute()({ to: "/guilds/$guildId/agents/$agentId/browser" });
  if (done || apply.isPending || apply.data) return null;
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
