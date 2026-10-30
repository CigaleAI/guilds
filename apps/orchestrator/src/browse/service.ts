import { getAgent } from "../db/agents.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import { resolveModelCredentials, type ModelCredentialsProvider } from "../llm/credentials.js";
import { shownProgressLines } from "../toolbox/harness-ops.js";
import { typeSafeApiKey } from "../typesafe/client.js";
import type { ToolEvents } from "../toolbox/services.js";
import type { CancelEvent, ToolHooks, ToolInvocation, ToolRun } from "../toolbox/types.js";
import { fastbrowseEnv } from "./env.js";
import { BrowseError, FASTBROWSE, runBrowse, type BrowseOutcome, type BrowseRequest, type FastbrowseLauncher } from "./runner.js";

/** How long a browse run may take past its own time limit to stop and hand back its result. */
const STOP_GRACE_SECONDS = 30;

/** The db/ function a browse call reads its agent's browser model through, on `db`. */
function browseDatabase(db: Queryable) {
  return {
    getAgent: bindQuery(db, getAgent),
  };
}

export type BrowseDatabase = ReturnType<typeof browseDatabase>;

/** What browse calls run with: the agents' rows, the organisations' model keys, the runs' streams, and fastbrowse. */
export type BrowseServiceDeps = {
  db: BrowseDatabase;
  credentials: ModelCredentialsProvider;
  events: ToolEvents;
  fastbrowse: FastbrowseLauncher;
};

/** A signal that aborts once the run is cancelled or `seconds` pass, and what stops watching the cancel. */
type BrowseStop = { signal: AbortSignal; unwatch(): void };

function browseStop(cancel: CancelEvent | null, seconds: number): BrowseStop {
  const watch = new AbortController();
  const cancelled = new AbortController();
  void cancel?.wait(watch.signal).then(
    () => cancelled.abort(),
    // The wait ends without a cancel once the call is over and stops watching.
    () => null,
  );
  return {
    signal: AbortSignal.any([cancelled.signal, AbortSignal.timeout(seconds * 1000)]),
    unwatch: () => watch.abort(),
  };
}

/**
 * Runs `browse` calls: each delegates one web task to fastbrowse on the agent's Chrome, with the
 * System One key as its Jev key and the agent's browser model on the organisation's credentials.
 * The keys stay in the orchestrator's fastbrowse process; the machine's container sees only
 * DevTools traffic.
 */
export class BrowseService {
  constructor(private readonly deps: BrowseServiceDeps) {}

  /**
   * Runs `request` for the run's `call`: each step is published as the call's `tool.progress`,
   * redacted with the run's secrets and clipped as the run view shows progress, and keeps the
   * agent's Chrome and machine from their idle stops. The run stops when the run is cancelled or
   * its time limit and a grace period pass.
   */
  async run(run: ToolRun, hooks: ToolHooks, call: ToolInvocation, request: BrowseRequest): Promise<BrowseOutcome> {
    const jevKey = typeSafeApiKey().trim();
    if (!jevKey) {
      throw new BrowseError("the agent-optimized browser needs the System One key under Platform keys");
    }
    if (hooks.cdp_target === null) {
      throw new BrowseError("the agent-optimized browser needs the agent's browser");
    }
    const agent = await this.deps.db.getAgent(run.agent_id);
    const model = agent?.config.browser_model ?? null;
    if (agent === null || model === null) {
      throw new BrowseError("the agent-optimized browser needs a browser model in the agent's settings");
    }
    const credentials = await resolveModelCredentials(this.deps.credentials, agent.org_id ?? "", model);
    const env = fastbrowseEnv(jevKey, model, credentials);
    const target = await hooks.cdp_target();
    const stop = browseStop(run.cancel_event, request.max_seconds + STOP_GRACE_SECONDS);
    const { events } = this.deps;
    try {
      return await runBrowse(
        this.deps.fastbrowse,
        {
          env,
          model,
          target,
          signal: stop.signal,
          onStep: async (text) => {
            hooks.touch_browser?.();
            await events.publish(run.run_id, "tool.progress", {
              run_id: run.run_id,
              tool_call_id: call.id,
              lines: shownProgressLines([text], run.secrets),
            });
          },
          log: { run_id: run.run_id, agent_id: run.agent_id, guild_id: run.guild_id },
        },
        request,
      );
    } finally {
      stop.unwatch();
    }
  }
}

/** The browse calls of the agents on `db`, with model keys from `credentials` and progress on `events`. */
export function browseService(db: Queryable, credentials: ModelCredentialsProvider, events: ToolEvents): BrowseService {
  return new BrowseService({ db: browseDatabase(db), credentials, events, fastbrowse: FASTBROWSE });
}
