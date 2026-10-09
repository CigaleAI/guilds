import { Plus } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";
import { Divider } from "../../primitives/Divider";
import { BrandMark } from "../identity/BrandMark";
import { RailItem } from "./RailItem";

export type CollapsedRailProps = Omit<ComponentProps<"nav">, "children"> & {
  /** Clicking the brand mark reopens the full sidebar. */
  onExpand?: () => void;
  /** Guild tiles (RailItems); they scroll when they outgrow the rail. */
  guilds: ReactNode;
  /** Shows the dashed create-guild tile after the guilds. */
  onCreateGuild?: () => void;
  /** Workspace tool tiles (RailItems), under a divider. */
  tools?: ReactNode;
  /** Pinned to the bottom: the settings tile and the account avatar. */
  footer?: ReactNode;
};

/** The retracted sidebar: brand, one tile per guild, the workspace tools and the account. */
export function CollapsedRail({
  onExpand,
  guilds,
  onCreateGuild,
  tools,
  footer,
  className,
  ...props
}: CollapsedRailProps) {
  return (
    <nav
      aria-label="Main"
      className={cn(
        "flex min-h-0 w-18 shrink-0 flex-col items-center gap-2 overflow-hidden contain-paint rounded-xl bg-surface py-4 text-fg",
        className,
      )}
      {...props}
    >
      {onExpand ? (
        <button
          type="button"
          onClick={onExpand}
          aria-label="Expand navigation"
          className="mb-2 flex shrink-0 cursor-pointer rounded-md p-1.5 transition-colors hover:bg-well"
        >
          <BrandMark size={32} aria-hidden />
        </button>
      ) : (
        <BrandMark size={32} className="mx-1.5 mt-1.5 mb-3.5" />
      )}
      <div className="flex min-h-0 w-full shrink flex-col items-center gap-2 overflow-y-auto py-1">
        {guilds}
        {onCreateGuild ? (
          <RailItem tone="add" icon={Plus} label="Create guild" onClick={onCreateGuild} />
        ) : null}
      </div>
      {tools ? (
        <>
          <Divider className="my-1 w-7 bg-line-3" />
          {tools}
        </>
      ) : null}
      {footer ? (
        <div className="mt-auto flex flex-col items-center gap-2 pt-6">{footer}</div>
      ) : null}
    </nav>
  );
}
