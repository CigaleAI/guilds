import type { AccessEdit, ConnectorAuthField, StudioMessage } from "../../api/types";
import { pendingDesignQuestions } from "../recipes/plan/planModel";

/**
 * The Builder coach's requests to the operator, read from its tool results: a login to connect or
 * plan for, or questions to answer. Each answer goes back to the coach as the operator's message.
 */

export type ConnectScope = "org" | "guild" | "agent";

/** A connector the coach names, as the widget carries it. */
export type WidgetServer = {
  id: string;
  slug: string;
  display_name: string;
  auth: "token" | "oauth" | "none";
  setup_hint: string | null;
  /** The inputs a key login asks for. */
  auth_fields?: ConnectorAuthField[];
  connection_state?: "connected" | "registered_not_connected";
};

export type ConnectWidget = {
  kind: "connect";
  /** `org`: connect this server to the organisation now. `any`: pick a server and where it logs in. */
  mode: "org" | "any";
  title: string;
  reason: string;
  storageHint: string | null;
  server: WidgetServer | null;
  servers: WidgetServer[];
  recommendedScope: ConnectScope;
  allowedScopes: ConnectScope[];
  alreadyConnected: boolean;
};

export type QuestionOption = { id: string; label: string; description: string };

export type Question = {
  id: string;
  header: string;
  question: string;
  options: QuestionOption[];
  allowOther: boolean;
  multiSelect: boolean;
};

export type QuestionWidget = { kind: "question"; title: string; questions: Question[] };

export type BuilderWidget = ConnectWidget | QuestionWidget;

const scopes: readonly ConnectScope[] = ["org", "guild", "agent"];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const text = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);

function serverOf(value: unknown): WidgetServer | null {
  const row = record(value);
  if (!row || typeof row.id !== "string") return null;
  const auth = row.auth === "token" || row.auth === "none" ? row.auth : "oauth";
  return {
    id: row.id,
    slug: text(row.slug),
    display_name: text(row.display_name) || text(row.slug),
    auth,
    setup_hint: typeof row.setup_hint === "string" ? row.setup_hint : null,
    ...(Array.isArray(row.auth_fields)
      ? { auth_fields: row.auth_fields as ConnectorAuthField[] }
      : {}),
    ...(row.connection_state === "connected" || row.connection_state === "registered_not_connected"
      ? { connection_state: row.connection_state }
      : {}),
  };
}

function scopeOf(value: unknown, fallback: ConnectScope): ConnectScope {
  return scopes.includes(value as ConnectScope) ? (value as ConnectScope) : fallback;
}

function questionOf(value: unknown, index: number): Question | null {
  const row = record(value);
  if (!row || !text(row.question).trim()) return null;
  const options = (Array.isArray(row.options) ? row.options : []).flatMap((item, position) => {
    const option = record(item);
    if (!option || !text(option.label).trim()) return [];
    return [
      {
        id: text(option.id) || `opt-${position + 1}`,
        label: text(option.label).trim(),
        description: text(option.description).trim(),
      },
    ];
  });
  return {
    id: text(row.id) || `q-${index + 1}`,
    header: text(row.header) || "Question",
    question: text(row.question).trim(),
    options,
    allowOther: options.length === 0 || row.allow_other !== false,
    multiSelect: row.multi_select === true,
  };
}

function widgetFrom(body: Record<string, unknown>): BuilderWidget | null {
  if (body.widget === "question") {
    const raw = Array.isArray(body.questions) ? body.questions : body.question ? [body] : [];
    const questions = raw.flatMap((item, index) => questionOf(item, index) ?? []);
    return questions.length
      ? { kind: "question", title: text(body.title) || "Question", questions }
      : null;
  }
  if (body.widget === "connect") {
    const recommended = scopeOf(body.recommended_scope, "org");
    const allowed = (Array.isArray(body.allowed_scopes) ? body.allowed_scopes : []).filter(
      (scope): scope is ConnectScope => scopes.includes(scope as ConnectScope),
    );
    return {
      kind: "connect",
      mode: body.mode === "any" ? "any" : "org",
      title: text(body.title) || "Connect a service",
      reason: text(body.reason),
      storageHint: typeof body.storage_hint === "string" ? body.storage_hint : null,
      server: serverOf(body.server),
      servers: (Array.isArray(body.servers) ? body.servers : []).flatMap(
        (item) => serverOf(item) ?? [],
      ),
      recommendedScope: recommended,
      allowedScopes: allowed.length ? allowed : [recommended],
      alreadyConnected: body.already_connected === true,
    };
  }
  return null;
}

/** The request a tool result carries, when it carries one. */
export function widgetOf(
  message: Pick<StudioMessage, "payload"> | null | undefined,
): BuilderWidget | null {
  if (!message) return null;
  const role = message.payload.role;
  if (role !== undefined && role !== "tool") return null;
  const parse = (value: unknown): Record<string, unknown> | null => {
    if (typeof value !== "string") return null;
    try {
      return record(JSON.parse(value));
    } catch {
      return null;
    }
  };
  const body = parse(message.payload.content);
  if (!body) return null;
  return widgetFrom(body) ?? (parse(body.content) ? widgetFrom(parse(body.content) ?? {}) : null);
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
  recipe: unknown,
  answered: ReadonlySet<string>,
): QuestionWidget | null {
  const questions = pendingDesignQuestions(recipe).flatMap((system, index): Question[] => {
    const id = system.name || `pending-${index + 1}`;
    if (answered.has(id)) return [];
    const reason = (system.reason ?? "").replace(/^\s*Open question\.?\s*/i, "").trim();
    return [
      {
        id,
        header: system.name || "Open question",
        question: reason || "Please answer this before the coach continues.",
        options: [],
        allowOther: true,
        multiSelect: false,
      },
    ];
  });
  return questions.length
    ? {
        kind: "question",
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
    `I declined connecting ${name} at ${scopeWords[scope]} scope. Continue without that login; keep working data in local notes and collections.`,
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
