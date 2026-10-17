export class GuildInactive extends Error {
  constructor(message = "guild is archived") {
    super(message);
    this.name = "GuildInactive";
  }
}

export class AgentMessageLimitReached extends Error {
  limit: number;

  constructor(limit: number) {
    super(`group chat is waiting for a user message after ${limit} consecutive agent messages`);
    this.name = "AgentMessageLimitReached";
    this.limit = limit;
  }
}

export class GroupChatCleared extends Error {
  constructor(message = "group chat was cleared after this run started") {
    super(message);
    this.name = "GroupChatCleared";
  }
}

export class LastGuildAdmin extends Error {
  constructor(message = "a guild needs at least one admin") {
    super(message);
    this.name = "LastGuildAdmin";
  }
}

// Agents and operators share the guild's tag namespace, so a name can
// belong to only one of them within a guild.
export class GuildNameTaken extends Error {
  constructor(name: string, holder: "agent" | "operator") {
    super(`${name} is already ${holder === "agent" ? "an agent" : "an operator"} in this guild`);
    this.name = "GuildNameTaken";
  }
}

// A secret's name is its environment variable, unique in its organisation.
export class SecretNameTaken extends Error {
  secretName: string;

  constructor(name: string) {
    super(`${name} already exists in this organisation`);
    this.name = "SecretNameTaken";
    this.secretName = name;
  }
}

// A machine change or an agent placement the organisation's machines refuse: a full machine, a
// machine below an agent's minimum, a name already taken, a machine that still hosts agents.
export class MachineConflict extends Error {
  status: number;

  constructor(status: 409 | 422 | 404, message: string) {
    super(message);
    this.name = "MachineConflict";
    this.status = status;
  }
}
