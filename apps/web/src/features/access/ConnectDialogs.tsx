import { Copy, ExternalLink } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  lookupWithCredentials,
  useConnectServer,
  useConnection,
  type AccessOwner,
} from "../../api/queries";
import type {
  ConnectorAuthField,
  McpConnection,
  McpCredentials,
  McpServerAccess,
} from "../../api/types";
import {
  Button,
  TextField,
  Banner,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  toast,
  Icon,
} from "@guildsrun/ui";
import { SettingsForm, type SettingsValue } from "./SettingsForm";

/** What signing in to a server needs to know about it. */
export type ConnectableServer = Pick<McpServerAccess, "id" | "slug" | "name" | "auth"> & {
  setup_hint?: string | undefined;
  /** The inputs the connector's key login asks for; one API key when absent. */
  auth_fields?: ConnectorAuthField[] | undefined;
  /** What the login stores beside its credentials, when it stores something. */
  settings_schema?: Record<string, unknown> | null | undefined;
};

const API_KEY_FIELD: ConnectorAuthField = { name: "token", label: "API key", secret: true };

type KeyDialogProps = {
  owner: AccessOwner;
  /** The key-based server to sign in to; null keeps the dialog closed. */
  server: ConnectableServer | null;
  onClose: () => void;
  onConnected?: (server: ConnectableServer) => void;
};

/**
 * Gives the scope being edited its own login to a key-based server: the inputs its connector
 * declares, and the settings its schema asks for. The keys stay with the orchestrator, never in
 * an agent's sandbox.
 */
export function KeyConnectDialog({ owner, server, onClose, onConnected }: KeyDialogProps) {
  const connect = useConnectServer(owner);
  const [values, setValues] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<SettingsValue>({});
  const fields = server?.auth_fields?.length ? server.auth_fields : [API_KEY_FIELD];
  const schema = server?.settings_schema ?? null;
  const serverId = server?.id ?? "";
  const search = useCallback(
    (property: string, query: string) => lookupWithCredentials(serverId, property, query, values),
    [serverId, values],
  );

  const close = () => {
    setValues({});
    setSettings({});
    connect.reset();
    onClose();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!server) return;
    const credentials: McpCredentials = Object.fromEntries(
      fields.map((field) => [field.name, (values[field.name] ?? "").trim()]),
    );
    if (schema && Object.keys(settings).length) credentials.settings = settings;
    connect.mutate(
      { serverId: server.id, credentials },
      {
        onSuccess: (connection) => {
          toast({
            kind: "success",
            title: connection.needs_settings
              ? `${server.name} signed in; finish its settings on its card`
              : `${server.name} connected`,
          });
          onConnected?.(server);
          close();
        },
      },
    );
  };

  return (
    <Dialog open={server !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent size="sm">
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader
            title={`Connect ${server?.name ?? ""}`}
            description="Signs in with a login of its own instead of the one it inherits."
          />
          <DialogBody>
            {server?.setup_hint ? <p className="text-sm text-fg-2">{server.setup_hint}</p> : null}
            {fields.map((field) => (
              <TextField
                key={field.name}
                name={field.name}
                tone="surface"
                label={field.label}
                type={field.secret === false ? "text" : "password"}
                required={!field.optional}
                autoComplete="off"
                {...(field.placeholder ? { placeholder: field.placeholder } : {})}
                value={values[field.name] ?? ""}
                onChange={(event) =>
                  setValues({ ...values, [field.name]: event.currentTarget.value })
                }
              />
            ))}
            {schema ? (
              <SettingsForm
                schema={schema}
                value={settings}
                onChange={setSettings}
                search={search}
              />
            ) : null}
            {connect.isError ? (
              <Banner tone="error" title="Couldn't connect">
                {connect.error.message}
              </Banner>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={connect.isPending}>
              {connect.isPending ? "Connecting…" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type OAuthDialogProps = {
  /** The server being signed in to and the login the server started; null keeps the dialog closed. */
  pending: { server: ConnectableServer; connection: McpConnection } | null;
  onDone: (connected: boolean) => void;
};

function openCentered(url: string) {
  const width = 640;
  const height = 760;
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
  const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));
  window
    .open(
      url,
      "guilds_oauth_auth",
      `width=${width},height=${height},left=${left},top=${top},menubar=no,toolbar=no`,
    )
    ?.focus();
}

/**
 * Finishes an OAuth login: the operator signs in at the provider in a window, from a copied link,
 * or in this tab. The dialog closes once the login reads connected.
 */
export function OAuthDialog({ pending, onDone }: OAuthDialogProps) {
  const connectionId = pending?.connection.id ?? null;
  const connection = useConnection(connectionId, true);
  const url = pending?.connection.authorization_url ?? "";
  const connected =
    connection.data?.status === "connected" || connection.data?.needs_settings === true;
  const refetch = connection.refetch;
  const finished = useRef<string | null>(null);

  useEffect(() => {
    if (!connected || !pending || finished.current === pending.connection.id) return;
    finished.current = pending.connection.id;
    toast({
      kind: "success",
      title: connection.data?.needs_settings
        ? `${pending.server.name} signed in; finish its settings on its card`
        : `${pending.server.name} connected`,
    });
    onDone(true);
  }, [connected, pending, onDone, connection.data?.needs_settings]);

  useEffect(() => {
    if (!pending) return;
    const onMessage = (event: MessageEvent<{ type?: string; success?: boolean } | null>) => {
      if (event.data?.type === "oauth_complete" && event.data.success) void refetch();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [pending, refetch]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast({ kind: "success", title: "Sign-in link copied" });
    } catch {
      toast({ kind: "error", title: "Couldn't copy the link", description: url });
    }
  };

  return (
    <Dialog open={pending !== null} onOpenChange={(open) => !open && onDone(false)}>
      <DialogContent size="sm">
        <DialogHeader
          title={`Sign in to ${pending?.server.name ?? ""}`}
          description={`You'll sign in at ${pending?.connection.authorization_host ?? "the provider"}; this closes by itself once the login connects.`}
        />
        <DialogBody className="gap-3">
          <Button onClick={() => openCentered(url)}>
            <Icon icon={ExternalLink} size={14} />
            Open sign-in window
          </Button>
          <Button variant="outline" onClick={() => void copy()}>
            <Icon icon={Copy} size={14} />
            Copy sign-in link
          </Button>
          <Button variant="ghost" onClick={() => window.location.assign(url)}>
            Continue in this tab
          </Button>
          <p className="text-xs text-muted">Waiting for the login to connect…</p>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Signs a scope in to a server: a dialog for the keys of a key-based server, the provider's page
 * for OAuth. A server the scope is already signed in to counts as connected.
 */
export function useServerConnect(
  owner: AccessOwner,
  onConnected: (server: ConnectableServer) => void = () => undefined,
) {
  const connect = useConnectServer(owner);
  const [keyServer, setKeyServer] = useState<ConnectableServer | null>(null);
  const [oauth, setOAuth] = useState<{
    server: ConnectableServer;
    connection: McpConnection;
  } | null>(null);
  const finishOAuth = useCallback(
    (connected: boolean) => {
      const server = oauth?.server;
      setOAuth(null);
      if (connected && server) onConnected(server);
    },
    [oauth, onConnected],
  );

  const start = (server: ConnectableServer) => {
    if (server.auth === "token") {
      setKeyServer(server);
      return;
    }
    connect.mutate(
      { serverId: server.id, credentials: {} },
      {
        onSuccess: (connection) => {
          if (connection.authorization_url) {
            setOAuth({ server, connection });
            return;
          }
          toast({ kind: "success", title: `${server.name} connected` });
          onConnected(server);
        },
        onError: (error) => {
          if (/already connected/i.test(error.message)) onConnected(server);
          else
            toast({
              kind: "error",
              title: `Couldn't connect ${server.name}`,
              description: error.message,
            });
        },
      },
    );
  };

  return {
    start,
    busy: connect.isPending,
    dialogs: (
      <>
        <KeyConnectDialog
          owner={owner}
          server={keyServer}
          onClose={() => setKeyServer(null)}
          onConnected={onConnected}
        />
        <OAuthDialog pending={oauth} onDone={finishOAuth} />
      </>
    ),
  };
}
