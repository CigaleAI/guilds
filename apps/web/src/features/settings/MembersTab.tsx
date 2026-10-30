import { X } from "lucide-react";
import { useState, type FormEvent } from "react";
import {
  useAddMember,
  useOrgMembers,
  useRemoveMember,
  useUpdateMemberRole,
} from "../../api/queries/org";
import type { OrgRole } from "../../api/types/org";
import { useIdentity } from "../../app/identity";
import { useSlots } from "../../app/slots";
import {
  Button,
  IconButton,
  Select,
  TextField,
  Banner,
  SkeletonRows,
  Avatar,
  ConfirmDialog,
  toast,
  personTone,
  Tag,
} from "@guildsrun/ui";
import { assignableRoles, canChangeMember, canManageMembers, roleLabel } from "./members";

/** The organisation's members with their roles, adding people by name, and what an extension adds under them. */
export function MembersTab() {
  const { user, org } = useIdentity();
  const manager = canManageMembers(org.role);
  const members = useOrgMembers(org.id);
  const setRole = useUpdateMemberRole(org.id);
  const remove = useRemoveMember(org.id);
  const { membersPanel: Panel } = useSlots();
  const [removing, setRemoving] = useState<{ user_id: string; name: string } | null>(null);
  const roles = assignableRoles(org.role);

  const failed = (title: string) => (error: Error) =>
    toast({ kind: "error", title, description: error.message });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 md:px-10">
      <div className="mx-auto flex max-w-240 flex-col gap-7">
        <section aria-label="Members" className="flex flex-col gap-3">
          <h2 className="type-label text-muted">Members</h2>
          <p className="text-sm text-fg-2">
            Everyone in {org.name}. Owners manage other owners; admins manage members, keys, and
            tools; members work in the guilds they operate.
            {manager
              ? " Add someone by the @name of their account on this box."
              : " Owners and admins add people and change roles."}
          </p>
          {members.isPending ? (
            <SkeletonRows rows={3} label="Loading members" />
          ) : members.isError ? (
            <Banner tone="error" title="Couldn't load members" meta={members.error.message} />
          ) : (
            <div className="flex flex-col overflow-hidden rounded-xl bg-surface">
              {members.data.map((member) => {
                const self = member.user_id === user.id;
                const editable = manager && canChangeMember(org.role, member.role, self);
                return (
                  <div
                    key={member.user_id}
                    className="flex items-center gap-3 border-b border-line px-3.5 py-2.5 last:border-b-0"
                  >
                    <Avatar
                      name={member.name}
                      tone={personTone(member.color) ?? "dusk"}
                      size={28}
                      round
                    />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      @{member.name}
                      {self ? (
                        <Tag tone="well" className="ml-2">
                          you
                        </Tag>
                      ) : null}
                    </span>
                    {editable ? (
                      <>
                        <Select
                          tone="paper"
                          aria-label={`${member.name}'s role`}
                          className="w-36"
                          value={member.role}
                          onValueChange={(next) =>
                            setRole.mutate(
                              { userId: member.user_id, role: next as OrgRole },
                              { onError: failed(`Couldn't change ${member.name}'s role`) },
                            )
                          }
                          options={roles.map((value) => ({ value, label: roleLabel[value] }))}
                        />
                        <IconButton
                          icon={X}
                          label={`Remove ${member.name}`}
                          variant="ghost"
                          size={28}
                          onClick={() =>
                            setRemoving({ user_id: member.user_id, name: member.name })
                          }
                        />
                      </>
                    ) : (
                      <span className="text-sm text-muted">{roleLabel[member.role]}</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {manager ? <AddMember /> : null}
        </section>

        {Panel ? <Panel /> : null}
      </div>
      <ConfirmDialog
        kind="destructive"
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove @${removing?.name ?? ""} from ${org.name}?`}
        description="They lose access to every guild here. Their messages and notes stay."
        confirmLabel="Remove member"
        onConfirm={() =>
          removing
            ? remove.mutateAsync(removing.user_id).then(
                () => setRemoving(null),
                (error: Error) => {
                  toast({
                    kind: "error",
                    title: "Couldn't remove the member",
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

/** Adds an account on this box to the organisation by its @name, with a role the viewer may give. */
function AddMember() {
  const { org } = useIdentity();
  const add = useAddMember(org.id);
  const roles = assignableRoles(org.role);
  const [name, setName] = useState("");
  const [role, setRole] = useState<OrgRole>("member");
  const handle = name.trim().replace(/^@/, "");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!handle) return;
    add.mutate(
      { name: handle, role },
      {
        onSuccess: (member) => {
          setName("");
          toast({ kind: "success", title: `@${member.name} joined ${org.name}` });
        },
        onError: (error) =>
          toast({ kind: "error", title: `Couldn't add @${handle}`, description: error.message }),
      },
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <TextField
        tone="surface"
        label="Add a member"
        className="min-w-56 flex-1"
        placeholder="name"
        lead="@"
        mono
        autoComplete="off"
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
      />
      <Select
        tone="surface"
        label="Role"
        className="w-40"
        value={role}
        onValueChange={(next) => setRole(next as OrgRole)}
        options={roles.map((value) => ({ value, label: roleLabel[value] }))}
      />
      <Button type="submit" variant="outline" size="xl" disabled={!handle || add.isPending}>
        Add
      </Button>
    </form>
  );
}
