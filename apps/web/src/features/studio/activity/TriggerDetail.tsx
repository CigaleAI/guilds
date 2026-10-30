import { Link } from "@tanstack/react-router";
import { ExternalLink, History, MessageSquareText } from "lucide-react";
import type { ActivityWake } from "../../../api/types/studio";
import { Button, Icon } from "@guildsrun/ui";
import { useStudio } from "../StudioContext";
import { clockWithDay, type ActivityIndex, type Chain, type ChainStartOf } from "./activityModel";
import { DetailHead, nodeName, Quoted, Section, sourceIcon, type ActivityData } from "./parts";

type TriggerDetailProps = {
  data: ActivityData;
  chain: Chain;
  onClose: () => void;
};

/** What started a chain: a routine's firing, a direct chat, or a message. */
export function TriggerDetail({ data, chain, onClose }: TriggerDetailProps) {
  const { start } = chain;
  const { index } = data;
  if (start.kind === "routine") {
    return <RoutineTriggerDetail start={start} index={index} onClose={onClose} />;
  }
  if (start.kind === "direct") {
    return (
      <DirectTriggerDetail
        start={start}
        first={chain.steps[0]?.wake}
        index={index}
        onClose={onClose}
      />
    );
  }
  return <MessageTriggerDetail start={start} onClose={onClose} />;
}

type RoutineTriggerDetailProps = {
  start: ChainStartOf<"routine">;
  index: ActivityIndex;
  onClose: () => void;
};

/** A routine's firing: the routine, when it fired, and its instruction. */
function RoutineTriggerDetail({ start, index, onClose }: RoutineTriggerDetailProps) {
  const { go } = useStudio();
  const routine = start.scheduleId ? index.routines.get(start.scheduleId) : undefined;
  return (
    <div className="flex max-w-3xl flex-col gap-2">
      <DetailHead onClose={onClose}>
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Icon icon={sourceIcon.routine} size={16} className="text-muted" />
          {routine?.description || "A routine no longer listed"}
        </span>
        <span className="text-xs text-muted">
          {[routine?.label, `fired ${clockWithDay(start.at)}`].filter(Boolean).join(" · ")}
        </span>
        {routine ? (
          <Button
            variant="outline"
            size="xs"
            onClick={() =>
              go({
                section: "agents",
                agent: routine.agent_id,
                tab: "routines",
                item: routine.id,
              })
            }
          >
            Open routine
          </Button>
        ) : null}
      </DetailHead>
      <Section title="Instruction">
        {routine?.instruction ? (
          <Quoted>{routine.instruction}</Quoted>
        ) : (
          <p className="text-xs text-muted">Not listed any more.</p>
        )}
      </Section>
    </div>
  );
}

type DirectTriggerDetailProps = {
  start: ChainStartOf<"direct">;
  /** The chain's first wake, the agent's answer to the chat. */
  first: ActivityWake | undefined;
  index: ActivityIndex;
  onClose: () => void;
};

/** A direct chat: the agent it was with, when, and its opening message. */
function DirectTriggerDetail({ start, first, index, onClose }: DirectTriggerDetailProps) {
  const { openStep } = useStudio();
  return (
    <div className="flex max-w-3xl flex-col gap-2">
      <DetailHead onClose={onClose}>
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Icon icon={sourceIcon.direct} size={16} className="text-muted" />
          Direct chat with {nodeName(index, first?.agent_id ?? "")}
        </span>
        <span className="text-xs text-muted">{clockWithDay(start.at)}</span>
        {first ? (
          <Button
            variant="outline"
            size="xs"
            onClick={() => openStep({ agentId: first.agent_id, runId: first.run_id })}
          >
            <Icon icon={History} size={14} />
            Open in History
          </Button>
        ) : null}
      </DetailHead>
      <Section title="Opening message">
        {first?.opening ? (
          <Quoted>{first.opening}</Quoted>
        ) : (
          <p className="text-xs text-muted">Not in this window.</p>
        )}
      </Section>
    </div>
  );
}

type MessageTriggerDetailProps = {
  start: ChainStartOf<"operator" | "earlier" | "unknown">;
  onClose: () => void;
};

/** A message: the operator's, an agent's post from before the window, or one outside it. */
function MessageTriggerDetail({ start, onClose }: MessageTriggerDetailProps) {
  const message = start.kind === "operator" || start.kind === "earlier" ? start.message : null;
  return (
    <div className="flex max-w-3xl flex-col gap-2">
      <DetailHead onClose={onClose}>
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Icon
            icon={start.kind === "operator" ? sourceIcon.operator : MessageSquareText}
            size={16}
            className="text-muted"
          />
          {start.kind === "operator"
            ? `Your message #${start.message.seq}`
            : start.kind === "earlier"
              ? `${start.message.author_name}'s post #${start.message.seq}, from before this window`
              : "A message outside the window"}
        </span>
        <span className="text-xs text-muted">
          {[
            clockWithDay(start.at),
            message?.tagged.length
              ? `tagged ${message.tagged.map((name) => `@${name}`).join(" ")}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        <MessageTriggerLink start={start} />
      </DetailHead>
      {message ? (
        <Section title="Message">
          <Quoted>{message.preview}</Quoted>
          {message.length > message.preview.length ? (
            <span className="text-xs text-muted">
              Shortened here; the group chat has all of it.
            </span>
          ) : null}
        </Section>
      ) : null}
    </div>
  );
}

type MessageTriggerLinkProps = { start: ChainStartOf<"operator" | "earlier" | "unknown"> };

/** Where a message opens: the group chat for the operator's, the run that posted an agent's. */
function MessageTriggerLink({ start }: MessageTriggerLinkProps) {
  const { openStep, session } = useStudio();
  if (start.kind === "operator") {
    return (
      <Button asChild variant="outline" size="xs">
        <Link to="/guilds/$guildId" params={{ guildId: session.source_guild_id }}>
          <Icon icon={ExternalLink} size={14} />
          Open group chat
        </Link>
      </Button>
    );
  }
  if (start.kind !== "earlier") return null;
  const { source_run_id: runId, author_agent_id: agentId } = start.message;
  if (!runId || !agentId) return null;
  return (
    <Button variant="outline" size="xs" onClick={() => openStep({ agentId, runId })}>
      <Icon icon={History} size={14} />
      Open the post
    </Button>
  );
}
