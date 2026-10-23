import { BROWSER_TOOLS } from "../toolbox/browser.js";
import { CODING_TOOLS } from "../toolbox/code.js";
import { HARNESS_TOOLS } from "../toolbox/harness.js";

export const NATIVE_CAPABILITY_GROUPS = [
  {
    id: "notes",
    label: "Notes",
    description:
      "Local markdown at agent, guild, or organisation level. Use for playbooks, field maps, and working files. Long-lived operator CRMs and wikis stay in a connected system of record.",
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

export const CODING_CAPABILITY = {
  id: "coding",
  label: "Coding",
  description:
    "A coding agent clones the guild's repositories into its sandbox, delegates code changes to a coding harness (Claude Code, Codex, Cursor, or Antigravity, on the operator's own subscription) with code_task, checks the harness's work with shell, file_read, and code_search, and hands work over through git branches and pull requests. Set config.coding on the role, config.harness when the operator named one, and list the repositories the guild needs in the recipe's repositories (name and purpose; no URL or credential). Node.js, build tools, git, gh, and mise are in the sandbox; the workspace, caches, and toolchains persist. A run near its input limit continues in a new run from the agent's own hand-off.",
  tools: [...CODING_TOOLS, ...HARNESS_TOOLS],
  costs: {
    sandbox: "a code box, 2 CPU, 4 GiB",
    limit: "max_coding_agents",
  },
  apply_step: {
    kind: "repository",
    deferrable: false,
    description:
      "Apply asks the operator to connect GitHub at the organisation or the guild, then to add each repository in the guild's Settings; a repository without a GitHub login is cloned anonymously.",
  },
};

