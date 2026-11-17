import { BROWSER_TOOLS } from "../toolbox/browser.js";

export const NATIVE_CAPABILITY_GROUPS = [
  {
    id: "notes",
    label: "Notes",
    description:
      "Local markdown notes, one per name across the organisation; each note's access list gives the organisation, a guild, or an agent read or write, and a note an agent creates is written by that agent alone until an operator shares it. Use for playbooks, field maps, and working files. Long-lived operator CRMs and wikis stay in a connected system of record.",
    tools: ["note_find", "note_get", "note_write", "note_delete"],
  },
  {
    id: "collections",
    label: "Collections",
    description:
      "Tables of a guild or of the organisation that the operator defines with typed columns; each table's access list gives the organisation, a guild, or an agent read or write. Queues, seen-sets, and operational state live here, not in an external workspace. Agents add, update, remove, list, and search records; they never create or alter a collection.",
    tools: ["record_search", "record_list", "record_add", "record_update", "record_remove"],
  },
  {
    id: "files",
    label: "Files",
    description:
      "Shared files, one per name across the organisation: any bytes an agent produced or needs, such as a report, a dataset, or an image. Each file carries a description and an access list that gives the organisation, a guild, or an agent read or write. An agent shares a file from its home and fetches one into it; the bytes never pass through the model.",
    tools: ["file_find", "file_fetch", "file_put", "file_delete"],
  },
  {
    id: "memory",
    label: "Memory",
    description: "Private free-form text the agent carries between runs, capped at 12,000 characters. Not a seen-set.",
    tools: ["memory_write"],
  },
  {
    id: "scripts",
    label: "Scripts",
    description: "Agent-owned sandboxed scripts. Pair with a named secret only when no catalog connector exists.",
    tools: ["script_create", "script_list", "script_read", "script_run", "script_delete"],
  },
  {
    id: "schedules",
    label: "Schedules",
    description:
      "UTC 5-field cron, or random wake-ups inside a daily local-time window, with a 5-minute minimum gap. Schedule tools are unavailable inside schedule runs.",
    tools: [
      "schedule_create_cron",
      "schedule_create_window",
      "schedule_list",
      "schedule_update",
      "schedule_pause",
      "schedule_resume",
      "schedule_delete",
    ],
  },
  {
    id: "wakes",
    label: "Wake-ups",
    description:
      "The agent asks to be woken again in the same run after 1 to 360 minutes, to come back to the result of a long process that finishes on its own, such as a CI run or a deploy. One pending wake-up per run; the run fires at most max_wake_ups of them. On in every kind of run. For work on a clock, use a routine.",
    tools: ["wake_after", "wake_cancel"],
  },
  {
    id: "chat",
    label: "Group chat",
    description:
      "Post to the guild group chat. Tag @name to wake a peer or @user for the operator. Untagged posts wake nobody. Turn off so a role cannot post.",
    tools: ["group_post"],
  },
] as const;

export const ALWAYS_OFFERED_TOOLS = [
  {
    name: "report_issue",
    description: "Report a tooling or login failure to the guild's operators, in their inbox and on the guild Issues tab.",
  },
] as const;

export const BROWSER_CAPABILITY = {
  id: "browser",
  label: "Browser",
  description:
    "Playwright Chromium in the agent sandbox when a site has no published connector. Set config.browser and browser.required on that role, write login instructions, and record design.browser (site, viable, login_failure_policy). After apply, the live agent asks the operator to take control of its browser and log in from the Browser tab. 60s orchestrator timeout, 15s per action, 1280×720. Login state lives in the workspace profile and expires silently.",
  tools: [...BROWSER_TOOLS],
  costs: {
    sandbox: "a standard box, 1 CPU, 2 GiB",
    limit: "max_browser_agents",
  },
  apply_step: {
    kind: "browser_login",
    deferrable: true,
    description:
      "After apply, the live agent asks the operator to take control of Chromium and log into the named site. Activating the guild does not require the login to be finished.",
  },
};

export const SUBSCRIPTION_CAPABILITY = {
  id: "subscription",
  label: "Subscription agent",
  description:
    "A subscription agent runs every turn on a coding harness (Claude Code, Codex, Cursor, or Antigravity) on the operator's own subscription instead of a model on a key, and is the agent that writes code. Each turn it works in the guild's repositories it picks, cloned into its sandbox, with the harness's own shell and file tools, and hands work over through pushed git branches, opening pull or merge requests with the repository host's connector tools. Leave config.model out of the role, set config.harness (the operator's pick, else claude-code), list the repositories the guild needs in the recipe's repositories (name and purpose; no URL or credential), and list in the role's config.repositories the ones its agent works on. Any role, one on a key too, may list repositories the same way; an agent on a key has no shell and works in them with scripts. config.read_only_repositories lists the ones of a role's repositories it only reads, never pushes to. Cursor and Antigravity run only in repositories. Node.js, build tools, git, and mise are in the sandbox; the workspace, caches, and toolchains persist.",
  tools: [],
  costs: {
    sandbox: "a code box, 2 CPU, 4 GiB",
    limit: "max_subscription_agents",
  },
  apply_step: {
    kind: "repository",
    deferrable: false,
    description:
      "Apply asks the operator to add each repository in the guild's Settings with its HTTPS URL, on any git host, and a credential: a GitHub login, an access token kept as a secret, or none for a public repository, which is cloned anonymously.",
  },
};

