import { Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { useDraftAction, useStudioInspector } from "../../../api/queries";
import type { StudioAgent, StudioDraft, StudioSession } from "../../../api/types";
import {
  Button,
  DiffView,
  diffLines,
  Markdown,
  PromptSections,
  TextAreaField,
  Banner,
  SkeletonRows,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  toast,
  Icon,
  Tag,
} from "@guildsrun/ui";
import { promptSectionsOf } from "../../agent/chat/runContext";
import { useStudio } from "../StudioContext";

/** A draft still waiting on the operator: proposed, or written over a Task that changed since. */
export const openDraft = (draft: Pick<StudioDraft, "status">) =>
  draft.status === "draft" || draft.status === "conflicted";

/** The agent's live Task, and the whole prompt a run receives. */
export function PromptTab({ agent }: { agent: StudioAgent }) {
  const { session, go } = useStudio();
  const inspector = useStudioInspector(session.id, agent.id);

  if (inspector.isPending)
    return <SkeletonRows rows={6} label="Loading the prompt" className="p-6" />;
  if (inspector.isError) {
    return (
      <div className="p-6">
        <Banner tone="error" title="Couldn't load the prompt" meta={inspector.error.message} />
      </div>
    );
  }
  const data = inspector.data;
  const latest = data.effective_prompt.latest_run;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-6">
      {data.generating ? (
        <Banner tone="info" title={`${agent.name} is running now`}>
          What it runs on is already fixed; changes apply to its next run.
        </Banner>
      ) : null}
      {data.task.embed_warning ? (
        <Banner tone="error" title="An embed doesn't resolve">
          {data.task.embed_warning}
        </Banner>
      ) : null}
      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h2 className="type-label text-muted">Task · v{data.task.version ?? 0}</h2>
          <Button asChild variant="ghost" size="sm" className="ml-auto">
            <Link
              to="/guilds/$guildId/agents/$agentId/prompt"
              params={{ guildId: session.source_guild_id, agentId: agent.id }}
            >
              <Icon icon={ExternalLink} size={14} />
              Edit in agent
            </Link>
          </Button>
        </div>
        <div className="rounded-lg bg-surface px-4 py-3">
          {data.task.content.trim() ? (
            <Markdown
              density="compact"
              onOpenEmbed={(path) =>
                go(
                  path.includes("/collections/")
                    ? { agent: agent.id, tab: "databases" }
                    : { agent: agent.id, tab: "files", item: path },
                )
              }
            >
              {data.task.content}
            </Markdown>
          ) : (
            <p className="text-sm text-muted">Empty Task.</p>
          )}
        </div>
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="type-label text-muted">What a run gets</h2>
        {latest ? (
          <p className="text-xs text-muted">
            Its latest run {latest.task_match ? "used this Task" : "used an older Task"}
            {latest.memory_match ? " and this memory" : " and older memory"}.
          </p>
        ) : null}
        <PromptSections sections={promptSectionsOf(data.effective_prompt.content)} />
      </section>
    </div>
  );
}

/** The Task change the coach proposed for the agent, to publish, edit or discard. */
export function DraftTab({ agent, drafts }: { agent: StudioAgent; drafts: StudioDraft[] }) {
  const { session } = useStudio();
  const inspector = useStudioInspector(session.id, agent.id);
  const current = drafts.find(openDraft) ?? drafts[0];
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
      {current ? (
        <DraftReview
          key={current.id}
          session={session}
          draft={current}
          generating={inspector.data?.generating ?? false}
        />
      ) : (
        <p className="text-sm text-muted">
          No draft for {agent.name}. Ask the coach to propose a change.
        </p>
      )}
    </div>
  );
}

function DraftReview({
  session,
  draft,
  generating,
}: {
  session: StudioSession;
  draft: StudioDraft;
  generating: boolean;
}) {
  const act = useDraftAction(session.id);
  const [confirm, setConfirm] = useState<"publish" | "discard" | null>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(draft.proposed_content);
  const reviewable = openDraft(draft) && session.status === "active";
  const name = draft.target_snapshot?.name ?? "the agent";

  const run = (action: "publish" | "discard" | "revise", content?: string) =>
    act
      .mutateAsync({ draftId: draft.id, action, ...(content !== undefined ? { content } : {}) })
      .then(
        () => {
          toast({
            kind: "success",
            title:
              action === "publish"
                ? `Published ${name}'s Task`
                : action === "discard"
                  ? "Draft discarded"
                  : "Draft revised",
          });
          setConfirm(null);
          setEditing(false);
        },
        (error: Error) => {
          toast({ kind: "error", title: "Couldn't update the draft", description: error.message });
          throw error;
        },
      );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-md font-semibold">
          Draft {draft.draft_number} for {name}
        </span>
        <Tag
          tone={
            draft.status === "conflicted" ? "plum" : draft.status === "draft" ? "signal" : "well"
          }
          font="sans"
        >
          {draft.status === "conflicted" ? "the live Task changed" : draft.status}
        </Tag>
        {draft.large_deletion ? (
          <Tag tone="ochre" font="sans">
            removes a lot
          </Tag>
        ) : null}
      </div>
      {draft.rationale ? <p className="text-sm text-fg-2">{draft.rationale}</p> : null}
      <DiffView
        lines={diffLines(draft.base_content, draft.proposed_content)}
        title={`task · v${draft.base_version} → draft`}
        defaultLayout="split"
      />
      {reviewable ? (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setConfirm("publish")} disabled={act.isPending}>
            Publish
          </Button>
          <Button variant="outline" onClick={() => setEditing(true)} disabled={act.isPending}>
            Edit
          </Button>
          <Button variant="ghost" onClick={() => setConfirm("discard")} disabled={act.isPending}>
            Discard
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        {...(confirm === "discard" ? { kind: "destructive" as const } : {})}
        title={confirm === "publish" ? `Publish this Task for ${name}?` : "Discard this draft?"}
        description={
          confirm === "publish"
            ? `It becomes ${name}'s live Task as a new version; the current one stays in its versions.${generating ? ` ${name} is running now and picks it up on its next run.` : ""}`
            : "The proposal is dropped; the live Task stays as it is."
        }
        confirmLabel={confirm === "publish" ? "Publish" : "Discard"}
        onConfirm={() => (confirm ? run(confirm) : undefined)}
      />
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent size="lg">
          <DialogHeader
            title="Edit the draft"
            description="Your version replaces the coach's proposal."
          />
          <DialogBody>
            <TextAreaField
              tone="surface"
              font="mono"
              aria-label="Proposed Task"
              rows={18}
              value={text}
              onChange={(event) => setText(event.currentTarget.value)}
            />
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button
              disabled={act.isPending || text === draft.proposed_content}
              onClick={() => void run("revise", text).catch(() => undefined)}
            >
              Save draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
