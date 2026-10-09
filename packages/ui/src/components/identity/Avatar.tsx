import type { ComponentProps } from "react";
import { cn } from "../../cn";
import { identityFill, initialsOf, type IdentityTone } from "../../identity";
import { Tile } from "../../primitives/Tile";

export type AvatarSize = 24 | 28 | 32 | 36 | 44 | 64;

export type AvatarProps = Omit<ComponentProps<"span">, "children"> & {
  /** Handle or person name; supplies the initials and the accessible name. */
  name: string;
  tone: IdentityTone;
  size?: AvatarSize;
  /** Mascot art, drawn in the identity colour; it sits on a neutral tile so the colour reads. */
  src?: string;
  /** Override the two-letter initials. */
  initials?: string;
  /** People (operators) are round; agents are square tiles. */
  round?: boolean;
};

/** An agent or person: their identity colour holding initials or mascot art. */
export function Avatar({ name, tone, size = 36, src, initials, round, className, ...props }: AvatarProps) {
  return (
    <Tile
      size={size}
      role="img"
      aria-label={name}
      title={name}
      className={cn(src ? "bg-well text-fg" : identityFill[tone], round && "rounded-full", className)}
      {...props}
    >
      {src ? (
        <img src={src} alt="" className="size-full object-cover" draggable={false} />
      ) : (
        <span aria-hidden>{initials ?? initialsOf(name)}</span>
      )}
    </Tile>
  );
}
