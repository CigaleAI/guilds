import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";
import type { IdentityTone } from "../../identity";
import { Tile } from "../../primitives/Tile";
import { Avatar } from "./Avatar";

export type AvatarStackMember = {
  /** Stable id when the tile opens something, such as an agent's inspector. */
  id?: string;
  name: string;
  tone: IdentityTone;
  src?: string;
  /** People (operators) are round; agents are square tiles. */
  round?: boolean;
};

/** The colour the stack sits on; every avatar is ringed in it. */
export type AvatarStackRing = "plum" | "surface" | "paper";

export type AvatarStackSize = 36 | 44;

const ringBorder: Record<AvatarStackRing, string> = {
  plum: "border-plum",
  surface: "border-surface",
  paper: "border-paper",
};

const overflowFill: Record<AvatarStackRing, string> = {
  plum: "bg-dusk text-on-plum",
  surface: "bg-well text-fg",
  paper: "bg-well text-fg",
};

const captionTone: Record<AvatarStackRing, string> = {
  plum: "text-on-plum-muted",
  surface: "text-fg-2",
  paper: "text-fg-2",
};

export type AvatarStackProps = ComponentProps<"div"> & {
  members: AvatarStackMember[];
  ring?: AvatarStackRing;
  size?: AvatarStackSize;
  /** Show at most this many avatars; the rest collapse into a "+N" tile. */
  max?: number;
  /** Trailing text, such as "4 of 15 seats". */
  caption?: ReactNode;
  /** When set, each visible avatar is a button that opens that member. */
  onMemberSelect?: (member: AvatarStackMember) => void;
};

/**
 * The agents (or people) of a guild as overlapping tiles. The ring sits inside each tile, so the
 * next tile covers ring and margin but never the initials.
 */
export function AvatarStack({
  members,
  ring = "surface",
  size = 36,
  max,
  caption,
  onMemberSelect,
  className,
  ...props
}: AvatarStackProps) {
  const visible = max !== undefined && members.length > max ? members.slice(0, max) : members;
  const hidden = members.length - visible.length;
  const ringClass = cn("border-[2.5px]", ringBorder[ring]);

  return (
    <div
      role="group"
      className={cn("inline-flex min-w-0 items-center gap-3.5", className)}
      {...props}
    >
      <span className="flex shrink-0">
        {visible.map((member, index) =>
          onMemberSelect ? (
            <button
              key={member.id ?? `${member.name}-${index}`}
              type="button"
              aria-label={`Open ${member.name}`}
              title={`Open ${member.name}`}
              onClick={() => onMemberSelect(member)}
              className={cn(
                "relative cursor-pointer bg-transparent p-0",
                size === 44 ? "rounded-lg" : "rounded-md",
                member.round && "rounded-full",
                index > 0 && "-ml-2",
                "hover:z-10 focus-visible:z-10",
              )}
            >
              <Avatar
                name={member.name}
                tone={member.tone}
                size={size}
                {...(member.src ? { src: member.src } : {})}
                round={member.round ?? false}
                className={ringClass}
                aria-hidden
              />
            </button>
          ) : (
            <Avatar
              key={member.id ?? `${member.name}-${index}`}
              name={member.name}
              tone={member.tone}
              size={size}
              {...(member.src ? { src: member.src } : {})}
              round={member.round ?? false}
              className={cn(ringClass, index > 0 && "-ml-2")}
            />
          ),
        )}
        {hidden > 0 ? (
          <Tile
            size={size}
            role="img"
            aria-label={`${hidden} more`}
            title={members
              .slice(visible.length)
              .map((member) => member.name)
              .join(", ")}
            className={cn(ringClass, overflowFill[ring], visible.length > 0 && "-ml-2")}
          >
            <span aria-hidden>+{hidden}</span>
          </Tile>
        ) : null}
      </span>
      {caption !== undefined ? (
        <span className={cn("min-w-0 truncate text-sm", captionTone[ring])}>{caption}</span>
      ) : null}
    </div>
  );
}
