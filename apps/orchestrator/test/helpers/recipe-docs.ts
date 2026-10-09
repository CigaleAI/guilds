import type { CollectionColumn } from "../../src/artifacts/columns.js";
import { DEFAULT_MODEL } from "../../src/llm/catalog.js";
import { emptyRecipe } from "../../src/recipes/minimal.js";
import {
  builderAuthor,
  operatorAuthor,
  type RecipeDocument,
  type RecipeRole,
} from "../../src/recipes/schema.js";

const CONFIG = {
  model: DEFAULT_MODEL,
  temperature: 1,
  max_tokens: 8192,
  max_steps: 30,
  max_tool_calls: 50,
  max_input_tokens: 100000,
  browser: false,
};

function role(partial: Partial<RecipeRole> & Pick<RecipeRole, "role">): RecipeRole {
  return {
    role: partial.role,
    name_suggestion: partial.name_suggestion ?? partial.role,
    focus: partial.focus ?? "",
    wake_triggers: partial.wake_triggers ?? "",
    avatar_shape: partial.avatar_shape ?? "teardrop",
    avatar_color: partial.avatar_color ?? "#7c5cff",
    scripts: partial.scripts ?? [],
    schedules: partial.schedules ?? [],
    grants: partial.grants ?? { read_guild: true, write_guild: true, read_org: true, write_org: false },
    native_tools: partial.native_tools ?? {
      note_find: true,
      record_list: true,
      record_add: true,
    },
    config: { ...CONFIG, ...(partial.config ?? {}) },
    task: {
      body: "",
      embeds: [],
      author: operatorAuthor(),
      ...(partial.task ?? {}),
    },
    browser: {
      required: Boolean(partial.browser?.required || partial.config?.browser),
      instructions: partial.browser?.instructions ?? "",
      author: partial.browser?.author ?? operatorAuthor(),
    },
  };
}

function column(
  name: string,
  type: CollectionColumn["type"],
  description: string,
  flags: { required?: boolean; unique?: boolean; values?: string[] } = {},
): CollectionColumn {
  return {
    name,
    type,
    description,
    required: flags.required === true,
    unique: flags.unique === true,
    ...(flags.values ? { values: flags.values } : {}),
  };
}

/** A queue of mail threads: the reader adds them, the writer drains them by status. */
export function inboxQueueColumns(): CollectionColumn[] {
  return [
    column("thread_id", "text", "mail thread id", { required: true, unique: true }),
    column("subject", "text", "thread subject as received"),
    column("status", "text", "queued when the reader adds it; written once the writer has upserted it", {
      required: true,
      values: ["queued", "written"],
    }),
  ];
}

/** A seen-set keyed by the external id of what was already processed. */
export function seenSetColumns(idDescription: string): CollectionColumn[] {
  return [
    column("external_id", "text", idDescription, { required: true, unique: true }),
    column("seen_at", "datetime", "when the poll first saw it"),
  ];
}

export function crmQueueColumns(): CollectionColumn[] {
  return [
    column("post_id", "text", "LinkedIn post id", { required: true, unique: true }),
    column("author", "text", "who interacted", { required: true }),
    column("profile_url", "text", "their LinkedIn profile"),
    column("status", "text", "new when the watcher adds it; written or skipped once the writer handled it", {
      required: true,
      values: ["new", "written", "skipped"],
    }),
  ];
}

export function linkedInNotionRecipe(author = operatorAuthor()): RecipeDocument {
  const recipe = emptyRecipe({
    name: "LinkedIn to Notion CRM",
    source: { kind: "builder", session_id: "bld_test" },
  });
  recipe.guild.name_suggestion = "linkedin-crm";
  recipe.guild.about = "Watch LinkedIn and write new interactors into Notion.";
  recipe.roles = [
    role({
      role: "watcher",
      name_suggestion: "li-watcher",
      focus: "Poll LinkedIn for matching posts",
      config: { ...CONFIG, browser: true },
      task: {
        body: "Open LinkedIn. For each new matching post, add it to crm-queue with status new and skip post ids already in seen-posts. Hand the rest to @{writer}.",
        embeds: [],
        author,
      },
      schedules: [
        {
          key: "watch-feed",
          cron: "*/15 * * * *",
          description: "Poll the LinkedIn feed",
          instruction: "Scan the feed for matching posts.",
          author,
        },
      ],
      browser: {
        required: true,
        instructions: "Log into LinkedIn in the browser before the first wake.",
        author,
      },
    }),
    role({
      role: "writer",
      name_suggestion: "notion-writer",
      focus: "Write interactors into the Notion CRM",
      task: {
        body: "List crm-queue where status is new. Upsert each person into the Notion CRM, then update the record to written. @{watcher} is the producer.",
        embeds: [],
        author,
      },
      schedules: [
        {
          key: "write-crm",
          cron: "*/20 * * * *",
          description: "Drain the CRM queue into Notion",
          instruction: "Write queued people to Notion.",
          author,
        },
      ],
    }),
  ];
  recipe.collections = [
    {
      name: "seen-posts",
      purpose: "One record per LinkedIn post the watcher already processed.",
      columns: seenSetColumns("LinkedIn post id"),
      scope: "org",
      guild: "read",
      writers: ["watcher"],
    },
    {
      name: "crm-queue",
      purpose: "One record per interactor waiting for the Notion writer.",
      columns: crmQueueColumns(),
      scope: "org",
      guild: "write",
      writers: [],
    },
  ];
  recipe.connections = [
    {
      server: "notion",
      auth: "oauth",
      recommended_scope: "guild",
      hint: "CRM database the operator already owns",
      setup: "Connect Notion and pick the CRM database.",
      resources: [
        {
          kind: "database",
          id: "crm-db",
          title: "CRM",
          use: "Long-lived interactor records. Not the crm-queue collection.",
        },
      ],
      author,
      roles: {
        writer: { enabled: true, tools: {} },
      },
    },
  ];
  recipe.design = {
    systems: [
      {
        proposed_by: "builder",
        accepted: true,
        name: "LinkedIn",
        resolution: "browser",
        reason: "No published LinkedIn connector",
      },
      {
        proposed_by: "builder",
        accepted: true,
        name: "Notion",
        resolution: "catalog",
        server: "notion",
        reason: "CRM writes",
      },
    ],
    specialization: [
      {
        proposed_by: "builder",
        accepted: true,
        role: "watcher",
        reason: "narrower_tools",
        detail: "Browser plus a seen-set; no Notion tools",
      },
      {
        proposed_by: "builder",
        accepted: true,
        role: "writer",
        reason: "narrower_access",
        detail: "Notion only; no browser",
      },
    ],
    routines: [
      {
        proposed_by: "builder",
        accepted: true,
        key: "watch-feed",
        role: "watcher",
        cadence: "*/15 * * * *",
        dedupe_collection: "seen-posts",
      },
      {
        proposed_by: "builder",
        accepted: true,
        key: "write-crm",
        role: "writer",
        cadence: "*/20 * * * *",
        dedupe_collection: "crm-queue",
      },
    ],
    handoffs: [
      {
        proposed_by: "builder",
        accepted: true,
        from: "watcher",
        to: "writer",
        kind: "collection",
        collection: "crm-queue",
      },
    ],
    browser: [
      {
        proposed_by: "builder",
        accepted: true,
        role: "watcher",
        site: "linkedin.com",
        viable: true,
        login_failure_policy: "pause the routine and ask the operator to log in again",
      },
    ],
  };
  return recipe;
}

export function cryptoThreeRoleRecipe(): RecipeDocument {
  const recipe = emptyRecipe({
    name: "Crypto desk",
    source: { kind: "file" },
  });
  recipe.guild.name_suggestion = "crypto-desk";
  recipe.roles = [
    role({
      role: "researcher",
      name_suggestion: "crypto-researcher",
      focus: "Collect market notes",
      task: { body: "Research and write notes for @{ta}.", embeds: [], author: operatorAuthor() },
    }),
    role({
      role: "ta",
      name_suggestion: "crypto-ta",
      focus: "Technical analysis",
      task: { body: "Read research and post a tagged brief for @{fund}.", embeds: [], author: operatorAuthor() },
    }),
    role({
      role: "fund",
      name_suggestion: "crypto-fund",
      focus: "Decide",
      task: { body: "Read @{ta} briefs and decide.", embeds: [], author: operatorAuthor() },
    }),
  ];
  recipe.design = {
    systems: [],
    specialization: [
      {
        proposed_by: "operator",
        accepted: true,
        role: "researcher",
        reason: "narrower_context",
        detail: "Research notes only",
      },
      {
        proposed_by: "operator",
        accepted: true,
        role: "ta",
        reason: "narrower_context",
        detail: "Charts only",
      },
      {
        proposed_by: "operator",
        accepted: true,
        role: "fund",
        reason: "other",
        detail: "Decision role",
      },
    ],
    routines: [],
    handoffs: [
      {
        proposed_by: "operator",
        accepted: true,
        from: "researcher",
        to: "ta",
        kind: "tagged",
        budget: 20,
      },
      {
        proposed_by: "operator",
        accepted: true,
        from: "ta",
        to: "fund",
        kind: "tagged",
        budget: 20,
      },
    ],
    browser: [],
  };
  return recipe;
}

function deskHandoff(authorProposed: "builder" | "operator" = "builder") {
  return {
    proposed_by: authorProposed,
    accepted: true,
    from: "reader",
    to: "writer",
    kind: "collection" as const,
    collection: "inbox-queue",
  };
}

export function fixtureDeskRecipe(author = operatorAuthor()): RecipeDocument {
  const recipe = emptyRecipe({
    name: "Mail to CRM desk",
    source: { kind: "file" },
  });
  recipe.guild.name_suggestion = "fixture-desk";
  recipe.guild.about = "Read mail and write matched rows into CRM.";
  recipe.guild.objective = "Drain mail into CRM without duplicating seen ids.";
  recipe.roles = [
    role({
      role: "reader",
      name_suggestion: "desk-reader",
      focus: "Read new mail threads",
      task: {
        body: "Call mail_ping. For each new thread, add it to inbox-queue with status queued and skip thread ids already in seen-ids. Hand the rest to @{writer}.",
        embeds: [],
        author,
      },
      schedules: [
        {
          key: "read-mail",
          cron: "*/15 * * * *",
          description: "Poll mail",
          instruction: "Scan mail for new threads.",
          author,
        },
      ],
    }),
    role({
      role: "writer",
      name_suggestion: "desk-writer",
      focus: "Upsert CRM rows",
      task: {
        body: "List inbox-queue where status is queued. Call crm_ping and upsert each queued person, then update the record to written. @{reader} is the producer.",
        embeds: [],
        author,
      },
      schedules: [
        {
          key: "write-crm",
          cron: "*/20 * * * *",
          description: "Drain CRM queue",
          instruction: "Write queued people to CRM.",
          author,
        },
      ],
    }),
  ];
  recipe.collections = [
    {
      name: "seen-ids",
      purpose: "One record per mail thread the reader already processed.",
      columns: seenSetColumns("mail thread id"),
      scope: "org",
      guild: "read",
      writers: ["reader"],
    },
    {
      name: "inbox-queue",
      purpose: "One record per thread waiting for the CRM writer.",
      columns: inboxQueueColumns(),
      scope: "org",
      guild: "write",
      writers: [],
    },
  ];
  recipe.connections = [
    {
      server: "mail",
      auth: "token",
      recommended_scope: "agent",
      hint: "Stub mailbox",
      setup: "Reuse the org mail login.",
      author,
      roles: {
        reader: { enabled: true, tools: { mail_ping: true } },
      },
    },
    {
      server: "crm",
      auth: "token",
      recommended_scope: "agent",
      hint: "Stub CRM",
      setup: "Reuse the org crm login.",
      author,
      roles: {
        writer: { enabled: true, tools: { crm_ping: true } },
      },
    },
  ];
  recipe.design = {
    systems: [
      {
        proposed_by: "builder",
        accepted: true,
        name: "Mail",
        resolution: "catalog",
        server: "mail",
        reason: "Inbox reads",
      },
      {
        proposed_by: "builder",
        accepted: true,
        name: "CRM",
        resolution: "catalog",
        server: "crm",
        reason: "Row writes",
      },
    ],
    specialization: [
      {
        proposed_by: "builder",
        accepted: true,
        role: "reader",
        reason: "narrower_tools",
        detail: "Mail only",
      },
      {
        proposed_by: "builder",
        accepted: true,
        role: "writer",
        reason: "narrower_access",
        detail: "CRM only",
      },
    ],
    routines: [
      {
        proposed_by: "builder",
        accepted: true,
        key: "read-mail",
        role: "reader",
        cadence: "*/15 * * * *",
        dedupe_collection: "seen-ids",
      },
      {
        proposed_by: "builder",
        accepted: true,
        key: "write-crm",
        role: "writer",
        cadence: "*/20 * * * *",
        dedupe_collection: "inbox-queue",
      },
    ],
    handoffs: [deskHandoff()],
    browser: [],
  };
  return recipe;
}

export function fixtureHuskDeskRecipe(author = operatorAuthor()): RecipeDocument {
  const recipe = emptyRecipe({
    name: "Husk mail to CRM desk",
    source: { kind: "builder", session_id: "bld_husk_desk" },
  });
  recipe.guild.name_suggestion = "fixture-husk-desk";
  recipe.guild.about = "Match mail to CRM.";
  recipe.guild.objective = "Every 15 minutes, read mail and upsert a row in crm.";
  recipe.roles = [
    role({
      role: "reader",
      name_suggestion: "husk-reader",
      focus: "Read mail threads",
      native_tools: {},
      task: { body: "", embeds: [], author },
    }),
    role({
      role: "writer",
      name_suggestion: "husk-writer",
      focus: "Write CRM rows",
      native_tools: {},
      task: { body: "", embeds: [], author },
    }),
  ];
  recipe.collections = [
    {
      name: "inbox-queue",
      purpose: "One record per thread waiting for the writer.",
      columns: inboxQueueColumns(),
      scope: "org",
      guild: "write",
      writers: [],
    },
  ];
  recipe.design = {
    systems: [],
    specialization: [],
    routines: [],
    handoffs: [deskHandoff()],
    browser: [],
  };
  return recipe;
}

export function huskLeadMatcherRecipe(author = operatorAuthor()): RecipeDocument {
  const recipe = emptyRecipe({
    name: "Cigale lead-interest story matcher",
    source: { kind: "builder", session_id: "bld_husk" },
  });
  recipe.guild.name_suggestion = "guilds-lead-matcher";
  recipe.guild.about = "Match Cigale stories to Notion leads";
  recipe.guild.objective = "Every 15 minutes, match Cigale stories to Notion leads and alert me.";
  recipe.roles = [
    role({
      role: "story-lead-matcher",
      name_suggestion: "story-lead-matcher",
      focus: "Match Cigale stories to Notion leads and alert me",
      native_tools: {},
      task: { body: "", embeds: [], author },
    }),
  ];
  return recipe;
}

export { builderAuthor, operatorAuthor };
