import { useNavigate } from "@tanstack/react-router";
import { useCreateStudioSession, useOrgModels } from "../../api/queries";
import type { Issue } from "../../api/types";
import { useIdentity } from "../../app/identity";
import { preselectedModel } from "../models/models";
import { toast } from "@guildsrun/ui";
/** What a new session starts pinned to, and the question it offers to ask. */
export type StudioPin = { focus: Record<string, unknown> & { label: string }; prompt: string };

const pinKey = (sessionId: string) => `studio-pin:${sessionId}`;

export function readPin(sessionId: string): StudioPin | null {
  try {
    const raw = sessionStorage.getItem(pinKey(sessionId));
    return raw ? (JSON.parse(raw) as StudioPin) : null;
  } catch {
    return null;
  }
}

export function clearPin(sessionId: string): void {
  try {
    sessionStorage.removeItem(pinKey(sessionId));
  } catch {
    // Nothing kept, nothing to clear.
  }
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
          description: "Set a default model on Model keys, or start a session from Studio and pick one.",
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
            try {
              sessionStorage.setItem(pinKey(session.id), JSON.stringify(pin));
            } catch {
              // Without storage the session opens unpinned.
            }
            void navigate({
              to: "/studio/$sessionId",
              params: { sessionId: session.id },
              search: issue.agent_id
                ? {
                    agent: issue.agent_id,
                    ...(issue.run_id ? { tab: "history" as const, item: issue.run_id } : {}),
                  }
                : {},
            });
          },
          onError: (error) =>
            toast({ kind: "error", title: "Couldn't open Studio", description: error.message }),
        },
      );
    },
  };
}
