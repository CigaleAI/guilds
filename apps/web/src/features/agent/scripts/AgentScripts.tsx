import { Link, useParams } from "@tanstack/react-router";
import { FileCode, Pencil, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { useAgent } from "../../../api/queries/agents";
import {
  useAgentScripts,
  useCreateScript,
  useDeleteAllScripts,
  useDeleteScript,
} from "../../../api/queries/scripts";
import { useLatestChange } from "../../../api/queries/notes";
import type { AgentConfig } from "../../../api/types/agents";
import type { Script } from "../../../api/types/scripts";
import type { FileChange } from "../../../api/types/notes";
import { relativeTime } from "../../../app/format";
import {
  Button,
  CodeBlock,
  IconButton,
  Tag,
  TextAreaField,
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
} from "@guildsrun/ui";
import { ChangeHistory, useOpenStepInAgent } from "../../notes/LatestChange";
import { changeActor } from "../../notes/changeActor";
import { capabilityOn, defaultAgentConfig } from "../settings/configForm";
import { readParameters } from "./scriptParameters";

/** The server's rules: a script name like a tool name, and not the reserved `manifest`. */
const scriptName = /^[a-z][a-z0-9_-]{0,62}$/;

type ProvenanceProps = {
  change: FileChange;
  agentName: string;
  onOpenStep: () => void;
};

/** Who wrote the script's current version: this agent through a run, or a person. */
function Provenance({ change, agentName, onOpenStep }: ProvenanceProps) {
  const actor = changeActor(change);
  const when = relativeTime(change.created_at);
  if (actor.kind === "run") {
    return (
      <button
        type="button"
        onClick={onOpenStep}
        title={`Open the step that wrote it · run ${actor.runId} · ${when}`}
        className="cursor-pointer truncate text-sm text-muted transition-colors hover:text-fg"
      >
        written by {agentName} · run{" "}
        <span className="font-mono text-xs">…{actor.runId.slice(-6)}</span>
      </button>
    );
  }
  return (
    <span className="truncate text-sm text-muted" title={when}>
      written by {actor.name}
    </span>
  );
}

type Disclosure = "history" | "parameters";

type ScriptCardProps = {
  script: Script;
  agentId: string;
  agentName: string;
  guildId: string;
  onEdit: () => void;
  onDelete: () => void;
};

function ScriptCard({ script, agentId, agentName, guildId, onEdit, onDelete }: ScriptCardProps) {
  const latest = useLatestChange(script.display_path);
  const openStep = useOpenStepInAgent(guildId);
  const [showing, setShowing] = useState<Disclosure | null>(null);
  const change = latest.data ?? null;
  const toggle = (view: Disclosure) => setShowing((current) => (current === view ? null : view));
  const footerLink =
    "cursor-pointer underline-offset-2 transition-colors hover:text-fg hover:underline";
  return (
    <article className="flex flex-col overflow-hidden rounded-xl bg-surface">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3.5 pb-2.5">
        <span className="font-mono text-md font-semibold">{script.name}.py</span>
        {change ? <Tag tone="surface">v{change.version}</Tag> : null}
        <span className="ml-auto flex min-w-0 items-center gap-2">
          {change ? (
            <Provenance
              change={change}
              agentName={agentName}
              onOpenStep={() => {
                if (change.run) openStep({ ...change, run: change.run });
              }}
            />
          ) : null}
          <Button variant="outline" size="sm" onClick={onEdit}>
            <Icon icon={Pencil} size={14} />
            Edit
          </Button>
          <IconButton
            icon={Trash2}
            label={`Delete ${script.name}`}
            variant="ghost"
            size={28}
            onClick={onDelete}
          />
        </span>
      </div>
      <p className="px-4 pb-3.5 text-sm text-fg-2">{script.description}</p>
      <CodeBlock code={script.source} language="python" lineNumbers className="rounded-none" />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2.5 font-mono text-2xs text-muted">
        <span className="min-w-0 truncate">
          /home/{agentId}/scripts/{script.name}.py
        </span>
        {script.display_path ? (
          <button
            type="button"
            aria-expanded={showing === "history"}
            onClick={() => toggle("history")}
            className={footerLink}
          >
            History
          </button>
        ) : null}
        {script.parameters ? (
          <button
            type="button"
            aria-expanded={showing === "parameters"}
            onClick={() => toggle("parameters")}
            className={footerLink}
          >
            Parameters · also a tool named {script.name}
          </button>
        ) : null}
        <span className="ml-auto">python · runs in {agentName}'s home</span>
      </div>
      {showing === "history" && script.display_path ? (
        <ChangeHistory displayPath={script.display_path} guildId={guildId} className="mx-4 mb-4" />
      ) : null}
      {showing === "parameters" && script.parameters ? (
        <CodeBlock
          code={JSON.stringify(script.parameters, null, 2)}
          language="json"
          density="compact"
          className="mx-4 mb-4"
        />
      ) : null}
    </article>
  );
}

type RemoveAllScriptsButtonProps = { agentId: string; count: number };

/** Removes every script on this agent after the operator confirms. */
export function RemoveAllScriptsButton({ agentId, count }: RemoveAllScriptsButtonProps) {
  const removeAll = useDeleteAllScripts(agentId);
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="danger"
        size="sm"
        disabled={count === 0 || removeAll.isPending}
        onClick={() => setConfirming(true)}
      >
        <Icon icon={Trash2} size={14} />
        Remove all scripts
      </Button>
      <ConfirmDialog
        kind="destructive"
        open={confirming}
        onOpenChange={setConfirming}
        title="Remove all scripts?"
        description="Every script leaves the agent's home, including any that are also tools. This can't be undone."
        confirmLabel="Remove all scripts"
        onConfirm={() =>
          removeAll.mutateAsync().then(
            () => {
              toast({ kind: "success", title: "Scripts removed" });
              setConfirming(false);
            },
            (error: Error) => {
              toast({
                kind: "error",
                title: "Couldn't remove the scripts",
                description: error.message,
              });
              throw error;
            },
          )
        }
      />
    </>
  );
}

/** How many scripts an agent may keep: its own cap, or the default before the agent loads. */
export function scriptCap(config: AgentConfig | undefined): number {
  return config?.max_scripts ?? defaultAgentConfig.max_scripts;
}

type ScriptingOffProps = { guildId: string; agentId: string };

/** An agent without scripting, pointed at the Settings section that turns it on. */
function ScriptingOff({ guildId, agentId }: ScriptingOffProps) {
  return (
    <div className="grid flex-1 place-items-center p-6">
      <EmptyState
        icon={FileCode}
        title="This agent has no scripting"
        description="Turn it on in Settings to give the agent script tools and this tab."
        action={
          <Button asChild size="sm">
            <Link
              to="/guilds/$guildId/agents/$agentId/settings"
              params={{ guildId, agentId }}
              search={{ section: "model" }}
            >
              Open Settings
            </Link>
          </Button>
        }
      />
    </div>
  );
}

type DeleteScriptDialogProps = {
  agentId: string;
  /** The script to delete; null keeps the dialog closed. */
  script: Script | null;
  onClose: () => void;
};

/** Deleting a script, with its tool when it had parameters; a refusal keeps the dialog open. */
function DeleteScriptDialog({ agentId, script, onClose }: DeleteScriptDialogProps) {
  const remove = useDeleteScript(agentId);
  return (
    <ConfirmDialog
      kind="destructive"
      open={script !== null}
      onOpenChange={(open) => !open && onClose()}
      title={`Delete ${script?.name ?? ""}?`}
      description="The script leaves the agent's home, with its tool if it had parameters."
      confirmLabel="Delete script"
      onConfirm={() =>
        script
          ? remove.mutateAsync(script.name).then(
              () => {
                toast({ kind: "success", title: `${script.name} deleted` });
                onClose();
              },
              (error: Error) => {
                toast({
                  kind: "error",
                  title: "Couldn't delete the script",
                  description: error.message,
                });
                throw error;
              },
            )
          : undefined
      }
    />
  );
}

type ScriptListProps = {
  scripts: ReturnType<typeof useAgentScripts>;
  agentId: string;
  agentName: string;
  guildId: string;
  /** Adds a script; the empty list offers it. */
  addButton: ReactNode;
  onEdit: (script: Script) => void;
  onDelete: (script: Script) => void;
};

/** The agent's scripts as cards, once they load; why they did not, or that there are none yet. */
function ScriptList({
  scripts,
  agentId,
  agentName,
  guildId,
  addButton,
  onEdit,
  onDelete,
}: ScriptListProps) {
  if (scripts.isPending) return <SkeletonRows rows={3} label="Loading scripts" />;
  if (scripts.isError) {
    return (
      <Banner
        tone="error"
        title="Couldn't load the scripts"
        meta={scripts.error.message}
        action={
          <Button variant="outline" size="sm" onClick={() => void scripts.refetch()}>
            Retry
          </Button>
        }
      />
    );
  }
  if (scripts.data.length === 0) {
    return (
      <EmptyState
        icon={FileCode}
        title="No scripts yet"
        description="Add a Python file, or ask the agent in chat to write one."
        action={addButton}
      />
    );
  }
  return scripts.data.map((script) => (
    <ScriptCard
      key={script.name}
      script={script}
      agentId={agentId}
      agentName={agentName}
      guildId={guildId}
      onEdit={() => onEdit(script)}
      onDelete={() => onDelete(script)}
    />
  ));
}

/**
 * Python the agent keeps at scripts/ in its home, /home/<agent id>, and runs with its script tools.
 * A script with parameters is also offered to the agent as a tool of its own.
 */
export function AgentScripts() {
  const { guildId, agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId" });
  const agent = useAgent(agentId);
  const scripts = useAgentScripts(agentId);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Script | null>(null);
  const [deleting, setDeleting] = useState<Script | null>(null);
  const count = scripts.data?.length ?? 0;
  const maxScripts = scriptCap(agent.data?.config);
  const atCap = count >= maxScripts;
  const agentName = agent.data?.name ?? "the agent";

  const addButton = (
    <Button size="sm" disabled={atCap} onClick={() => setAdding(true)}>
      <Icon icon={Plus} size={14} />
      Add script
    </Button>
  );

  if (agent.data && !capabilityOn(agent.data.config, "scripting")) {
    return <ScriptingOff guildId={guildId} agentId={agentId} />;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
      <div className="mx-auto flex max-w-240 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-60 flex-1 text-sm text-fg-2">
            Reusable Python in the agent's home, at /home/{agentId}/scripts/. Only the agent runs
            them; secrets reach them as environment variables. {count} of {maxScripts} scripts.
          </p>
          {count ? (
            <>
              {addButton}
              <RemoveAllScriptsButton agentId={agentId} count={count} />
            </>
          ) : null}
        </div>
        <ScriptList
          scripts={scripts}
          agentId={agentId}
          agentName={agentName}
          guildId={guildId}
          addButton={addButton}
          onEdit={setEditing}
          onDelete={setDeleting}
        />
      </div>

      <ScriptForm
        key={editing ? editing.name : "new"}
        agentId={agentId}
        script={editing}
        scripts={scripts.data}
        open={adding || editing !== null}
        onOpenChange={(open) => {
          if (open) {
            setAdding(true);
            return;
          }
          setAdding(false);
          setEditing(null);
        }}
      />
      <DeleteScriptDialog agentId={agentId} script={deleting} onClose={() => setDeleting(null)} />
    </div>
  );
}

/** A script as the form edits it: its parameters stay JSON text while typed. */
export type ScriptDraft = { name: string; description: string; source: string; parameters: string };

/** A script's fields in the form; a new script's are empty. */
export function scriptDraft(script: Script | null): ScriptDraft {
  return {
    name: script?.name ?? "",
    description: script?.description ?? "",
    source: script?.source ?? "",
    parameters: script?.parameters ? JSON.stringify(script.parameters, null, 2) : "",
  };
}

/** What is wrong with a script name the server would refuse; undefined for a valid or empty one. */
export function scriptNameError(name: string): string | undefined {
  if (!name) return undefined;
  if (!scriptName.test(name)) return "Lowercase letters, digits, _ and -, starting with a letter.";
  return name === "manifest" ? "That name is reserved." : undefined;
}

/** The hint under the name: an edited script keeps its name; a new one under a taken name replaces it. */
export function scriptNameHint(
  script: Script | null,
  scripts: readonly Script[] | undefined,
  name: string,
): string | undefined {
  if (script) return "A script keeps its name; add a new script to use another.";
  return scripts?.some((item) => item.name === name)
    ? "A script with this name exists; saving replaces it."
    : undefined;
}

/** The form's words for adding a script and for saving a new version of one. */
const SCRIPT_FORM_COPY = Object.freeze({
  add: {
    description: "Python the agent runs on its machine.",
    submit: "Add script",
  },
  edit: {
    description: "Saving records a new version in the agent's home.",
    submit: "Save",
  },
});

type ScriptFormProps = {
  agentId: string;
  script: Script | null;
  /** The agent's scripts, so a new one's name says when saving replaces one. */
  scripts: readonly Script[] | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Adds a script, or saves a new version of `script`; saving under an existing name replaces it. */
function ScriptForm({ agentId, script, scripts, open, onOpenChange }: ScriptFormProps) {
  const create = useCreateScript(agentId);
  const [draft, setDraft] = useState(() => scriptDraft(script));
  const copy = SCRIPT_FORM_COPY[script ? "edit" : "add"];

  const trimmed = draft.name.trim();
  const nameError = scriptNameError(trimmed);
  const { schema, error: parametersError } = readParameters(draft.parameters);

  const close = () => {
    setDraft(scriptDraft(null));
    create.reset();
    onOpenChange(false);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (nameError || parametersError) return;
    create.mutate(
      {
        name: trimmed,
        description: draft.description.trim(),
        source: draft.source,
        parameters: schema,
      },
      {
        onSuccess: () => {
          toast({ kind: "success", title: `${trimmed} saved` });
          close();
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent size="lg">
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader
            title={script ? `Edit ${script.name}.py` : "Add a script"}
            description={copy.description}
          />
          <DialogBody>
            <TextField
              tone="surface"
              label="Name"
              mono
              required
              autoComplete="off"
              placeholder="send_usdc"
              value={draft.name}
              disabled={script !== null}
              onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
              hint={scriptNameHint(script, scripts, trimmed)}
              {...(nameError ? { error: nameError } : {})}
            />
            <TextField
              tone="surface"
              label="Description"
              required
              maxLength={400}
              showCount
              placeholder="Why this script exists"
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.currentTarget.value })}
            />
            <TextAreaField
              tone="surface"
              label="Source"
              font="mono"
              required
              rows={10}
              placeholder="print('hello')"
              value={draft.source}
              onChange={(event) => setDraft({ ...draft, source: event.currentTarget.value })}
            />
            <TextAreaField
              tone="surface"
              label="Parameters"
              aside="optional · JSON Schema"
              font="mono"
              rows={4}
              placeholder='{"type": "object", "properties": {}}'
              hint="With parameters, the script is also a tool the agent calls with arguments."
              value={draft.parameters}
              onChange={(event) => setDraft({ ...draft, parameters: event.currentTarget.value })}
              {...(parametersError ? { error: parametersError } : {})}
            />
            {create.isError ? (
              <Banner tone="error" title="Couldn't save the script">
                {create.error.message}
              </Banner>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button
              type="submit"
              disabled={create.isPending || !trimmed || Boolean(nameError || parametersError)}
            >
              {create.isPending ? "Saving…" : copy.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
