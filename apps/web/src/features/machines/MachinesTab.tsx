import { Link } from "@tanstack/react-router";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useDeleteMachine, useOrgMachines } from "../../api/queries/agents";
import type { Machine, MachineAgent } from "../../api/types/agents";
import { useIdentity } from "../../app/identity";
import {
  Banner,
  Button,
  ConfirmDialog,
  Icon,
  IconButton,
  SkeletonRows,
  Tag,
  toast,
} from "@guildsrun/ui";
import { MachineDialog } from "./MachineDialog";
import { DiskMeter, LoadBudget } from "./MachineMeters";
import { NoMachines } from "./MachineNotes";
import {
  canManageMachines,
  machineAgentCount,
  machineBoxLabel,
  machineSizeLabel,
  sharedMachineNote,
  sizingNote,
} from "./machines";

/**
 * The organisation's machines and the sizing rules: each one's tier and size, the agents on it with
 * their browser and coding flags, its planned load against its capacity, and its disk against its
 * cap. Owners and admins add, resize and delete them; members see them.
 */
export function MachinesTab() {
  const { org } = useIdentity();
  const manager = canManageMachines(org.role);
  const machines = useOrgMachines(org.id);
  const [editing, setEditing] = useState<Machine | "new" | null>(null);
  const [deleting, setDeleting] = useState<Machine | null>(null);
  const addButton = manager ? (
    <Button size="sm" onClick={() => setEditing("new")}>
      <Icon icon={Plus} size={14} />
      Add machine
    </Button>
  ) : null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 md:px-10">
      <div className="mx-auto flex max-w-240 flex-col gap-7">
        <section aria-label="Machines" className="flex flex-col gap-3">
          <h2 className="type-label text-muted">Machines</h2>
          <div className="flex flex-wrap items-start gap-3">
            <p className="min-w-60 flex-1 text-sm text-fg-2">
              Every agent runs on one of {org.name}'s machines, and shares its CPU, memory and disk
              with the other agents there. {sharedMachineNote}
              {manager ? null : " Owners and admins add, resize and delete machines."}
            </p>
            {machines.data?.length ? addButton : null}
          </div>
          <div className="rounded-lg bg-paper px-4 py-3 text-sm text-fg-2">
            <span className="font-semibold">Sizing.</span> {sizingNote} A machine below an
            agent&apos;s minimum can&apos;t take it.
          </div>
          {machines.isPending ? (
            <SkeletonRows rows={3} label="Loading machines" />
          ) : machines.isError ? (
            <Banner tone="error" title="Couldn't load machines" meta={machines.error.message} />
          ) : machines.data.length === 0 ? (
            <NoMachines action={addButton} />
          ) : (
            machines.data.map((machine) => (
              <MachineCard
                key={machine.id}
                machine={machine}
                manager={manager}
                last={machines.data.length === 1}
                onEdit={() => setEditing(machine)}
                onDelete={() => setDeleting(machine)}
              />
            ))
          )}
        </section>
      </div>
      {editing !== null ? (
        <MachineDialog
          machine={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <DeleteMachineDialog machine={deleting} onClose={() => setDeleting(null)} />
    </div>
  );
}

type DeleteMachineDialogProps = {
  machine: Machine | null;
  onClose: () => void;
};

function DeleteMachineDialog({ machine, onClose }: DeleteMachineDialogProps) {
  const { org } = useIdentity();
  const remove = useDeleteMachine(org.id);
  return (
    <ConfirmDialog
      kind="destructive"
      open={machine !== null}
      onOpenChange={(open) => !open && onClose()}
      title={`Delete ${machine?.name ?? ""}?`}
      description="The machine and its directory go. This can't be undone."
      confirmLabel="Delete machine"
      onConfirm={() =>
        machine
          ? remove.mutateAsync(machine.id).then(onClose, (error: Error) => {
              toast({
                kind: "error",
                title: "Couldn't delete the machine",
                description: error.message,
              });
              throw error;
            })
          : undefined
      }
    />
  );
}

/** Why a machine cannot be deleted, or null when it can. */
function deleteBlocker(machine: Machine, last: boolean): string | null {
  if (machineAgentCount(machine) > 0) return `${machine.name} still has agents; move them first`;
  return last ? "The organisation keeps at least one machine" : null;
}

type MachineCardProps = {
  machine: Machine;
  manager: boolean;
  /** The organisation's only machine, which it keeps. */
  last: boolean;
  onEdit: () => void;
  onDelete: () => void;
};

function MachineCard({ machine, manager, last, onEdit, onDelete }: MachineCardProps) {
  const blocker = deleteBlocker(machine, last);
  return (
    <article aria-label={machine.name} className="flex flex-col gap-4 rounded-xl bg-surface p-4">
      <header className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-md font-semibold">{machine.name}</span>
        <Tag tone={machine.box === "standard" ? "well" : "signal"} font="sans">
          {machineBoxLabel[machine.box]}
        </Tag>
        <span className="text-sm text-muted">{machineSizeLabel(machine)}</span>
        <span className="flex-1" />
        {manager ? (
          <>
            <Button variant="outline" size="sm" onClick={onEdit}>
              <Icon icon={Pencil} size={14} />
              Edit
            </Button>
            <IconButton
              icon={Trash2}
              label={blocker ?? `Delete ${machine.name}`}
              variant="ghost"
              size={28}
              disabled={blocker !== null}
              onClick={onDelete}
            />
          </>
        ) : null}
      </header>
      <div className="grid gap-4 md:grid-cols-3">
        <section aria-label="Planned load" className="flex flex-col gap-1.5 md:col-span-2">
          <h3 className="type-label text-muted">Planned load</h3>
          <LoadBudget
            size={machine}
            planned={{ cpu: machine.planned_cpu, memory_mib: machine.planned_mib }}
            remedy="resize it or move some of its agents to another machine"
            rules={false}
          />
        </section>
        <section aria-label="Disk" className="flex flex-col gap-1.5">
          <h3 className="type-label text-muted">Disk</h3>
          <DiskMeter
            usedMib={machine.workspace_mib}
            maxMib={machine.max_workspace_mib}
            label={`Disk used on ${machine.name}`}
          />
        </section>
      </div>
      <MachineAgents machine={machine} />
    </article>
  );
}

type MachineAgentsProps = { machine: Machine };

/** The agents on a machine the viewer can see, then how many sit in guilds they cannot. */
function MachineAgents({ machine }: MachineAgentsProps) {
  const hidden = machine.hidden_agents;
  return (
    <section aria-label="Agents" className="flex flex-col gap-1.5">
      <h3 className="type-label text-muted">Agents · {machineAgentCount(machine)}</h3>
      {machine.agents.length ? (
        <ul className="flex flex-col overflow-hidden rounded-lg bg-paper">
          {machine.agents.map((agent) => (
            <MachineAgentRow key={agent.id} agent={agent} />
          ))}
        </ul>
      ) : null}
      {hidden ? (
        <p className="text-sm text-muted">
          +{hidden} agent{hidden === 1 ? "" : "s"} of guilds you cannot see.
        </p>
      ) : null}
      {machineAgentCount(machine) === 0 ? (
        <p className="text-sm text-muted">No agents on it yet.</p>
      ) : null}
    </section>
  );
}

type MachineAgentRowProps = { agent: MachineAgent };

function MachineAgentRow({ agent }: MachineAgentRowProps) {
  return (
    <li className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 last:border-b-0">
      <Link
        to="/guilds/$guildId/agents/$agentId/settings"
        params={{ guildId: agent.guild_id, agentId: agent.id }}
        search={{ section: "machine" }}
        className="font-mono text-sm hover:underline"
      >
        {agent.name}
      </Link>
      <span className="min-w-0 flex-1 truncate text-xs text-muted">{agent.guild_name}</span>
      {agent.browser ? (
        <Tag tone="tide" font="sans">
          Browser
        </Tag>
      ) : null}
      {agent.coding ? (
        <Tag tone="signal" font="sans">
          Coding
        </Tag>
      ) : null}
    </li>
  );
}
