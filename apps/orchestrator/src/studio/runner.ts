import { EventQueue } from "../lib/event.js";
import { AdmissionCoordinator } from "../admission/coordinator.js";
import type { OrgPolicy } from "../policy/index.js";
import {
  ConversationRunner,
  generationLive,
  type ConversationTool,
} from "../conversation/runner.js";
import {
  STUDIO_MIN_UNSTUBBED_TOOL_RESULTS,
  STUDIO_PROJECTION_POLICY_VERSION,
  STUDIO_TOOL_RESULT_STUB_HINT,
} from "./constants.js";
import type { ModelCredentialsProvider } from "../llm/credentials.js";
import type { Queryable } from "../db/pg.js";
import {
  studioToolMap,
  type StudioTool,
  type StudioToolCall,
  type StudioToolDeps,
} from "./tools.js";
import type { StudioSessionRow } from "../db/studio.js";

export { generationLive };

/** A generation a Studio session starts: its number, the context composed for it, and the system message it runs under. */
export type StudioGeneration = {
  session: StudioSessionRow;
  generation: number;
  generationContext: string;
  systemContent?: string;
};

export type StudioRunnerDeps = {
  db: Queryable;
  admission: AdmissionCoordinator;
  credentials?: ModelCredentialsProvider;
  policy?: OrgPolicy;
};

function conversationTools(
  tools: Map<string, StudioTool>,
  deps: StudioToolDeps,
): Map<string, ConversationTool> {
  return new Map(
    [...tools.entries()].map(([name, tool]) => [
      name,
      {
        name: tool.name,
        schema: tool.schema,
        handler: (call, args) => tool.handler(deps, call as StudioToolCall, args),
      },
    ]),
  );
}

export class StudioRunner {
  private inner: ConversationRunner;

  constructor(public deps: StudioRunnerDeps) {
    this.inner = new ConversationRunner({
      db: deps.db,
      kind: "studio",
      admission: deps.admission,
      stubHint: STUDIO_TOOL_RESULT_STUB_HINT,
      projectionPolicyVersion: STUDIO_PROJECTION_POLICY_VERSION,
      minUnstubbedToolResults: STUDIO_MIN_UNSTUBBED_TOOL_RESULTS,
      ...(deps.credentials ? { credentials: deps.credentials } : {}),
      ...(deps.policy ? { policy: deps.policy } : {}),
      onToolResult: async (sessionId, name, result, publish) => {
        if (name === "studio_create_task_draft" && !("error" in result)) {
          await publish(sessionId, "draft.changed", result);
        }
      },
    });
  }

  subscribe(sessionId: string): EventQueue<[string, Record<string, unknown>]> {
    return this.inner.subscribe(sessionId);
  }

  unsubscribe(sessionId: string, queue: EventQueue<[string, Record<string, unknown>]>): void {
    this.inner.unsubscribe(sessionId, queue);
  }

  async publish(sessionId: string, event: string, data: Record<string, unknown>): Promise<void> {
    await this.inner.publish(sessionId, event, data);
  }

  cancel(sessionId: string): void {
    this.inner.cancel(sessionId);
  }

  async wait(sessionId: string): Promise<void> {
    await this.inner.wait(sessionId);
  }

  /** Starts the generation as the operator `toolCall` names, its tools reading through `toolDeps`. */
  start(toolDeps: StudioToolDeps, started: StudioGeneration, toolCall: Omit<StudioToolCall, "generation">): void {
    const config = started.session.config_snapshot;
    this.inner.start({
      session: started.session,
      user: toolCall.user,
      generation: started.generation,
      generationContext: started.generationContext,
      ...(started.systemContent ? { systemContent: started.systemContent } : {}),
      tools: conversationTools(studioToolMap(), toolDeps),
      toolContext: toolCall,
      bindToolContext: (upcoming): StudioToolCall => ({
        ...toolCall,
        generation: started.generation,
        nextMessageSeq: upcoming,
      }),
      maxTokens: config.max_tokens,
      maxSteps: config.max_steps,
      maxToolCalls: config.max_tool_calls,
      maxInput: config.max_input_tokens,
      minUnstubbed: STUDIO_MIN_UNSTUBBED_TOOL_RESULTS,
    });
  }

  async reconcile(session: StudioSessionRow): Promise<void> {
    await this.inner.reconcile(session);
  }
}

