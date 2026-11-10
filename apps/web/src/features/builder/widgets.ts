import type {
  BuilderWidget,
  ConnectScope,
  ConnectServer,
  ConnectWidget,
  Question,
  QuestionWidget,
} from "../../api/types/builder";
import type { StudioMessage } from "../../api/types/studio";
import type { AccessEdit } from "../../api/types/recipes";
import { isBuilderWidget, parseJson } from "../../api/wire";
import { pendingDesignQuestions } from "../recipes/plan/designSystems";
import type { RecipeDraft } from "../recipes/plan/recipeDraft";
import type { WidgetEvent, WidgetRow, WidgetState } from "./types";

/**
 * The Builder coach's requests to the operator, read from its tool results: a login to connect or
 * plan for, or questions to answer. Each answer goes back to the coach as the operator's message.
 */

/** The server a connect widget's card starts on: the one it names, else the first it offers. */
export function initialServerId(widget: ConnectWidget): string {
  const offered = widget.mode === "any" ? widget.servers[0] : undefined;
  return widget.server?.id ?? offered?.id ?? "";
}

/** The server a connect card signs in to: the one picked when it offers several, else its own. */
export function pickedServer(widget: ConnectWidget, picked: string): ConnectServer | null {
  if (widget.mode !== "any") return widget.server;
  return widget.servers.find((item) => item.id === picked) ?? widget.server;
}

/** How a connect card names its server: by its display name, its slug, or as "the service". */
export function serverName(server: ConnectServer | null): string {
  return server?.display_name || server?.slug || "the service";
}

/** The request a tool result carries, when it carries one. */
export function widgetOf(
  message: Pick<StudioMessage, "payload"> | null | undefined,
): BuilderWidget | null {
  if (message?.payload.role !== "tool") return null;
  const body = parseJson(message.payload.content);
  return isBuilderWidget(body) ? body : null;
}

/** One answer to a question: the options picked and any words of the operator's own. */
export type Answer = { picked: string[]; other: string };

/** True once every question has a pick or words of its own. */
export function answeredAll(
  questions: readonly Question[],
  answers: Record<string, Answer>,
): boolean {
  return questions.every((question) => {
    const answer = answers[question.id];
    return Boolean(answer && (answer.picked.length || answer.other.trim()));
  });
}

/** The operator's reply to a question widget, one line per question. */
export function answerMessage(
  questions: readonly Question[],
  answers: Record<string, Answer>,
): string {
  const lines = questions.map((question) => {
    const answer = answers[question.id] ?? { picked: [], other: "" };
    const labels = question.options
      .filter((option) => answer.picked.includes(option.id))
      .map((option) => option.label);
    const parts = [...labels, ...(answer.other.trim() ? [answer.other.trim()] : [])];
    return `- ${question.header}: ${parts.join("; ")}`;
  });
  return `I answered:\n${lines.join("\n")}`;
}

/** The design's open questions the operator has not answered here, as one question widget. */
export function pendingQuestions(
  doc: RecipeDraft | null | undefined,
  answered: ReadonlySet<string>,
): QuestionWidget | null {
  const questions = pendingDesignQuestions(doc).flatMap((system, index): Question[] => {
    const id = system.name || `pending-${index + 1}`;
    if (answered.has(id)) return [];
    const reason = (system.reason ?? "").replace(/^\s*Open question\.?\s*/i, "").trim();
    return [
      {
        id,
        header: system.name || "Open question",
        question: reason || "Please answer this before the coach continues.",
        options: [],
        allow_other: true,
        multi_select: false,
      },
    ];
  });
  return questions.length
    ? {
        widget: "question",
        await_operator: true,
        title: questions.length === 1 ? "Open question" : `${questions.length} open questions`,
        questions,
      }
    : null;
}

const scopeWords: Record<ConnectScope, string> = {
  org: "organisation",
  guild: "guild",
  agent: "agent",
};

/** What the operator tells the coach after answering a connect widget. */
export const connectReplies = {
  connected: (name: string) =>
    `${name} is now connected at organisation scope. Search it for long-lived tables we should use, ask me which ones to keep, and store queues and working files locally.`,
  planned: (name: string, scope: ConnectScope) =>
    `Use ${name} at ${scopeWords[scope]} scope. I will connect it during apply.`,
  declined: (name: string, scope: ConnectScope) =>
    `I declined connecting ${name} at ${scopeWords[scope]} scope. Continue without that login; keep working data in local notes and tables.`,
};

/** What the operator tells the coach after cutting access in the blueprint; null when nothing was removed. */
export function accessCutMessage(edits: readonly AccessEdit[]): string | null {
  const lines = edits.flatMap((edit) => {
    if (edit.action === "remove_connection") return [`- connector ${edit.server}`];
    return edit.enabled ? [] : [`- tool ${edit.tool} from ${edit.server} for ${edit.role}`];
  });
  return lines.length
    ? `I validated connector access. I removed:\n${lines.join("\n")}\nUpdate standing prompts if they rely on these, or ask me questions.`
    : null;
}

/** The state a widget card's reply moves to on each event; an event missing here changes nothing. */
const widgetTransitions: Record<WidgetState, Partial<Record<WidgetEvent, WidgetState>>> = {
  open: { send: "sending" },
  sending: { delivered: "settled", failed: "open" },
  settled: {},
};

/**
 * Moves a widget card's reply on: a send takes an open card in flight, a delivered reply settles
 * it, and a failed one leaves it open to try again. A send while a reply is in flight, or any event
 * once the card has settled, changes nothing.
 */
export function reduceWidget(state: WidgetState, event: WidgetEvent): WidgetState {
  return widgetTransitions[state][event] ?? state;
}

/** A widget card's button row, by where its reply stands. */
export const widgetRows = {
  open: { disabled: false, badge: null },
  sending: { disabled: true, badge: { label: "Sending", status: "running" } },
  settled: { disabled: true, badge: null },
} as const satisfies Record<WidgetState, WidgetRow>;
