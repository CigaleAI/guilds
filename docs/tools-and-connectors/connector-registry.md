# Connector registry

A connector registry publishes connectors and recipes beyond the ones
the image ships. A platform admin installs a connector from it, and the
connector joins every organisation's catalog. Each organisation then
connects it and turns it on or not. Recipes from the same registry are
imported under **Recipes** ([Recipes](../concepts/recipes.md)).

The box reads the registry `REGISTRY_URL` names, part of the
`registry` [platform key](platform-keys.md):

- unset: the guilds.run registry, `https://registry.guilds.run`
- set empty: no registry; the box is offline
- set: that registry

The guilds.run registry publishes the connectors and recipes of
[CigaleAI/guilds-connectors](https://github.com/CigaleAI/guilds-connectors).
Anyone adds one there by pull request. Its README holds the rules its
check enforces and how Guilds verifies a version.

## The index

A box reads `<REGISTRY_URL>/index.json`:

```json
{
  "generated_at": "2026-10-01T00:00:00Z",
  "connectors": [
    { "slug": "acme", "version": "1.2.0", "path": "connectors/acme/1.2.0.tgz",
      "sha256": "…", "size": 812, "publisher": "acme", "verified": true,
      "display_name": "Acme", "description": "…" }
  ],
  "recipes": [
    { "name": "crm-desk", "version": "1.0.0", "path": "recipes/crm-desk/1.0.0.json",
      "sha256": "…", "size": 9120, "publisher": "guilds", "verified": true,
      "display_name": "CRM desk", "description": "…" }
  ]
}
```

- There is one entry per published version. `path` is relative to the
  index.
- An entry may carry `experimental: true`: its publisher is still
  trying it out. An install accepts it only explicitly, and the row
  keeps the mark beside `verified`.
- An index may carry `signature`: a base64 Ed25519 signature over its
  canonical bytes. Those are the index without `signature`, as JSON
  with every object's keys sorted and no whitespace.
- With `REGISTRY_PUBLIC_KEY` set (base64 SPKI DER), the box refuses an
  index that is unsigned or that the key does not verify.

A connector package is a gzipped tar of its folder, at the root or
under one directory:

- `connector.json`
- an optional `logo.svg`
- `adapter.js`, for a connector with code

The index, a package, and an unpacked package are each at most
16 MiB.

## Installing a connector

An install (`apps/orchestrator/src/registry/`) runs these steps:

1. It picks the named version, or the newest.
2. It refuses an entry with `verified: false` unless the install
   accepts it (`--unverified`). It refuses an experimental entry unless
   the install accepts that (`--experimental`). Both are a 409.
3. It refuses a slug any server on the box holds, platform or
   organisation.
4. It downloads the package. It refuses a size or SHA-256 that differs
   from the index's.
5. It validates `connector.json` with the loader, and its slug against
   the entry's.
6. It refuses what the package may not claim (below).
7. It writes a platform row: `source` `registry`, the entry's
   `version`, `verified`, and `publisher`, on at install. The tool
   prefix is generated against every prefix on the box.
8. A key or client the connector declares of its own appears under
   **Admin**, **Platform keys** as `connector:<slug>`. Until a platform
   admin fills it, **Connector catalog** and **Tools** mark the
   connector **Not set up**, with a **Set up** link there
   ([A connector's own key or client](platform-keys.md#a-connectors-own-key-or-client)).

### What a package may not claim

Every package is refused when it reaches for the box's own wiring
(`boxWiringProblem`, `apps/orchestrator/src/connectors/manifest.ts`):

- `auth.instance: { integration, field }`: a key of the box's own
  integrations
- `auth.oauth.strategy: "configured"` with a `provider`: the box's
  OAuth client
- `auth.oauth.strategy: "github_app"`: the box's GitHub App

A package may declare a key or a client of its own instead:
`auth.instance: { "own": true }`, or `configured` with no `provider`.

A package without code must also be endpoint-only
(`endpointOnlyProblem`): it needs an endpoint and may not declare a
`state` hook.

A package with code needs the code tier and a verified index
(`codeManifestProblem`, `apps/orchestrator/src/registry/client.ts`;
[Code tier](#code-tier)).

## Updating and removing

An update moves a registry row to the newest entry. It replaces:

- the manifest
- the version
- `verified` and the experimental mark
- the publisher

It keeps the switch, the OAuth client, the overrides, the logins, and
the bindings. Every login lists its tools again on its next use.

A removal deletes:

- the row and its logins
- the bindings that name it
- the key or client it declared of its own
- its code on disk

A `core` or `local` row is neither updated nor removed this way.

## In the app and the CLI

The instance admin installs under **Admin**, **Connector catalog**,
**Install from the registry**. An install, update, or removal from
Admin takes effect in the running server at once. **Reload
connectors** does the same for what the CLI changed. Each of these
also rebuilds the connector-declared platform keys and resyncs
platform logins.

From the orchestrator's directory (`docker compose exec orchestrator`
on the Compose stack):

```bash
pnpm connector install <slug>[@version] [--unverified] [--experimental]
pnpm connector update [slug] [--unverified] [--experimental]
pnpm connector remove <slug>
pnpm connector list
```

`list` prints each platform connector's slug, source, version, switch,
verification, experimental mark, and the newer version the index
offers. The CLI runs in a process of its own. The running server
serves a code connector the CLI installed after **Reload connectors**
or a restart, and the CLI says so.

## Code tier

A registry connector may carry adapter code: `adapter.js`, one
self-contained ESM file whose default export is the adapter. Its only
runtime input is the context the pool passes it.
`pnpm build:connector <folder> <package.tgz>` bundles a connector
folder (`connector.json`, `adapter.ts`, `logo.svg`) into that package.
It prints the package's SHA-256 and size for the index.

The code runs inside the orchestrator process, so the tier is an
opt-in, the `connector-code` platform key:

- The tier is on only when `CONNECTORS_CODE_TIER=1` and
  `CONNECTORS_ROOT` is set. `CONNECTORS_ROOT` names where code
  connectors live, `${STATE_ROOT}/connectors` on the Compose stack.
- A code package installs only from an index `REGISTRY_PUBLIC_KEY`
  verifies, and only when that index marks it verified. Without the
  key, every code install is refused. `--unverified` never applies to
  code.
- The install writes `connector.json`, `adapter.js`, and `logo.svg` to
  `CONNECTORS_ROOT/<slug>/<version>/`. It imports the adapter once and
  refuses a package that does not load, before any row changes.

The running server serves the version its row names. It imports the
adapter of each registry row whose version folder holds one:

- at boot, after the seed
- after each change from Admin
- after **Reload connectors**

It swaps the adapter in with no restart. A call already running
finishes on the adapter it started with, and the next call uses the
new version. A version that does not load is logged, and the previous
one stays. A removed connector leaves the running server. An update
keeps only the new version's folder. While the tier is off, code on
disk is a warning and is not loaded.

The pool recognises an adapter's `ConnectorError` by its name and
status, because a bundle carries its own copy of the class.

## Reference

| Route | Does |
| --- | --- |
| `GET /api/admin/registry` | `{ offline, url, connectors }`: the newest entry of each connector, with `installed` (`source`, `version`) when the box holds it |
| `POST /api/admin/registry/connectors` | Installs `{ slug, version?, unverified?, experimental? }`. 201 with the catalog row |
| `POST /api/admin/registry/connectors/:slug/update` | Updates one connector, `{ unverified?, experimental? }`. Answers `{ moved }` |
| `DELETE /api/admin/registry/connectors/:slug` | Removes one connector. 204 |
| `POST /api/admin/registry/reload` | Serves what the database now holds, after a CLI change |

Every route needs an instance admin. While the box is offline, an
install or update is a 409. A removal works offline.
