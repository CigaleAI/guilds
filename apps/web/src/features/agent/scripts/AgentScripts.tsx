import { Link, useParams } from "@tanstack/react-router";
import { FileCode, Pencil, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import {
  useAgent,
  useAgentScripts,
  useCreateScript,
  useDeleteAllScripts,
  useDeleteScript,
  useLatestChange,
} from "../../../api/queries";
import type { FileChange, Script } from "../../../api/types";
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
import { ChangeHistory, useOpenStepInAgent } from "../../files/LatestChange";
import { changeActor } from "../prompt/taskContext";
import { capabilityOn, defaultAgentConfig } from "../settings/configForm";

/** The server's rules: a script name like a tool name, and not the reserved `manifest`. */
const scriptName = /^[a-z][a-z0-9_-]{0,62}$/;

/** Who wrote the script's current version: this agent through a run, or a person. */
function Provenance({
  change,
  agentName,
  onOpenStep,
}: {
  change: FileChange;
  agentName: string;
  onOpenStep: () => void;
}) {
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

function ScriptCard({
  script,
  agentId,
  agentName,
  guildId,
  onEdit,
  onDelete,
}: {
  script: Script;
  agentId: string;
  agentName: string;
  guildId: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
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

/** Removes every script on this agent after the operator confirms. */
export function RemoveAllScriptsButton({ agentId, count }: { agentId: string; count: number }) {
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

/**
 * Python the agent keeps at scripts/ in its home, /home/<agent id>, and runs with its script tools.
 * A script with parameters is also offered to the agent as a tool of its own.
 */
export function AgentScripts() {
  const { guildId, agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId" });
  const agent = useAgent(agentId);
  const scripts = useAgentScripts(agentId);
  const remove = useDeleteScript(agentId);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Script | null>(null);
  const [deleting, setDeleting] = useState<Script | null>(null);
  const count = scripts.data?.length ?? 0;
  const maxScripts = agent.data?.config.max_scripts ?? defaultAgentConfig.max_scripts;
  const atCap = count >= maxScripts;
  const agentName = agent.data?.name ?? "the agent";

  const addButton = (
    <Button size="sm" disabled={atCap} onClick={() => setAdding(true)}>
      <Icon icon={Plus} size={14} />
      Add script
    </Button>
  );

  if (agent.data && !capabilityOn(agent.data.config, "scripting")) {
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
        {scripts.isPending ? (
          <SkeletonRows rows={3} label="Loading scripts" />
        ) : scripts.isError ? (
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
        ) : scripts.data.length === 0 ? (
          <EmptyState
            icon={FileCode}
            title="No scripts yet"
            description="Add a Python file, or ask the agent in chat to write one."
            action={addButton}
          />
        ) : (
          scripts.data.map((script) => (
            <ScriptCard
              key={script.name}
              script={script}
              agentId={agentId}
              agentName={agentName}
              guildId={guildId}
              onEdit={() => setEditing(script)}
              onDelete={() => setDeleting(script)}
            />
          ))
        )}
      </div>

      <ScriptForm
        key={editing ? editing.name : "new"}
        agentId={agentId}
        script={editing}
        existing={scripts.data?.map((script) => script.name) ?? []}
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
      <ConfirmDialog
        kind="destructive"
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? ""}?`}
        description="The script leaves the agent's home, with its tool if it had parameters."
        confirmLabel="Delete script"
        onConfirm={() =>
          deleting
            ? remove.mutateAsync(deleting.name).then(
                () => {
                  toast({ kind: "success", title: `${deleting.name} deleted` });
                  setDeleting(null);
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
    </div>
  );
}

/** Adds a script, or saves a new version of `script`; saving under an existing name replaces it. */
function ScriptForm({
  agentId,
  script,
  existing,
  open,
  onOpenChange,
}: {
  agentId: string;
  script: Script | null;
  existing: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateScript(agentId);
  const [name, setName] = useState(script?.name ?? "");
  const [description, setDescription] = useState(script?.description ?? "");
  const [source, setSource] = useState(script?.source ?? "");
  const [parameters, setParameters] = useState(
    script?.parameters ? JSON.stringify(script.parameters, null, 2) : "",
  );

  const trimmed = name.trim();
  const nameError = !trimmed
    ? undefined
    : !scriptName.test(trimmed)
      ? "Lowercase letters, digits, _ and -, starting with a letter."
      : trimmed === "manifest"
        ? "That name is reserved."
        : undefined;
  let parsed: Record<string, unknown> | null = null;
  let parametersError: string | undefined;
  if (parameters.trim()) {
    try {
      const value: unknown = JSON.parse(parameters);
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as { type?: unknown }).type === "object"
      ) {
        parsed = value as Record<string, unknown>;
      } else {
        parametersError = 'A JSON Schema object, with "type": "object".';
      }
    } catch {
      parametersError = "Not valid JSON.";
    }
  }

  const close = () => {
    setName("");
    setDescription("");
    setSource("");
    setParameters("");
    create.reset();
    onOpenChange(false);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (nameError || parametersError) return;
    create.mutate(
      { name: trimmed, description: description.trim(), source, parameters: parsed },
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
            description={
              script
                ? "Saving records a new version in the agent's home."
                : "Python the agent runs on its machine."
            }
          />
          <DialogBody>
            <TextField
              tone="surface"
              label="Name"
              mono
              required
              autoComplete="off"
              placeholder="send_usdc"
              value={name}
              disabled={script !== null}
              onChange={(event) => setName(event.currentTarget.value)}
              hint={
                script
                  ? "A script keeps its name; add a new script to use another."
                  : existing.includes(trimmed)
                    ? "A script with this name exists; saving replaces it."
                    : undefined
              }
              {...(nameError ? { error: nameError } : {})}
            />
            <TextField
              tone="surface"
              label="Description"
              required
              maxLength={400}
              showCount
              placeholder="Why this script exists"
              value={description}
              onChange={(event) => setDescription(event.currentTarget.value)}
            />
            <TextAreaField
              tone="surface"
              label="Source"
              font="mono"
              required
              rows={10}
              placeholder="print('hello')"
              value={source}
              onChange={(event) => setSource(event.currentTarget.value)}
            />
            <TextAreaField
              tone="surface"
              label="Parameters"
              aside="optional · JSON Schema"
              font="mono"
              rows={4}
              placeholder='{"type": "object", "properties": {}}'
              hint="With parameters, the script is also a tool the agent calls with arguments."
              value={parameters}
              onChange={(event) => setParameters(event.currentTarget.value)}
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
              {create.isPending ? "Saving…" : script ? "Save" : "Add script"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
