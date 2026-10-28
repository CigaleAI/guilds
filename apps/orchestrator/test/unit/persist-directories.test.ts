import assert from "node:assert/strict";
import { test } from "node:test";
import { persistAgent } from "../../src/agents/persist.js";
import { persistGuild } from "../../src/guilds/persist.js";
import { collectDirectoryListing } from "../../src/directories/index.js";
import { agentConfig } from "../helpers/generation.js";

class FakeDB {
  guilds = new Map<string, string>();
  agents = new Map<string, unknown>();
  deletedGuilds: string[] = [];
  deletedAgents: string[] = [];
  orgId = "";
  about = "";
  description = "";

  async insertGuild(input: {
    guildId: string;
    name: string;
    orgId: string;
    about?: string | undefined;
    description?: string | undefined;
  }) {
    this.guilds.set(input.guildId, input.name);
    this.orgId = input.orgId;
    this.about = input.about ?? "";
    this.description = input.description ?? "";
  }
  async deleteGuild(guildId: string) {
    this.guilds.delete(guildId);
    this.deletedGuilds.push(guildId);
  }
  async addAgent(input: {
    agentId: string;
    guildId: string;
    name: string;
    focus?: string | undefined;
    wakeTriggers?: string | undefined;
    avatarShape?: string | undefined;
    avatarColor?: string | undefined;
  }) {
    this.agents.set(input.agentId, [
      input.guildId,
      input.name,
      input.focus ?? "",
      input.wakeTriggers ?? "",
      input.avatarShape ?? "teardrop",
      input.avatarColor ?? "#7c5cff",
    ]);
  }
  async deleteAgent(agentId: string) {
    this.agents.delete(agentId);
    this.deletedAgents.push(agentId);
  }
}

class BoomNotes {
  async createGuild() {
    throw new Error("notes failed");
  }
  async createAgent() {
    throw new Error("notes failed");
  }
}

class RecordingNotes {
  created: Array<[string, string, string, string]> = [];
  async createGuild() {}
  async createAgent(orgSlug: string, guildName: string, name: string, task = "") {
    this.created.push([orgSlug, guildName, name, task]);
  }
}

test("guild persist deletes row when notes fails", async () => {
  const db = new FakeDB();
  await assert.rejects(
    () =>
      persistGuild(db, new BoomNotes(), {
        guildId: "guild_1",
        name: "research",
        now: new Date(),
        orgId: "org_1",
        orgSlug: "acme",
        creatorUserId: "user_1",
      }),
    /notes failed/,
  );
  assert.equal(db.guilds.size, 0);
  assert.deepEqual(db.deletedGuilds, ["guild_1"]);
});

test("agent persist deletes row when notes fails", async () => {
  const db = new FakeDB();
  await assert.rejects(
    () =>
      persistAgent(db, new BoomNotes(), {
        agentId: "a_1",
        guildId: "guild_1",
        guildName: "research",
        orgSlug: "acme",
        name: "researcher",
        config: agentConfig({ model: "openrouter/x" }),
        now: new Date(),
      }),
    /notes failed/,
  );
  assert.equal(db.agents.size, 0);
  assert.deepEqual(db.deletedAgents, ["a_1"]);
});

test("agent persist seeds task from focus", async () => {
  const db = new FakeDB();
  const notes = new RecordingNotes();
  await persistAgent(db, notes, {
    agentId: "a_1",
    guildId: "guild_1",
    guildName: "research",
    orgSlug: "acme",
    name: "researcher",
    config: agentConfig({ model: "openrouter/x" }),
    now: new Date(),
    focus: "read papers",
  });
  assert.deepEqual(notes.created, [["acme", "research", "researcher", "read papers"]]);
});

test("guild persist stores the description on the guild row", async () => {
  const db = new FakeDB();
  const notes = new RecordingNotes();
  await persistGuild(db, notes, {
    guildId: "guild_1",
    name: "research",
    now: new Date(),
    orgId: "org_1",
    orgSlug: "acme",
    about: "weekly synthesis",
    description: "Track papers and post a digest.",
    creatorUserId: "user_1",
  });
  assert.equal(db.about, "weekly synthesis");
  assert.equal(db.description, "Track papers and post a digest.");
  assert.equal(db.guilds.get("guild_1"), "research");
});

test("directory listing omits memory archive and includes scripts", () => {
  const notes = {
    private: [
      "orgs/acme/guilds/research/agents/researcher/notes/alpha.md",
      "orgs/acme/guilds/research/agents/researcher/notes/history-archive/",
      "orgs/acme/guilds/research/agents/researcher/notes/history-archive/2026-09-13T09-00-12Z-r_ab12cd.md",
      "orgs/acme/guilds/research/agents/researcher/notes/memory-archive/",
      "orgs/acme/guilds/research/agents/researcher/notes/memory-archive/2026-09-13T09-00-12Z-r_ab12cd.md",
    ],
    shared: [] as string[],
    listNotes(scope: "private" | "shared") {
      return scope === "private" ? this.private : this.shared;
    },
  };
  const listing = collectDirectoryListing(notes, "acme", "research", "researcher", {
    scripts: [
      {
        name: "send_usdc",
        description: "Sign and send USDC",
        parameters: { type: "object" },
      },
    ],
    secrets: [
      {
        id: "sec_1",
        name: "WALLET_PRIVATE_KEY",
        description: "Solana treasury; signs USDC sends",
      },
    ],
  });
  assert.deepEqual(listing.private, [
    "orgs/acme/guilds/research/agents/researcher/notes/alpha.md",
  ]);
  assert.deepEqual(listing.scripts, [
    {
      name: "send_usdc",
      description: "Sign and send USDC",
      parameters: { type: "object" },
    },
  ]);
  assert.deepEqual(listing.environment, [
    {
      name: "WALLET_PRIVATE_KEY",
      description: "Solana treasury; signs USDC sends",
    },
  ]);
  assert.equal("workspace" in listing, false);
});
