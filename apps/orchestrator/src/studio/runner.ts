import { EventQueue } from "../lib/event.js";
import { AdmissionCoordinator } from "../generation/admission.js";
import type { OrgPolicy } from "../policy/index.js";
import {
  ConversationRunner,
  generationLive,
  type ConversationStore,
  type ConversationTool,
} from "../conversation/runner.js";
import {
  STUDIO_MAX_INPUT_TOKENS,
  STUDIO_MAX_STEPS,
  STUDIO_MAX_TOKENS,
  STUDIO_MAX_TOOL_CALLS,
  STUDIO_MIN_UNSTUBBED_TOOL_RESULTS,
  STUDIO_PROJECTION_POLICY_VERSION,
  STUDIO_TOOL_RESULT_STUB_HINT,
} from "./constants.js";
import type { ModelCredentialsProvider } from "../llm/credentials.js";
import type { StudioStore } from "./store.js";
import { studioToolMap, type StudioTool, type StudioToolContext } from "./tools.js";

export { generationLive };

export type StudioRunnerDeps = {
  store: StudioStore;
  admission: AdmissionCoordinator;
  credentials?: ModelCredentialsProvider;
  policy?: OrgPolicy;
};

function studioConversationStore(store: StudioStore): ConversationStore {
  return {
    getSession: (sessionId) => store.getSession(sessionId),
    nextSeq: (sessionId, client) => store.nextSeq(sessionId, client),
    insertMessage: (...args) => store.insertMessage(...args),
    listMessages: (sessionId) => store.listMessages(sessionId),
    updateSession: (...args) => store.updateSession(...args),
    incrementUsage: (...args) => store.incrementStudioUsage(...args),
  };
}

function conversationTools(tools: Map<string, StudioTool>): Map<string, ConversationTool> {
  return new Map(
    [...tools.entries()].map(([name, tool]) => [
      name,
      {
        name: tool.name,
        schema: tool.schema,
        handler: (ctx, args) => tool.handler(ctx as StudioToolContext, args),
      },
    ]),
  );
}

export class StudioRunner {
  private inner: ConversationRunner;

  constructor(public deps: StudioRunnerDeps) {
    this.inner = new ConversationRunner({
      store: studioConversationStore(deps.store),
      admission: deps.admission,
      admissionKind: "studio",
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
    session: Record<string, unknown>;
    user: Record<string, unknown>;
    toolContext: Omit<StudioToolContext, "generation">;
    generation: number;
    generationContext: string;
    systemContent?: string;
  }): void {
    const config = (args.session.config_snapshot ?? {}) as Record<string, unknown>;
    this.inner.start({
      session: args.session,
      user: args.user,
      generation: args.generation,
      generationContext: args.generationContext,
      ...(args.systemContent ? { systemContent: args.systemContent } : {}),
      tools: conversationTools(studioToolMap()),
      toolContext: args.toolContext,
      bindToolContext: (upcoming) =>
        ({
          ...args.toolContext,
          generation: args.generation,
          nextMessageSeq: upcoming,
        }) as StudioToolContext,
      maxTokens: Number(config.max_tokens ?? STUDIO_MAX_TOKENS),
      maxSteps: Number(config.max_steps ?? STUDIO_MAX_STEPS),
      maxToolCalls: Number(config.max_tool_calls ?? STUDIO_MAX_TOOL_CALLS),
      maxInput: Number(config.max_input_tokens ?? STUDIO_MAX_INPUT_TOKENS),
      minUnstubbed: STUDIO_MIN_UNSTUBBED_TOOL_RESULTS,
    });
  }

  async reconcile(session: Record<string, unknown>): Promise<void> {
    await this.inner.reconcile(session);
  }
}

