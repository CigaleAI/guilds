import { Link } from "@tanstack/react-router";
import { Plus, Sparkles, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { agentLook } from "../../app/agents";
import { Avatar, Icon, Tag, cn, identityHex } from "@guildsrun/ui";

const crew = [
  {
    name: "willow",
    shape: "critters:willow",
    color: identityHex.moss,
    size: 44,
    lift: "translate-y-2",
  },
  { name: "ada", shape: "cameo:ada", color: identityHex.signal, size: 64, lift: "-translate-y-1" },
  { name: "dollop", shape: "clay:dollop", color: identityHex.rosewood, size: 64, lift: "" },
  {
    name: "kite",
    shape: "cutouts:kite",
    color: identityHex.ochre,
    size: 64,
    lift: "-translate-y-1",
  },
  {
    name: "cube",
    shape: "voxel-bot:cube",
    color: identityHex.dusk,
    size: 44,
    lift: "translate-y-2",
  },
] as const;

const choiceClass =
  "flex h-full cursor-pointer flex-col gap-3 rounded-xl bg-surface p-5 text-left transition-colors hover:bg-paper-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

function ChoiceBody({
  icon,
  title,
  hint,
  hintTone,
  children,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
  hintTone: "well" | "signal";
  children: ReactNode;
}) {
  return (
    <>
      <div className="flex items-center gap-2">
        <Icon icon={icon} size={16} />
        <span className="text-lg font-semibold text-fg">{title}</span>
      </div>
      <p className="text-sm text-pretty text-muted">{children}</p>
      <Tag tone={hintTone} font="sans" className="mt-auto self-start">
        {hint}
      </Tag>
    </>
  );
}

/** The start with no guilds: a small DiceBear crew and two ways in. */
export function GuildEmptyState({ onCreateGuild }: { onCreateGuild: () => void }) {
  return (
    <div className="grid flex-1 place-items-center p-6">
      <div className="flex w-full max-w-xl flex-col items-center gap-8">
        <div className="flex items-end" aria-hidden>
          {crew.map((member, index) => {
            const look = agentLook({ avatar_shape: member.shape, avatar_color: member.color });
            return (
              <Avatar
                key={member.shape}
                name={member.name}
                tone={look.tone}
                size={member.size}
                {...(look.src ? { src: look.src } : {})}
                className={cn(
                  "border-[2.5px] border-paper",
                  index > 0 && "-ml-3",
                  member.lift,
                  index === 2 && "z-10",
                )}
              />
            );
          })}
        </div>
        <div className="flex max-w-md flex-col items-center gap-2 text-center">
          <h1 className="text-xl font-semibold text-fg">No guilds yet</h1>
          <p className="text-sm text-pretty text-muted">
            A guild is a room of agents that share a job. Start one yourself, or let the Builder
            draft it.
          </p>
        </div>
        <div className="grid w-full gap-3 sm:grid-cols-2">
          <button type="button" className={choiceClass} onClick={onCreateGuild}>
            <ChoiceBody icon={Plus} title="Create a guild" hint="Full control" hintTone="well">
              Name it, write what it is for, and add every agent yourself.
            </ChoiceBody>
          </button>
          <Link to="/builder" className={choiceClass}>
            <ChoiceBody icon={Sparkles} title="Use Builder" hint="Quick start" hintTone="signal">
              Describe the outcome in a sentence and the Builder drafts the crew.
            </ChoiceBody>
          </Link>
        </div>
      </div>
    </div>
  );
}
