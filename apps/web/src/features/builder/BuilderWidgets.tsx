import { Check, Link2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useIdentity } from "../../app/identity";
import { Button, Select, TextField, cn, Icon, Tag } from "@guildsrun/ui";
import { useServerConnect } from "../access/ConnectDialogs";
import {
  answeredAll,
  answerMessage,
  connectReplies,
  type Answer,
  type ConnectScope,
  type ConnectWidget,
  type QuestionWidget,
  type WidgetServer,
} from "./widgets";

const scopeLabel: Record<ConnectScope, string> = {
  org: "Organisation · connect now",
  guild: "Guild · at apply",
  agent: "Agent · at apply",
};

type WidgetCardProps = {
  kicker: string;
  title: string;
  children: ReactNode;
  settled: boolean;
};

function WidgetCard({ kicker, title, children, settled }: WidgetCardProps) {
  return (
    <article
      className={cn(
        "flex flex-col gap-3 rounded-xl p-4 text-fg",
        settled ? "bg-surface" : "bg-t-sig",
      )}
    >
      <div className="flex flex-col gap-1">
        <span className="type-label text-muted">{kicker}</span>
        <span className="text-md font-semibold">{title}</span>
      </div>
      {children}
    </article>
  );
}

type WidgetProps = {
  /** The operator already replied after this request. */
  answered: boolean;
  /** False while the coach is writing; the reply waits for it. */
  live: boolean;
  onReply: (message: string) => void;
};

type ConnectCardProps = WidgetProps & { widget: ConnectWidget };

/** The coach asks for a login: connect it to the organisation now, or plan it for apply, or skip it. */
export function ConnectCard({ widget, answered, live, onReply }: ConnectCardProps) {
  const { org } = useIdentity();
  const [picked, setPicked] = useState<string>(widget.server?.id ?? widget.servers[0]?.id ?? "");
  const [scope, setScope] = useState<ConnectScope>(widget.recommendedScope);
  const [done, setDone] = useState<string | null>(null);
  const server: WidgetServer | null =
    widget.mode === "any"
      ? (widget.servers.find((item) => item.id === picked) ?? widget.server)
      : widget.server;
  const name = server?.display_name || server?.slug || "the service";
  const notSetUp = server?.oauth_setup_state === "unsupported";
  const orgConnected =
    scope === "org" && (widget.alreadyConnected || server?.connection_state === "connected");
  const connect = useServerConnect({ scope: "org", id: org.id }, () => {
    setDone(`${name} is connected. The coach carries on.`);
    onReply(connectReplies.connected(name));
  });

  const settled = answered || done !== null || orgConnected;
  const status = done
    ? done
    : answered
      ? "Answered; the coach has your reply."
      : orgConnected
        ? `${name} is connected to this organisation.`
        : scope === "org"
          ? "Connect it or skip it; the coach waits for you."
          : `${scope === "guild" ? "Guild" : "Agent"} logins are made when the guild is applied.`;

  return (
    <WidgetCard
      kicker={widget.mode === "org" ? "Organisation login" : "Connection"}
      title={widget.title}
      settled={settled}
    >
      {widget.reason ? <p className="text-sm text-fg-2">{widget.reason}</p> : null}
      {widget.storageHint ? <p className="text-xs text-muted">{widget.storageHint}</p> : null}
      {!settled ? (
        <div className="flex flex-wrap gap-3">
          {widget.mode === "any" && widget.servers.length ? (
            <Select
              tone="surface"
              label="Service"
              className="min-w-48"
              value={picked}
              onValueChange={setPicked}
              options={widget.servers.map((item) => ({
                value: item.id,
                label: `${item.display_name}${item.connection_state === "connected" ? " · connected" : ""}`,
              }))}
            />
          ) : null}
          <Select
            tone="surface"
            label="Where it logs in"
            className="min-w-48"
            value={scope}
            disabled={widget.allowedScopes.length < 2}
            onValueChange={(value) => setScope(value as ConnectScope)}
            options={widget.allowedScopes.map((value) => ({ value, label: scopeLabel[value] }))}
          />
        </div>
      ) : null}
      <p className="text-sm text-fg-2">{status}</p>
      {!settled && notSetUp ? (
        <p className="text-xs text-muted">
          Not set up on this server: a platform admin sets it up under Admin → Platform keys.
        </p>
      ) : null}
      {!settled ? (
        <div className="flex flex-wrap gap-2">
          {scope === "org" ? (
            <Button
              size="sm"
              disabled={!live || !server || connect.busy || notSetUp}
              {...(notSetUp ? { title: "Not set up on this server" } : {})}
              onClick={() =>
                server &&
                connect.start({
                  id: server.id,
                  slug: server.slug,
                  name,
                  auth: server.auth === "token" ? "token" : "oauth",
                  setup_hint: server.setup_hint ?? undefined,
                  auth_fields: server.auth_fields,
                })
              }
            >
              <Icon icon={Link2} size={14} />
              Connect {name}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!live}
              onClick={() => {
                setDone(`${name} is planned at ${scope} scope.`);
                onReply(connectReplies.planned(name, scope));
              }}
            >
              Use at {scope} scope
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={!live}
            onClick={() => {
              setDone(`Skipped ${name}.`);
              onReply(connectReplies.declined(name, scope));
            }}
          >
            Skip
          </Button>
        </div>
      ) : null}
      {connect.dialogs}
    </WidgetCard>
  );
}

type QuestionCardProps = WidgetProps & { widget: QuestionWidget; kicker?: string };

/** The coach's questions: pick options or write an answer, then send them all at once. */
export function QuestionCard({ widget, answered, live, onReply, kicker }: QuestionCardProps) {
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [sent, setSent] = useState(false);
  const settled = answered || sent;
  const ready = answeredAll(widget.questions, answers);

  const update = (id: string, change: (answer: Answer) => Answer) =>
    setAnswers((current) => ({
      ...current,
      [id]: change(current[id] ?? { picked: [], other: "" }),
    }));

  const send = () => {
    if (!ready || settled || !live) return;
    setSent(true);
    onReply(answerMessage(widget.questions, answers));
  };

  return (
    <WidgetCard
      kicker={
        settled
          ? "Answered"
          : (kicker ??
            (widget.questions.length === 1 ? "Question" : `${widget.questions.length} questions`))
      }
      title={widget.title}
      settled={settled}
    >
      {widget.questions.map((question) => {
        const answer = answers[question.id] ?? { picked: [], other: "" };
        return (
          <fieldset key={question.id} disabled={settled} className="flex flex-col gap-2">
            <legend className="flex flex-col gap-0.5">
              <span className="text-sm font-semibold">{question.header}</span>
              <span className="text-sm text-fg-2">{question.question}</span>
            </legend>
            {question.options.length ? (
              <div className="flex flex-col gap-1.5">
                {question.options.map((option, index) => {
                  const on = answer.picked.includes(option.id);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        update(question.id, (current) => ({
                          ...current,
                          picked: question.multiSelect
                            ? on
                              ? current.picked.filter((id) => id !== option.id)
                              : [...current.picked, option.id]
                            : [option.id],
                        }))
                      }
                      className="flex cursor-pointer items-start gap-2.5 rounded-lg bg-paper px-3 py-2 text-left text-sm hover:bg-paper-hi disabled:cursor-default selected:bg-ink-fill selected:text-on-ink"
                    >
                      <Tag tone="well" className="mt-0.5 shrink-0">
                        {on ? <Icon icon={Check} size={14} /> : String.fromCharCode(65 + index)}
                      </Tag>
                      <span className="flex min-w-0 flex-col">
                        <span className="font-medium">{option.label}</span>
                        {option.description ? (
                          <span className="text-xs opacity-80">{option.description}</span>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            {question.allowOther ? (
              <TextField
                tone="paper"
                label={question.options.length ? "Other" : "Your answer"}
                value={answer.other}
                onChange={(event) => {
                  const other = event.currentTarget.value;
                  update(question.id, (current) => ({ ...current, other }));
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    send();
                  }
                }}
              />
            ) : null}
          </fieldset>
        );
      })}
      {!settled ? (
        <Button size="sm" className="self-start" disabled={!ready || !live} onClick={send}>
          Send answers
        </Button>
      ) : null}
    </WidgetCard>
  );
}
