import { Link, useNavigate } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useBuilderSessions, useOrgModels, useStartBuilder } from "../../api/queries";
import { hasConnectedProvider } from "../../api/types";
import { useIdentity } from "../../app/identity";
import { relativeTime } from "../../app/format";
import { ConnectProviderGuide } from "../models/ConnectProviderGuide";
import { modelOptions, preselectedModel } from "../models/models";
import {
  Button,
  Select,
  TextAreaField,
  Banner,
  SkeletonRows,
  toast,
  Icon,
  Row,
  Tag,
} from "@guildsrun/ui";
/** Descriptions to start from; picking one fills the box to edit before sending. */
const examples = [
  {
    label: "Reply to X mentions in my voice",
    brief:
      "Reply to mentions of my X account in my voice. Draft each reply for me to approve, and post only the ones I approve.",
  },
  {
    label: "Weekly competitor digest",
    brief:
      "Every Monday, research what our competitors shipped, announced or changed last week, and post a short digest with links.",
  },
  {
    label: "LinkedIn prospecting desk",
    brief:
      "Find people on LinkedIn who match our ideal customer, research each one, and draft a personal first message for me to review.",
  },
];

/**
 * The Builder's start: describe a guild in a sentence or two and a coach drafts it as a recipe,
 * asking what it needs; earlier drafts resume below.
 */
export function BuilderLanding() {
  const navigate = useNavigate();
  const sessions = useBuilderSessions();
  const { org } = useIdentity();
  const models = useOrgModels(org.id);
  const start = useStartBuilder();
  const [model, setModel] = useState("");
  const [brief, setBrief] = useState("");
  const chosenModel = model || preselectedModel(models.data, { marketplaceOnly: true });
  const noProvider = hasConnectedProvider(models.data) === false;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = brief.trim();
    if (!text || !chosenModel) return;
    start.mutate(
      { model: chosenModel, brief: text },
      {
        onSuccess: ({ session, error }) => {
          if (error)
            toast({
              kind: "error",
              title: "Couldn't send the description",
              description: error.message,
            });
          void navigate({ to: "/builder/$sessionId", params: { sessionId: session.id } });
        },
      },
    );
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <form
        onSubmit={submit}
        className="flex flex-col gap-4 bg-plum px-6 pt-7 pb-8 text-on-plum md:px-10"
      >
        <span className="type-label text-signal-soft">Builder</span>
        <h1 className="type-h1">Describe the guild you want.</h1>
        <div className="flex max-w-240 flex-col gap-3 rounded-xl bg-paper p-4 text-fg">
          <TextAreaField
            tone="paper"
            font="sans"
            aria-label="What the guild should do"
            placeholder="A desk that scouts new token launches, researches the holders, and only buys after I approve."
            rows={3}
            value={brief}
            onChange={(event) => setBrief(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit(event);
            }}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Select
              tone="surface"
              aria-label="Coach model"
              placeholder="Choose a model"
              lead={<span className="text-xs font-semibold text-muted">Coach</span>}
              className="min-w-56"
              value={chosenModel}
              onValueChange={setModel}
              options={modelOptions(models.data, { current: chosenModel, marketplaceOnly: true })}
            />
            <span className="flex-1" />
            <Button
              type="submit"
              variant="accent"
              size="lg"
              disabled={start.isPending || !brief.trim() || !chosenModel}
            >
              <Icon icon={Sparkles} size={14} />
              {start.isPending ? "Starting…" : "Draft the recipe"}
            </Button>
          </div>
          {noProvider ? <ConnectProviderGuide what="the Builder" /> : null}
          {start.isError ? (
            <Banner tone="error" title="Couldn't start the Builder">
              {start.error.message}
            </Banner>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-on-plum-muted">Try</span>
          {examples.map((example) => (
            <Button
              key={example.label}
              type="button"
              variant="on-plum"
              size="sm"
              onClick={() => setBrief(example.brief)}
            >
              {example.label}
            </Button>
          ))}
        </div>
      </form>

      <section aria-label="Drafts" className="px-6 py-8 md:px-10">
        <div className="flex max-w-240 flex-col gap-2">
          <div className="flex flex-col gap-0.5">
            <h2 className="type-label text-muted">Your drafts</h2>
            <p className="text-sm text-muted">
              Nothing is created or run until you deploy a recipe as a guild.
            </p>
          </div>
          {sessions.isPending ? (
            <SkeletonRows rows={3} label="Loading drafts" />
          ) : sessions.isError ? (
            <Banner tone="error" title="Couldn't load your drafts" meta={sessions.error.message} />
          ) : sessions.data.length === 0 ? (
            <p className="text-sm text-muted">
              No drafts yet. Describe a guild above to start one.
            </p>
          ) : (
            sessions.data.map((session) => (
              <Row
                key={session.id}
                asChild
                tone="surface"
                interactive
                title={session.recipe?.name || "Untitled guild"}
                meta={`${session.recipe ? `body v${session.recipe.body_version} · ` : ""}${session.generation_state === "idle" ? "" : "coach designing · "}updated ${relativeTime(session.updated_at)}`}
                trail={
                  <>
                    {session.status !== "active" ? (
                      <Tag tone="well" font="sans">
                        {session.status}
                      </Tag>
                    ) : null}
                    {session.recipe ? (
                      <Tag tone={session.recipe.status === "ready" ? "tide" : "ochre"} font="sans">
                        {session.recipe.status === "ready" ? "approved" : "draft"}
                      </Tag>
                    ) : null}
                  </>
                }
              >
                <Link to="/builder/$sessionId" params={{ sessionId: session.id }} />
              </Row>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
