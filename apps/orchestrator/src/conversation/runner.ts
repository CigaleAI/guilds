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
import { isPlainRecord } from "../db/json.js";
import type { Queryable } from "../db/pg.js";
import type { MessagePayload, ToolCall, ToolMessage } from "../db/schema/index.js";
import { incrementOrgUsage } from "../db/usage.js";
import { EventQueue } from "../lib/event.js";
import { streamCompletion } from "../llm/client.js";
import { LLMError, type Completion } from "../llm/completion.js";
import { countInputTokens } from "../llm/tokens.js";
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
import { AdmissionConflictError, AdmissionCoordinator } from "../admission/coordinator.js";
import { promptHash } from "../prompts/index.js";
import { ConversationCancelled, ConversationConflictError } from "./errors.js";
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

/**
 * One generation of a coach conversation: the session and the operator it answers, its number,
 * the context and system prompt it is sent, the tools it offers, and its limits.
 */
export type ConversationGeneration = {
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
};

/** One call of the model: the history it is sent and the settings from the session's snapshot. */
type CompletionRequest = {
  model: string;
  messages: Array<Record<string, unknown>>;
  temperature: number;
  max_tokens: number;
  tools: unknown[];
};

/** A completion the model did not return: what the session records as the generation's error. */
type CompletionFailure = { failure: string };

/** What a generation has used across its steps: the tool calls it made, and the seqs its projections stubbed. */
type GenerationProgress = { toolCalls: number; stubbed: number[] };

/** Whether the generation takes another step after this one. */
type StepEnd = "next" | "stop";

/**
 * A coach conversation's history as the model is sent it: the stored rows, the generation they
 * are seen from, the context and system prompt this generation replaces, and how old tool
 * results are stubbed. `stubbed` collects the seqs the projection stubs.
 */
export type ConversationProjection = {
  history: ProjectedRow[];
  generationContext: string;
  currentGeneration: number;
  stubHint: string;
  stubbed: number[];
  minUnstubbed?: number;
  budget?: ConversationProjectionBudget;
  systemContent?: string;
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

  start(args: ConversationGeneration): void {
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

  private async run(turn: ConversationGeneration): Promise<void> {
    const sessionId = turn.session.id;
    const orgId = turn.session.org_id;
    const cancel = new CancelEvent();
    this.cancels.set(sessionId, cancel);
    await this.publish(sessionId, "generation.started", {
      session_id: sessionId,
      generation: turn.generation,
    });
    const kind = this.deps.kind;
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
      const progress: GenerationProgress = { toolCalls: 0, stubbed: [] };
      let step = 0;
      while (step < turn.maxSteps && (await this.takeStep(turn, cancel, progress)) === "next") {
        step += 1;
      }
      if (step >= turn.maxSteps) {
        await this.fail(sessionId, "generation step limit reached");
      }
    } finally {
      this.cancels.delete(sessionId);
      this.deps.admission.release(kind, sessionId);
      await updateConversationSession(this.deps.db, this.session(sessionId), { generation_state: "idle", generation_token: null, generation_started_at: null }, new Date());
      await this.publish(sessionId, "generation.finished", { session_id: sessionId, generation: turn.generation });
    }
  }

  /**
   * One model step: sends the projected history to the model, commits its message, and runs its
   * tool calls. The generation stops after a step that is cancelled, would pass the input limit,
   * fails, calls no tool, or awaits the operator.
   */
  private async takeStep(turn: ConversationGeneration, cancel: CancelEvent, progress: GenerationProgress): Promise<StepEnd> {
    const sessionId = turn.session.id;
    if (cancel.aborted) {
      await this.repair(sessionId, turn.generation, "cancelled");
      return "stop";
    }
    const { model, temperature } = turn.session.config_snapshot;
    const schemas = offeredToolSchemas(turn);
    const messages = await this.projectHistory(turn, progress);
    if (generationLive.countInputTokens(model, messages, schemas) > turn.maxInput) {
      await this.blockAtInputTokenLimit(sessionId);
      return "stop";
    }
    await this.assertAllowed(turn.session.org_id);
    const completion = await this.requestCompletion(
      turn,
      { model, messages, temperature, max_tokens: turn.maxTokens, tools: schemas },
      cancel,
    );
    if ("failure" in completion) {
      if (cancel.aborted) {
        await this.repair(sessionId, turn.generation, "cancelled");
      } else {
        await this.fail(sessionId, completion.failure);
      }
      return "stop";
    }
    await this.commitCompletion(turn, messages, completion, progress);
    if (!completion.payload.tool_calls?.length) {
      return "stop";
    }
    return (await this.runToolCalls(turn, messages, completion, progress)) ? "stop" : "next";
  }

  /** The history as this step sends it to the model; the seqs it stubs join the generation's. */
  private async projectHistory(turn: ConversationGeneration, progress: GenerationProgress): Promise<MessagePayload[]> {
    const history = await listConversationMessages(this.deps.db, this.deps.kind, turn.session.id);
    const stubbedThisStep: number[] = [];
    const minUnstubbed = turn.minUnstubbed ?? this.deps.minUnstubbedToolResults;
    const messages = projectConversationHistory({
      history,
      generationContext: turn.generationContext,
      currentGeneration: turn.generation,
      stubHint: this.deps.stubHint,
      stubbed: stubbedThisStep,
      ...(minUnstubbed !== undefined ? { minUnstubbed } : {}),
      budget: {
        model: turn.session.config_snapshot.model,
        schemas: offeredToolSchemas(turn),
        maxInput: turn.maxInput,
        countInputTokens: (nextModel, nextMessages, nextTools) =>
          generationLive.countInputTokens(nextModel, nextMessages, nextTools),
      },
      ...(turn.systemContent ? { systemContent: turn.systemContent } : {}),
    });
    progress.stubbed.push(...stubbedThisStep.filter((seq) => !progress.stubbed.includes(seq)));
    return messages;
  }

  /** Blocks the session because its projected history passes the input-token limit. */
  private async blockAtInputTokenLimit(sessionId: string): Promise<void> {
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
      operation: `${this.deps.kind}.session`,
      session_id: sessionId,
      error_type: "InputTokenLimit",
    });
  }

  /** Commits the model's message with the projection it answered, and charges its usage to the organisation. */
  private async commitCompletion(
    turn: ConversationGeneration,
    messages: MessagePayload[],
    completion: Completion,
    progress: GenerationProgress,
  ): Promise<void> {
    const sessionId = turn.session.id;
    const now = new Date();
    const seq = await nextConversationSeq(this.deps.db, this.deps.kind, sessionId);
    const metadata = {
      generation: turn.generation,
      projection_policy_version: this.deps.projectionPolicyVersion ?? 2,
      projected_input_hash: promptHash(JSON.stringify(messages)),
      stubbed_message_seqs: progress.stubbed,
      ...completion.metadata,
    };
    const row = await insertConversationMessage(
      this.deps.db,
      this.deps.kind,
      {
        session_id: sessionId,
        seq,
        generation: turn.generation,
        payload: completion.payload,
        metadata,
      },
      now,
    );
    await incrementOrgUsage(this.deps.db, turn.session.org_id, metadata, now);
    await this.publish(sessionId, "message.committed", { message: row });
  }

  /**
   * Runs the completion's tool calls in order; a call past the generation's limit is answered
   * with an error. True when a result awaits the operator.
   */
  private async runToolCalls(
    turn: ConversationGeneration,
    messages: MessagePayload[],
    completion: Completion,
    progress: GenerationProgress,
  ): Promise<boolean> {
    let awaitsOperator = false;
    for (const call of completion.payload.tool_calls ?? []) {
      progress.toolCalls += 1;
      if (progress.toolCalls > turn.maxToolCalls) {
        await this.commitToolError(turn.session.id, turn.generation, call, "tool call limit reached");
        continue;
      }
      const result = await this.runToolCall(turn, messages, call, completion.metadata.finish_reason);
      if (result.await_operator === true) {
        awaitsOperator = true;
      }
    }
    return awaitsOperator;
  }

  /**
   * Calls the tool and commits its result as the next message, or an error when the result
   * would put the next prompt over the input limit, then hands the result to `onToolResult`.
   */
  private async runToolCall(
    turn: ConversationGeneration,
    messages: MessagePayload[],
    call: ToolCall,
    finishReason: string,
  ): Promise<Record<string, unknown>> {
    const sessionId = turn.session.id;
    const name = call.function.name;
    const upcoming = await nextConversationSeq(this.deps.db, this.deps.kind, sessionId);
    const result = await callConversationTool(turn, call, upcoming, finishReason);
    const envelope = { tool_message_seq: upcoming, ...result };
    const candidateMessages = [
      ...messages,
      { role: "tool", tool_call_id: call.id, content: JSON.stringify(envelope) },
    ];
    const nextTokens = generationLive.countInputTokens(
      turn.session.config_snapshot.model,
      candidateMessages,
      offeredToolSchemas(turn),
    );
    const payload: ToolMessage =
      nextTokens > turn.maxInput
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
        generation: turn.generation,
        payload,
        metadata: { generation: turn.generation, tool_name: name },
      },
      new Date(),
    );
    await this.publish(sessionId, "message.committed", { message: committed });
    if (this.deps.onToolResult) {
      await this.deps.onToolResult(sessionId, name, result, (id, event, data) => this.publish(id, event, data));
    }
    return result;
  }

  /** The model's completion of a step; a provider failure or a cancel ends with its message as a typed failure. */
  private async requestCompletion(
    turn: ConversationGeneration,
    request: CompletionRequest,
    cancel: CancelEvent,
  ): Promise<Completion | CompletionFailure> {
    try {
      return await this.complete(turn, request, cancel);
    } catch (error) {
      return { failure: error instanceof Error ? error.message : "provider error" };
    }
  }

  private async complete(
    turn: ConversationGeneration,
    request: CompletionRequest,
    cancel: CancelEvent,
  ): Promise<Completion> {
    const sessionId = turn.session.id;
    const abort = new AbortController();
    const credentials: ModelCredentials = await resolveModelCredentials(
      this.deps.credentials ?? NO_CREDENTIALS,
      turn.session.org_id,
      request.model,
    );
    void modelCatalog.ensureFresh();
    const agen = generationLive.streamCompletion(
      {
        model: request.model,
        messages: request.messages,
        temperature: request.temperature,
        max_tokens: request.max_tokens,
        tools: request.tools,
      },
      credentials,
      abort.signal,
    );
    const iterator = agen[Symbol.asyncIterator]();
    let completion: Completion | null = null;
    try {
      while (true) {
        const nextPromise = iterator.next();
        const winner = await Promise.race([
          nextPromise.then((value) => ({ cancelled: false as const, value })),
          cancel.wait().then(() => ({ cancelled: true as const })),
        ]);
        if (winner.cancelled) {
          abort.abort();
          throw new ConversationCancelled();
        }
        const result = winner.value;
        if (result.done) break;
        const event = result.value;
        if (event[0] === "delta") {
          await this.publish(sessionId, "assistant.delta", {
            session_id: sessionId,
            content: event[1],
            text: event[1],
          });
        } else if (event[0] === "reasoning") {
          await this.publish(sessionId, "assistant.reasoning.delta", {
            session_id: sessionId,
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
    await reportModelUsage(credentials, modelUsageOf(sessionId, request.model, completion.metadata));
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

/** The function schemas of the tools a generation offers, as the model is sent them. */
function offeredToolSchemas(turn: ConversationGeneration): Array<Record<string, unknown>> {
  return [...turn.tools.values()].map((tool) => tool.schema);
}

export function projectConversationHistory(args: ConversationProjection): MessagePayload[] {
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

/**
 * Calls the tool the model named with the call's arguments and the generation's tool context.
 * A tool that is unknown, whose arguments the step's output cut short, or that throws, ends with
 * its error as the result, which the model reads.
 */
export async function callConversationTool(
  turn: ConversationGeneration,
  call: ToolCall,
  upcoming: number,
  finishReason: string,
): Promise<Record<string, unknown>> {
  const tool = turn.tools.get(call.function.name);
  if (!tool) {
    return { error: `unknown tool ${call.function.name}` };
  }
  if (truncatedToolArguments(finishReason, call.function.arguments)) {
    return {
      error: "output truncated at max_tokens; tool arguments are incomplete JSON. Retry with a smaller payload.",
    };
  }
  try {
    return await tool.handler(
      turn.bindToolContext ? turn.bindToolContext(upcoming) : turn.toolContext,
      parseToolArgs(call.function.arguments),
    );
  } catch (error) {
    return { error: error instanceof Error ? error.message : "tool failed" };
  }
}

export function toolArgsAreJsonObject(raw: unknown): boolean {
  if (isPlainRecord(raw)) {
    return true;
  }
  if (typeof raw !== "string" || !raw.trim()) {
    return false;
  }
  try {
    return isPlainRecord(JSON.parse(raw));
  } catch {
    return false;
  }
}

export function truncatedToolArguments(finishReason: unknown, raw: unknown): boolean {
  return finishReason === "length" && !toolArgsAreJsonObject(raw);
}

export function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (isPlainRecord(raw)) return raw;
  if (typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isPlainRecord(parsed)) {
      return parsed;
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
    out.agent_id = decodeJsonStringBody(handle[1]) ?? handle[1];
  }
  const rationale = raw.match(/"rationale"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (rationale?.[1]) {
    out.rationale = decodeJsonStringBody(rationale[1]) ?? rationale[1];
  }
  return out;
}

/** The text a JSON string's body between its quotes decodes to; null when its escapes are not JSON. */
function decodeJsonStringBody(body: string): string | null {
  try {
    const decoded: unknown = JSON.parse(`"${body}"`);
    return typeof decoded === "string" ? decoded : null;
  } catch {
    return null;
  }
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
