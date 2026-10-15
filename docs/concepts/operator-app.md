# Operator app

The operator app is the web page where operators work with guilds.run: they
create guilds and agents, talk to them, and watch and change what they
do. Its title is guilds.run. The orchestrator serves it at the site
root, and the same app works on a laptop or a phone.

This page is a map. It covers what belongs to the whole app: its
routes, how a page loads who you are, and how text renders. Each
screen is explained on the page of the concept it shows; the table at
the end points there. How the app is built is in
[Web app](../architecture/web-app.md).

## Routes

Every screen has a path, so a link opens the same screen:

- `/inbox`
- `/guilds/<id>` and its pages
- `/guilds/<id>/agents/<id>` and its tabs
- `/studio`
- `/builder`
- `/recipes`
- `/applies/<id>`
- `/databases/<collection id>`
- `/settings`
- `/admin`

A view inside a page is a search parameter (`?tab=…`, `?run=…`,
`?seq=…`).

`/` opens the last guild visited, or the first. With none, it offers
**Create a guild** or the **Builder**.

The [code map](../architecture/code-map.md) lists every route.

## How a page loads

Before any page renders, the app works out who the operator is and
which organisation they work in. Core has no sign-in page.

1. The app reads `GET /api/auth/config` to learn the identity mode
   ([Users](users.md)).
2. On `compat-cookie`, it takes the stored user when that user is in
   `GET /api/users`, otherwise the first user, and remembers it in
   `localStorage`. With no user at all, the page says to seed one. On
   `trusted-header`, the proxy in front of the box has already said
   who the request is from.
3. Every mode then reads `GET /api/auth/me`. Its `platform_admin` flag
   shows the **Admin** entry. A 401 is an error on the page, unless an
   edition supplies a sign-in page, which the app opens instead.
4. The organisation is the stored one while the operator still belongs
   to it, otherwise the first from `GET /api/orgs`. An account with no
   organisation gets an error on the page.

Requests carry the organisation as `X-Guilds-Org`, and the user as
`X-Guilds-User` on `compat-cookie`. The `guilds_user` and `guilds_org`
cookies carry both for event streams, which cannot send headers.

While the organisation has no model provider connected, a welcome
dialog over every page gates the app until one is
([Model keys](model-keys.md)).

## Markdown

Messages, notes, Tasks, and instructions render as GitHub Markdown
that keeps single line breaks. `![[…]]` embeds and tagged handles show
as chips. Code blocks show their language and a copy button.

## Screens

| Screen | Route | Explained in |
|---|---|---|
| Welcome dialog | over every page | [Model keys](model-keys.md) |
| Home | `/` | this page, [Routes](#routes) |
| Sidebar: guild rows | every page | [Guilds](guilds.md) |
| Sidebar: agent rows and **Add agent** | every page | [Agents](agents.md) |
| Sidebar: account menu (switch organisation, theme, **Settings**, **Admin**, **Sign out**) | every page | [Organisations](organisations.md), [Users](users.md) |
| **Create guild** dialog | from the sidebar | [Guilds](guilds.md) |
| **Create an agent**: choice of agent or coding agent | from **Add agent** | [Agents](agents.md) |
| **Create an agent** (Identity, Model, Machine) | from **Add agent** | [Agents](agents.md), [Machines](machines.md), [Agent home](agent-home.md) for **Disk** |
| **Create a coding agent** (Identity, Machine, Harness, Lead model, Repositories) | from **Add agent** | [Coding agents](coding/index.md), [Harnesses](coding/harnesses.md), [Repositories](coding/repositories.md) |
| Guild header and options menu | `/guilds/<id>` | [Guilds](guilds.md) |
| Guild message-budget button | `/guilds/<id>` | [Group chat](group-chat.md) |
| Open recipe apply strip | `/guilds/<id>` | [Applying recipes](applying-recipes.md) |
| Guild **Group chat** tab | `/guilds/<id>` | [Group chat](group-chat.md) |
| Guild **Settings** tab | `/guilds/<id>/settings` | [Guilds](guilds.md) |
| Guild Settings: **Operators** | `/guilds/<id>/settings` | [Operators](operators.md) |
| Guild Settings: **Commit author email**, **Repositories** | `/guilds/<id>/settings` | [Repositories](coding/repositories.md) |
| Guild **State › Files** | `/guilds/<id>/state/files` | [Notes](notes.md) |
| Guild **State › Databases** | `/guilds/<id>/state/databases` | [Collections](collections.md) |
| Guild **State › Artifact scope** | `/guilds/<id>/state/artifacts` | [Notes](notes.md), [Access](access.md) |
| Guild **Routines** tab | `/guilds/<id>/routines` | [Routines](routines.md) |
| Guild **Issues** tab | `/guilds/<id>/issues` | [Operators](operators.md) |
| Guild **Tools** tab | `/guilds/<id>/tools` | [Access](access.md) |
| Guild **Secrets** tab | `/guilds/<id>/secrets` | [Secrets](secrets.md) |
| Guild **Usage** tab | `/guilds/<id>/usage` | [Usage](usage.md) |
| Agent inspector header and menu | `/guilds/<id>/agents/<id>` | [Agents](agents.md) |
| Coding readiness warning | agent inspector | [Coding agents](coding/index.md) |
| **Browser login needed** strip | agent inspector | [Browser](browser.md) |
| Agent **Chat** tab: transcript, run flow, attachments, **Resume** | `/guilds/<id>/agents/<id>` (`?run=…`) | [Runs](runs.md) |
| Chat session drawer | `/guilds/<id>/agents/<id>/history` (`?history=true`) | [Runs](runs.md) |
| Chat coding strip | agent **Chat** tab | [Coding agents](coding/index.md) |
| Chat `code_task` row and **Changes** panel | agent **Chat** tab | [Code tools](coding/code-tools.md), [Reviewing changes](coding/reviewing-changes.md) |
| Chat secret request card | agent **Chat** tab | [Runs](runs.md), [Secrets](secrets.md) |
| Agent **Prompt** tab | `/guilds/<id>/agents/<id>/prompt` | [Task](task.md) |
| Agent **State › Memory** | `/guilds/<id>/agents/<id>/state/memory` | [Memory](memory.md) |
| Agent **State › Notes** | `/guilds/<id>/agents/<id>/state/notes` | [Notes](notes.md) |
| Agent **State › Databases** | `/guilds/<id>/agents/<id>/state/databases` | [Collections](collections.md) |
| Agent **State › Scripts** | `/guilds/<id>/agents/<id>/state/scripts` | [Scripts](scripts.md) |
| Agent **State › Artifact scope** | `/guilds/<id>/agents/<id>/state/artifacts` | [Notes](notes.md), [Access](access.md) |
| Agent **Routine** tab | `/guilds/<id>/agents/<id>/routine` | [Routines](routines.md) |
| Agent **Browser** tab | `/guilds/<id>/agents/<id>/browser` | [Browser](browser.md) |
| Agent **CLI** tab | `/guilds/<id>/agents/<id>/cli` | [Agent home](agent-home.md) |
| Agent **Tools** tab | `/guilds/<id>/agents/<id>/tools` | [Access](access.md) |
| Agent **Secrets** tab | `/guilds/<id>/agents/<id>/secrets` | [Secrets](secrets.md) |
| Agent **Usage** tab | `/guilds/<id>/agents/<id>/usage` | [Usage](usage.md), [Agent home](agent-home.md) for disk |
| Agent **Settings**: **Identity**, **Model** / **Lead model** | `/guilds/<id>/agents/<id>/settings` (`?section=identity`, `model`) | [Agents](agents.md) |
| Agent Settings: **Machine** | `?section=machine` | [Machines](machines.md) |
| Agent Settings: **Harness** | `?section=harness` | [Harnesses](coding/harnesses.md) |
| Agent Settings: **Repositories** | `?section=repositories` | [Repositories](coding/repositories.md) |
| Access view (Tools and Secrets, at organisation, guild, and agent) | Settings, guild, and agent tabs | [Access](access.md), [Secrets](secrets.md) |
| **Inbox** | `/inbox` | [Operators](operators.md) |
| **Databases** | `/databases`, `/databases/<collection id>` | [Collections](collections.md) |
| Settings › **General** | `/settings` | [Organisations](organisations.md) |
| Settings › **Members** | `/settings?tab=members` | [Organisations](organisations.md) |
| Settings › **Machines** | `/settings?tab=machines` | [Machines](machines.md) |
| Settings › **Model keys** | `/settings?tab=keys` | [Model keys](model-keys.md) |
| Settings › **Secrets** | `/settings?tab=secrets` | [Secrets](secrets.md) |
| Settings › **Tools** | `/settings?tab=tools` | [Access](access.md) |
| Settings › **Usage** | `/settings?tab=usage` | [Usage](usage.md) |
| Admin › **Connector catalog** | `/admin` | [Users](users.md), [Registry](../tools-and-connectors/registry.md) |
| Admin › **Platform keys** | `/admin?tab=instance` | [Users](users.md), [Configure](../getting-started/configure.md#platform-keys) |
| **Studio** landing and workspace | `/studio`, `/studio/<session id>` | [Prompt Studio](prompt-studio.md) |
| **Builder** landing and workspace | `/builder`, `/builder/<session id>` | [Guild builder](guild-builder.md) |
| **Recipes** library and recipe page | `/recipes`, `/recipes/<id>` | [Recipes](recipes.md) |
| Apply preview and apply checklist | `/recipes/<id>/apply`, `/applies/<apply id>` | [Applying recipes](applying-recipes.md) |
