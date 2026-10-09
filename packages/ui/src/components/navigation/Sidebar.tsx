import { PanelLeftClose } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";
import { IconButton } from "../actions/IconButton";
import { BrandMark } from "../identity/BrandMark";

export type SidebarProps = Omit<ComponentProps<"nav">, "children"> & {
  /** Top-left; defaults to the brand mark with its wordmark. */
  brand?: ReactNode;
  /** Shows the retract button, which folds the sidebar into the collapsed rail. */
  onRetract?: () => void;
  /** The list header, a SidebarSection. */
  section: ReactNode;
  /** The guild list (GuildRows); it scrolls on its own. */
  children: ReactNode;
  /** Workspace tools (UtilityLinks), pinned under a rule. */
  footer?: ReactNode;
};

/** The full sidebar: brand, every guild with its agents, and the workspace tools. */
export function Sidebar({
  brand,
  onRetract,
  section,
  children,
  footer,
  className,
  ...props
}: SidebarProps) {
  return (
    <nav
      aria-label="Main"
      className={cn(
        "flex min-h-0 w-75 shrink-0 flex-col gap-1 overflow-hidden contain-paint rounded-2xl bg-surface px-3.5 pt-4 pb-2.5 text-fg shadow-float",
        className,
      )}
      {...props}
    >
      <div className="flex items-center gap-2 px-1 pb-1">
        {brand ?? <BrandMark size={28} wordmark />}
        {onRetract ? (
          <IconButton
            icon={PanelLeftClose}
            label="Retract navigation"
            variant="well"
            size={28}
            onClick={onRetract}
            className="ml-auto"
          />
        ) : null}
      </div>
      {section}
      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1 pt-1">
        {children}
      </div>
      {footer ? (
        <div className="flex flex-col gap-1 border-t border-line-2 pt-1.5">
          {footer}
        </div>
      ) : null}
    </nav>
  );
}
