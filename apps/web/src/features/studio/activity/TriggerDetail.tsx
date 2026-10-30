import { Link } from "@tanstack/react-router";
import { ExternalLink, History, MessageSquareText } from "lucide-react";
import { Button, Icon } from "@guildsrun/ui";
import { useStudio } from "../StudioContext";
import { clockWithDay, type Chain } from "./activityModel";
import { DetailHead, nodeName, Quoted, Section, sourceIcon, type ActivityData } from "./parts";

type TriggerDetailProps = {
  data: ActivityData;
  chain: Chain;
  onClose: () => void;
};

export function TriggerDetail({ data, chain, onClose }: TriggerDetailProps) {
  const { go, openStep, session } = useStudio();
  const { start } = chain;
  const { index } = data;
  const first = chain.steps[0]?.wake;
  if (start.kind === "routine") {
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
  if (start.kind === "direct") {
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
        {start.kind === "operator" ? (
          <Button asChild variant="outline" size="xs">
            <Link to="/guilds/$guildId" params={{ guildId: session.source_guild_id }}>
              <Icon icon={ExternalLink} size={14} />
              Open group chat
            </Link>
          </Button>
        ) : start.kind === "earlier" &&
          start.message.source_run_id &&
          start.message.author_agent_id ? (
          <Button
            variant="outline"
            size="xs"
            onClick={() =>
              start.message.source_run_id &&
              start.message.author_agent_id &&
              openStep({
                agentId: start.message.author_agent_id,
                runId: start.message.source_run_id,
              })
            }
          >
            <Icon icon={History} size={14} />
            Open the post
          </Button>
        ) : null}
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
