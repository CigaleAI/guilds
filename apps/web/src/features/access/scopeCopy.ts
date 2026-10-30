import type { AccessOwner } from "../../api/types/access";

/** The words and links an access view uses for the scope it edits. */
export type ScopeCopy = {
  /** "this agent", "this guild", "the organisation". */
  subject: string;
  /** What a switch here decides, and what it overrides. */
  switchesIntro: string;
};

export function scopeCopy(owner: AccessOwner): ScopeCopy {
  switch (owner.scope) {
    case "agent":
      return {
        subject: "this agent",
        switchesIntro:
          "Switches here set this agent's own choice over what it inherits from its guild, organisation and the platform.",
      };
    case "guild":
      return {
        subject: "this guild",
        switchesIntro:
          "Switches here set the choice for this guild's agents over what it inherits from the organisation and the platform; each agent can still override it.",
      };
    case "org":
      return {
        subject: "the organisation",
        switchesIntro:
          "Switches here set the organisation's choice over the platform's defaults; guilds and agents can still override it.",
      };
  }
}
