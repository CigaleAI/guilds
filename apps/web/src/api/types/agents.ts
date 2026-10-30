/**
 * Shapes of the orchestrator's JSON API for agents and the machines they run on, as the app reads
 * them. Timestamps are ISO-8601 in UTC.
 */

export type Agent = {
  id: string;
  guild_id: string;
  name: string;
  focus: string;
  /** `<style>:<seed>` for generated art, or a bare seed for the clay style. */
  avatar_shape: string;
  /** `#rrggbb`. */
  avatar_color: string;
  browser: boolean;
  /** Code work through a harness, with Node.js, build tools and git on its machine. */
  coding: boolean;
  /** The organisation's machine it runs on. */
  machine_id: string;
  machine: MachineRef;
  /** A run is generating for this agent right now. */
  generating: boolean;
};

export type ThinkingLevel = "none" | "low" | "medium" | "high";

/**
 * A machine's tier: `standard` and `code` have fixed sizes, `custom` is sized by an owner or admin.
 * Which agents a machine takes depends on its size (`agentMinimum` in features/machines).
 */
export type MachineBox = "standard" | "code" | "custom";

/** A machine as an agent payload names it. */
export type MachineRef = { id: string; name: string; box: MachineBox };

/** An agent on a machine, with what it runs there. */
export type MachineAgent = {
  id: string;
  name: string;
  guild_id: string;
  guild_name: string;
  browser: boolean;
  coding: boolean;
};

/** `GET /api/orgs/:id/machines`: one of the organisation's machines, its agents, and what they use. */
export type Machine = MachineRef & {
  cpu: number;
  memory_mib: number;
  /** The disk cap in MiB, over every agent home on the machine. */
  max_workspace_mib: number;
  /** Every agent home on it, measured after a generation; null before one. */
  workspace_mib: number | null;
  /** The disk its agents' own caps reserve, those in guilds the viewer cannot see included. */
  allocated_workspace_mib: number;
  /** Its planned load: the sum of its agents' minimum CPUs, and of their minimum memory. */
  planned_cpu: number;
  planned_mib: number;
  /** Its agents in guilds the viewer can see. */
  agents: MachineAgent[];
  /** How many of its agents sit in guilds the viewer cannot see; the planned load counts them too. */
  hidden_agents: number;
  /** The harness CLIs its image carries; null before it first started. */
  harnesses: Harness[] | null;
};

/** A machine to create, or the fields to change; `cpu` and `memory_mib` only on custom. */
export type MachineInput = {
  name: string;
  box: MachineBox;
  cpu?: number;
  memory_mib?: number;
  max_workspace_mib?: number;
};

/** The fields to change on one machine. */
export type MachineUpdate = { machineId: string; input: Partial<MachineInput> };

/** The coding CLI a coding agent delegates code work to through `code_task`. */
export type Harness = "claude-code" | "codex" | "cursor" | "antigravity";

/** The reasoning efforts a harness can run a model at, lowest first. */
export type HarnessEffort =
  "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/** One model a harness offers. */
export type HarnessCatalogModel = {
  /** What the agent's `harness_model` stores. */
  id: string;
  label: string;
  /** The efforts the model runs at; empty when it takes none. */
  efforts: HarnessEffort[];
  /** The effort a run gets without one set; null leaves it to the harness. */
  default_effort: HarnessEffort | null;
};

/** `GET /api/harnesses`: one harness's listed models, and the efforts any other model takes. */
export type HarnessCatalog = {
  harness: Harness;
  label: string;
  /** False when the box turns the harness off: offered only to an agent already on it. */
  enabled: boolean;
  models: HarnessCatalogModel[];
  /** The efforts for the subscription's default model or a custom one; empty when the model name carries it. */
  unlisted_efforts: HarnessEffort[];
};

export type AgentConfig = {
  model: string;
  temperature: number;
  max_tokens: number;
  max_steps: number;
  max_tool_calls: number;
  max_input_tokens: number;
  /** User turns, including the current one, whose tool results stay in the model prompt. */
  keep_tool_result_generations: number;
  max_scripts: number;
  /** The agent home's cap in MiB. A generation will not start while the home is over this. */
  max_workspace_mib: number;
  browser: boolean;
  /** Chrome UI and Accept-Language. Default `en-US`. */
  browser_language: string;
  /** Whether browsing runs through the agent-optimized `browse` tool instead of the step-by-step browser tools. */
  browser_optimized: boolean;
  /** The `{provider}/{model}` the agent-optimized browser plans and reads with; null unless `browser_optimized`. */
  browser_model: string | null;
  coding: boolean;
  /** The harness a coding agent runs; null when coding is off. */
  harness: Harness | null;
  /** The model the harness runs; null leaves it to the harness's subscription. */
  harness_model: string | null;
  /** The effort the harness runs its model at; null leaves it to the harness. */
  harness_effort: HarnessEffort | null;
  /** Variable names the agent's commands see, each holding the value of the secret it names. */
  secret_aliases: Record<string, string>;
  scripting: boolean;
  memory: boolean;
  thinking_level: ThinkingLevel;
};

/** One harness's credentials for an agent: the secret that carries a subscription token, and the CLI login. */
export type HarnessCredential = {
  harness: Harness;
  label: string;
  /** The variable the harness reads its subscription token from; null when it takes none. */
  secret: string | null;
  /** The secret that variable reads: the one aliased to it, else its own name; null with `secret`. */
  secret_source: string | null;
  /** Whether `secret_source` reaches the agent. */
  secret_granted: boolean;
  /** Whether an alias replaces a secret named `secret` that also reaches the agent. */
  secret_shadowed: boolean;
  /** What to run in the agent's CLI tab to log in. */
  login: string;
  /** When a check last found a login in the agent's home; null before one did, or once one found none. */
  login_seen_at: string | null;
  /** Whose that login is, as the harness recorded it; null when unknown. */
  login_account: string | null;
};

/** `GET /api/agents/:id/harness`: the agent's harness, and each harness's credentials for it. */
export type AgentHarness = {
  harness: Harness | null;
  /** The model the harness runs; null for its subscription's default. */
  harness_model: string | null;
  /** The effort the harness runs its model at; null for the harness's default. */
  harness_effort: HarnessEffort | null;
  harnesses: HarnessCredential[];
  /** The harness CLIs the agent's machine's image carries; null before the machine first started. */
  machine_harnesses: Harness[] | null;
  /** The guild repositories a coding run clones, by name; a coding run of a guild with none fails at start. */
  repositories: string[];
};

/** `POST /api/agents/:id/harness/check`: what the agent's machine has for a harness, outside a run. */
export type HarnessCheck = {
  installed: boolean;
  version: string | null;
  /** A login in the agent's home, or nothing; a granted secret reaches only a run. */
  credential: "secret" | "login" | null;
  /** Whose the login is, as the harness recorded it; null without one or when unknown. */
  account: string | null;
};

/** One agent with its model settings; `access` is its resolved tools, secrets and grants. */
export type AgentDetail = Agent & {
  /** The untagged group-chat messages it wakes for; empty means its focus stands in. */
  wake_triggers: string;
  config: AgentConfig;
  /** The agent's home, measured after its last generation; null before one. */
  workspace_mib: number | null;
  access: Record<string, unknown>;
};

/** A new agent of a guild; without `machine_id` it goes on the organisation's only machine. */
export type NewAgent = Pick<Agent, "name" | "focus" | "avatar_shape" | "avatar_color"> & {
  config: AgentConfig;
  machine_id?: string;
};

export type AgentBrief = {
  id: string;
  name: string;
  avatar_shape: string;
  avatar_color: string;
};

/** An agent's lifetime model usage; cost is what providers reported, or catalog rates without it. */
export type AgentUsage = {
  id: string;
  name: string;
  guild_id: string;
  guild_name: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  /** Input plus output; cache reads are counted apart. */
  total_tokens: number;
  cost_usd: number;
  calls: number;
  /** Tokens `browse` calls spent: the browsing service's and the model it drove the page with. */
  browser_input_tokens: number;
  browser_output_tokens: number;
  /** What `browse` calls cost; also counted in `cost_usd`. */
  browser_cost_usd: number;
  /** `browse` calls, counted apart from model calls. */
  browser_calls: number;
  updated_at: string | null;
  /** The agent's home, measured after the last generation; null before one. */
  workspace_mib: number | null;
  /** The agent's home cap in MiB. */
  max_workspace_mib: number;
  /** The agent's machine: every agent home on it against the machine's disk cap. */
  machine: { id: string; name: string; workspace_mib: number | null; max_workspace_mib: number };
};

/** A settings save: the whole model config, and the name, machine, focus, wake triggers and look when they change. */
export type AgentSettingsInput = {
  name?: string;
  config: AgentConfig;
  /** The machine to move the agent to; absent keeps it where it is. */
  machine_id?: string;
  focus?: string;
  wake_triggers?: string;
  avatar_shape?: string;
  avatar_color?: string;
};
