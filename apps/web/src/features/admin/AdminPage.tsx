import { Link, useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import {
  ChevronDown,
  ChevronRight,
  Download,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  ShieldOff,
} from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import {
  catalogExportUrl,
  useAdminCatalog,
  useInstance,
  useReloadRegistry,
  useSaveCatalogServer,
  useSaveCatalogTool,
} from "../../api/queries/admin";
import type {
  CatalogCopyField,
  CatalogServer,
  CatalogServerInput,
  CatalogTool,
} from "../../api/types/admin";
import type { TabSearch } from "../../app/router";
import { useIdentity } from "../../app/identity";
import { chosenTab, placeTabs, useSlots } from "../../app/slots";
import {
  Button,
  IconButton,
  OnOffSwitch,
  StatBand,
  SearchField,
  Segmented,
  Select,
  TextAreaField,
  TextField,
  Banner,
  EmptyState,
  SkeletonRows,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  toast,
  Icon,
  Tag,
} from "@guildsrun/ui";
import { connectorLogo } from "../access/connectorLogo";
import { integrationFor, setupSearch } from "../instance/instance";
import { InstanceTab } from "./InstanceTab";
import { RegistryDialog } from "./RegistryDialog";
import { parseInputSchema } from "./toolSchema";
import { UsersTab } from "./UsersTab";

const coreTabs = [
  { value: "catalog", label: "Connector catalog" },
  { value: "instance", label: "Platform keys" },
];

/** The user directory's tab, on the modes whose server serves one. */
const usersTab = { value: "users", label: "Users" };

type ScrollProps = { children: ReactNode };

function Scroll({ children }: ScrollProps) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 md:px-10">
      <div className="mx-auto flex max-w-240 flex-col gap-6">{children}</div>
    </div>
  );
}

/** Platform administration: the connector catalog, the platform's keys, the users, and the tabs an extension adds. */
export function AdminPage() {
  const search = useSearch({ strict: false }) as TabSearch;
  const navigate = useNavigate();
  const catalog = useAdminCatalog();
  const { adminTabs = [] } = useSlots();
  const { mode } = useIdentity();
  const directory = mode === "compat-cookie" || mode === "trusted-header";
  const tabs = placeTabs(directory ? [...coreTabs, usersTab] : coreTabs, adminTabs);
  const tab = chosenTab(tabs, search.tab);
  const added = adminTabs.find((item) => item.id === tab);

  if (catalog.isError) {
    return (
      <div className="grid flex-1 place-items-center p-6">
        <EmptyState
          icon={ShieldOff}
          title="Platform admins only"
          description="This page is for the platform's admins."
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-col gap-3 border-b border-line px-6 pt-8 pb-4 md:px-10">
        <div className="flex flex-col gap-1">
          <span className="type-label text-muted">Platform</span>
          <h1 className="type-h1">Admin</h1>
        </div>
        <Segmented
          size="sm"
          label="Admin section"
          value={tab}
          onValueChange={(next) =>
            void navigate({ to: "/admin", search: next === "catalog" ? {} : { tab: next } })
          }
          options={tabs}
        />
      </header>
      {added ? (
        added.render()
      ) : tab === "instance" ? (
        <InstanceTab />
      ) : tab === "users" ? (
        <UsersTab />
      ) : (
        <Catalog servers={catalog.data?.servers} />
      )}
    </div>
  );
}

type CatalogProps = { servers: CatalogServer[] | undefined };

function Catalog({ servers }: CatalogProps) {
  const save = useSaveCatalogServer();
  const [query, setQuery] = useState("");
  const [editingServer, setEditingServer] = useState<CatalogServer | "new" | null>(null);
  const [editingTool, setEditingTool] = useState<{
    server: CatalogServer;
    tool: CatalogTool;
  } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const reload = useReloadRegistry();
  const instance = useInstance();
  const location = useLocation();

  if (!servers) {
    return (
      <Scroll>
        <SkeletonRows rows={6} label="Loading the catalog" />
      </Scroll>
    );
  }

  const needle = query.trim().toLowerCase();
  const shown = [...servers]
    .filter(
      (server) =>
        !needle ||
        `${server.slug} ${server.display_name} ${server.description}`
          .toLowerCase()
          .includes(needle),
    )
    .sort((a, b) => a.slug.localeCompare(b.slug));

  const setEnabled = (server: CatalogServer, enabled: boolean) =>
    save.mutate(
      { id: server.id, input: { enabled } },
      {
        onSuccess: () =>
          toast({ kind: "success", title: `${server.display_name} ${enabled ? "on" : "off"}` }),
      },
    );

  const reloadConnectors = () =>
    reload.mutate(undefined, {
      onSuccess: ({ loaded, removed, failed }) => {
        const changes = [
          loaded.length ? `Loaded ${loaded.join(", ")}.` : null,
          removed.length ? `Removed ${removed.join(", ")}.` : null,
        ].filter(Boolean);
        toast({
          kind: "success",
          title: "Connectors reloaded",
          description: changes.length ? changes.join(" ") : "Nothing changed.",
        });
        if (failed.length)
          toast({
            kind: "error",
            title: `Couldn't load ${failed.length} connector${failed.length === 1 ? "" : "s"}`,
            description: failed.join(", "),
          });
      },
      onError: (error) =>
        toast({ kind: "error", title: "Couldn't reload connectors", description: error.message }),
    });

  return (
    <Scroll>
      <StatBand
        stats={[
          { label: "Connectors", value: servers.length },
          { label: "On", value: servers.filter((server) => server.enabled).length },
          {
            label: "Added here",
            value: servers.filter((server) => server.source === "local").length,
          },
          {
            label: "With edits",
            value: servers.filter(
              (server) => server.overridden.length || server.tools.some((tool) => tool.overridden),
            ).length,
          },
        ]}
      />

      <section aria-label="Connectors" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="type-label flex-1 text-muted">Connectors</h2>
          <SearchField
            tone="surface"
            className="w-64"
            label="Search connectors"
            placeholder="Search connectors…"
            value={query}
            onValueChange={setQuery}
          />
          <Button variant="outline" size="sm" onClick={() => setBrowsing(true)}>
            <Icon icon={Package} size={14} />
            Install from the registry
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={reload.isPending}
            onClick={reloadConnectors}
          >
            <Icon icon={RefreshCw} size={14} />
            Reload connectors
          </Button>
          <Button size="sm" onClick={() => setEditingServer("new")}>
            <Icon icon={Plus} size={14} />
            Add a remote server
          </Button>
        </div>
        <div className="flex flex-col overflow-hidden rounded-xl bg-surface">
          {shown.map((server) => {
            const expanded = open === server.id;
            const edits =
              server.overridden.length + server.tools.filter((tool) => tool.overridden).length;
            const integration = integrationFor(instance.data, "connectors", server.slug);
            const notSetUp = integration && integration.state !== "on" ? integration : null;
            return (
              <div key={server.id} className="border-b border-line last:border-b-0">
                <div className="flex items-center gap-3 px-4 py-3 hover:bg-paper">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : server.id)}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
                  >
                    <Icon icon={expanded ? ChevronDown : ChevronRight} size={14} />
                    {connectorLogo(server.logo_url, "size-4")}
                    <span className="min-w-0 flex-1 truncate text-sm">
                      <span className="font-semibold">{server.display_name}</span>{" "}
                      <span className="font-mono text-xs text-muted">
                        {server.slug} · {server.auth}
                        {server.oauth_strategy !== "none" ? ` · ${server.oauth_strategy}` : ""}
                      </span>
                    </span>
                    {server.source === "local" ? (
                      <Tag tone="ochre" font="sans">
                        added here
                      </Tag>
                    ) : !server.verified ? (
                      <Tag tone="ochre" font="sans">
                        unverified
                      </Tag>
                    ) : null}
                    {server.experimental ? (
                      <Tag tone="ochre" font="sans">
                        experimental
                      </Tag>
                    ) : null}
                    {notSetUp ? (
                      <Tag tone="ochre" font="sans">
                        Not set up
                      </Tag>
                    ) : null}
                    {edits ? (
                      <span className="type-meta text-muted">
                        {edits} edit{edits === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </button>
                  {notSetUp ? (
                    <Link
                      to="/admin"
                      search={setupSearch(notSetUp.id, location.href)}
                      className="text-sm underline"
                    >
                      Set up
                    </Link>
                  ) : null}
                  <OnOffSwitch
                    label={`${server.display_name} on this box`}
                    value={server.enabled}
                    disabled={save.isPending}
                    onValueChange={(enabled) => setEnabled(server, enabled)}
                  />
                </div>
                {expanded ? (
                  <div className="flex flex-col gap-3 bg-paper px-4 py-3">
                    <p className="font-mono text-xs text-muted">
                      prefix {server.tool_prefix} · setup {server.oauth_setup_state} ·{" "}
                      {server.url ?? "no endpoint"}
                      {server.version ? ` · v${server.version}` : ""}
                      {server.publisher ? ` · ${server.publisher}` : ""}
                    </p>
                    {server.description ? (
                      <p className="text-sm text-fg-2">{server.description}</p>
                    ) : null}
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => setEditingServer(server)}>
                        <Icon icon={Pencil} size={14} />
                        {server.editable === "fields" ? "Edit server" : "Edit copy"}
                      </Button>
                      <Button variant="ghost" size="sm" asChild>
                        <a href={catalogExportUrl(server.id)} download>
                          <Icon icon={Download} size={14} />
                          Export connector.json
                        </a>
                      </Button>
                    </div>
                    {server.tools.length ? (
                      <div className="flex flex-col">
                        {server.tools.map((tool) => (
                          <div
                            key={tool.remote_name}
                            className="flex items-center gap-3 border-t border-line py-2"
                          >
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="font-mono text-xs">{tool.namespaced_name}</span>
                              <span className="truncate text-xs text-muted">
                                {tool.description}
                              </span>
                            </span>
                            {tool.mutating ? (
                              <Tag tone="plum" font="sans">
                                mutating
                              </Tag>
                            ) : null}
                            <Tag tone={tool.default_enabled ? "tide" : "well"} font="sans">
                              {tool.default_enabled ? "starts on" : "starts off"}
                              {tool.default_override === null ? "" : " · set here"}
                            </Tag>
                            <IconButton
                              icon={Pencil}
                              label={`Edit ${tool.namespaced_name}`}
                              variant="ghost"
                              size={24}
                              onClick={() => setEditingTool({ server, tool })}
                            />
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted">
                        Its tools are those each login lists; the Tools view sets them per scope.
                      </p>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      <ServerDialog server={editingServer} onClose={() => setEditingServer(null)} />
      <ToolDialog editing={editingTool} onClose={() => setEditingTool(null)} />
      <RegistryDialog open={browsing} onClose={() => setBrowsing(false)} />
    </Scroll>
  );
}

type ServerDialogProps = {
  server: CatalogServer | "new" | null;
  onClose: () => void;
};

function ServerDialog({ server, onClose }: ServerDialogProps) {
  return (
    <Dialog open={server !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg">
        {server === "new" ? <NewServerForm onClose={onClose} /> : null}
        {server && server !== "new" ? (
          server.editable === "fields" ? (
            <NewServerForm key={server.id} server={server} onClose={onClose} />
          ) : (
            <CopyForm key={server.id} server={server} onClose={onClose} />
          )
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type NewServerFormProps = { server?: CatalogServer; onClose: () => void };

/** A remote MCP server added on this box: its own fields. */
function NewServerForm({ server, onClose }: NewServerFormProps) {
  const save = useSaveCatalogServer();
  const [form, setForm] = useState({
    slug: server?.slug ?? "",
    display_name: server?.display_name ?? "",
    url: server?.url ?? "",
    auth: server?.auth ?? ("token" as CatalogServer["auth"]),
    oauth_strategy: server?.oauth_strategy ?? ("none" as CatalogServer["oauth_strategy"]),
    description: server?.description ?? "",
    limitations: server?.limitations ?? "",
    setup_hint: server?.setup_hint ?? "",
  });
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input: CatalogServerInput = {
      ...form,
      limitations: form.limitations || null,
      setup_hint: form.setup_hint || null,
    };
    save.mutate(
      { ...(server ? { id: server.id } : {}), input },
      {
        onSuccess: () => {
          toast({ kind: "success", title: `${form.slug} saved` });
          onClose();
        },
      },
    );
  };

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-col">
      <DialogHeader
        title={server ? `Edit ${server.display_name}` : "Add a remote server"}
        description="A remote MCP server on public HTTPS, installed for every organisation on this box."
      />
      <DialogBody>
        <div className="grid gap-4 md:grid-cols-2">
          <TextField
            tone="surface"
            label="Slug"
            mono
            required
            value={form.slug}
            onChange={(event) => set({ slug: event.currentTarget.value })}
          />
          <TextField
            tone="surface"
            label="Display name"
            required
            value={form.display_name}
            onChange={(event) => set({ display_name: event.currentTarget.value })}
          />
        </div>
        <TextField
          tone="surface"
          label="URL"
          mono
          required
          value={form.url}
          onChange={(event) => set({ url: event.currentTarget.value })}
        />
        <div className="grid gap-4 md:grid-cols-2">
          <Select
            tone="surface"
            label="Auth"
            value={form.auth}
            onValueChange={(value) =>
              set({
                auth: value as CatalogServer["auth"],
                oauth_strategy: value === "oauth" ? "dynamic" : "none",
              })
            }
            options={["none", "token", "oauth"].map((value) => ({ value, label: value }))}
          />
          <Select
            tone="surface"
            label="OAuth strategy"
            value={form.oauth_strategy}
            disabled={form.auth !== "oauth"}
            onValueChange={(value) =>
              set({ oauth_strategy: value as CatalogServer["oauth_strategy"] })
            }
            options={(form.auth === "oauth" ? ["dynamic", "configured"] : ["none"]).map(
              (value) => ({
                value,
                label: value,
              }),
            )}
          />
        </div>
        <TextAreaField
          tone="surface"
          font="sans"
          label="Description"
          rows={3}
          value={form.description}
          onChange={(event) => set({ description: event.currentTarget.value })}
        />
        <TextAreaField
          tone="surface"
          font="sans"
          label="Limitations"
          rows={2}
          value={form.limitations}
          onChange={(event) => set({ limitations: event.currentTarget.value })}
        />
        <TextField
          tone="surface"
          label="Setup hint"
          value={form.setup_hint}
          onChange={(event) => set({ setup_hint: event.currentTarget.value })}
        />
        {save.isError ? (
          <Banner tone="error" title="Couldn't save the server">
            {save.error.message}
          </Banner>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="ghost">Cancel</Button>
        </DialogClose>
        <Button type="submit" disabled={save.isPending}>
          Save server
        </Button>
      </DialogFooter>
    </form>
  );
}

const COPY_FIELDS: Array<{ field: CatalogCopyField; label: string; rows: number }> = [
  { field: "display_name", label: "Display name", rows: 1 },
  { field: "description", label: "Description", rows: 3 },
  { field: "limitations", label: "Limitations", rows: 2 },
  { field: "setup_hint", label: "Setup hint", rows: 1 },
];

type CopyFormProps = { server: CatalogServer; onClose: () => void };

/** The copy of a connector the box did not write: each field overrides its manifest, beside the upstream value. */
function CopyForm({ server, onClose }: CopyFormProps) {
  const save = useSaveCatalogServer();
  const [values, setValues] = useState<Record<CatalogCopyField, string>>({
    display_name: server.display_name,
    description: server.description,
    limitations: server.limitations ?? "",
    setup_hint: server.setup_hint ?? "",
  });

  const upstream = (field: CatalogCopyField) => server.upstream[field] ?? "";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input: CatalogServerInput = {};
    for (const { field } of COPY_FIELDS) {
      input[field] = values[field] === upstream(field) ? null : values[field];
    }
    save.mutate(
      { id: server.id, input },
      {
        onSuccess: () => {
          toast({ kind: "success", title: `${server.display_name} saved` });
          onClose();
        },
      },
    );
  };

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-col">
      <DialogHeader
        title={`Edit ${server.display_name}`}
        description="Edits sit over the connector's manifest; an update keeps them. Set a field back to its manifest value to drop the edit."
      />
      <DialogBody>
        {COPY_FIELDS.map(({ field, label, rows }) => {
          const changed = values[field] !== upstream(field);
          const hint = changed ? `Manifest: ${upstream(field) || "empty"}` : undefined;
          return rows > 1 ? (
            <TextAreaField
              key={field}
              tone="surface"
              font="sans"
              label={label}
              rows={rows}
              value={values[field]}
              {...(hint ? { hint } : {})}
              onChange={(event) => setValues({ ...values, [field]: event.currentTarget.value })}
            />
          ) : (
            <TextField
              key={field}
              tone="surface"
              label={label}
              value={values[field]}
              {...(hint ? { hint } : {})}
              onChange={(event) => setValues({ ...values, [field]: event.currentTarget.value })}
            />
          );
        })}
        {save.isError ? (
          <Banner tone="error" title="Couldn't save the connector">
            {save.error.message}
          </Banner>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="ghost">Cancel</Button>
        </DialogClose>
        <Button type="submit" disabled={save.isPending}>
          Save copy
        </Button>
      </DialogFooter>
    </form>
  );
}

type ToolDialogProps = {
  editing: { server: CatalogServer; tool: CatalogTool } | null;
  onClose: () => void;
};

function ToolDialog({ editing, onClose }: ToolDialogProps) {
  return (
    <Dialog open={editing !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg">
        {editing ? (
          <ToolForm
            key={editing.tool.remote_name}
            server={editing.server}
            tool={editing.tool}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type ToolFormProps = {
  server: CatalogServer;
  tool: CatalogTool;
  onClose: () => void;
};

/** One tool's edit: its description, its schema, and whether a new login starts it On. */
function ToolForm({ server, tool, onClose }: ToolFormProps) {
  const save = useSaveCatalogTool();
  const [description, setDescription] = useState(tool.description);
  const [start, setStart] = useState<"manifest" | "on" | "off">(
    tool.default_override === null ? "manifest" : tool.default_override ? "on" : "off",
  );
  const [schema, setSchema] = useState(JSON.stringify(tool.input_schema, null, 2));
  const parsed = parseInputSchema(schema);
  const schemaError = "error" in parsed ? parsed.error : undefined;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if ("error" in parsed) return;
    save.mutate(
      {
        serverId: server.id,
        name: tool.remote_name,
        input: {
          ...(description === tool.description ? {} : { description }),
          ...(schema === JSON.stringify(tool.input_schema, null, 2)
            ? {}
            : { input_schema: parsed.schema }),
          default: start === "manifest" ? null : start === "on",
        },
      },
      {
        onSuccess: () => {
          toast({ kind: "success", title: "Tool saved" });
          onClose();
        },
      },
    );
  };

  const clear = () =>
    save.mutate(
      {
        serverId: server.id,
        name: tool.remote_name,
        input: { description: null, input_schema: null, default: null },
      },
      {
        onSuccess: () => {
          toast({ kind: "success", title: "Edits cleared" });
          onClose();
        },
      },
    );

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-col">
      <DialogHeader title={`Edit ${tool.namespaced_name}`} />
      <DialogBody>
        <TextAreaField
          tone="surface"
          font="sans"
          label="Description"
          rows={3}
          hint="What the model reads."
          value={description}
          onChange={(event) => setDescription(event.currentTarget.value)}
        />
        <Select
          tone="surface"
          label="A new login starts it"
          value={start}
          onValueChange={(value) => setStart(value as "manifest" | "on" | "off")}
          options={[
            { value: "manifest", label: "As the connector says" },
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
        />
        <TextAreaField
          tone="surface"
          font="mono"
          label="Input schema"
          rows={8}
          value={schema}
          onChange={(event) => setSchema(event.currentTarget.value)}
          {...(schemaError ? { error: schemaError } : {})}
        />
        {save.isError ? (
          <Banner tone="error" title="Couldn't save the tool">
            {save.error.message}
          </Banner>
        ) : null}
      </DialogBody>
      <DialogFooter>
        {tool.overridden ? (
          <Button variant="ghost" disabled={save.isPending} onClick={clear}>
            Clear edits
          </Button>
        ) : null}
        <DialogClose asChild>
          <Button variant="ghost">Cancel</Button>
        </DialogClose>
        <Button type="submit" disabled={save.isPending || Boolean(schemaError)}>
          Save tool
        </Button>
      </DialogFooter>
    </form>
  );
}
