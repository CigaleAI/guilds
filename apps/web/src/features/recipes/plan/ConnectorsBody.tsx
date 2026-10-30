import { ChevronDown, Globe, KeyRound, Plug, Trash2, Undo2 } from "lucide-react";
import { Button, Markdown, ToolRow, cn, Icon, Tag } from "@guildsrun/ui";
import { connectorLogo } from "../../access/connectorLogo";
import type { RecipePlan } from "./planModel";
import { accessSection, connectionCard, secretCard, type CatalogEntry } from "./planConnectors";
import type { PlanHooks } from "./PlanView";
import { ReviewerTag } from "./ReviewerTag";

type ConnectorsBodyProps = {
  plan: RecipePlan;
  catalog: readonly CatalogEntry[] | undefined;
  hooks: PlanHooks;
};

export function ConnectorsBody({ plan, catalog, hooks }: ConnectorsBodyProps) {
  const { access } = hooks;
  const { systems } = accessSection(plan);
  return (
    <div className="flex flex-col gap-3">
      {plan.connections.map((connection) => {
        const card = connectionCard(connection, plan, catalog, access?.pending ?? null);
        const removed = access?.pending.removed.has(card.server) ?? false;
        return (
          <article
            key={card.server}
            className={cn(
              "flex flex-col gap-2.5 rounded-xl bg-surface p-4",
              removed && "opacity-60",
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              {connectorLogo(
                catalog?.find((entry) => (entry.slug ?? entry.server) === card.server)?.logo_url,
                "size-4 text-muted",
              ) ?? <Icon icon={Plug} size={16} className="text-muted" />}
              <span className="font-mono text-sm font-semibold">{card.server}</span>
              <Tag tone={card.chip.tone === "ok" ? "tide" : "signal"} font="sans">
                {removed ? "removed" : card.chip.label}
              </Tag>
              {card.reviewer ? <ReviewerTag by={card.reviewer} /> : null}
              {access ? (
                <Button
                  variant="ghost"
                  size="xs"
                  className="ml-auto"
                  disabled={access.disabled}
                  onClick={() => access.onRemoveConnection(card.server, !removed)}
                >
                  <Icon icon={removed ? Undo2 : Trash2} size={14} />
                  {removed ? "Keep" : "Remove"}
                </Button>
              ) : null}
            </div>
            {card.description ? (
              <Markdown density="compact">{card.description}</Markdown>
            ) : card.snippet ? (
              <p className="text-sm text-fg-2">{card.snippet}</p>
            ) : null}
            <p className="text-xs text-muted">{card.meta}</p>
            {hooks.connectionExtras?.(card.server)}
            {card.resources.length ? (
              <ul className="flex flex-col gap-0.5 text-xs text-fg-2">
                {card.resources.map((resource) => (
                  <li key={resource}>{resource}</li>
                ))}
              </ul>
            ) : null}
            {!removed ? (
              card.tools.groups.length ? (
                card.tools.groups.map((group) => (
                  <details key={group.role} className="group rounded-lg bg-paper">
                    <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2.5 text-sm">
                      <span className="font-medium">{group.title}</span>
                      <span className="text-xs text-muted">
                        {group.tools.filter((tool) => tool.enabled).length} of {group.tools.length}{" "}
                        on
                      </span>
                      <Icon
                        icon={ChevronDown}
                        size={14}
                        className="ml-auto text-muted transition-transform group-open:rotate-180"
                      />
                    </summary>
                    <div className="border-t border-line">
                      {group.tools.map((tool) => (
                        <ToolRow
                          key={tool.name}
                          name={tool.name}
                          enabled={tool.enabled}
                          disabled={!access || Boolean(access.disabled)}
                          onEnabledChange={(enabled) =>
                            access?.onToolChange(card.server, group.role, tool.name, enabled)
                          }
                        />
                      ))}
                    </div>
                  </details>
                ))
              ) : card.tools.empty ? (
                <p className="text-xs text-muted">{card.tools.empty}</p>
              ) : null
            ) : null}
          </article>
        );
      })}
      {plan.secrets.map((secret) => {
        const card = secretCard(secret);
        return (
          <article
            key={card.name}
            className="flex items-center gap-3 rounded-xl bg-surface px-4 py-3"
          >
            <Icon icon={KeyRound} size={16} className="shrink-0 text-muted" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="font-mono text-sm font-semibold">{card.name}</span>
              {card.snippet ? <span className="text-xs text-fg-2">{card.snippet}</span> : null}
            </div>
            <Tag tone="well" font="sans">
              secret
            </Tag>
          </article>
        );
      })}
      {systems.map((system) => (
        <article
          key={`${system.name}:${system.server ?? ""}`}
          className="flex flex-col gap-1 rounded-xl bg-surface px-4 py-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Icon icon={Globe} size={16} className="text-muted" />
            <span className="text-sm font-semibold">{system.name}</span>
            <Tag tone="well" font="sans">
              {system.resolution}
            </Tag>
          </div>
          {system.reason ? <p className="text-sm text-fg-2">{system.reason}</p> : null}
        </article>
      ))}
    </div>
  );
}
