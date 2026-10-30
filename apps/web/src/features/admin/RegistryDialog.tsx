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
import { registryAction } from "./registry";

type Pending = { entry: RegistryConnector; action: "install" | "update" | "remove" };

/** Whether installing or updating the entry asks the admin to accept it first. */
const needsAcceptance = (entry: RegistryConnector) =>
  !entry.verified || entry.experimental === true;

/** What the admin accepts with the entry: "unverified", "experimental", or both. */
function acceptanceWords(entry: RegistryConnector | undefined): string {
  if (!entry) return "";
  return [!entry.verified ? "unverified" : null, entry.experimental ? "experimental" : null]
    .filter(Boolean)
    .join(" and ");
}

function acceptanceWarning(entry: RegistryConnector | undefined): string {
  if (!entry) return "";
  return [
    !entry.verified
      ? "The registry hasn't verified its publisher. Its tools reach whatever its logins grant."
      : null,
    entry.experimental ? "It is still being tried out and may change or break." : null,
  ]
    .filter(Boolean)
    .join(" ");
}

function installLabel(entry: RegistryConnector | undefined): string {
  return entry && needsAcceptance(entry) ? `Install ${acceptanceWords(entry)}` : "Install";
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

  const run = ({ entry, action }: Pending) => {
    const accepted = { unverified: !entry.verified, experimental: entry.experimental === true };
    const done =
      action === "install"
        ? install.mutateAsync({ slug: entry.slug, ...accepted })
        : action === "update"
          ? update.mutateAsync({ slug: entry.slug, ...accepted })
          : remove.mutateAsync(entry.slug);
    return done.then(
      () => {
        toast({
          kind: "success",
          title:
            action === "install"
              ? `${entry.display_name} installed`
              : action === "update"
                ? `${entry.display_name} updated to v${entry.version}`
                : `${entry.display_name} removed`,
        });
      },
      (error: Error) => {
        toast({
          kind: "error",
          title: `Couldn't ${action} ${entry.display_name}`,
          description: error.message,
        });
        throw error;
      },
    );
  };

  const start = (pending: Pending) => {
    if (pending.action === "remove" || needsAcceptance(pending.entry)) setConfirming(pending);
    else void run(pending).catch(() => undefined);
  };

  const entry = confirming?.entry;
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
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(next) => !next && setConfirming(null)}
        {...(confirming?.action === "remove" ? { kind: "destructive" as const } : {})}
        title={
          confirming?.action === "remove"
            ? `Remove ${entry?.display_name ?? ""}?`
            : `${confirming?.action === "update" ? "Update" : "Install"} ${entry?.display_name ?? ""} ${acceptanceWords(entry)}?`
        }
        description={
          confirming?.action === "remove"
            ? "The connector leaves the box with every organisation's logins to it and their bindings."
            : acceptanceWarning(entry)
        }
        confirmLabel={
          confirming?.action === "remove"
            ? "Remove connector"
            : confirming?.action === "update"
              ? `Update to v${entry?.version ?? ""}`
              : installLabel(entry)
        }
        onConfirm={() => (confirming ? run(confirming) : undefined)}
      />
    </>
  );
}
