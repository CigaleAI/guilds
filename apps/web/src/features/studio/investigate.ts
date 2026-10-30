import { useNavigate } from "@tanstack/react-router";
import { useCreateStudioSession } from "../../api/queries/studio";
import { useOrgModels } from "../../api/queries/models";
import type { Issue } from "../../api/types/issues";
import { isRecord } from "../../api/wire";
import { useIdentity } from "../../app/identity";
import { preselectedModel } from "../models/models";
import { toast } from "@guildsrun/ui";

/** What a new session starts pinned to, and the question it offers to ask. */
export type StudioPin = { focus: Record<string, unknown> & { label: string }; prompt: string };

const pinKey = (sessionId: string) => `studio-pin:${sessionId}`;

/** Whether a value read back from storage is a pin: a prompt and a focus with its label. */
function isStudioPin(value: unknown): value is StudioPin {
  return (
    isRecord(value) &&
    typeof value.prompt === "string" &&
    isRecord(value.focus) &&
    typeof value.focus.label === "string"
  );
}

/** The pin kept for a session; null when none is kept, or what is kept is not a pin. */
export function readPin(sessionId: string): StudioPin | null {
  try {
    const raw = sessionStorage.getItem(pinKey(sessionId));
    const kept: unknown = raw ? JSON.parse(raw) : null;
    return isStudioPin(kept) ? kept : null;
  } catch {
    return null;
  }
}

/** This tab's session storage; null where the browser denies the page its storage. */
function tabStorage(): Storage | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

/** Keeps a pin for the session's workspace to open with; false where this tab cannot keep it. */
export function keepPin(sessionId: string, pin: StudioPin): boolean {
  try {
    sessionStorage.setItem(pinKey(sessionId), JSON.stringify(pin));
    return true;
  } catch {
    return false;
  }
}

/** Forgets the session's kept pin; a tab without session storage kept none. */
export function clearPin(sessionId: string): void {
  tabStorage()?.removeItem(pinKey(sessionId));
}

/**
 * Opens a new Studio session on an issue's guild with the issue pinned and the question ready to
 * send; nothing is sent until the operator does.
 */
export function useInvestigateIssue() {
  const navigate = useNavigate();
  const { org } = useIdentity();
  const models = useOrgModels(org.id);
  const create = useCreateStudioSession();
  return {
    pending: create.isPending,
    investigate: async (issue: Issue) => {
      const loaded = models.data ?? (await models.refetch()).data;
      const model = preselectedModel(loaded, { marketplaceOnly: true });
      if (!model) {
        toast({
          kind: "error",
          title: "Couldn't open Studio",
          description:
            "Set a default model on Model keys, or start a session from Studio and pick one.",
        });
        return;
      }
      create.mutate(
        { guildId: issue.guild_id, model, temperature: 0.2 },
        {
          onSuccess: (session) => {
            const pin: StudioPin = {
              focus: {
                kind: "issue",
                issue_id: issue.id,
                agent_id: issue.agent_id,
                run_id: issue.run_id,
                label: `Issue · ${issue.summary}`,
              },
              prompt: "What caused this issue, and what should change so it does not happen again?",
            };
            if (!keepPin(session.id, pin)) {
              toast({
                kind: "error",
                title: "Couldn't pin the issue",
                description: "This tab couldn't keep it, so the session opens without the issue.",
              });
            }
            void navigate({
              to: "/studio/$sessionId",
              params: { sessionId: session.id },
              search: issue.agent_id
                ? {
                    section: "agents" as const,
                    agent: issue.agent_id,
                    ...(issue.run_id ? { tab: "history" as const, item: issue.run_id } : {}),
                  }
                : { section: "guild" as const },
            });
          },
          onError: (error) =>
            toast({ kind: "error", title: "Couldn't open Studio", description: error.message }),
        },
      );
    },
  };
}
