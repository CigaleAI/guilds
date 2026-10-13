# Users and organisations

An application user is a member of organisations. Organisations own:

- guilds
- secrets
- connector logins
- model keys
- usage

How a request becomes a user depends on `AUTH_MODE`
(`apps/orchestrator/src/http/identity.ts`).

## Identity

A user has these fields:

- an id
- a globally unique name
- an optional email
- an optional `image` path
- an optional IANA `timezone`
- an optional identity `color` (a 6-digit lowercase hex)

Names match `^[a-z][a-z0-9-]{0,62}$`. The name `user` is reserved so
`@user` stays the group-chat tag for every operator of a guild.

`GET /api/auth/me` returns the user with `platform_admin`. That field
is true for the instance admin.

The Settings page sends `PATCH /api/auth/me`. The body takes `name`,
`timezone`, `color`, or any of them. `timezone` and `color` may be
`null`. A field left out keeps its value.

A name another user holds is 409.

The Routine tab pre-fills random windows with the timezone. It falls
back to the browser's.

The colour tints the person's messages and avatar. `/api/auth/me` and
the organisation's member list return it.

Core implements two modes. Its configuration accepts no other.

Before anyone is identified the app reads `GET /api/auth/config`. That
response names the mode.

An edition built on core may add a mode of its own by supplying an
identity provider
([Extension points](../architecture/extension-points.md)). A server in
a mode with no provider signs no one in (401).

| `AUTH_MODE` | Proof | Typical box |
| --- | --- | --- |
| `compat-cookie` | `X-Guilds-User` or `guilds_user` | Local Compose; the default |
| `trusted-header` | Proxy email header (`TRUSTED_HEADER_EMAIL`, default `X-Forwarded-Email`) + `X-Guilds-Proxy-Secret` | Behind the operator's own authenticating proxy |

On `compat-cookie`, whoever reaches the port is the operator.

- One user and no header selects that user.
- Several users and no header is 400.
- An unknown id is 404.

The UI boots from `GET /api/users`. It remembers the chosen id in
`localStorage`.

The user directory is:

- `GET /api/users`
- `POST /api/users` (a name and an optional `email`; creates the user
  plus a personal organisation)
- `PATCH /api/users/:id` (sets the `email`, or clears it with `null`)
- `DELETE /api/users/:id`

On `compat-cookie` it takes no current-user header. It answers whoever
reaches the box.

On `trusted-header` it answers the instance admin. It is 404 to anyone
else.

A mode an edition adds has no directory.

An email is stored trimmed and in lower case. Two users cannot hold the
same one (409).

On `trusted-header`, the reverse proxy exclusively determines the
email. The request's user is the one who holds it.

An email no user holds is 401. A header without `TRUSTED_PROXY_SECRET`
is also 401.

Boot gives the seeded operator the address in `OPERATOR_EMAIL`. The
mode does not start without that address. It refuses to start when
another user holds it.

The operator gives anyone else an account through the user directory
([Remote access](../getting-started/remote-access.md)).

## Organisations

```text
instance → organisation → guild → agent
```

Organisation is the ownership root. `org_members` carries an `owner`,
`admin`, or `member` role.

A new user gets a personal organisation with themselves as owner. It
stays visually implicit while it is the user's only membership.

Every new organisation, whichever path creates it, starts with one
`standard` machine named `default`. Its agents run on its machines;
a machine is never shared with another organisation
([Machines](guilds-and-agents.md#machines)).

Guild names are unique within an organisation. Agent names are
globally unique.

The selected organisation is `X-Guilds-Org` or `guilds_org`.

One membership and no header selects that organisation. Several
memberships and no header is 400.

Lists return that organisation's:

- visible guilds (org-visible plus the private guilds the current user
  operates)
- secrets
- connector logins

Cross-organisation reads and writes return 404.

Every member lists every secret of the organisation (metadata, never a
value). Owners and admins manage any secret and decide who gets it. A
member manages only secrets granted inside guilds they can see
([Secrets and access](secrets-and-access.md)).

Organisation routes:

- `GET /api/orgs`
- `POST /api/orgs` (`name`, `slug`; anyone on `compat-cookie`, the
  instance admin otherwise)
- `GET /api/orgs/:id`
- `PATCH /api/orgs/:id` (name, slug)
- members: `GET /api/orgs/:id/members`, `POST /api/orgs/:id/members`
  with `user_id` and `role`,
  `PATCH`/`DELETE /api/orgs/:id/members/:user_id`; owners change
  owners, admins the rest
- usage: `GET /api/usage` returns the current organisation's guilds
  the caller may see, by guild and agent
- machines: `GET /api/orgs/:id/machines` for members; `POST`,
  `PATCH`, and `DELETE` for owners and admins
  ([Machines](guilds-and-agents.md#machines))
- model providers: below

An organisation's limits come from the organisation policy:

- how many agents, browser agents, coding agents, and guilds it may
  hold
- how many machines it may hold (`maxMachines`), and how many agents
  one machine takes (`maxAgentsPerMachine`, never above 32)
- how many generations run at once

Core's policy sets none of them. The instance-wide ceiling on
concurrent generations is `MAX_CONCURRENT_GENERATIONS`
([Configure](../getting-started/configure.md)).

An edition may supply a policy of its own
([Extension points](../architecture/extension-points.md)).

## Model providers

An organisation connects a key per model provider, chooses the models
it offers from each, and names one default
([Orchestrator](../architecture/orchestrator.md#model-client)). A run
is `provider + credentials + model`; the server holds no key of its
own.

Per connected provider the organisation holds the key, encrypted as
every credential is (`api_key`, and `base_url` for the local
endpoint), the key's last characters, and the chosen model ids as
plain data. It holds one `default_model`, or none. Removing a key
removes the provider's row and its chosen models, and clears the
default when it was among them. A provider is **connected** when
credentials resolve for the organisation: in core, when a key is
saved.

- `GET /api/orgs/:id/models`, for every member: the organisation's
  `default`, its `providers` (`id`, `label`, `kind`, `connected`,
  `key_hint`, and `base_url` for the local endpoint), and its chosen
  `models` with their capacities (`thinking`, `temperature`,
  `attachments`, `context`, `price` per million tokens, `kind`,
  `coding_only`). Every picker reads this.
- `GET /api/orgs/:id/model-providers/:provider/catalog`, for every
  member: the provider's full catalog, or the local endpoint's live
  list once its URL is saved. Only Model keys reads this.
- `PUT /api/orgs/:id/model-providers/:provider`, for owners and
  admins: `api_key` (kept when left out on a connected provider),
  `base_url` for the local endpoint, and `models`, the chosen ids as
  `{provider}/{model}`. The key is probed with `GET {baseURL}/models`
  before the row is written; a rejected key answers 422.
- `PUT /api/orgs/:id/default-model`, for owners and admins: `model`,
  one of the chosen models on a connected marketplace provider, or
  null.
- `DELETE /api/orgs/:id/model-providers/:provider`, for owners and
  admins.

**Instance admin** is who administers the instance:

- the connector catalog
- instance-level access
- new organisations

Core's rule is an owner of the seed organisation `org_home`. An
edition may replace the rule.

The instance admin reaches:

- `/api/admin/mcp/*` (the connector catalog)
- `GET /api/platform` (the instance-level access view)
- the **Admin** entry in the account menu
  ([Operator app](operator-app.md))

Group chat snapshots the current user's name on each post. Agents see
it as the post's author.

A guild's operators
([Guilds and agents](guilds-and-agents.md#operators)) are tagged by
name. `@user` tags all of them. Neither selects an agent.

A user can be removed from an organisation, or deleted, only while
every guild they administer has another admin.

## Seed identity

On a box with no user at all, boot (`seedOperator`) inserts one user
row and the organisation it owns:

| Id | Name | Email | Image |
|---|---|---|---|
| `user_operator` | `operator` | none, or `OPERATOR_EMAIL` when it is set | none |

Organisation `org_home` (name `Home`, slug `home`) has `operator` as
the owner, and its `default` machine. That user has no second
personal organisation.

The seed user cannot be deleted.

Once the box has a user the seed never runs again. A renamed operator
or organisation keeps its name.

An edition that seeds its own first user before core looks gets no
operator.

A user has no portrait upload path. The account button shows initials.

## Delete

`DELETE /api/users/:id` refuses a seed user. It also refuses a user
who is the last owner of an organisation that still has guilds.

The UI has no delete control.

Deleting a user does not cascade organisation-owned data.

The instance usage view lists every organisation's lifetime totals. An
organisation's counter drops when that organisation is deleted. The
global total stays.
