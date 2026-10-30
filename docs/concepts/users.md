# Users

A user is an account on the box: one person, with a name others tag
them by. A user belongs to one or more
[organisations](organisations.md) as a member. In a guild the user
works for, the user is an [operator](operators.md).

How a request becomes a user depends on the box's authentication
mode. Core has two. On a local box, whoever reaches the port picks a
user. Behind an authenticating proxy, the proxy says who the request
is from. One role on the box, the **instance admin**, administers the
box itself.

## Why it exists

Agents and people share a guild's group chat. Each post needs an
author, each tag needs a person to reach, and each organisation needs
to know who may change it. A user gives every person one name, one
colour, and one timezone across every organisation they belong to.

## How it works

### Identity

A user has:

- a name, unique on the box. It is the `@name` agents and other
  operators tag. Group chat snapshots it on each post
  ([Group chat](group-chat.md)).
- an optional email. Behind a proxy, the email is how the box knows
  the user.
- an optional timezone. New random-window routines start in it
  ([Routines](routines.md)).
- an optional identity colour. It tints the person's messages and
  avatar.
- an optional image. Core never sets one, so the account button shows
  initials. An image an extension sets shows in their place.

The name `user` is reserved: `@user` is the group-chat tag for every
operator of a guild.

### Authentication modes

| Mode | Who the request is from | Typical box |
|---|---|---|
| `compat-cookie` | Whoever reaches the port picks a user | Local Compose; the default |
| `trusted-header` | The email sent by an authenticating proxy that the person who runs the box sets up | A box reached from other computers ([Remote access](../operations/remote-access.md)) |

On `compat-cookie`, whoever reaches the port is trusted. With one
user on the box, that user is picked. With several, the app asks
which one and remembers the choice in the browser.

On `trusted-header`, the reverse proxy alone determines the email.
The request's user is the one who holds that email. The proxy also
proves itself with a shared secret. Everyone else gets an account
from **Admin**, **Users**.

An extension built on core may add a mode of its own by supplying an
identity provider
([Extension points](../architecture/extension-points.md)).

### The seed identity

A box with no user at all starts with one: the user `operator`, owner
of the organisation **Home**. Once the box has a user, the seed never
runs again. A renamed seed user or organisation keeps its new name.

### The instance admin

The instance admin administers the box, not one organisation: the
connector catalog, the platform keys, instance-level access, and new
organisations. They work from the **Admin** page
([Instance admin](instance-admin.md)).

In core, an instance admin is an owner of the seed organisation
**Home**. An extension may replace the rule.

### Deleting a user

A user is deleted from the user directory. The app has no delete
control. Deleting refuses the seed user, a user who is the last owner
of an organisation that still has other members or guilds, and a user
who is the only admin of a guild.

Deleting a user removes their memberships, and any organisation left
with no member and no guild. Data the organisations own stays.

## In the app

### The account menu

The account button at the foot of the sidebar shows the user's name
and organisation. Its menu:

- switches organisation when the user has several memberships
  ([Organisations](organisations.md))
- sets the theme: **Match system**, **Light**, or **Dark**
- turns **Desktop notifications** on or off for this browser, when
  the browser supports them. Turning them on asks the browser's
  permission ([Group chat](group-chat.md#in-the-app))
- offers **Settings**, and **Admin** for the instance admin only

An extension that signs people in adds **Sign out** here.

### Settings, General, You

**Settings**, **General** opens on the user's own profile:

- **Name**: the `@name` agents and other operators tag. It has its
  own **Save**.
- **Your colour**: one of the six identity colours, or none. A click
  saves it. With none, the user's messages are plum.
- **Timezone**: new random-window routines start in it. It has its
  own **Save**. Unset, the hint says new routines use the browser's
  timezone.

The rest of the tab belongs to the organisation
([Organisations](organisations.md)).

### The Users tab

**Admin**, **Users** shows on `compat-cookie` and `trusted-header`
only. It lists every account on the box with its email, or **No
email**. **New user** takes a name and an optional email, and creates
the user with their personal organisation. The pencil on a row sets
or clears that user's email. To work in another organisation, the
user is added to it by name in its **Settings**, **Members**
([Organisations](organisations.md)).

## Rules and limits

| Rule | Value or behaviour |
|---|---|
| Name | Lowercase letter first, then lowercase letters, digits, and hyphens; 63 characters at most |
| Reserved name | `user` |
| Name taken | Refused |
| Email | Optional, stored trimmed and in lower case, one user per email |
| Colour | A 6-digit hex, or none |
| Timezone | An IANA name, or none |
| Default mode | `compat-cookie` |
| Seed user | Created only on a box with no user; cannot be deleted |
| Instance admin in core | An owner of **Home** |
| Delete | Refused for the seed user, the last owner of an organisation with other members or guilds, and the only admin of a guild |

## Reference

### Fields

The `users` table:

| Column | Meaning |
|---|---|
| `id` | The user id |
| `name` | Unique (`users_name_key`). The server checks `^[a-z][a-z0-9-]{0,62}$` and refuses `user` |
| `email` | Optional. Unique without regard to case (`users_email_lower_unique`) |
| `image` | Optional image path |
| `timezone` | Optional IANA name |
| `color` | Optional, `^#[0-9a-f]{6}$` |
| `created_at`, `updated_at` | Timestamps |

Code: `apps/orchestrator/src/users/index.ts`.

### Current user

- `GET /api/auth/config` is read before anyone is identified. It
  returns `{ mode }`, plus what an identity provider's sign-in page
  needs.
- `GET /api/auth/me` returns the user with `platform_admin`, true
  for the instance admin. The app shows **Admin** from it.
- `PATCH /api/auth/me` takes `name`, `timezone`, `color`, or any of
  them. `name` is a string; `timezone` and `color` are a string or
  `null`. A field of another type is 422. A field left out keeps
  its value. A body with none of the three is 422. An invalid name,
  colour, or timezone is 422. A name another user holds is 409. The
  name is trimmed. The colour is stored in lower case. A new name is
  not checked against the agents of the guilds the user operates.

`/api/auth/me` and the organisation's member list return the colour.
The Routine tab pre-fills random windows with the timezone and falls
back to the browser's.

### Modes

`AUTH_MODE` selects the mode. Core's configuration accepts
`compat-cookie` and `trusted-header`, and an extension's own modes.
Code: `apps/orchestrator/src/http/identity.ts`.

| `AUTH_MODE` | Proof | Typical box |
| --- | --- | --- |
| `compat-cookie` | `X-Guilds-User` or `guilds_user` | Local Compose; the default |
| `trusted-header` | Proxy email header (`TRUSTED_HEADER_EMAIL`, default `X-Forwarded-Email`) + `X-Guilds-Proxy-Secret` | Behind an authenticating proxy |

A server in a mode with no provider signs no one in (401).

On `compat-cookie`:

- One user and no header selects that user.
- Several users and no header is 400.
- An unknown id is 404.

The UI boots from `GET /api/users` and remembers the chosen id in
`localStorage`.

On `trusted-header`:

- An `X-Guilds-Proxy-Secret` that does not equal
  `TRUSTED_PROXY_SECRET` is 401.
- A missing email header is 401.
- An email no user holds is 401.
- The mode does not start without `TRUSTED_PROXY_SECRET`,
  `PUBLIC_BASE_URL`, and `OPERATOR_EMAIL`.

### User directory

- `GET /api/users`
- `POST /api/users`: a string `name` and an optional `email`, a
  string or `null`. It creates the
  user plus a personal organisation whose name and slug are the
  user's name, with its `default` machine. 201. An invalid name or
  email is 422. A name or email already taken is 409. A name that is
  already an organisation's slug is also 409, with the message `user
  name already exists`.
- `PATCH /api/users/:id`: sets the `email`, or clears it with `null`.
  A body without `email` is 422. 404 for an unknown user.
- `DELETE /api/users/:id`: 204. 404 for an unknown user. 400 for the
  seed user. 409 for the last owner of an organisation that still has
  other members or guilds. 409 for the only admin of a guild.

Who reaches the directory:

- On `compat-cookie` it takes no current-user header. It answers
  whoever reaches the box.
- On `trusted-header` it answers the instance admin. It is 404 to
  anyone else.
- A mode an extension adds has no directory (404).

### Seed identity

On a box with no user at all, boot (`seedOperator`,
`apps/orchestrator/src/seed/operator.ts`) inserts one user row and
the organisation it owns:

| Id | Name | Email | Image |
|---|---|---|---|
| `user_operator` | `operator` | none, or `OPERATOR_EMAIL` when it is set | none |

Organisation `org_home` (name `Home`, slug `home`) has `operator` as
the owner, and its `default` machine. That user has no second
personal organisation.

When `OPERATOR_EMAIL` is set, each boot gives the seed user that
address. Boot refuses to start when another user holds it.

An extension that seeds its own first user before core looks gets no
seed user.

### Instance admin

`isInstanceAdmin` (`apps/orchestrator/src/http/instance-admin.ts`):
in core, an owner of `org_home`. An extension may replace the rule. The
routes it opens are on [Instance admin](instance-admin.md#routes).

### Delete

`DELETE /api/users/:id` removes the user row. Their organisation
memberships go with it, and with them their guild operator rows.
Every organisation left with no member and no guild is deleted in the
same transaction. The delete check looks only at organisations that
have guilds. An organisation with other members and no guilds can be
left with no owner.
