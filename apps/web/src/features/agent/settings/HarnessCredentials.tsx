import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useAgentHarness } from "../../../api/queries";
import type { Harness, HarnessCredential } from "../../../api/types";
import { relativeTime } from "../../../app/format";

type Tabs = { guildId: string; agentId: string };

function SecretsLink(params: Tabs) {
  return (
    <Link to="/guilds/$guildId/agents/$agentId/secrets" params={params} className="underline">
      Secrets
    </Link>
  );
}

function CliLink(params: Tabs) {
  return (
    <Link to="/guilds/$guildId/agents/$agentId/cli" params={params} className="underline">
      CLI
    </Link>
  );
}

/** How to log in: the command to run in the CLI tab, or what to do before the tab offers one. */
function loginStep(entry: HarnessCredential, cli: boolean, tabs: Tabs, again: boolean): ReactNode {
  if (entry.login) {
    return (
      <>
        log in{again ? " again" : ""} from the <CliLink {...tabs} /> tab with{" "}
        <code className="font-mono">{entry.login}</code>
      </>
    );
  }
  return cli
    ? "save with CLI on, then log in from its tab"
    : "turn on CLI, then log in from its tab";
}

/**
 * Whether the selected harness has a credential for this agent: the granted secret it runs on,
 * or what to set up (the secret to grant on the Secrets tab, a login from the CLI tab, which a
 * harness without a secret cannot do while the CLI is off), with when a code task last found a
 * login in the agent's home.
 */
export function HarnessCredentials({
  guildId,
  agentId,
  harness,
  cli,
}: Tabs & {
  harness: Harness;
  /** Whether the form has the CLI on; a login needs it. */
  cli: boolean;
}) {
  const status = useAgentHarness(agentId);
  if (status.isError) {
    return (
      <p className="text-sm text-muted">Couldn't check its credentials: {status.error.message}</p>
    );
  }
  const entry = status.data?.harnesses.find((item) => item.harness === harness);
  if (!entry) return null;
  const tabs = { guildId, agentId };
  if (entry.secret && entry.secret_granted) {
    return (
      <p className="text-sm text-fg-2">
        Runs on the secret <code className="font-mono">{entry.secret}</code>.
      </p>
    );
  }
  const seen = entry.login_seen_at;
  if (!entry.secret && !cli && !seen) {
    return (
      <p className="text-sm text-fg-2">
        {entry.label} runs only on a login, and logging in needs the CLI: turn on CLI, then log in
        from its tab.
      </p>
    );
  }
  const secret = entry.secret ? (
    <>
      grant the secret <code className="font-mono">{entry.secret}</code> on the{" "}
      <SecretsLink {...tabs} /> tab
    </>
  ) : null;
  const login = loginStep(entry, cli, tabs, Boolean(seen));
  return (
    <p className="text-sm text-fg-2">
      {seen ? (
        <>Runs on its login, last seen {relativeTime(seen)}. If it lapses, </>
      ) : (
        <>{entry.label} has no credential yet. To set one up, </>
      )}
      {secret ? <>{secret}, or </> : null}
      {login}.
    </p>
  );
}
