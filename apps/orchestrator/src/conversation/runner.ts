import {
  type ConversationKind,
  type ConversationMessageRow,
  type ConversationSessionKey,
  conversationSessionErrors,
  insertConversationMessage,
  listConversationMessages,
  nextConversationSeq,
  updateConversationSession,
} from "../db/conversations.js";
import type { Queryable } from "../db/pg.js";
import type { MessagePayload, ToolCall, ToolMessage } from "../db/schema/index.js";
import { incrementOrgUsage } from "../db/usage.js";
import { EventQueue } from "../lib/event.js";
import {
  LLMError,
  countInputTokens,
  streamCompletion,
  type Completion,
  type ModelEvent,
} from "../llm/index.js";
import { CancelEvent } from "../toolbox/index.js";
import { OPEN_POLICY, type OrgPolicy } from "../policy/index.js";
import { modelCatalog } from "../llm/catalog.js";
import {
  NO_CREDENTIALS,
  modelUsageOf,
  reportModelUsage,
  resolveModelCredentials,
  type ModelCredentials,
  type ModelCredentialsProvider,
} from "../llm/credentials.js";
import { AdmissionConflictError, AdmissionCoordinator } from "../generation/admission.js";
import { promptHash } from "../prompts/index.js";
import { ConversationConflictError, ConversationError } from "./errors.js";
import {
  projectToolResults,
  TOOL_RESULT_STUB_MIN_BYTES,
  type ProjectedRow,
  type ProjectionBudget,
} from "./projection.js";
import { writeLog } from "../observability/log.js";
import type { UserRow } from "../db/users.js";
import type { StudioSessionRow } from "../db/studio.js";
import type { BuilderSessionRow } from "../db/builder.js";

export const generationLive = {
  streamCompletion,
  countInputTokens,
};

const INTERRUPTED_CONTENT = "ERROR: execution interrupted";

const EVENT_QUEUE_LIMIT = 4096;

export type ConversationTool = {
  name: string;
  schema: Record<string, unknown>;
  handler: (ctx: unknown, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

export type ConversationProjectionBudget = ProjectionBudget;

export type ConversationRunnerDeps = {
  /** The connection the conversation's session and messages are read and written on. */
  db: Queryable;
  /** Whose conversation it is, which names its tables and its admission. */
  kind: ConversationKind;
  admission: AdmissionCoordinator;
  /** What a model provider is called with; nothing resolves when absent. */
  credentials?: ModelCredentialsProvider;
  policy?: OrgPolicy;
  /** What a stubbed older tool result tells this coach to do instead. */
  stubHint: string;
  projectionPolicyVersion?: number;
  minUnstubbedToolResults?: number;
  onToolResult?: (
    sessionId: string,
    name: string,
    result: Record<string, unknown>,
    publish: (sessionId: string, event: string, data: Record<string, unknown>) => Promise<void>,
  ) => Promise<void>;
};

export class ConversationRunner {
  private subs = new Map<string, Set<EventQueue<[string, Record<string, unknown>]>>>();
  private cancels = new Map<string, CancelEvent>();
  private tasks = new Map<string, Promise<void>>();

  constructor(public deps: ConversationRunnerDeps) {}

  private session(sessionId: string): ConversationSessionKey {
    return { kind: this.deps.kind, sessionId };
  }

  subscribe(sessionId: string): EventQueue<[string, Record<string, unknown>]> {
    const queue = new EventQueue<[string, Record<string, unknown>]>();
    const listeners = this.subs.get(sessionId) ?? new Set();
    listeners.add(queue);
    this.subs.set(sessionId, listeners);
    return queue;
  }

  unsubscribe(sessionId: string, queue: EventQueue<[string, Record<string, unknown>]>): void {
    const listeners = this.subs.get(sessionId);
    if (!listeners) return;
    listeners.delete(queue);
    if (!listeners.size) this.subs.delete(sessionId);
  }

  async publish(sessionId: string, event: string, data: Record<string, unknown>): Promise<void> {
    for (const queue of [...(this.subs.get(sessionId) ?? [])]) {
      if (queue.size >= EVENT_QUEUE_LIMIT) {
        this.unsubscribe(sessionId, queue);
        continue;
      }
      await queue.put([event, data]);
    }
  }

  cancel(sessionId: string): void {
    this.cancels.get(sessionId)?.set();
  }

  async wait(sessionId: string): Promise<void> {
    await this.tasks.get(sessionId);
  }

  start(args: {
    session: StudioSessionRow | BuilderSessionRow;
    user: UserRow;
    generation: number;
    generationContext: string;
    systemContent?: string;
    tools: Map<string, ConversationTool>;
    toolContext: unknown;
    bindToolContext?: (upcoming: number) => unknown;
    maxTokens: number;
    maxSteps: number;
    maxToolCalls: number;
    maxInput: number;
    minUnstubbed?: number;
  }): void {
    const sessionId = args.session.id;
    const task = this.run(args).finally(() => {
      if (this.tasks.get(sessionId) === task) {
        this.tasks.delete(sessionId);
      }
    });
    this.tasks.set(sessionId, task);
  }

  async reconcile(session: StudioSessionRow | BuilderSessionRow): Promise<void> {
    if (session.generation_state !== "generating" && session.generation_state !== "cancelling") {
      return;
    }
    await this.repair(session.id, Number(session.generation_number || 1), "execution interrupted");
    await updateConversationSession(this.deps.db, this.session(session.id), { generation_state: "idle", generation_token: null }, new Date());
  }

  private async run(args: {
    session: StudioSessionRow | BuilderSessionRow;
    user: UserRow;
    generation: number;
    generationContext: string;
    systemContent?: string;
    tools: Map<string, ConversationTool>;
    toolContext: unknown;
    bindToolContext?: (upcoming: number) => unknown;
    maxTokens: number;
    maxSteps: number;
    maxToolCalls: number;
    maxInput: number;
    minUnstubbed?: number;
  }): Promise<void> {
    const sessionId = args.session.id;
    const orgId = args.session.org_id;
    const cancel = new CancelEvent();
    this.cancels.set(sessionId, cancel);
    await this.publish(sessionId, "generation.started", {
      session_id: sessionId,
      generation: args.generation,
    });
    const config = args.session.config_snapshot;
    const model = config.model;
    const temperature = config.temperature;
    const maxTokens = args.maxTokens;
    const maxSteps = args.maxSteps;
    const maxToolCalls = args.maxToolCalls;
    const maxInput = args.maxInput;
    const tools = args.tools;
    const schemas = [...tools.values()].map((tool) => tool.schema);
    let toolCalls = 0;
    let step = 0;
    const stubbed: number[] = [];
    const kind = this.deps.kind;
    let exhaustedSteps;
    try {
      await this.deps.admission.acquire(kind, sessionId, orgId, await this.maxConcurrent(orgId));
    } catch (error) {
      if (error instanceof AdmissionConflictError) {
        await this.fail(sessionId, error.message);
        return;
      }
      throw error;
    }
    try {
      while (step < maxSteps) {
        if (cancel.aborted) {
          await this.repair(sessionId, args.generation, "cancelled");
          break;
        }
        const history = await listConversationMessages(this.deps.db, this.deps.kind, sessionId);
        const stubbedThisStep: number[] = [];
        const minUnstubbed = args.minUnstubbed ?? this.deps.minUnstubbedToolResults;
        const providerMessages = projectConversationHistory({
          history,
          generationContext: args.generationContext,
          currentGeneration: args.generation,
          stubHint: this.deps.stubHint,
          stubbed: stubbedThisStep,
          ...(minUnstubbed !== undefined ? { minUnstubbed } : {}),
          budget: {
            model,
            schemas,
            maxInput,
            countInputTokens: (nextModel, messages, nextTools) =>
              generationLive.countInputTokens(nextModel, messages, nextTools),
          },
          ...(args.systemContent ? { systemContent: args.systemContent } : {}),
        });
        stubbed.push(...stubbedThisStep.filter((seq) => !stubbed.includes(seq)));
        const projectedTokens = generationLive.countInputTokens(model, providerMessages, schemas);
        if (projectedTokens > maxInput) {
          await updateConversationSession(
            this.deps.db,
            this.session(sessionId),
            {
              status: "blocked",
              blocked_reason: "input_token_limit",
              generation_state: "idle",
              generation_token: null,
            },
            new Date(),
          );
          await this.publish(sessionId, "session.error", {
            detail: "input token limit reached",
            blocked_reason: "input_token_limit",
          });
          writeLog("warn", "input token limit reached", {
            source: "backend",
            operation: `${kind}.session`,
            session_id: sessionId,
            error_type: "InputTokenLimit",
          });
          break;
        }
        await this.assertAllowed(orgId);
        let completion: Completion;
        try {
          completion = await this.complete({
            sessionId,
            model,
            messages: providerMessages,
            temperature,
            max_tokens: maxTokens,
            tools: schemas,
            orgId,
            cancel,
          });
        } catch (error) {
          if (cancel.aborted) {
            await this.repair(sessionId, args.generation, "cancelled");
            break;
          }
          const detail =
            error instanceof LLMError ? error.message : error instanceof Error ? error.message : "provider error";
          await this.fail(sessionId, detail);
          break;
        }
        const now = new Date();
        const seq = await nextConversationSeq(this.deps.db, this.deps.kind, sessionId);
        const metadata = {
          generation: args.generation,
          projection_policy_version: this.deps.projectionPolicyVersion ?? 2,
          projected_input_hash: promptHash(JSON.stringify(providerMessages)),
          stubbed_message_seqs: stubbed,
          ...completion.metadata,
        };
        const row = await insertConversationMessage(
          this.deps.db,
          this.deps.kind,
          {
            session_id: sessionId,
            seq,
            generation: args.generation,
            payload: completion.payload,
            metadata,
          },
          now,
        );
        await incrementOrgUsage(this.deps.db, orgId, metadata, now);
        await this.publish(sessionId, "message.committed", { message: row });
        const calls = completion.payload.tool_calls ?? [];
        if (!calls.length) {
          break;
        }
        const finishReason = completion.metadata.finish_reason;
        let awaitOperator = false;
        for (const call of calls) {
          toolCalls += 1;
          if (toolCalls > maxToolCalls) {
            await this.commitToolError(sessionId, args.generation, call, "tool call limit reached");
            continue;
          }
          const fn = call.function;
          const name = fn.name;
          const tool = tools.get(name);
          const upcoming = await nextConversationSeq(this.deps.db, this.deps.kind, sessionId);
          let result: Record<string, unknown>;
          try {
            if (!tool) {
              result = { error: `unknown tool ${name}` };
            } else if (truncatedToolArguments(finishReason, fn.arguments)) {
              result = {
                error:
                  "output truncated at max_tokens; tool arguments are incomplete JSON. Retry with a smaller payload.",
              };
            } else {
              result = await tool.handler(
                args.bindToolContext ? args.bindToolContext(upcoming) : args.toolContext,
                parseToolArgs(fn.arguments),
              );
            }
          } catch (error) {
            result = {
              error:
                error instanceof ConversationError || error instanceof Error ? error.message : "tool failed",
            };
          }
          const envelope = { tool_message_seq: upcoming, ...result };
          const candidateMessages = [
            ...providerMessages,
            { role: "tool", tool_call_id: call.id, content: JSON.stringify(envelope) },
          ];
          const nextTokens = generationLive.countInputTokens(model, candidateMessages, schemas);
          const payload: ToolMessage =
            nextTokens > maxInput
              ? {
                  role: "tool",
                  tool_call_id: call.id,
                  content: JSON.stringify({
                    tool_message_seq: upcoming,
                    error: "projected tool result exceeds the session input-token limit; narrow the requested range",
                  }),
                }
              : { role: "tool", tool_call_id: call.id, content: JSON.stringify(envelope) };
          const committed = await insertConversationMessage(
            this.deps.db,
            this.deps.kind,
            {
              session_id: sessionId,
              seq: upcoming,
              generation: args.generation,
              payload,
              metadata: { generation: args.generation, tool_name: name },
            },
            new Date(),
          );
          await this.publish(sessionId, "message.committed", { message: committed });
          if (this.deps.onToolResult) {
            await this.deps.onToolResult(sessionId, name, result, (id, event, data) => this.publish(id, event, data));
          }
          if (result.await_operator === true) {
            awaitOperator = true;
          }
        }
        if (awaitOperator) {
          break;
        }
        step += 1;
      }
      exhaustedSteps = step >= maxSteps;
      if (exhaustedSteps) {
        await this.fail(sessionId, "generation step limit reached");
      }
    } finally {
      this.cancels.delete(sessionId);
      this.deps.admission.release(kind, sessionId);
      await updateConversationSession(this.deps.db, this.session(sessionId), { generation_state: "idle", generation_token: null, generation_started_at: null }, new Date());
      await this.publish(sessionId, "generation.finished", { session_id: sessionId, generation: args.generation });
    }
  }

  private async complete(options: {
    sessionId: string;
    model: string;
    messages: Array<Record<string, unknown>>;
    temperature: number;
    max_tokens: number;
    tools: unknown[];
    orgId: string;
    cancel: CancelEvent;
  }): Promise<Completion> {
    const abort = new AbortController();
    const credentials: ModelCredentials = await resolveModelCredentials(
      this.deps.credentials ?? NO_CREDENTIALS,
      options.orgId,
      options.model,
    );
    void modelCatalog.ensureFresh();
    const agen = generationLive.streamCompletion({
      model: options.model,
      messages: options.messages,
      temperature: options.temperature,
      max_tokens: options.max_tokens,
      tools: options.tools,
      signal: abort.signal,
      apiKey: credentials.apiKey,
      ...(credentials.baseURL ? { baseURL: credentials.baseURL } : {}),
    });
    const iterator = agen[Symbol.asyncIterator]();
    let completion: Completion | null = null;
    try {
      while (true) {
        const nextPromise = iterator.next();
        const winner = await Promise.race([
          nextPromise.then((value) => ({ cancelled: false as const, value })),
          options.cancel.wait().then(() => ({ cancelled: true as const })),
        ]);
        if ("cancelled" in winner && winner.cancelled) {
          abort.abort();
          throw new Error("cancelled");
        }
        const result = (winner as { value: IteratorResult<ModelEvent> }).value;
        if (result.done) break;
        const event = result.value;
        if (event[0] === "delta") {
          await this.publish(options.sessionId, "assistant.delta", {
            session_id: options.sessionId,
            content: event[1],
            text: event[1],
          });
        } else if (event[0] === "reasoning") {
          await this.publish(options.sessionId, "assistant.reasoning.delta", {
            session_id: options.sessionId,
            text: event[1],
          });
        } else {
          completion = event[1];
        }
      }
    } finally {
      abort.abort();
    }
    if (!completion) {
      throw new LLMError("provider returned no completion");
    }
    await reportModelUsage(credentials, modelUsageOf(options.sessionId, options.model, completion.metadata));
    return completion;
  }

  private async repair(sessionId: string, generation: number, detail: string): Promise<void> {
    const messages = await listConversationMessages(this.deps.db, this.deps.kind, sessionId);
    const pending = unresolvedCalls(messages);
    for (const call of pending) {
      const seq = await nextConversationSeq(this.deps.db, this.deps.kind, sessionId);
      const row = await insertConversationMessage(
        this.deps.db,
        this.deps.kind,
        {
          session_id: sessionId,
          seq,
          generation,
          payload: { role: "tool", tool_call_id: call.id, content: INTERRUPTED_CONTENT },
          metadata: { generation, interrupted: true, detail },
        },
        new Date(),
      );
      await this.publish(sessionId, "message.committed", { message: row });
    }
  }

  private async commitToolError(
    sessionId: string,
    generation: number,
    call: ToolCall,
    detail: string,
  ): Promise<void> {
    const seq = await nextConversationSeq(this.deps.db, this.deps.kind, sessionId);
    const row = await insertConversationMessage(
      this.deps.db,
      this.deps.kind,
      {
        session_id: sessionId,
        seq,
        generation,
        payload: { role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: detail }) },
        metadata: { generation, tool_error: true },
      },
      new Date(),
    );
    await this.publish(sessionId, "message.committed", { message: row });
  }

  private async fail(sessionId: string, detail: string): Promise<void> {
    const kind = this.deps.kind;
    writeLog("error", detail, {
      source: "backend",
      operation: `${kind}.session`,
      session_id: sessionId,
      error_type: "ConversationError",
    });
    const errors = [...((await conversationSessionErrors(this.deps.db, this.session(sessionId))) ?? [])];
    errors.push({ at: new Date().toISOString(), detail });
    await updateConversationSession(this.deps.db, this.session(sessionId), { errors }, new Date());
    await this.publish(sessionId, "session.error", { detail });
  }

  private get policy(): OrgPolicy {
    return this.deps.policy ?? OPEN_POLICY;
  }

  private async maxConcurrent(orgId: string): Promise<number | undefined> {
    return (await this.policy.standing(orgId)).limits.maxConcurrentRuns ?? undefined;
  }

  private async assertAllowed(orgId: string): Promise<void> {
    const { blocked } = await this.policy.standing(orgId);
    if (blocked) {
      throw new ConversationConflictError(blocked.message);
    }
  }
}

export function projectConversationHistory(args: {
  history: ProjectedRow[];
  generationContext: string;
  currentGeneration: number;
  stubHint: string;
  stubbed: number[];
  minUnstubbed?: number;
  budget?: ConversationProjectionBudget;
  systemContent?: string;
}): MessagePayload[] {
  const messages = projectToolResults({
    history: args.history,
    currentGeneration: args.currentGeneration,
    keepGenerations: 1,
    hint: args.stubHint,
    stubbed: args.stubbed,
    minStubBytes: TOOL_RESULT_STUB_MIN_BYTES,
    includeContentHash: true,
    ...(args.minUnstubbed !== undefined ? { minUnstubbed: args.minUnstubbed } : {}),
    ...(args.budget ? { budget: args.budget } : {}),
  });
  const [first] = messages;
  if (first?.role === "system") {
    messages[0] = args.systemContent ? { ...first, content: args.systemContent } : first;
    messages.splice(1, 0, { role: "user", content: args.generationContext });
  }
  return messages;
}

export function toolArgsAreJsonObject(raw: unknown): boolean {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return true;
  }
  if (typeof raw !== "string" || !raw.trim()) {
    return false;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  } catch {
    return false;
  }
}

export function truncatedToolArguments(finishReason: unknown, raw: unknown): boolean {
  return finishReason === "length" && !toolArgsAreJsonObject(raw);
}

export function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return recoverPartialToolArgs(raw);
  }
  return recoverPartialToolArgs(raw);
}

export function recoverPartialToolArgs(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const handle = raw.match(/"(?:agent_id|agent_name)"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (handle?.[1]) {
    try {
      out.agent_id = JSON.parse(`"${handle[1]}"`);
    } catch {
      out.agent_id = handle[1];
    }
  }
  const rationale = raw.match(/"rationale"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (rationale?.[1]) {
    try {
      out.rationale = JSON.parse(`"${rationale[1]}"`);
    } catch {
      out.rationale = rationale[1];
    }
  }
  return out;
}

function unresolvedCalls(messages: ConversationMessageRow[]): ToolCall[] {
  const pending = new Map<string, ToolCall>();
  for (const { payload } of messages) {
    if (payload.role === "assistant") {
      for (const call of payload.tool_calls ?? []) pending.set(call.id, call);
    }
    if (payload.role === "tool") {
      pending.delete(payload.tool_call_id);
    }
  }
  return [...pending.values()];
}
