# Instance admin

The **Admin** page is where the [instance admin](users.md#the-instance-admin)
runs the box itself: the connectors every organisation can use, the
platform keys behind them, and, on the core sign-in modes, the user
directory. Everything else belongs to an
[organisation](organisations.md) and lives in its **Settings**.

## Why it exists

Some things are shared by every organisation on the box: which
connectors are installed, and the keys of the box's own integrations,
such as web search, System One, the GitHub App, and Google. One
person decides them for everyone.

## In the app

**Admin** (`/admin`) opens from the account menu, for the instance
admin only. Anyone else sees **Platform admins only**.

Its tabs:

| Tab | Shows | Depth |
|---|---|---|
| **Connector catalog** | Every installed connector | [Connectors](../tools-and-connectors/connectors.md), [Registry](../tools-and-connectors/connector-registry.md) |
| **Platform keys** | The box's optional integrations | [Platform keys](../tools-and-connectors/platform-keys.md) |
| **Users** | Every account on the box, on `compat-cookie` and `trusted-header` only | [Users](users.md#the-users-tab) |

An extension places its own tabs among these.

### Connector catalog

The catalog lists every installed connector with its switch, its
source, its version when it has one, and its tools. The admin:

- turns a connector on or off
- edits its copy over the manifest, with the manifest's value shown
  beside an edited field
- sets whether each tool starts On for a new login
- exports it as `connector.json`
- adds a remote MCP server with **Add a remote server**
- opens **Install from the registry**, which installs, updates, and
  removes registry connectors
- runs **Reload connectors**, which loads code connectors installed
  from the command line

A connector whose integration is not on is marked **Not set up**,
with a **Set up** link to **Platform keys** on that integration.

### Platform keys

Each integration shows its state (on, incomplete, or off), what it
switches on, and which of its fields are set, with when and by whom.
The admin enters and removes the values of an integration kept in
the database. A value is never shown again. An integration set in
`.env` is read-only. The GitHub App is created from a manifest here.

**Set up** links from Tools, a coding agent's repositories, and a
recipe's preview open this tab on that integration.

## Rules and limits

| Rule | Value or behaviour |
|---|---|
| Who opens Admin | The instance admin only |
| **Users** tab | On `compat-cookie` and `trusted-header` only |
| Platform key values | Never shown after saving |
| An integration from `.env` | Read-only |
| An instance admin route, for anyone else | 404 |

## Reference

### Routes

The instance admin reaches:

- `/api/admin/mcp/*`: the connector catalog
- `/api/admin/registry/*`: the registry, and
  `POST /api/admin/registry/reload`
- `PUT` and `DELETE /api/admin/instance/keys/:integration`, and the
  GitHub App manifest flow: platform keys
- `GET /api/platform`: the instance-level access view
- `POST /api/orgs`, on any mode other than `compat-cookie`
- the user directory, on `trusted-header`

`GET /api/instance` feeds **Platform keys**. Every signed-in user
reads it. Only the instance admin gets who set each field and when.

### Tabs

The tabs are `?tab=catalog`, `?tab=instance`, and `?tab=users`.
`?integration=<id>` opens **Platform keys** on one integration.

Code: `apps/web/src/features/admin/`,
`apps/orchestrator/src/http/instance-admin.ts`.
