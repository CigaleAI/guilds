import { useParams } from "@tanstack/react-router";
import { RotateCw, SquareTerminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../../api/client";
import { useAgent } from "../../../api/queries/agents";
import { Button, IconButton, EmptyState, StatusBadge } from "@guildsrun/ui";
type Session =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "live"; nonce: number }
  | { kind: "failed"; detail: string };

function terminalUrl(agentId: string, nonce: number): string {
  // ttyd opens its socket and its token request next to the page, so the path ends in a slash.
  return `/api/agents/${encodeURIComponent(agentId)}/cli/tty/?_=${nonce}`;
}

/**
 * A bash session in the agent's home, on the machine it shares with other agents. Nothing starts
 * until the operator asks: opening the terminal wakes the machine, which then stays up for five
 * minutes after the last input. The shell has the agent's home and port block, and no secrets.
 */
export function AgentCli() {
  const { agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId" });
  const agent = useAgent(agentId);
  const [session, setSession] = useState<Session>({ kind: "idle" });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const start = () => {
    setSession({ kind: "starting" });
    api(`/api/agents/${encodeURIComponent(agentId)}/cli`, { method: "POST" }).then(
      () => mounted.current && setSession({ kind: "live", nonce: Date.now() }),
      (error: Error) =>
        mounted.current &&
        setSession({ kind: "failed", detail: error.message || "Could not start the terminal." }),
    );
  };

  if (session.kind === "idle") {
    return (
      <div className="grid flex-1 place-items-center p-6">
        <EmptyState
          icon={SquareTerminal}
          title="Open a terminal on this agent's machine"
          description={`Starting it wakes the machine, which stays up for five minutes after the last input. The machine is shared with the other agents on it. The shell runs in /home/${agentId} with the agent's port block; no secret values reach it.`}
          action={
            <Button size="sm" onClick={start}>
              Start the terminal
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-7 py-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-fg-2">
          Bash in /home/{agentId}, on the machine the agent shares with the other agents there. It
          stays up for five minutes after the last input. No secret values reach it.
        </span>
        <span className="flex-1" />
        <StatusBadge
          status={session.kind === "live" ? "ok" : session.kind === "failed" ? "failed" : "running"}
        >
          {session.kind === "live" ? "Live" : session.kind === "failed" ? "Failed" : "Starting"}
        </StatusBadge>
        <IconButton
          icon={RotateCw}
          label="Restart the terminal"
          variant="surface"
          onClick={start}
        />
      </div>
      {session.kind === "live" ? (
        <iframe
          key={session.nonce}
          title={`${agent.data?.name ?? "Agent"} terminal`}
          src={terminalUrl(agentId, session.nonce)}
          className="min-h-0 w-full flex-1 rounded-lg bg-panel"
        />
      ) : session.kind === "failed" ? (
        <div className="grid flex-1 place-items-center">
          <div className="flex max-w-160 flex-col items-center gap-3 text-center">
            <h3 className="text-lg font-semibold">Terminal unavailable</h3>
            <pre className="max-h-60 w-full overflow-auto rounded-md bg-surface p-3 text-left font-mono text-xs whitespace-pre-wrap">
              {session.detail}
            </pre>
            <Button size="sm" onClick={start}>
              Try again
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid flex-1 place-items-center">
          <div role="status" className="flex flex-col items-center gap-2 text-sm text-muted">
            <StatusBadge status="running">Starting the terminal</StatusBadge>
            It can take up to a minute when the machine is asleep.
          </div>
        </div>
      )}
    </div>
  );
}
