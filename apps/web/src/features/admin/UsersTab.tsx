import { Link } from "@tanstack/react-router";
import { Pencil, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import {
  Avatar,
  Banner,
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Icon,
  IconButton,
  SkeletonRows,
  Tag,
  TextField,
  personTone,
  toast,
} from "@guildsrun/ui";
import { useCreateUser, useSetUserEmail, useUsers } from "../../api/queries/admin";
import type { User } from "../../api/types/org";
import { useIdentity } from "../../app/identity";

/** Every account on the box, with a new one and the email each signs in with. */
export function UsersTab() {
  const { user: me, mode } = useIdentity();
  const users = useUsers();
  const [editing, setEditing] = useState<User | "new" | null>(null);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 md:px-10">
      <div className="mx-auto flex max-w-240 flex-col gap-3">
        <div className="flex items-center gap-3">
          <h2 className="type-label flex-1 text-muted">Users</h2>
          <Button size="sm" onClick={() => setEditing("new")}>
            <Icon icon={Plus} size={14} />
            New user
          </Button>
        </div>
        <p className="text-sm text-fg-2">
          Every account on this box. A new user gets a personal organisation; an owner or admin of
          another organisation adds them by name in{" "}
          <Link to="/settings" search={{ tab: "members" }} className="underline">
            Settings → Members
          </Link>
          .
          {mode === "trusted-header"
            ? " Each person signs in with the email your proxy sends for them."
            : null}
        </p>
        {users.isPending ? (
          <SkeletonRows rows={3} label="Loading users" />
        ) : users.isError ? (
          <Banner tone="error" title="Couldn't load users" meta={users.error.message} />
        ) : (
          <div className="flex flex-col overflow-hidden rounded-xl bg-surface">
            {users.data.map((user) => (
              <div
                key={user.id}
                className="flex items-center gap-3 border-b border-line px-3.5 py-2.5 last:border-b-0"
              >
                <Avatar name={user.name} tone={personTone(user.color) ?? "dusk"} size={28} round />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  @{user.name}
                  {user.id === me.id ? (
                    <Tag tone="well" className="ml-2">
                      you
                    </Tag>
                  ) : null}
                </span>
                <span className="min-w-0 truncate text-sm text-muted">
                  {user.email ?? "No email"}
                </span>
                <IconButton
                  icon={Pencil}
                  label={`Edit ${user.name}'s email`}
                  variant="ghost"
                  size={28}
                  onClick={() => setEditing(user)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
      {editing === "new" ? <NewUserDialog onClose={() => setEditing(null)} /> : null}
      {editing && editing !== "new" ? (
        <UserEmailDialog user={editing} onClose={() => setEditing(null)} />
      ) : null}
    </div>
  );
}

type NewUserDialogProps = { onClose: () => void };

/** Creates a user with a name and an optional email. */
function NewUserDialog({ onClose }: NewUserDialogProps) {
  const create = useCreateUser();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { name: name.trim(), email: email.trim() || null },
      {
        onSuccess: (created) => {
          toast({ kind: "success", title: `@${created.name} created` });
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="sm">
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader
            title="New user"
            description="An account on this box, with a personal organisation of its own."
          />
          <DialogBody>
            <TextField
              tone="surface"
              label="Name"
              hint="The @name others tag: a lowercase letter, then lowercase letters, digits, and hyphens."
              lead="@"
              mono
              maxLength={63}
              autoComplete="off"
              autoFocus
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
            <TextField
              tone="surface"
              label="Email"
              aside="Optional"
              type="email"
              autoComplete="off"
              value={email}
              onChange={(event) => setEmail(event.currentTarget.value)}
            />
            {create.isError ? (
              <Banner tone="error" title="Couldn't create the user">
                {create.error.message}
              </Banner>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={create.isPending || !name.trim()}>
              Create user
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type UserEmailDialogProps = { user: User; onClose: () => void };

/** Changes the email an existing user signs in with. */
function UserEmailDialog({ user, onClose }: UserEmailDialogProps) {
  const setUserEmail = useSetUserEmail();
  const [email, setEmail] = useState(user.email ?? "");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setUserEmail.mutate(
      { userId: user.id, email: email.trim() || null },
      {
        onSuccess: () => {
          toast({ kind: "success", title: `@${user.name}'s email saved` });
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="sm">
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader
            title={`@${user.name}`}
            description="The email this person signs in with behind an authenticating proxy."
          />
          <DialogBody>
            <TextField
              tone="surface"
              label="Email"
              aside="Optional"
              type="email"
              autoComplete="off"
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.currentTarget.value)}
            />
            {setUserEmail.isError ? (
              <Banner tone="error" title="Couldn't save the email">
                {setUserEmail.error.message}
              </Banner>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={setUserEmail.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
