import { KeyRound } from "lucide-react";
import { useGrantStudioConnection, useStudioConnections } from "../../api/queries/studio";
import type { StudioSession } from "../../api/types/studio";
import {
  Button,
  SkeletonRows,
  Popover,
  PopoverContent,
  PopoverTrigger,
  toast,
  Icon,
} from "@guildsrun/ui";
const scopeWord: Record<string, string> = {
  platform: "platform",
  org: "organisation",
  guild: "guild",
  agent: "agent",
};

/**
 * The logins the guild reaches, and which of them the coach may read through: granting one lets
 * the coach call its read-only tools while it investigates.
 */
export function LoginsPopover({ session }: { session: StudioSession }) {
  const connections = useStudioConnections(session.id);
  const grant = useGrantStudioConnection(session.id);
  const live = session.status === "active";
  const granted = session.granted_connection_ids.length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="on-panel" size="sm">
          <Icon icon={KeyRound} size={14} />
          Logins{granted ? ` · ${granted} granted` : ""}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-96 max-w-full flex-col gap-3 p-4">
        <div className="flex flex-col gap-1">
          <span className="text-md font-semibold">What the coach may read</span>
          <span className="text-xs text-muted">
            A granted login lets the coach call its read-only tools while it investigates.
          </span>
        </div>
        {connections.isPending ? (
          <SkeletonRows rows={3} label="Loading logins" />
        ) : !connections.data?.length ? (
          <p className="text-sm text-muted">No logins are reachable from this guild.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {connections.data.map((connection) => {
              const name = connection.server.display_name || connection.server.slug;
              const connected = connection.status === "connected";
              return (
                <li
                  key={connection.id}
                  className="flex items-center gap-3 rounded-lg bg-surface px-3 py-2"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">
                      {name}
                      {connection.account_hint ? ` · ${connection.account_hint}` : ""}
                    </span>
                    <span className="text-xs text-muted">
                      {scopeWord[connection.owner_scope] ?? connection.owner_scope} ·{" "}
                      {connection.status} · {connection.readable_tools.length}/
                      {connection.tool_count} read-only
                    </span>
                  </div>
                  <Button
                    variant={connection.granted ? "outline" : "primary"}
                    size="xs"
                    disabled={!live || !connected || grant.isPending}
                    onClick={() =>
                      grant.mutate(
                        { connectionId: connection.id, granted: !connection.granted },
                        {
                          onError: (error) =>
                            toast({
                              kind: "error",
                              title: connection.granted
                                ? `Couldn't revoke ${name}`
                                : `Couldn't grant ${name}`,
                              description: error.message,
                            }),
                        },
                      )
                    }
                  >
                    {connection.granted ? "Revoke" : "Grant"}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
