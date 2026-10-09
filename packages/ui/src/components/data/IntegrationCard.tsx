import { cva } from "class-variance-authority";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";
import { Tile } from "../../primitives/Tile";
import { Button } from "../actions/Button";
import { OnOffSwitch, type BindingOrigin } from "../controls/OnOffSwitch";
import { bindingCaption } from "./ToolRow";

/** The login state of an MCP connection. */
export type ConnectionStatus = "connected" | "pending" | "disconnected";

const statusLabel: Record<ConnectionStatus, string> = {
  connected: "Connected",
  pending: "Pending",
  disconnected: "Disconnected",
};

const statusBadge = cva(
  "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-2xs font-bold whitespace-nowrap",
  {
    variants: {
      status: {
        connected: "bg-t-tide text-t-tide-fg",
        pending: "bg-t-ochre text-t-ochre-fg",
        disconnected: "bg-t-plum text-plum-t",
      },
    },
  },
);

const statusDot: Record<ConnectionStatus, string> = {
  connected: "bg-tide",
  pending: "bg-ochre",
  disconnected: "bg-plum",
};

const logoTile = {
  panel: "bg-panel text-signal-soft",
  plum: "bg-plum text-on-plum",
  tide: "bg-tide text-on-plum",
  dusk: "bg-dusk text-on-plum",
  signal: "bg-signal text-on-signal",
  paper: "bg-paper-hi text-fg",
} as const;

export type IntegrationLogoTone = keyof typeof logoTile;

const cardTone = {
  paper: { card: "bg-paper", toolsButton: "bg-surface hover:bg-well", body: "bg-surface" },
  surface: { card: "bg-surface", toolsButton: "bg-paper hover:bg-paper-hi", body: "bg-paper" },
} as const;

export type IntegrationCardProps = Omit<ComponentProps<"article">, "children"> & {
  name: string;
  description?: ReactNode;
  /** Logo art for the 44px tile; without it the tile holds the name's first letter. */
  logo?: ReactNode;
  logoTone?: IntegrationLogoTone;
  /** Omit for tools the platform serves without a login. */
  status?: ConnectionStatus;
  /** The signed-in account, shown in place of the status word in the caption. */
  accountHint?: string;
  /** Effective state after org → guild → agent resolution. */
  enabled: boolean;
  /** Scope whose binding decided the effective state. */
  source?: string;
  origin?: BindingOrigin;
  /** Omit for a login that is not switched per scope; the card then has no On/Off. */
  onEnabledChange?: (enabled: boolean) => void;
  switchDisabled?: boolean;
  /** Login actions before the tools toggle, such as Connect or Disconnect. */
  actions?: ReactNode;
  /** Active and total tools; shows the tools toggle when present. */
  tools?: { active: number; total: number };
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** The card's fill: paper on a surface ground, surface on a paper ground. */
  tone?: keyof typeof cardTone;
  /** Settings of the login itself, shown under the header, such as the coins a price feed quotes. */
  settings?: ReactNode;
  /** The expanded tool list: a filter bar and tool rows. */
  children?: ReactNode;
};

/** An integration (MCP server) at one scope: login state, inherited On/Off, and its tools behind a toggle. */
export function IntegrationCard({
  name,
  description,
  logo,
  logoTone = "panel",
  status,
  accountHint,
  enabled,
  source,
  origin,
  onEnabledChange,
  switchDisabled,
  actions,
  tools,
  expanded = false,
  onExpandedChange,
  tone = "paper",
  settings,
  children,
  className,
  ...props
}: IntegrationCardProps) {
  const bodyId = useId();
  const palette = cardTone[tone];
  const caption = [
    onEnabledChange ? bindingCaption(enabled, source) : null,
    accountHint ?? (status ? statusLabel[status].toLowerCase() : null),
  ]
    .filter(Boolean)
    .join(" · ");
  const showBody = expanded && children !== undefined && children !== null;

  return (
    <article
      className={cn("@container min-w-0 rounded-xl text-fg", palette.card, className)}
      {...props}
    >
      <div className="flex min-w-0 flex-col gap-3 p-4 @2xl:flex-row @2xl:items-start @2xl:gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-3.5">
          <Tile size={44} className={cn("text-xl", logoTile[logoTone])} aria-hidden>
            {logo ?? name.trim().charAt(0).toUpperCase()}
          </Tile>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="min-w-0 truncate text-lg font-semibold">{name}</h3>
              {status ? (
                <span className={statusBadge({ status })}>
                  <span className={cn("size-1.5 rounded-full", statusDot[status])} aria-hidden />
                  {statusLabel[status]}
                </span>
              ) : null}
            </div>
            <span className="text-xs text-muted">{caption}</span>
            {description ? <div className="text-md text-fg-2">{description}</div> : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-start gap-2">
          {actions}
          {tools ? (
            <Button
              variant={expanded ? "primary" : "secondary"}
              size="md"
              className={cn(!expanded && palette.toolsButton)}
              aria-expanded={expanded}
              aria-controls={showBody ? bodyId : undefined}
              onClick={() => onExpandedChange?.(!expanded)}
            >
              {tools.active}/{tools.total} tools
              <Icon icon={expanded ? ChevronDown : ChevronRight} size={14} />
            </Button>
          ) : null}
          {onEnabledChange ? (
            <OnOffSwitch
              label={name}
              value={enabled}
              onValueChange={onEnabledChange}
              disabled={switchDisabled ?? false}
              className="ml-auto @2xl:ml-0"
              {...(origin ? { origin } : {})}
            />
          ) : null}
        </div>
      </div>
      {settings ? <div className="px-4 pb-4">{settings}</div> : null}
      {showBody ? (
        <div id={bodyId} className={cn("mx-2 mb-2 overflow-hidden rounded-lg", palette.body)}>
          {children}
        </div>
      ) : null}
    </article>
  );
}
