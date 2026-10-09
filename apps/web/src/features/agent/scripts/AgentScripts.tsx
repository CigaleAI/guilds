import { Link, useParams } from "@tanstack/react-router";
import { FileCode, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import {
  useAgent,
  useAgentScripts,
  useCreateScript,
  useDeleteAllScripts,
  useDeleteScript,
} from "../../../api/queries";
import type { Script } from "../../../api/types";

import {
  Button,
  IconButton,
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
import { LatestChange } from "../../files/LatestChange";
import { capabilityOn, defaultAgentConfig } from "../settings/configForm";

/** The server's rules: a script name like a tool name, and not the reserved `manifest`. */
const scriptName = /^[a-z][a-z0-9_-]{0,62}$/;

function Code({ children }: { children: string }) {
  return (
    <pre className="max-h-80 overflow-auto rounded-md bg-paper p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-fg">
      {children}
    </pre>
  );
}

function ScriptCard({
  script,
  guildId,
  onDelete,
}: {
  script: Script;
  guildId: string;
  onDelete: () => void;
}) {
  return (
    <article className="flex flex-col gap-3 rounded-xl bg-surface p-4">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="font-mono text-md font-medium">{script.name}</span>
          <p className="text-sm text-fg-2">{script.description}</p>
        </div>
        <IconButton
          icon={Trash2}
          label={`Delete ${script.name}`}
          variant="ghost"
          size={28}
          onClick={onDelete}
        />
      </div>
      {script.display_path ? (
        <LatestChange displayPath={script.display_path} guildId={guildId} />
      ) : null}
      {script.parameters ? (
        <details className="text-sm">
          <summary className="cursor-pointer font-semibold">
            Parameters · also a tool named {script.name}
          </summary>
          <div className="mt-2">
            <Code>{JSON.stringify(script.parameters, null, 2)}</Code>
          </div>
        </details>
      ) : null}
      <details className="text-sm">
        <summary className="cursor-pointer font-semibold">Source</summary>
        <div className="mt-2">
          <Code>{script.source}</Code>
        </div>
      </details>
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
        description="Every script leaves the agent's sandbox, including any that are also tools. This can't be undone."
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
 * Python the agent keeps in its sandbox at /home/agent/scripts/ and runs with its script tools. A
 * script with parameters is also offered to the agent as a tool of its own.
 */
export function AgentScripts() {
  const { guildId, agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId" });
  const agent = useAgent(agentId);
  const scripts = useAgentScripts(agentId);
  const remove = useDeleteScript(agentId);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Script | null>(null);
  const count = scripts.data?.length ?? 0;
  const maxScripts = agent.data?.config.max_scripts ?? defaultAgentConfig.max_scripts;
  const atCap = count >= maxScripts;

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
              <Link to="/guilds/$guildId/agents/$agentId/settings" params={{ guildId, agentId }}>
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
            Reusable Python in the agent's sandbox, at /home/agent/scripts/. Only the agent runs
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
              guildId={guildId}
              onDelete={() => setDeleting(script)}
            />
          ))
        )}
      </div>

      <ScriptForm
        agentId={agentId}
        existing={scripts.data?.map((script) => script.name) ?? []}
        open={adding}
        onOpenChange={setAdding}
      />
      <ConfirmDialog
        kind="destructive"
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? ""}?`}
        description="The script leaves the agent's sandbox, with its tool if it had parameters."
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

function ScriptForm({
  agentId,
  existing,
  open,
  onOpenChange,
}: {
  agentId: string;
  existing: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateScript(agentId);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [source, setSource] = useState("");
  const [parameters, setParameters] = useState("");

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
          <DialogHeader title="Add a script" description="Python the agent runs in its sandbox." />
          <DialogBody>
            <TextField
              tone="surface"
              label="Name"
              mono
              required
              autoComplete="off"
              placeholder="send_usdc"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              hint={
                existing.includes(trimmed)
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
              {create.isPending ? "Saving…" : "Add script"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
