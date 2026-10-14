import { KeyRound, Pencil, Plus, Trash2, Users } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import {
  useCreateSecret,
  useDeleteSecret,
  useSecrets,
  useSetSecretAccess,
  useUpdateSecret,
  type AccessOwner,
} from "../../api/queries";
import type { Secret, SecretAccessChoice } from "../../api/types";
import { relativeTime } from "../../app/format";
import { useIdentity } from "../../app/identity";
import {
  Button,
  IconButton,
  TextField,
  Banner,
  EmptyState,
  SkeletonRows,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  toast,
  Icon,
  Tag,
} from "@guildsrun/ui";
import { SecretAccessPicker } from "./SecretAccessPicker";
import {
  availableTo,
  managesSecrets,
  reachLabel,
  secretDescriptionMax,
  secretNamePattern,
  secretOrigin,
  visibleAccess,
} from "./secrets";

/** What the view lists, and what a secret added from it is granted to by default. */
const viewCopy: Record<AccessOwner["scope"], { lead: string; empty: string }> = {
  org: {
    lead: "Every secret of the organisation, unassigned ones included.",
    empty: "No secrets yet. Add one for the whole organisation or for chosen guilds and agents.",
  },
  guild: {
    lead: "Secrets that reach this guild's agents: organisation-wide ones, the guild's, and its agents'.",
    empty: "No secret reaches this guild's agents yet.",
  },
  agent: {
    lead: "This agent's environment, exactly: every secret it gets as a variable.",
    empty: "No secret reaches this agent yet.",
  },
};

function defaultAccess(owner: AccessOwner, manager: boolean): SecretAccessChoice {
  if (owner.scope === "guild") return { org_wide: false, guild_ids: [owner.id], agent_ids: [] };
  if (owner.scope === "agent") return { org_wide: false, guild_ids: [], agent_ids: [owner.id] };
  return { org_wide: manager, guild_ids: [], agent_ids: [] };
}

/**
 * Values that reach agents' commands as environment variables. Each secret belongs to the
 * organisation under one name; its access says which agents get it.
 */
export function AccessSecrets({ owner }: { owner: AccessOwner }) {
  const { org } = useIdentity();
  const manager = managesSecrets(org.role);
  const secrets = useSecrets(owner);
  const remove = useDeleteSecret();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Secret | null>(null);
  const [granting, setGranting] = useState<Secret | null>(null);
  const [deleting, setDeleting] = useState<Secret | null>(null);
  const copy = viewCopy[owner.scope];

  const addButton = (
    <Button size="sm" onClick={() => setAdding(true)}>
      <Icon icon={Plus} size={14} />
      Add secret
    </Button>
  );

  let body: ReactNode;
  if (secrets.isPending) body = <SkeletonRows rows={4} label="Loading secrets" />;
  else if (secrets.isError) {
    body = (
      <Banner
        tone="error"
        title="Couldn't load the secrets"
        meta={secrets.error.message}
        action={
          <Button variant="outline" size="sm" onClick={() => void secrets.refetch()}>
            Retry
          </Button>
        }
      />
    );
  } else if (secrets.data.length === 0) {
    body = (
      <EmptyState icon={KeyRound} title="No secrets" description={copy.empty} action={addButton} />
    );
  } else {
    body = (
      <div className="flex flex-col overflow-hidden rounded-xl bg-surface">
        {secrets.data.map((secret) => (
          <SecretRow
            key={secret.id}
            secret={secret}
            actions={
              secret.can_manage ? (
                <>
                  <IconButton
                    icon={Pencil}
                    label={`Edit ${secret.name}`}
                    variant="ghost"
                    size={28}
                    onClick={() => setEditing(secret)}
                  />
                  {manager ? (
                    <IconButton
                      icon={Users}
                      label={`Change who gets ${secret.name}`}
                      variant="ghost"
                      size={28}
                      onClick={() => setGranting(secret)}
                    />
                  ) : null}
                  <IconButton
                    icon={Trash2}
                    label={`Delete ${secret.name}`}
                    variant="ghost"
                    size={28}
                    onClick={() => setDeleting(secret)}
                  />
                </>
              ) : null
            }
          />
        ))}
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
      <div className="mx-auto flex max-w-240 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-60 flex-1 text-sm text-fg-2">
            {copy.lead} Values reach the agents' commands; other agents on the same machine can read
            them.
          </p>
          {secrets.data?.length ? addButton : null}
        </div>
        {body}
      </div>

      <AddSecretDialog
        open={adding}
        onOpenChange={setAdding}
        initialAccess={defaultAccess(owner, manager)}
        manager={manager}
      />
      {editing ? <EditSecretDialog secret={editing} onClose={() => setEditing(null)} /> : null}
      {granting ? <SecretAccessDialog secret={granting} onClose={() => setGranting(null)} /> : null}
      <ConfirmDialog
        kind="destructive"
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? ""}?`}
        description="The secret and its value are removed. Agents that use it lose the variable from their next generation."
        confirmLabel="Delete secret"
        onConfirm={() =>
          deleting
            ? remove.mutateAsync(deleting.id).then(
                () => {
                  toast({ kind: "success", title: `${deleting.name} deleted` });
                  setDeleting(null);
                },
                (error: Error) => {
                  toast({
                    kind: "error",
                    title: `Couldn't delete ${deleting.name}`,
                    description: error.message,
                  });
                  throw error;
                },
              )
            : undefined
        }
      />
    </div>
  );
}

/** Available to as chips: Organisation, each granted guild and agent, or Unassigned. */
export function SecretReach({ secret }: { secret: Pick<Secret, "org_wide" | "grants"> }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {availableTo(secret).map((reach, index) => (
        <Tag
          key={index}
          tone={
            reach.kind === "unassigned" ? "ochre" : reach.kind === "organisation" ? "tide" : "term"
          }
          font="sans"
        >
          {reachLabel(reach)}
        </Tag>
      ))}
    </span>
  );
}

function SecretRow({ secret, actions }: { secret: Secret; actions: ReactNode }) {
  const origin = secretOrigin(secret);
  return (
    <div className="flex min-w-0 items-start gap-2.5 border-b border-line px-3.5 py-3 last:border-b-0">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="min-w-0 font-mono text-sm font-medium wrap-anywhere text-fg">
          {secret.name}
        </span>
        <p className="line-clamp-2 text-xs text-fg-2" title={secret.description}>
          {secret.description}
        </p>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <SecretReach secret={secret} />
          {origin ? <span>{origin}</span> : null}
          <span>Rotated {relativeTime(secret.rotated_at)}</span>
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-0.5">{actions}</div> : null}
    </div>
  );
}

function nameError(name: string): string | undefined {
  return name.trim() && !secretNamePattern.test(name.trim())
    ? "Letters, digits and underscores; not starting with a digit."
    : undefined;
}

/**
 * Adds a secret with its access. `initialName` and `initialDescription` start the form, as the
 * subscription token picker does; `onCreated` hears the secret once it is stored.
 */
export function AddSecretDialog({
  open,
  onOpenChange,
  initialAccess,
  manager,
  initialName = "",
  initialDescription = "",
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialAccess: SecretAccessChoice;
  manager: boolean;
  initialName?: string;
  initialDescription?: string;
  onCreated?: (secret: Secret) => void;
}) {
  const create = useCreateSecret();
  const [name, setName] = useState(initialName);
  const [value, setValue] = useState("");
  const [description, setDescription] = useState(initialDescription);
  const [access, setAccess] = useState(initialAccess);
  const invalidName = nameError(name);
  const needsGrant = !manager && !access.guild_ids.length && !access.agent_ids.length;

  const reset = () => {
    setName(initialName);
    setValue("");
    setDescription(initialDescription);
    setAccess(initialAccess);
    create.reset();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (invalidName || needsGrant) return;
    create.mutate(
      { name: name.trim(), value, description: description.trim(), ...access },
      {
        onSuccess: (secret) => {
          toast({ kind: "success", title: `${name.trim()} added` });
          onCreated?.(secret);
          reset();
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent size="sm">
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader
            title="Add a secret"
            description="One name, one value, for the whole organisation. Pick who gets it."
          />
          <DialogBody>
            <TextField
              tone="surface"
              label="Variable name"
              mono
              required
              autoComplete="off"
              placeholder="WALLET_PRIVATE_KEY"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              {...(invalidName ? { error: invalidName } : {})}
            />
            <TextField
              tone="surface"
              label="Value"
              type="password"
              required
              autoComplete="off"
              value={value}
              onChange={(event) => setValue(event.currentTarget.value)}
            />
            <TextField
              tone="surface"
              label="Description"
              required
              maxLength={secretDescriptionMax}
              showCount
              placeholder="How the agent should use this variable"
              value={description}
              onChange={(event) => setDescription(event.currentTarget.value)}
            />
            <SecretAccessPicker value={access} onChange={setAccess} allowOrgWide={manager} />
            {create.isError ? (
              <Banner tone="error" title="Couldn't add the secret">
                {create.error.message}
              </Banner>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={create.isPending || Boolean(invalidName) || needsGrant}>
              {create.isPending ? "Adding…" : "Add secret"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditSecretDialog({ secret, onClose }: { secret: Secret; onClose: () => void }) {
  const update = useUpdateSecret();
  const [name, setName] = useState(secret.name);
  const [description, setDescription] = useState(secret.description);
  const [value, setValue] = useState("");
  const invalidName = nameError(name);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (invalidName) return;
    const changes = {
      ...(name.trim() !== secret.name ? { name: name.trim() } : {}),
      ...(description.trim() !== secret.description ? { description: description.trim() } : {}),
      ...(value ? { value } : {}),
    };
    if (!Object.keys(changes).length) {
      onClose();
      return;
    }
    update.mutate(
      { secretId: secret.id, changes },
      {
        onSuccess: (saved) => {
          toast({ kind: "success", title: `${saved.name} saved` });
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm">
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader
            title={`Edit ${secret.name}`}
            description="A new name or value reaches agents from their next generation."
          />
          <DialogBody>
            <TextField
              tone="surface"
              label="Variable name"
              mono
              required
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              {...(invalidName ? { error: invalidName } : {})}
            />
            <TextField
              tone="surface"
              label="Description"
              required
              maxLength={secretDescriptionMax}
              showCount
              value={description}
              onChange={(event) => setDescription(event.currentTarget.value)}
            />
            <TextField
              tone="surface"
              label="New value"
              type="password"
              autoComplete="off"
              hint="Leave empty to keep the current value."
              value={value}
              onChange={(event) => setValue(event.currentTarget.value)}
            />
            {update.isError ? (
              <Banner tone="error" title="Couldn't save the secret">
                {update.error.message}
              </Banner>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={update.isPending || Boolean(invalidName)}>
              {update.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Change access: organisation-wide, or the guilds and agents picked. Org owners and admins only. */
function SecretAccessDialog({ secret, onClose }: { secret: Secret; onClose: () => void }) {
  const setAccess = useSetSecretAccess();
  const [access, setChoice] = useState(() => visibleAccess(secret));
  const hidden = secret.org_wide ? 0 : secret.grants.filter((grant) => grant.id === null).length;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setAccess.mutate(
      { secretId: secret.id, access },
      {
        onSuccess: () => {
          toast({ kind: "success", title: `${secret.name} access saved` });
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm">
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader
            title={`Who gets ${secret.name}`}
            description="Agents that gain or lose it get the change from their next generation."
          />
          <DialogBody>
            <SecretAccessPicker value={access} onChange={setChoice} allowOrgWide />
            {hidden && !access.org_wide ? (
              <p className="text-xs text-muted">
                {hidden} grant{hidden === 1 ? "" : "s"} in private guilds you don't see stay as they
                are.
              </p>
            ) : null}
            {setAccess.isError ? (
              <Banner tone="error" title="Couldn't change who gets it">
                {setAccess.error.message}
              </Banner>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={setAccess.isPending}>
              {setAccess.isPending ? "Saving…" : "Save access"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
