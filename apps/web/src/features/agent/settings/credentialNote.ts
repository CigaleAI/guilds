import type { Harness, HarnessCredential } from "../../../api/types/agents";
import { relativeTime } from "../../../app/format";

/** A tab of the agent's page that a credential note links to. */
export type AgentTab = "secrets" | "cli";

/** One piece of a credential note: plain text, a name set as code, or a link to an agent tab. */
export type NotePart = string | { code: string } | { tab: AgentTab };

/** What the Harness field says under the select; muted when the credentials could not be checked. */
export type CredentialNote = { muted: boolean; parts: NotePart[] };

/** What the note is read from: the agent's harness credentials and the harness picked. */
export type CredentialCheck = {
  /** Each harness's credentials for the agent; undefined while they load. */
  credentials: readonly HarnessCredential[] | undefined;
  /** Why the credentials could not load; null otherwise. */
  error: string | null;
  harness: Harness;
};

/** How a setup note opens: when a login was last seen, or that the harness has no credential yet. */
function setupLead(entry: HarnessCredential, now: Date): NotePart[] {
  return entry.login_seen_at
    ? [`Runs on its login, last seen ${relativeTime(entry.login_seen_at, now)}. If it lapses, `]
    : [`${entry.label} has no credential yet. To set one up, `];
}

/** The step that picks the harness's token from the select above; nothing for a harness without one. */
function pickTokenStep(secret: string | null): NotePart[] {
  return secret ? ["choose a subscription token above, or "] : [];
}

/** The secret the harness runs on, with the variable it is read as when that is another name. */
function runsOn(entry: HarnessCredential): NotePart[] {
  const source = entry.secret_source ?? entry.secret ?? "";
  const as: NotePart[] = source === entry.secret ? [] : [" as ", { code: entry.secret ?? "" }];
  return ["Runs on the secret ", { code: source }, ...as, "."];
}

/** How to log in: the command to run in the CLI tab. */
function loginStep(entry: HarnessCredential): NotePart[] {
  const again = entry.login_seen_at ? " again" : "";
  return [`log in${again} from the `, { tab: "cli" }, " tab with ", { code: entry.login }];
}

/** What a harness's credential entry says: the granted secret it runs on, or how to set one up. */
function credentialParts(entry: HarnessCredential, now: Date): NotePart[] {
  if (entry.secret && entry.secret_granted) {
    return runsOn(entry);
  }
  return [...setupLead(entry, now), ...pickTokenStep(entry.secret), ...loginStep(entry), "."];
}

/**
 * Whether the picked harness has a credential for the agent: the secret it runs on, or what to
 * set up (a token from the select, or a login from the CLI tab), with when a check last found a
 * login. Null while the
 * credentials load, or when they do not list the harness.
 */
export function harnessCredentialNote(check: CredentialCheck, now: Date): CredentialNote | null {
  if (check.error !== null) {
    return { muted: true, parts: [`Couldn't check its credentials: ${check.error}`] };
  }
  const entry = check.credentials?.find((item) => item.harness === check.harness);
  return entry ? { muted: false, parts: credentialParts(entry, now) } : null;
}
