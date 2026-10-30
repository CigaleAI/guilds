import { useState } from "react";
import {
  useAdminRegistry,
  useInstallRegistryConnector,
  useRemoveRegistryConnector,
  useUpdateRegistryConnector,
} from "../../api/queries/admin";
import type { RegistryConnector } from "../../api/types/admin";
import {
  Banner,
  Button,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  SkeletonRows,
  Tag,
  toast,
} from "@guildsrun/ui";
import { acceptanceOf, registryAction } from "./registry";

type Pending = { entry: RegistryConnector; action: "install" | "update" | "remove" };

/** Whether installing or updating the entry asks the admin to accept it first. */
const needsAcceptance = (entry: RegistryConnector) =>
  !entry.verified || entry.experimental === true;

/** What the admin accepts with the entry: "unverified", "experimental", or both. */
function acceptanceWords(entry: RegistryConnector): string {
  return [!entry.verified ? "unverified" : null, entry.experimental ? "experimental" : null]
    .filter(Boolean)
    .join(" and ");
}

function acceptanceWarning(entry: RegistryConnector): string {
  return [
    !entry.verified
      ? "The registry hasn't verified its publisher. Its tools reach whatever its logins grant."
      : null,
    entry.experimental ? "It is still being tried out and may change or break." : null,
  ]
    .filter(Boolean)
    .join(" ");
}

function installLabel(entry: RegistryConnector): string {
  return needsAcceptance(entry) ? `Install ${acceptanceWords(entry)}` : "Install";
}

/** What the confirmation says before each action on a registry entry. */
const confirmationCopy: Record<
  Pending["action"],
  (entry: RegistryConnector) => { title: string; description: string; confirmLabel: string }
> = {
  install: (entry) => ({
    title: `Install ${entry.display_name} ${acceptanceWords(entry)}?`,
    description: acceptanceWarning(entry),
    confirmLabel: installLabel(entry),
  }),
  update: (entry) => ({
    title: `Update ${entry.display_name} ${acceptanceWords(entry)}?`,
    description: acceptanceWarning(entry),
    confirmLabel: `Update to v${entry.version}`,
  }),
  remove: (entry) => ({
    title: `Remove ${entry.display_name}?`,
    description:
      "The connector leaves the box with every organisation's logins to it and their bindings.",
    confirmLabel: "Remove connector",
  }),
};

/** The toasts that say how an action on a registry entry went. */
function actionReport({ entry, action }: Pending) {
  return {
    onSuccess: () =>
      toast({
        kind: "success",
        title:
          action === "install"
            ? `${entry.display_name} installed`
            : action === "update"
              ? `${entry.display_name} updated to v${entry.version}`
              : `${entry.display_name} removed`,
      }),
    onError: (error: Error) =>
      toast({
        kind: "error",
        title: `Couldn't ${action} ${entry.display_name}`,
        description: error.message,
      }),
  };
}

type RegistryDialogProps = { open: boolean; onClose: () => void };

/** What the registry offers, beside what the box has: install, update, or remove a registry connector. */
export function RegistryDialog({ open, onClose }: RegistryDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="lg">{open ? <RegistryList /> : null}</DialogContent>
    </Dialog>
  );
}

function RegistryList() {
  const registry = useAdminRegistry();
  const install = useInstallRegistryConnector();
  const update = useUpdateRegistryConnector();
  const remove = useRemoveRegistryConnector();
  const [confirming, setConfirming] = useState<Pending | null>(null);
  const busy = install.isPending || update.isPending || remove.isPending;

  /** Runs a confirmed action; rejects when it fails, which keeps the confirmation open. */
  const run = (pending: Pending) => {
    const report = actionReport(pending);
    if (pending.action === "remove") return remove.mutateAsync(pending.entry.slug, report);
    const mutation = pending.action === "install" ? install : update;
    return mutation.mutateAsync(acceptanceOf(pending.entry), report);
  };

  const start = (pending: Pending) => {
    if (pending.action === "remove" || needsAcceptance(pending.entry)) {
      setConfirming(pending);
      return;
    }
    const mutation = pending.action === "install" ? install : update;
    mutation.mutate(acceptanceOf(pending.entry), actionReport(pending));
  };

  return (
    <>
      <DialogHeader
        title="Install from the registry"
        description={
          registry.data?.url
            ? `Connectors published at ${registry.data.url}, installed for every organisation on this box.`
            : "Connectors published in the registry, installed for every organisation on this box."
        }
      />
      <DialogBody>
        {registry.isPending ? (
          <SkeletonRows rows={4} label="Loading the registry" />
        ) : registry.isError ? (
          <Banner tone="error" title="Couldn't read the registry">
            {registry.error.message}
          </Banner>
        ) : registry.data.offline ? (
          <Banner tone="info" title="The box is offline">
            REGISTRY_URL is set empty, so nothing installs from the registry.
          </Banner>
        ) : registry.data.connectors.length === 0 ? (
          <p className="text-sm text-muted">The registry offers no connectors.</p>
        ) : (
          <div className="flex flex-col">
            {registry.data.connectors.map((item) => {
              const offer = registryAction(item);
              return (
                <div
                  key={item.slug}
                  className="flex flex-wrap items-start gap-3 border-b border-line py-3 last:border-b-0"
                >
                  <div className="flex min-w-60 flex-1 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-semibold">{item.display_name}</span>
                      <span className="font-mono text-xs text-muted">
                        {item.slug} · v{item.version}
                        {item.publisher ? ` · ${item.publisher}` : ""}
                      </span>
                      {!item.verified ? (
                        <Tag tone="ochre" font="sans">
                          unverified
                        </Tag>
                      ) : null}
                      {item.experimental ? (
                        <Tag tone="ochre" font="sans">
                          experimental
                        </Tag>
                      ) : null}
                    </span>
                    {item.description ? (
                      <p className="text-sm text-fg-2">{item.description}</p>
                    ) : null}
                    {offer === "update" || offer === "current" ? (
                      <span className="text-xs text-muted">
                        Installed v{item.installed?.version}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    {offer === "install" ? (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => start({ entry: item, action: "install" })}
                      >
                        {installLabel(item)}
                      </Button>
                    ) : offer === "elsewhere" ? (
                      <Tag tone="well" font="sans">
                        Installed
                      </Tag>
                    ) : (
                      <>
                        {offer === "update" ? (
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() => start({ entry: item, action: "update" })}
                          >
                            Update to v{item.version}
                          </Button>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => start({ entry: item, action: "remove" })}
                        >
                          Remove
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </DialogBody>
      <RegistryConfirmDialog
        pending={confirming}
        onClose={() => setConfirming(null)}
        onConfirm={run}
      />
    </>
  );
}

type RegistryConfirmDialogProps = {
  /** The action to confirm on an entry; null keeps the dialog closed. */
  pending: Pending | null;
  onClose: () => void;
  /** Runs the confirmed action; rejects when it fails, which keeps the dialog open. */
  onConfirm: (pending: Pending) => Promise<unknown>;
};

/** Asks before removing a registry connector, or before installing or updating one the registry does not vouch for. */
function RegistryConfirmDialog({ pending, onClose, onConfirm }: RegistryConfirmDialogProps) {
  const copy = pending
    ? confirmationCopy[pending.action](pending.entry)
    : { title: "", description: "", confirmLabel: "" };
  return (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(next) => !next && onClose()}
      {...(pending?.action === "remove" ? { kind: "destructive" as const } : {})}
      title={copy.title}
      description={copy.description}
      confirmLabel={copy.confirmLabel}
      onConfirm={() => (pending ? onConfirm(pending) : undefined)}
    />
  );
}
