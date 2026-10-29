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
import type { UserRow } from "../db/users.js";
import type { StudioSessionRow } from "../db/studio.js";

export { generationLive };

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

  start(args: {
    session: StudioSessionRow;
    user: UserRow;
    toolDeps: StudioToolDeps;
    toolCall: Omit<StudioToolCall, "generation">;
    generation: number;
    generationContext: string;
    systemContent?: string;
  }): void {
    const config = args.session.config_snapshot;
    this.inner.start({
      session: args.session,
      user: args.user,
      generation: args.generation,
      generationContext: args.generationContext,
      ...(args.systemContent ? { systemContent: args.systemContent } : {}),
      tools: conversationTools(studioToolMap(), args.toolDeps),
      toolContext: args.toolCall,
      bindToolContext: (upcoming): StudioToolCall => ({
        ...args.toolCall,
        generation: args.generation,
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

