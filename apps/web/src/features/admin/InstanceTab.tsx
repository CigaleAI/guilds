import { useNavigate, useSearch } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Banner,
  Button,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Icon,
  SkeletonRows,
  Tag,
  TextAreaField,
  TextField,
  toast,
} from "@guildsrun/ui";
import { ApiError } from "../../api/client";
import {
  useInstance,
  useRemoveInstanceKeys,
  useSaveInstanceKeys,
  useStartGithubAppManifest,
} from "../../api/queries/admin";
import type { InstanceIntegration, IntegrationField, IntegrationState } from "../../api/types";
import { DocsLink } from "../../app/docs";
import type { TabSearch } from "../../app/router";
import { safeReturnTo } from "../instance/instance";
import { submitManifestForm } from "./githubManifest";

const stateTag: Record<IntegrationState, { tone: "tide" | "ochre" | "well"; label: string }> = {
  on: { tone: "tide", label: "On" },
  incomplete: { tone: "ochre", label: "Incomplete" },
  off: { tone: "well", label: "Off" },
};

/** The docs page that walks through setting up an integration, by its id. */
const integrationDocs: Record<string, string> = {
  "github-app": "/tools-and-connectors/github",
};

/** What went wrong when GitHub sent the browser back from creating the App, by the callback's code. */
const setupErrors: Record<string, string> = {
  state: "The GitHub redirect didn't match this session. Try again.",
  conversion: "GitHub refused the creation code. Try again.",
  store: "The App could not be stored. Check the server log.",
};

const setDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** A field's tag: set, missing from an integration that has some of its others, or just not set. */
function fieldTag(
  integration: InstanceIntegration,
  field: IntegrationField,
): { tone: "tide" | "ochre" | "well"; note: string } {
  if (field.set) return { tone: "tide", note: "set" };
  if (field.optional) return { tone: "well", note: "optional" };
  return integration.state === "incomplete"
    ? { tone: "ochre", note: "missing" }
    : { tone: "well", note: "not set" };
}

/**
 * The platform's keys: each optional integration of the server, what it switches on, and its
 * values. A platform admin enters a store integration's keys here; an environment integration
 * only shows which of its variables are set.
 */
export function InstanceTab() {
  const search = useSearch({ strict: false }) as TabSearch;
  const navigate = useNavigate();
  const instance = useInstance();
  const returnTo = safeReturnTo(search.return_to);
  const [saved, setSaved] = useState(false);
  const setupError = search.setup_error
    ? (setupErrors[search.setup_error] ?? "The GitHub App could not be created. Try again.")
    : null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 md:px-10">
      <div className="mx-auto flex max-w-240 flex-col gap-6">
        <p className="text-sm text-fg-2">
          What this server can be given. Platform keys are entered here, encrypted under the
          server's master key, and take effect at once; what is entered is never shown again.
          Environment integrations are read from the server's environment at start.
        </p>
        {setupError ? (
          <Banner tone="error" title="Couldn't create the GitHub App">
            {setupError}
          </Banner>
        ) : null}
        {saved && returnTo ? (
          <Banner
            tone="success"
            title="Saved"
            action={
              <Button variant="outline" size="sm" onClick={() => void navigate({ href: returnTo })}>
                Back
              </Button>
            }
          >
            Go back to connect it where you were.
          </Banner>
        ) : null}
        {instance.isPending ? (
          <SkeletonRows rows={6} label="Loading integrations" />
        ) : instance.isError ? (
          <Banner
            tone="error"
            title="Couldn't load the integrations"
            meta={instance.error.message}
          />
        ) : (
          <div className="flex flex-col overflow-hidden rounded-xl bg-surface">
            {instance.data.integrations.map((integration) => (
              <IntegrationBlock
                key={integration.id}
                integration={integration}
                focused={search.integration === integration.id}
                returnTo={returnTo}
                onSaved={() => setSaved(true)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** One integration: its state and what it enables, with its keys form or its variables behind a toggle. */
function IntegrationBlock({
  integration,
  focused,
  returnTo,
  onSaved,
}: {
  integration: InstanceIntegration;
  /** Named in the page's search: opened and scrolled to on arrival. */
  focused: boolean;
  returnTo: string | null;
  onSaved: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(focused);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "start" });
  }, [focused]);
  const tag = stateTag[integration.state];
  const docs = integrationDocs[integration.id];

  return (
    <div ref={ref} className="border-b border-line last:border-b-0">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex w-full cursor-pointer items-start gap-3 px-4 py-3.5 text-left hover:bg-paper"
      >
        <Icon icon={expanded ? ChevronDown : ChevronRight} size={14} className="mt-1.5 shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-md font-semibold">{integration.label}</span>
            <Tag tone={tag.tone} font="sans">
              {tag.label}
            </Tag>
            <Tag tone="well" font="sans">
              {integration.source === "store" ? "Platform key" : "Environment"}
            </Tag>
          </span>
          <span className="text-sm text-fg-2">{integration.enables}</span>
        </span>
      </button>
      {expanded ? (
        <div className="flex flex-col gap-4 bg-paper px-4 py-4 pl-11">
          {docs ? (
            <p className="text-sm text-fg-2">
              <DocsLink path={docs}>Setup guide</DocsLink>
            </p>
          ) : null}
          {integration.source === "store" ? (
            <KeysForm integration={integration} returnTo={returnTo} onSaved={onSaved} />
          ) : (
            <EnvFields integration={integration} />
          )}
        </div>
      ) : null}
    </div>
  );
}

/** An environment integration's variables and whether each is set; a value is never shown. */
function EnvFields({ integration }: { integration: InstanceIntegration }) {
  return (
    <>
      <p className="text-xs text-muted">
        Read from the server's environment at start; a change takes a restart.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {integration.fields.map((field) => {
          const tag = fieldTag(integration, field);
          return (
            <Tag key={field.name} tone={tag.tone}>
              {field.name} · {tag.note}
            </Tag>
          );
        })}
      </div>
    </>
  );
}

/** How many GitHub logins a change to the App dropped, for the toast that reports it. */
function disconnectedNote(disconnected: number): { description?: string } {
  return disconnected
    ? { description: `${disconnected} GitHub login${disconnected === 1 ? "" : "s"} disconnected.` }
    : {};
}

/**
 * A store integration's keys: one input per field, entered afresh each time since the server
 * never returns a value. Replacing the GitHub App while logins exist asks first.
 */
function KeysForm({
  integration,
  returnTo,
  onSaved,
}: {
  integration: InstanceIntegration;
  returnTo: string | null;
  onSaved: () => void;
}) {
  const save = useSaveInstanceKeys();
  const remove = useRemoveInstanceKeys();
  const [values, setValues] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [replacing, setReplacing] = useState<{ action: "save" | "remove"; message: string } | null>(
    null,
  );
  const busy = save.isPending || remove.isPending;
  const on = integration.state === "on";

  const entered = () =>
    Object.fromEntries(
      integration.fields.flatMap((field) => {
        const value = (values[field.name] ?? "").trim();
        return value ? [[field.name, value]] : [];
      }),
    );

  const saveKeys = (confirmReplace: boolean) =>
    save
      .mutateAsync({
        integration: integration.id,
        values: entered(),
        ...(confirmReplace ? { confirmReplace } : {}),
      })
      .then(
        ({ disconnected }) => {
          toast({
            kind: "success",
            title: `${integration.label} saved`,
            ...disconnectedNote(disconnected),
          });
          setValues({});
          onSaved();
        },
        (error: Error) => {
          if (!confirmReplace && error instanceof ApiError && error.status === 409) {
            setReplacing({ action: "save", message: error.message });
            return;
          }
          toast({
            kind: "error",
            title: `Couldn't save ${integration.label}`,
            description: error.message,
          });
          throw error;
        },
      );

  const removeKeys = (confirmReplace: boolean) =>
    remove
      .mutateAsync({ integration: integration.id, ...(confirmReplace ? { confirmReplace } : {}) })
      .then(
        ({ disconnected }) => {
          toast({
            kind: "success",
            title: `${integration.label} removed`,
            ...disconnectedNote(disconnected),
          });
          setValues({});
        },
        (error: Error) => {
          if (!confirmReplace && error instanceof ApiError && error.status === 409) {
            setReplacing({ action: "remove", message: error.message });
            return;
          }
          toast({
            kind: "error",
            title: `Couldn't remove ${integration.label}`,
            description: error.message,
          });
          throw error;
        },
      );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void saveKeys(false).catch(() => undefined);
  };

  return (
    <>
      <form onSubmit={submit} className="flex flex-col gap-4">
        {integration.fields.map((field) => (
          <KeyInput
            key={field.name}
            field={field}
            value={values[field.name] ?? ""}
            disabled={busy}
            onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))}
          />
        ))}
        <p className="text-xs text-muted">
          {on
            ? "Replacing enters every value again; what is stored is never shown."
            : "Stored encrypted under the server's master key; never shown again."}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={busy}>
            {on ? "Replace" : "Save"}
          </Button>
          {integration.state !== "off" ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setRemoving(true)}
            >
              Remove
            </Button>
          ) : null}
          {integration.setup === "github-app-manifest" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setCreating(true)}
            >
              Create the GitHub App
            </Button>
          ) : null}
          {integration.updated_at ? (
            <span className="text-xs text-muted">
              Set{integration.set_by ? ` by ${integration.set_by}` : ""} on{" "}
              {setDate.format(new Date(integration.updated_at))}
            </span>
          ) : null}
        </div>
      </form>
      <ConfirmDialog
        kind="destructive"
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove ${integration.label}?`}
        description="Its keys are deleted from this server and the integration switches off at once."
        confirmLabel="Remove"
        onConfirm={() => removeKeys(false)}
      />
      <ConfirmDialog
        kind="destructive"
        open={replacing !== null}
        onOpenChange={(open) => !open && setReplacing(null)}
        title={replacing?.action === "remove" ? "Remove anyway?" : "Replace anyway?"}
        description={replacing?.message}
        confirmLabel={replacing?.action === "remove" ? "Remove" : "Replace"}
        onConfirm={() => (replacing?.action === "remove" ? removeKeys(true) : saveKeys(true))}
      />
      {integration.setup === "github-app-manifest" ? (
        <CreateAppDialog
          integration={integration}
          returnTo={returnTo}
          open={creating}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </>
  );
}

/** One key's input: a password field for a secret, a mono text area for a multiline value, plain text otherwise. */
function KeyInput({
  field,
  value,
  disabled,
  onChange,
}: {
  field: IntegrationField;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const aside = [field.optional ? "Optional" : null, field.set ? "Set" : null]
    .filter(Boolean)
    .join(" · ");
  const common = {
    tone: "surface" as const,
    label: field.label,
    name: field.name,
    placeholder: field.label,
    required: !field.optional,
    autoComplete: "off",
    value,
    disabled,
    ...(aside ? { aside } : {}),
  };
  return field.multiline ? (
    <TextAreaField
      {...common}
      font="mono"
      rows={6}
      spellCheck={false}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  ) : (
    <TextField
      {...common}
      type={field.secret ? "password" : "text"}
      mono={!field.secret}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  );
}

/**
 * Starts creating the GitHub App from a manifest: the name and owner to create it under, then
 * GitHub's confirmation page, which brings the admin back here with the App stored.
 */
function CreateAppDialog({
  integration,
  returnTo,
  open,
  onClose,
}: {
  integration: InstanceIntegration;
  returnTo: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const start = useStartGithubAppManifest();
  const [name, setName] = useState("");
  const [owner, setOwner] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    start.mutate(
      {
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(owner.trim() ? { owner: owner.trim() } : {}),
        ...(returnTo ? { return_to: returnTo } : {}),
      },
      { onSuccess: ({ action, manifest }) => submitManifestForm(action, manifest) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="sm">
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader
            title="Create the GitHub App"
            description="GitHub asks you to confirm the App, then sends you back here with its keys stored."
          />
          <DialogBody>
            {integration.state === "on" ? (
              <Banner
                tone="warning"
                title="Replacing the App disconnects the existing GitHub logins."
              />
            ) : null}
            <TextField
              tone="surface"
              label="App name"
              aside="Optional"
              hint="Shown on GitHub, where it must be unique."
              maxLength={34}
              showCount
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
            <TextField
              tone="surface"
              label="Organisation"
              aside="Optional"
              hint="The GitHub organisation that owns the App; empty creates it on your account."
              mono
              autoComplete="off"
              value={owner}
              onChange={(event) => setOwner(event.currentTarget.value)}
            />
            {start.isError ? (
              <Banner tone="error" title="Couldn't start creating the App">
                {start.error.message}
              </Banner>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={start.isPending}>
              {start.isPending ? "Opening GitHub…" : "Continue on GitHub"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
