import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useCreateStudioSession, useGuilds, useModels, useStudioSessions } from "../../api/queries";
import { marketplaceCatalogModels } from "../../api/types";
import { messageTime } from "../../app/format";
import { ModelKeyGapHint, useModelKeyGap } from "../instance/ModelKeyGapHint";
import {
  Button,
  Select,
  TextField,
  Banner,
  EmptyState,
  SkeletonRows,
  Row,
  Tag,
} from "@guildsrun/ui";
/**
 * Studio's start: a coach session on one guild. An open session resumes; a new one picks the
 * coach's model and temperature.
 */
export function StudioLanding() {
  const search = useSearch({ strict: false }) as { guild?: string; new?: boolean };
  const navigate = useNavigate();
  const guilds = useGuilds();
  const sessions = useStudioSessions();
  const models = useModels();
  const create = useCreateStudioSession();
  const [guildId, setGuildId] = useState(search.guild ?? "");
  const [model, setModel] = useState("");
  const [temperature, setTemperature] = useState("0.2");

  const chosenGuild = guildId || guilds.data?.[0]?.id || "";
  const chosenModel = model || models.data?.default || "";
  const keyGap = useModelKeyGap(chosenModel);
  const listed = (sessions.data ?? []).filter(
    (session) => !guildId || session.source_guild_id === guildId,
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = Number(temperature);
    if (!chosenGuild || !chosenModel || !Number.isFinite(value) || value < 0 || value > 2) return;
    create.mutate(
      { guildId: chosenGuild, model: chosenModel, temperature: value },
      {
        onSuccess: (session) =>
          void navigate({ to: "/studio/$sessionId", params: { sessionId: session.id } }),
      },
    );
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8 md:px-10">
      <div className="mx-auto flex max-w-200 flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h1 className="type-h1">Studio</h1>
          <p className="text-sm text-fg-2">
            Talk a guild over with a coach: it reads the agents' runs, memory and tools, explains
            what happened, and proposes Task changes for you to publish.
          </p>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-4 rounded-xl bg-surface p-5">
          <div className="grid gap-4 md:grid-cols-3">
            <Select
              tone="paper"
              label="Guild"
              value={chosenGuild}
              onValueChange={setGuildId}
              options={(guilds.data ?? []).map((guild) => ({ value: guild.id, label: guild.name }))}
            />
            <Select
              tone="paper"
              label="Coach model"
              value={chosenModel}
              onValueChange={setModel}
              options={marketplaceCatalogModels(models.data).map((item) => ({
                value: item.id,
                label: item.label,
              }))}
              {...(keyGap ? { hint: <ModelKeyGapHint integration={keyGap} /> } : {})}
            />
            <TextField
              tone="paper"
              label="Temperature"
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={temperature}
              onChange={(event) => setTemperature(event.currentTarget.value)}
            />
          </div>
          {create.isError ? (
            <Banner tone="error" title="Couldn't start the session">
              {create.error.message}
            </Banner>
          ) : null}
          <Button
            type="submit"
            className="self-start"
            disabled={create.isPending || !chosenGuild || !chosenModel}
          >
            <Sparkles size={14} />
            Start a session
          </Button>
        </form>

        <section aria-label="Sessions" className="flex flex-col gap-2">
          <h2 className="type-label text-muted">Your sessions{guildId ? " on this guild" : ""}</h2>
          {sessions.isPending ? (
            <SkeletonRows rows={3} label="Loading sessions" />
          ) : listed.length === 0 ? (
            <EmptyState icon={Sparkles} title="No sessions yet" description="Start one above." />
          ) : (
            listed.map((session) => (
              <Row
                key={session.id}
                asChild
                tone="surface"
                interactive
                title={session.source_guild?.name ?? session.source_guild_id}
                meta={`${session.coach.model} · started ${messageTime(session.created_at)}${session.parent_session_id ? " · continues an earlier session" : ""}`}
                trail={
                  <Tag tone={session.status === "active" ? "tide" : "well"} font="sans">
                    {session.status}
                  </Tag>
                }
              >
                <Link to="/studio/$sessionId" params={{ sessionId: session.id }} />
              </Row>
            ))
          )}
        </section>
      </div>
    </div>
  );
}
