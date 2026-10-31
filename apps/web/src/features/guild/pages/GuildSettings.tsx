import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Trash2, X } from "lucide-react";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  useDeleteGuild,
  useGuild,
  useRemoveOperator,
  useSetOperator,
  useUpdateGuild,
} from "../../../api/queries/guilds";
import { useGroupChatState, useSetMessageLimit } from "../../../api/queries/chat";
import { useGuildAgents } from "../../../api/queries/agents";
import { useOrgMembers } from "../../../api/queries/org";
import type { Guild, GuildOperator } from "../../../api/types/guilds";
import { useIdentity } from "../../../app/identity";
import {
  Button,
  IconButton,
  Markdown,
  Checkbox,
  Segmented,
  Select,
  TextAreaField,
  TextField,
  Banner,
  SkeletonRows,
  Avatar,
  ConfirmDialog,
  toast,
  Icon,
  personTone,
  Tag,
} from "@guildsrun/ui";
import { handleError, handleHint } from "../../../app/names";
import { isGuildAdmin, isOperatorRole } from "../permissions";
import { GuildPage } from "./GuildPage";
import { GuildRepositories } from "../../agent/GuildRepositories";

/** The server's limits on a guild's text. */
const aboutMax = 200;
const descriptionMax = 8000;

type Form = {
  name: string;
  about: string;
  description: string;
  maxAgents: string;
  gitAuthorEmail: string;
  messageLimit: string;
  private: boolean;
  routines: boolean;
};

function positiveInteger(text: string): boolean {
  return /^\d+$/.test(text.trim()) && Number(text) >= 1;
}

type GroupProps = { title: string; children: ReactNode };

function Group({ title, children }: GroupProps) {
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <h3 className="type-label text-muted">{title}</h3>
      {children}
    </section>
  );
}

/**
 * What the guild is for and how it runs: its name, description, agent cap, turn limit, visibility
 * and routines; its operators; its git commit author email and repositories; and deleting it.
 * Visibility, operators and deleting are for guild admins.
 */
export function GuildSettings() {
  const { guildId } = useParams({ from: "/guilds/$guildId" });
  const { user } = useIdentity();
  const guild = useGuild(guildId);
  const agents = useGuildAgents(guildId);
  const chat = useGroupChatState(guildId);
  const update = useUpdateGuild(guildId);
  const setLimit = useSetMessageLimit(guildId);
  const [draft, setDraft] = useState<Form | null>(null);

  const saved = useMemo<Form | null>(
    () =>
      guild.data && chat.data
        ? {
            name: guild.data.name,
            about: guild.data.about,
            description: guild.data.description,
            maxAgents: String(guild.data.max_agents),
            gitAuthorEmail: guild.data.git_author_email,
            messageLimit: String(chat.data.agent_message_limit),
            private: guild.data.visibility === "private",
            routines: guild.data.routines_enabled,
          }
        : null,
    [guild.data, chat.data],
  );
  const form = draft ?? saved;

  if (!guild.data || !form || !saved) {
    return (
      <GuildPage>
        <SkeletonRows rows={6} label="Loading settings" />
      </GuildPage>
    );
  }

  const admin = isGuildAdmin(guild.data, user.id);
  const agentCount = (agents.data ?? []).length;
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const errors = formErrors(form);
  const invalid = Object.values(errors).some(Boolean);
  const saving = update.isPending || setLimit.isPending;
  const set = (patch: Partial<Form>) => setDraft({ ...form, ...patch });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (invalid) return;
    // A save that fails shows in the banner under the form, from the mutation's error.
    const results = await Promise.allSettled([
      update.mutateAsync({
        name: form.name.trim(),
        about: form.about.trim(),
        description: form.description.trim(),
        max_agents: Number(form.maxAgents),
        git_author_email: form.gitAuthorEmail.trim(),
        routines_enabled: form.routines,
        ...(admin ? { visibility: form.private ? ("private" as const) : ("org" as const) } : {}),
      }),
      form.messageLimit !== saved.messageLimit
        ? setLimit.mutateAsync(Number(form.messageLimit))
        : undefined,
    ]);
    if (results.some((result) => result.status === "rejected")) return;
    setDraft(null);
    toast({ kind: "success", title: "Guild settings saved" });
  };

  const failure = update.error ?? setLimit.error;

  return (
    <form onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-1 flex-col">
      <GuildPage>
        <Group title="Identity">
          <TextField
            tone="surface"
            label="Name"
            mono
            required
            autoComplete="off"
            maxLength={63}
            placeholder="research"
            hint="Shown in the sidebar and header."
            value={form.name}
            onChange={(event) => set({ name: event.currentTarget.value })}
            {...(errors.name ? { error: errors.name } : {})}
          />
        </Group>

        <PurposeGroup form={form} onChange={set} />
        <LimitsGroup form={form} errors={errors} agentCount={agentCount} onChange={set} />
        <BehaviourGroup form={form} admin={admin} onChange={set} />

        {failure ? (
          <Banner tone="error" title="Couldn't save the settings">
            {failure.message}
          </Banner>
        ) : null}

        <Operators guild={guild.data} admin={admin} />
        <Group title="Git">
          <TextField
            tone="surface"
            label="Commit author email"
            type="email"
            placeholder="you@example.com"
            hint="A verified email on the GitHub account that owns the Vercel project (Hobby: the account owner). Empty uses each agent's platform address."
            value={form.gitAuthorEmail}
            onChange={(event) => set({ gitAuthorEmail: event.currentTarget.value })}
          />
        </Group>
        <GuildRepositories guild={guild.data} />
        {admin ? <DangerZone guild={guild.data} /> : null}
      </GuildPage>
      <SettingsFooter
        dirty={dirty}
        invalid={invalid}
        saving={saving}
        onDiscard={() => setDraft(null)}
      />
    </form>
  );
}

type FormErrors = {
  name: string | undefined;
  maxAgents: string | undefined;
  messageLimit: string | undefined;
};

/** Why each checked field of the form cannot be saved; undefined for one that can. */
function formErrors(form: Form): FormErrors {
  return {
    name: form.name.trim() ? handleError(form.name.trim()) : handleHint,
    maxAgents: positiveInteger(form.maxAgents) ? undefined : "A whole number, 1 or more.",
    messageLimit: positiveInteger(form.messageLimit) ? undefined : "A whole number, 1 or more.",
  };
}

type PurposeGroupProps = { form: Form; onChange: (patch: Partial<Form>) => void };

/** What the guild is for: its short description, and its Markdown description to write or preview. */
function PurposeGroup({ form, onChange }: PurposeGroupProps) {
  const [view, setView] = useState<"write" | "preview">("write");
  return (
    <Group title="Purpose">
      <TextAreaField
        tone="surface"
        label="Short description"
        font="sans"
        rows={2}
        maxLength={aboutMax}
        showCount
        placeholder="High-level goal for everyone in this guild"
        hint="Shown in the guild header and to agents."
        value={form.about}
        onChange={(event) => onChange({ about: event.currentTarget.value })}
      />
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-semibold">Description</span>
          <Segmented
            size="sm"
            label="Description view"
            value={view}
            onValueChange={setView}
            options={[
              { value: "write", label: "Write" },
              { value: "preview", label: "Preview" },
            ]}
          />
        </div>
        {view === "write" ? (
          <TextAreaField
            tone="surface"
            aria-label="Description"
            font="mono"
            rows={12}
            maxLength={descriptionMax}
            showCount
            placeholder="What this guild is for, how it should work, constraints"
            hint="Markdown. Agents read it on every run."
            value={form.description}
            onChange={(event) => onChange({ description: event.currentTarget.value })}
          />
        ) : (
          <div className="min-h-40 rounded-lg bg-surface px-4 py-3">
            {form.description.trim() ? (
              <Markdown>{form.description}</Markdown>
            ) : (
              <p className="text-sm text-muted">Nothing written yet.</p>
            )}
          </div>
        )}
      </div>
    </Group>
  );
}

type LimitsGroupProps = {
  form: Form;
  errors: FormErrors;
  /** How many agents the guild has now. */
  agentCount: number;
  onChange: (patch: Partial<Form>) => void;
};

/** The guild's agent cap and how many agent turns in a row the group chat allows. */
function LimitsGroup({ form, errors, agentCount, onChange }: LimitsGroupProps) {
  return (
    <Group title="Limits">
      <div className="grid gap-4 md:grid-cols-2">
        <TextField
          tone="surface"
          label="Agents"
          type="number"
          min={1}
          hint={`This guild has ${agentCount} agent${agentCount === 1 ? "" : "s"}. New agents are refused past this number.`}
          value={form.maxAgents}
          onChange={(event) => onChange({ maxAgents: event.currentTarget.value })}
          {...(errors.maxAgents ? { error: errors.maxAgents } : {})}
        />
        <TextField
          tone="surface"
          label="Agent turns in a row"
          type="number"
          min={1}
          hint="Agent messages in the group chat before an operator must post."
          value={form.messageLimit}
          onChange={(event) => onChange({ messageLimit: event.currentTarget.value })}
          {...(errors.messageLimit ? { error: errors.messageLimit } : {})}
        />
      </div>
    </Group>
  );
}

type BehaviourGroupProps = {
  form: Form;
  /** Only a guild admin changes the guild's visibility. */
  admin: boolean;
  onChange: (patch: Partial<Form>) => void;
};

/** Whether the guild's routines fire, and for an admin whether the guild is private. */
function BehaviourGroup({ form, admin, onChange }: BehaviourGroupProps) {
  return (
    <Group title="Behaviour">
      <div className="flex flex-col gap-1">
        <Checkbox
          label="Routines fire on schedule"
          checked={form.routines}
          onCheckedChange={(checked) => onChange({ routines: checked === true })}
        />
        <p className="pl-7 text-sm text-fg-2">
          Turn this off to hold every routine; paused routines stay paused.
        </p>
      </div>
      {admin ? (
        <div className="flex flex-col gap-1">
          <Checkbox
            label="Private"
            checked={form.private}
            onCheckedChange={(checked) => onChange({ private: checked === true })}
          />
          <p className="pl-7 text-sm text-fg-2">
            Only this guild's operators can see it; others in the organisation cannot.
          </p>
        </div>
      ) : null}
    </Group>
  );
}

type SettingsFooterProps = {
  /** The form differs from the saved settings. */
  dirty: boolean;
  invalid: boolean;
  saving: boolean;
  onDiscard: () => void;
};

/** Whether there are unsaved changes, with Discard and Save. */
function SettingsFooter({ dirty, invalid, saving, onDiscard }: SettingsFooterProps) {
  return (
    <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-surface px-6 py-3 md:px-10">
      {dirty ? <span className="mr-auto text-sm text-muted">Unsaved changes</span> : null}
      <Button variant="ghost" disabled={!dirty || saving} onClick={onDiscard}>
        Discard
      </Button>
      <Button type="submit" disabled={!dirty || invalid || saving}>
        {saving ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}

type OperatorsProps = { guild: Guild; admin: boolean };

/** The people the guild works for: agents can tag them, and they get its issues and tags. */
function Operators({ guild, admin }: OperatorsProps) {
  const { user, org } = useIdentity();
  const members = useOrgMembers(org.id);
  const setOperator = useSetOperator(guild.id);
  const remove = useRemoveOperator(guild.id);
  const [adding, setAdding] = useState("");
  const [role, setRole] = useState<GuildOperator["role"]>("operator");
  const candidates = (members.data ?? []).filter(
    (member) => !guild.operators.some((operator) => operator.user_id === member.user_id),
  );
  const colorById = new Map((members.data ?? []).map((member) => [member.user_id, member.color]));

  const failed = (title: string) => (error: Error) =>
    toast({ kind: "error", title, description: error.message });

  return (
    <Group title="Operators">
      <p className="text-sm text-fg-2">
        The people this guild works for. Agents see their names and can tag them with @name, or all
        of them with @user. Operators get the guild's issues and tags in their inbox, and a private
        guild shows only to them.
        {admin ? null : " Only a guild admin can change operators."}
      </p>
      <div className="flex flex-col overflow-hidden rounded-xl bg-surface">
        {guild.operators.map((operator) => (
          <div
            key={operator.user_id}
            className="flex items-center gap-3 border-b border-line px-3.5 py-2.5 last:border-b-0"
          >
            <Avatar
              name={operator.name}
              tone={personTone(colorById.get(operator.user_id)) ?? "dusk"}
              size={28}
              round
            />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              @{operator.name}
              {operator.user_id === user.id ? (
                <Tag tone="well" className="ml-2">
                  you
                </Tag>
              ) : null}
            </span>
            {admin ? (
              <>
                <Select
                  tone="paper"
                  aria-label={`${operator.name}'s role`}
                  className="w-36"
                  value={operator.role}
                  onValueChange={(next) => {
                    if (!isOperatorRole(next)) return;
                    setOperator.mutate(
                      { userId: operator.user_id, role: next },
                      { onError: failed(`Couldn't change ${operator.name}'s role`) },
                    );
                  }}
                  options={[
                    { value: "admin", label: "Admin" },
                    { value: "operator", label: "Operator" },
                  ]}
                />
                <IconButton
                  icon={X}
                  label={`Remove ${operator.name}`}
                  variant="ghost"
                  size={28}
                  onClick={() =>
                    remove.mutate(operator.user_id, {
                      onError: failed(`Couldn't remove ${operator.name}`),
                    })
                  }
                />
              </>
            ) : (
              <span className="text-sm text-muted">
                {operator.role === "admin" ? "Admin" : "Operator"}
              </span>
            )}
          </div>
        ))}
      </div>
      {admin && candidates.length ? (
        <div className="flex flex-wrap items-end gap-2">
          <Select
            tone="surface"
            label="Add a member"
            className="min-w-56 flex-1"
            placeholder="Choose a member…"
            value={adding}
            onValueChange={setAdding}
            options={candidates.map((member) => ({
              value: member.user_id,
              label: `@${member.name}`,
            }))}
          />
          <Select
            tone="surface"
            label="Role"
            className="w-40"
            value={role}
            onValueChange={(next) => {
              if (isOperatorRole(next)) setRole(next);
            }}
            options={[
              { value: "operator", label: "Operator" },
              { value: "admin", label: "Admin" },
            ]}
          />
          <Button
            variant="outline"
            size="xl"
            disabled={!adding || setOperator.isPending}
            onClick={() =>
              setOperator.mutate(
                { userId: adding, role },
                { onSuccess: () => setAdding(""), onError: failed("Couldn't add the operator") },
              )
            }
          >
            Add
          </Button>
        </div>
      ) : admin && members.isSuccess ? (
        <p className="text-sm text-muted">
          Everyone in {org.name} already operates this guild. Add people to the organisation in{" "}
          <Link to="/settings" search={{ tab: "members" }} className="underline">
            Settings → Members
          </Link>
          .
        </p>
      ) : null}
    </Group>
  );
}

type DangerZoneProps = { guild: Guild };

/** Deleting the guild, with everything in it. */
function DangerZone({ guild }: DangerZoneProps) {
  const navigate = useNavigate();
  const remove = useDeleteGuild();
  const [confirming, setConfirming] = useState(false);
  return (
    <Group title="Delete">
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-t-plum p-4">
        <p className="min-w-60 flex-1 text-sm text-plum-t">
          Deleting the guild removes its group chat, and its agents with their sessions, notes and
          homes. Their machines stay.
        </p>
        <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
          <Icon icon={Trash2} size={14} />
          Delete guild
        </Button>
      </div>
      <ConfirmDialog
        kind="destructive"
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${guild.name}?`}
        description="Its group chat, agents, notes and agent homes are removed. This can't be undone."
        confirmLabel="Delete guild"
        confirmText={guild.name}
        onConfirm={() =>
          remove.mutateAsync(guild.id).then(
            () => {
              toast({ kind: "success", title: `${guild.name} deleted` });
              void navigate({ to: "/" });
            },
            (error: Error) => {
              toast({
                kind: "error",
                title: "Couldn't delete the guild",
                description: error.message,
              });
              throw error;
            },
          )
        }
      />
    </Group>
  );
}
