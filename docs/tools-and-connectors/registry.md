# Registry

A registry publishes connectors and recipes beyond the ones the image
ships. The box reads the one `REGISTRY_URL` names, the guilds.run
registry while it is unset, and none while it is set empty (the
`registry` integration). It reads `<REGISTRY_URL>/index.json`:

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

One entry per published version; `path` is relative to the index. An
entry may carry `experimental: true`: its publisher is still trying it
out, an install accepts it explicitly (`--experimental`), and the
row keeps the mark, shown beside `verified`. A
connector package is a gzipped tar of its folder: `connector.json`, an
optional `logo.svg`, and, for a connector with code, `adapter.js`, at
the root or under one directory. An index may carry `signature`: a
base64 Ed25519 signature over its canonical bytes (the index without
`signature`, as JSON with every object's keys sorted and no
whitespace). With `REGISTRY_PUBLIC_KEY` set (base64 SPKI DER), the box
refuses an index that is unsigned or that the key does not verify.

Installing a connector (`apps/orchestrator/src/registry/`):

1. picks the named version, or the newest
2. refuses an entry with `verified: false` unless the install accepts
   it (`--unverified`), and an experimental one unless it accepts that
   (`--experimental`)
3. refuses a slug any server on the box holds, platform or
   organisation
4. downloads the package and refuses it when its size or SHA-256
   differs from the index's
5. validates `connector.json` with the loader, its slug against the
   entry's
6. refuses what the package may not claim. With or without code, a
   package may not reach for the box's own wiring: a shipped
   integration's key (`auth.instance.integration`), the box's OAuth
   client (`auth.oauth.provider`), or the GitHub App (`github_app`)
   (`boxWiringProblem`, `apps/orchestrator/src/connectors/manifest.ts`).
   It may declare a key or an OAuth client of its own
   (`auth.instance: { "own": true }`, or `configured` with no
   provider), which the instance admin fills in by name for that
   connector alone ([Instance keys](connectors.md#instance-keys)).
   Without code it is endpoint-only as well: it needs an endpoint and
   may not declare a `state` hook (`endpointOnlyProblem`). With code
   (`codeManifestProblem`, `apps/orchestrator/src/registry/client.ts`),
   the install needs the code tier and a verified index (below)
7. writes a platform row: `source` `registry`, the entry's `version`,
   `verified`, and `publisher`, on at install, its tool prefix
   generated against every prefix on the box
8. lists the key or client the connector declared of its own under
   **Admin → Platform keys** as `connector:<slug>`. Until a platform
   admin fills it, Connector catalog and Tools mark the connector
   **Not set up** with a **Set up** link there

The row has no folder. Updating replaces its manifest, version,
verification, experimental mark, and publisher with the newest
entry's; its switch, OAuth client, overrides, logins, and bindings
stay, and every login lists its tools again on its next use. Removing it deletes it
with its logins, the bindings that name it, and the key it declared
of its own. A `core` or `local` row is neither updated nor removed
this way.

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
offers. The CLI runs in a process of its own, so the running server
serves a code connector it installed after **Reload connectors**
(below) or a restart; the CLI says so. The instance admin does the
same under **Admin → Connector catalog**, **Install
from the registry**:

```text
GET    /api/admin/registry
POST   /api/admin/registry/connectors          { slug, version?, unverified?, experimental? }
POST   /api/admin/registry/connectors/:slug/update { unverified?, experimental? }
DELETE /api/admin/registry/connectors/:slug
POST   /api/admin/registry/reload
```

A registry install is box-wide: the connector joins every
organisation's catalog, and each organisation connects it and turns
it on or not. An install, update, or removal from Admin takes effect
in the running server at once; **Reload connectors**
(`POST /api/admin/registry/reload`) does the same for what the CLI
changed. Each of these rebuilds the list of connector-declared
integrations Platform keys offers (`refreshConnectorIntegrations`,
`apps/orchestrator/src/instance/connectors.ts`).

## Code tier

A registry connector may carry adapter code: `adapter.js`, one
self-contained ESM file whose default export is the adapter. Its
only runtime input is the context the pool passes it.
`pnpm build:connector <folder> <package.tgz>` bundles a connector
folder (`connector.json`, `adapter.ts`, `logo.svg`) into that package
and prints its SHA-256 and size for the index.

The code runs inside the orchestrator process, so installing it is
an opt-in (the `connector-code` integration):

- `CONNECTORS_CODE_TIER=1` turns the tier on, and `CONNECTORS_ROOT`
  names where code connectors live (`STATE_ROOT/connectors` on the
  Compose stack)
- a code package installs only from an index `REGISTRY_PUBLIC_KEY`
  verifies, and only when that index marks it verified; without the
  key every code install is refused, and `--unverified` never applies
  to code
- the install writes `connector.json`, `adapter.js`, and `logo.svg` to
  `CONNECTORS_ROOT/<slug>/<version>/`, imports the adapter once, and
  refuses a package that does not load before any row changes

The running server serves the version its row names. At boot, after
the seed, and after each change from Admin or **Reload connectors**,
it imports the adapter of each registry row whose version folder
holds one and swaps it in for the version it served, with no restart:
a call already running finishes on the adapter it started with, and
the next one uses the new version. A version that does not load is
logged and the previous one stays. A removed connector leaves the
running server. An update keeps only the new version's folder. While
the tier is off, code on disk is a warning and is not loaded. The pool
recognises an adapter's `ConnectorError` by its name and status, since
a bundle carries its own copy of the class.
