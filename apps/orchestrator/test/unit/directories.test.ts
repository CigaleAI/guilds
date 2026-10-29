import assert from "node:assert/strict";
import { test } from "node:test";
import { collectDirectoryListing } from "../../src/directories/index.js";

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
    listPrivateNotes() {
      return this.private;
    },
    listSharedNotes() {
      return this.shared;
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
