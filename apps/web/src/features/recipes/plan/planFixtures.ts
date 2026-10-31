import type { RecipeFinding } from "../../../api/types/recipes";
import type { RecipeDraft } from "./recipeDraft";

export const builder = { by: "builder", reviewed: false } as const;

export const operator = { by: "operator", reviewed: true } as const;

export function finding(
  code: string,
  path: string,
  severity: RecipeFinding["severity"] = "warning",
  message = `${code} at ${path}`,
): RecipeFinding {
  return { code, severity, path, message };
}

/** Two roles: a browser watcher on a cron schedule that queues posts for a writer using a connector. */
export function deskRecipe(): RecipeDraft {
  return {
    meta: { name: "Desk", description: "Watch and write" },
    guild: { name_suggestion: "desk", about: "Watches posts", objective: "Draft replies" },
    roles: [
      {
        role: "watcher",
        name_suggestion: "desk-watcher",
        focus: "Watch the feed",
        config: { model: "fast-model", browser: true },
        task: { body: "Watch the feed and queue posts.", author: builder },
        browser: { required: true, instructions: "", author: builder },
        native_tools: { note_find: true, web_fetch: false },
        schedules: [
          {
            key: "watch-feed",
            cron: "*/15 * * * *",
            description: "Check the feed",
            instruction: "Look for new posts",
            author: builder,
          },
        ],
        scripts: [
          { name: "scrape", description: "Scrape a page", source: "print(1)", author: operator },
        ],
      },
      {
        role: "writer",
        focus: "Write replies",
        task: { body: "", author: operator },
      },
    ],
    collections: [
      {
        name: "post-queue",
        purpose: "Posts waiting for the writer",
        columns: [
          { name: "url", type: "text", description: "post url", required: true, unique: true },
          {
            name: "status",
            type: "text",
            description: "",
            required: true,
            values: ["new", "done"],
          },
        ],
        scope: "org",
        guild: "write",
        writers: ["watcher"],
      },
    ],
    notes: [
      {
        id: "style",
        level: "guild",
        key: "style.md",
        body: "# Style\n\nKeep replies short.",
        author: builder,
      },
    ],
    connections: [
      {
        server: "crm",
        auth: "oauth",
        recommended_scope: "guild",
        hint: "Log into the CRM",
        setup: "",
        author: builder,
        roles: { writer: { enabled: true, tools: { crm_write: true, crm_delete: false } } },
      },
    ],
    secrets: [{ name: "API_KEY", description: "Feed API key", recommended_scope: "guild" }],
    external: [{ kind: "dns", title: "", setup: "Add a TXT record", author: builder }],
    design: {
      systems: [],
      routines: [],
      handoffs: [
        { from: "watcher", to: "writer", kind: "collection", collection: "post-queue" },
        { from: "watcher", to: "writer", kind: "tagged", budget: 3 },
        { from: "writer", to: "editor", kind: "tagged" },
      ],
      browser: [{ role: "watcher", site: "feed.example" }],
    },
  };
}
