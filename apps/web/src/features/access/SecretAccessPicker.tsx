import { useAgentsByGuild, useGuilds } from "../../api/queries";
import type { SecretAccessChoice } from "../../api/types";
import { Checkbox, Toggle } from "@guildsrun/ui";

function withId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? [...ids] : [...ids, id];
}

function withoutId(ids: readonly string[], id: string): string[] {
  return ids.filter((item) => item !== id);
}

/**
 * Who gets a secret: organisation-wide (owners and admins only), or any set of the guilds the
 * viewer can see and their agents. Grants add up; an agent gets the secret through its guild or itself.
 */
export function SecretAccessPicker({
  value,
  onChange,
  allowOrgWide,
  disabled = false,
}: {
  value: SecretAccessChoice;
  onChange: (value: SecretAccessChoice) => void;
  allowOrgWide: boolean;
  disabled?: boolean;
}) {
  const guilds = useGuilds().data ?? [];
  const agentsByGuild = useAgentsByGuild(guilds.map((guild) => guild.id));

  return (
    <fieldset className="flex flex-col gap-3" disabled={disabled}>
      <legend className="mb-1 text-sm font-semibold text-fg">Available to</legend>
      {allowOrgWide ? (
        <Toggle
          label="Every agent in the organisation"
          description="Otherwise only the guilds and agents picked below get it."
          checked={value.org_wide}
          onCheckedChange={(checked) => onChange({ ...value, org_wide: checked })}
          disabled={disabled}
        />
      ) : null}
      {value.org_wide ? null : (
        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto rounded-xl bg-surface px-3.5 py-3">
          {guilds.length === 0 ? (
            <p className="text-sm text-muted">No guilds to grant it to.</p>
          ) : (
            guilds.map((guild) => {
              const agents = agentsByGuild.get(guild.id) ?? [];
              return (
                <div key={guild.id} className="flex flex-col gap-0.5">
                  <Checkbox
                    label={
                      <span>
                        {guild.name}{" "}
                        <span className="text-xs text-muted">· every agent in the guild</span>
                      </span>
                    }
                    checked={value.guild_ids.includes(guild.id)}
                    onCheckedChange={(checked) =>
                      onChange({
                        ...value,
                        guild_ids:
                          checked === true
                            ? withId(value.guild_ids, guild.id)
                            : withoutId(value.guild_ids, guild.id),
                      })
                    }
                  />
                  {agents.map((agent) => (
                    <Checkbox
                      key={agent.id}
                      className="pl-6"
                      label={agent.name}
                      checked={
                        value.guild_ids.includes(guild.id) || value.agent_ids.includes(agent.id)
                      }
                      disabled={value.guild_ids.includes(guild.id)}
                      onCheckedChange={(checked) =>
                        onChange({
                          ...value,
                          agent_ids:
                            checked === true
                              ? withId(value.agent_ids, agent.id)
                              : withoutId(value.agent_ids, agent.id),
                        })
                      }
                    />
                  ))}
                </div>
              );
            })
          )}
        </div>
      )}
    </fieldset>
  );
}
