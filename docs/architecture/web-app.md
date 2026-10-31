# Web app

The operator app is a single-page React app in `apps/web`. The
orchestrator serves its build at the site root, and the app talks to
the orchestrator's API on the same origin. It holds no durable state
of its own: it reads PostgreSQL through the API and follows changes
over server-sent events (SSE).

This page is the app as code. Which screen explains which concept is
the [Screen map](screen-map.md). Where each directory sits is the
[Code map](code-map.md#appsweb).

## Stack

- Vite
- React 19
- TypeScript
- Tailwind v4
- Radix primitives
- TanStack Router (routes are paths; a view inside a page is a search
  parameter)
- TanStack Query (every API read)
- the guilds.run design system, `@guildsrun/ui` in `packages/ui`
  ([Design system](design-system.md))

The same app serves a laptop or a phone.

## Build and serving

`pnpm --filter @guildsrun/web build` writes `apps/web/dist`. The
build splits React, TanStack, Radix, and the Markdown libraries into
chunks of their own, so they stay cached when the app changes. The
core image's `web` stage builds the app and Storybook, and copies
Storybook's build to `dist/storybook`.

The orchestrator serves the build at the site root
(`apps/orchestrator/src/http/web-app.ts`):

| Request | Answer |
|---|---|
| `/assets/…` (hashed files) | The file, cached as immutable for a year |
| Other files in the build | The file, `no-cache` |
| `/` | `index.html`, never cached |
| A browser page request (`GET` or `HEAD` accepting HTML) for any path outside the server's own (`/api/`, `/assets/`, `/avatars/`, `/health`, `/storybook`) | `index.html`, so the client router resolves the path |
| `/storybook` | The Storybook build at `dist/storybook`, when the image built it |
| Anything else not found | A JSON 404 |

Without a build, every page is a 404. An extension serves its own build
through `ServerExtension.webApp`
([Extension points](extension-points.md)).

`pnpm --filter @guildsrun/web dev` serves the app on
`http://127.0.0.1:5173/` and proxies `/api`, `/avatars`, and `/health`
(WebSockets included) to the orchestrator on `127.0.0.1:8080`.

## Boot

`src/main.tsx` imports `@guildsrun/ui/theme.css` and calls
`mount()` (`src/mount.tsx`) with no slot filled. `mount(slots)`:

1. installs the client error log
2. applies the stored theme (`src/app/theme.ts` writes `data-theme`
   on `<html>`)
3. records the extension's sign-in path, if any
4. renders `App` into `#root`, with React's error hooks reporting to
   the client error log

`App.tsx` mounts the theme, the query client, the slots,
`TooltipProvider`, and `Toaster`. It shows the extension's public
page when one owns the path, and otherwise resolves the operator and
organisation (`src/api/identity.ts`) before the router renders any
page.

The query client keeps data fresh for 15 s. A query that fails with a
4xx is not retried; any other failure is retried up to twice.

### How a page loads

Before any page renders, the app works out who the operator is and
which organisation they work in. Core has no sign-in page.

1. The app reads `GET /api/auth/config` to learn the identity mode
   ([Users](../concepts/users.md)).
2. On `compat-cookie`, it takes the stored user when that user is in
   `GET /api/users`, otherwise the first user, and remembers it in
   `localStorage`. With no user at all, the page says to seed one. On
   `trusted-header`, the proxy in front of the box has already said
   who the request is from.
3. Every mode then reads `GET /api/auth/me`. Its `platform_admin` flag
   shows the **Admin** entry.
4. The organisation is the stored one while the operator still belongs
   to it, otherwise the first from `GET /api/orgs`. An account with no
   organisation gets an error on the page.

Every API call (`src/api/client.ts`) carries the organisation as
`X-Guilds-Org`, the user as `X-Guilds-User` on `compat-cookie`, and
the tab's `X-Request-Id`. The `guilds_user` and `guilds_org` cookies
carry the user and organisation for event streams, which cannot send
headers.

A 401 outside `compat-cookie` mode goes to the extension's sign-in page
when it has one, returning to the same page afterwards. Without one
it is an error on the page.

While the organisation has no model provider connected, a welcome
dialog over every page gates the app until one is
([Model keys](../concepts/model-keys.md)).

## Routes

`src/app/router.tsx` holds every route. A path not in it shows the
not-found page (`features/home/NotFound.tsx`).

| Path | Page | Search parameters |
|---|---|---|
| `/` | Home: the last guild visited, or the first; with none, the empty state | |
| `/inbox` | Inbox | |
| `/settings` | Organisation settings | `tab`: `general`, `members`, `machines`, `keys`, `secrets`, `tools`, `usage`, or an extension's |
| `/admin` | Admin | `tab`: `catalog`, `instance`, `users` on the modes whose server serves a user directory, or an extension's |
| `/builder`, `/builder/$sessionId` | Builder landing and workspace | |
| `/recipes`, `/recipes/$recipeId` | Recipe library and recipe page | |
| `/recipes/$recipeId/apply` | Apply preview | |
| `/applies/$applyId` | Apply checklist | |
| `/studio` | Studio landing | `guild` |
| `/studio/$sessionId` | Studio workspace | `section`, `agent`, `tab`, `kind`, `item`, `call`, `seq`: the section (`guild`, `agents`, `state`, `tools`), the inspected or filtered agent, its tab or view, the kind of item listed, the item selected, and the run step to reveal. Without a known `section` it opens the guild |
| `/tables`, `/tables/$collectionId` | Tables | `tab`: `columns` or `access` (records without it) |
| `/guilds/$guildId` | Guild group chat | `seq`: open at that message |
| `/guilds/$guildId/settings` | Guild settings | |
| `/guilds/$guildId/state` | Opens Guild State › Notes | |
| `/guilds/$guildId/state/notes` | Guild State › Notes | `path`: open that note |
| `/guilds/$guildId/state/files` | Guild State › Files | `path`: open that file |
| `/guilds/$guildId/state/tables` | Guild State › Tables | |
| `/guilds/$guildId/state/access` | Guild State › Access | |
| `/guilds/$guildId/routines`, `…/issues`, `…/usage`, `…/tools`, `…/secrets` | Guild tabs | |
| `/guilds/$guildId/agents/$agentId` | Agent inspector, Chat tab | `run`: one session; with it `call` or `seq` for a step; `history=true` opens the History drawer |
| `/guilds/$guildId/agents/$agentId/state/files` | Agent State › Files | `path`: open that file |
| `…/agents/$agentId/prompt` | Agent Prompt tab | |
| `…/agents/$agentId/state` | Opens Agent State › Memory | |
| `…/agents/$agentId/state/memory`, `…/state/notes`, `…/state/tables`, `…/state/access`, `…/state/scripts` | Agent State sub-tabs | `path` on notes |
| `…/agents/$agentId/history` | Opens Chat with the History drawer | |
| `…/agents/$agentId/routine`, `…/browser`, `…/cli`, `…/tools`, `…/secrets`, `…/usage` | Agent tabs | |
| `…/agents/$agentId/settings` | Agent Settings | `section`: the open section (Identity without it) |

## Extension slots

An extension built on core may fill slots of the app. Core fills none of
them, and the app is whole without a slot. The slots are `AppSlots`
(`src/app/slots.ts`), passed to `mount(slots)`:

| Slot | What it adds |
|---|---|
| `publicPage` | A page for a path the extension owns, shown before identity loads |
| `signInPath` | Where a signed-out request goes to sign in |
| `signOut` | **Sign out** in the account menu |
| `settingsTabs`, `adminTabs` | Tabs on Settings and Admin, each placed after the core tab it names, or last |
| `shellBanners` | Notices above every page |
| `membersPanel` | A panel under the member list on Settings, Members |

[Extension points](extension-points.md) lists the server-side points
beside these.

`package.json` lists under `exports` what an extension's package may
import:

| Export | What it holds |
|---|---|
| `mount` | `mount(slots)` |
| `vite` | The build recipe, `appConfig()` in `vite.app.ts` |
| `app/slots` | `AppSlots` and the tab placement |
| `app/router` | The router and its routes |
| `app/identity` | The signed-in operator and organisation |
| `app/format` | Times, sizes, and costs as text, such as `formatCost` |
| `api/client` | The API client and its error |
| `api/session` | Who the app acts as, and the sign-in path |
| `api/types/<domain>` | The API types of one domain, one module per query module |
| `api/wire` | `JsonValue`, `JsonObject`, and the guards that narrow a server's reply, such as `isRecord` and `isJsonObject` |
| `features/agent/runs/toolFormat` | Tool-call formatting |
| `features/settings/members` | The member role helpers |

## State and events

The UI derives durable state from PostgreSQL through TanStack Query.

SSE carries transient deltas and newly committed rows
(`src/api/streams.ts`). The events are listed in
[Orchestrator](orchestrator.md#events).

| Stream | URL | What it keeps current |
|---|---|---|
| One per open guild | `/api/guilds/:id/group-chat/stream` | Chat, delivery state, issues, notes, files, Tasks and Memory, routines, and scripts |
| The inbox | `/api/notifications/stream` | The inbox and its badge, each guild's unread count, and the chime for a message posted where the operator is not looking |
| One per open run | `/api/runs/:id/stream` | The run transcript, the progress lines of its running tool calls, and the records its tools change |
| One per open Studio session | `/api/studio/sessions/:id/stream` | The coach chat and drafts |
| One per open Builder session | `/api/builder/sessions/:id/stream` | The coach chat and the recipe draft |

A dropped stream reconnects after one second, the inbox stream after
five. Each stream re-reads what it covers on every (re)connect, since
the server replays nothing, so a reload reconstructs the same chat
and the same resolved access view.

A run stream marks the run generating when `generation.started`
arrives, and streams reasoning and text into the transcript. Studio
and Builder streams do the same for the coach. While a run or a coach
generates, its data is also re-read every 2.5 s, in case the stream
falls silent.

A group message the operator sends while the agents it targets are
generating waits in a queue in the tab (`features/guild/messageQueue.ts`)
and posts when they finish. The queue lives in memory and is lost on
reload.

`src/api/clientLog.ts` reports uncaught errors, unhandled rejections,
React render errors, and API calls that fail with a 5xx or on the
network to `POST /api/client-errors`, deduplicated for 30 s and capped
at 10 a minute.

### Browser storage

`localStorage` holds:

| Key | What it keeps |
|---|---|
| `guilds-user-id`, `guilds-org-id` | The operator's user and organisation |
| `guilds-theme` | The theme, when it is not `system` |
| `guilds-desktop-notifications` | Whether desktop notifications are wanted |
| `guilds-last-guild` | The last guild visited, which `/` opens |
| `guilds-guilds-collapsed` | The guilds the sidebar folds |
| `guilds-rail-retracted` | Whether the sidebar is retracted to the rail |
| `guilds-agent-view-mode` | Whether the agent inspector opens full or as a modal |
| `guilds-setup-dismissed:<agent id>:browser-login` | A browser login marked done |
| `studio.split`, `builder.split` | The Studio and Builder splits |
| `studio.activity.hours`, `studio.activity.tab` | The Studio activity window and its view |
| `studio.state.hours`, `studio.tools.hours` | The Studio State and Tools windows |

Every read and write tolerates storage being unavailable; the cookies
still carry the user and organisation.

`sessionStorage` holds the tab's request id (`guilds-request-id`)
and the pin a new Studio session opens with: its focus and the
question it offers (`studio-pin:<session id>`).

## Design system

The app imports `@guildsrun/ui` and `@guildsrun/ui/theme.css`. Pages
import components from the package barrel
([Design system](design-system.md)).

## Code paths

| Path | What it holds |
|---|---|
| `apps/web/src/main.tsx`, `index.html` | Entry: mounts the app with no slot filled |
| `apps/web/src/mount.tsx` | `mount(slots)` |
| `apps/web/src/app/App.tsx` | Providers and the identity boot |
| `apps/web/src/app/router.tsx` | Every route |
| `apps/web/src/app/slots.ts` | `AppSlots` and tab placement |
| `apps/web/src/app/theme.ts` | Theme preference and `data-theme` |
| `apps/web/src/app/storage.ts` | Browser storage reads and writes that tolerate its absence |
| `apps/web/src/api/` | API client, identity, session storage, streams, client log |
| `apps/web/src/api/wire.ts` | The JSON value type and the guards that narrow what the server sends |
| `apps/web/src/api/types/` | The shapes of the API's JSON and the records its calls send, one type module per domain, named as the query modules are |
| `apps/web/src/api/queries/` | Every API read and write as a TanStack Query hook, with its query keys, one module per domain: `guilds` (with their repositories and operators), `agents` (with their harnesses and the machines they run on), `scripts`, `chat` (the group chat and the inbox), `issues`, `schedules`, `runs`, `notes` (notes, Tasks, Memory, embeds, and file changes), `files`, `tables`, `access` (tools, logins, access lists, reach, and a GitHub login's repositories), `secrets`, `admin` (the instance, the catalog, the registry, and the users), `org` (members, profile, and usage), `models`, `recipes` (with the registry and their applies), `studio`, `builder`. A module imports another's keys to refresh what a write changes there |
| `apps/web/src/features/` | One directory per area of the app |
| `apps/web/vite.app.ts` | Build and dev-server configuration, shared with an extension's package |
| `apps/orchestrator/src/http/web-app.ts` | Serving the build and the page fallback |
