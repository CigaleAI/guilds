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

Without a build, every page is a 404. An edition serves its own build
through `ServerExtension.webApp`
([Extension points](extension-points.md)).

`pnpm --filter @guildsrun/web dev` serves the app on
`http://127.0.0.1:5173/` and proxies `/api`, `/avatars`, and `/health`
(WebSockets included) to the orchestrator on 8080.

## Boot

`src/main.tsx` imports `@guildsrun/ui/theme.css` and calls
`mount()` (`src/mount.tsx`) with no slot filled. `mount(slots)`:

1. installs the client error log
2. applies the stored theme (`src/app/theme.ts` writes `data-theme`
   on `<html>`)
3. records the edition's sign-in path, if any
4. renders `App` into `#root`, with React's error hooks reporting to
   the client error log

`App.tsx` mounts the query client, the slots, `TooltipProvider`, and
`Toaster`. It shows the edition's public page when one owns the path,
and otherwise resolves the operator and organisation
(`src/api/identity.ts`) before the router renders any page.

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

A 401 outside `compat-cookie` mode goes to the edition's sign-in page
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
| `/settings` | Organisation settings | `tab`: `general`, `members`, `machines`, `keys`, `secrets`, `tools`, `usage`, or an edition's |
| `/admin` | Admin | `tab`: `catalog`, `instance`, `users` on the modes whose server serves a user directory, or an edition's |
| `/builder`, `/builder/$sessionId` | Builder landing and workspace | |
| `/recipes`, `/recipes/$recipeId` | Recipe library and recipe page | |
| `/recipes/$recipeId/apply` | Apply preview | |
| `/applies/$applyId` | Apply checklist | |
| `/studio` | Studio landing | `guild` |
| `/studio/$sessionId` | Studio workspace | `section`, `agent`, `tab`, `kind`, `item`, `call`, `seq`: the section (`guild`, `agents`, `state`, `tools`), the inspected or filtered agent, its tab or view, the kind of item listed, the item selected, and the run step to reveal. Without a known `section` it opens the guild |
| `/tables`, `/tables/$collectionId` | Tables | `tab`: `columns` or `access` (records without it) |
| `/guilds/$guildId` | Guild group chat | `seq`: open at that message |
| `/guilds/$guildId/settings` | Guild settings | |
| `/guilds/$guildId/state/notes` | Guild State › Notes | `path`: open that note |
| `/guilds/$guildId/state/files` | Guild State › Files | `path`: open that file |
| `/guilds/$guildId/state/tables` | Guild State › Tables | |
| `/guilds/$guildId/state/access` | Guild State › Access | |
| `/guilds/$guildId/routines`, `…/issues`, `…/usage`, `…/tools`, `…/secrets` | Guild tabs | |
| `/guilds/$guildId/agents/$agentId` | Agent inspector, Chat tab | `run`: one session; with it `call` or `seq` for a step; `history=true` opens the History drawer |
| `/guilds/$guildId/agents/$agentId/state/files` | Agent State › Files | `path`: open that file |
| `…/agents/$agentId/prompt` | Agent Prompt tab | |
| `…/agents/$agentId/state/memory`, `…/state/notes`, `…/state/tables`, `…/state/access`, `…/state/scripts` | Agent State sub-tabs | `path` on notes |
| `…/agents/$agentId/history` | Opens Chat with the History drawer | |
| `…/agents/$agentId/routine`, `…/browser`, `…/cli`, `…/tools`, `…/secrets`, `…/usage` | Agent tabs | |
| `…/agents/$agentId/settings` | Agent Settings | `section`: the open section (Identity without it) |

## Extension slots

An edition built on core may fill slots of the app. Core fills none of
them, and the app is whole without a slot. The slots are `AppSlots`
(`src/app/slots.ts`), passed to `mount(slots)`:

| Slot | What it adds |
|---|---|
| `publicPage` | A page for a path the edition owns, shown before identity loads |
| `signInPath` | Where a signed-out request goes to sign in |
| `signOut` | **Sign out** in the account menu |
| `settingsTabs`, `adminTabs` | Tabs on Settings and Admin, each placed after the core tab it names, or last |
| `shellBanners` | Notices above every page |
| `membersPanel` | A panel under the member list on Settings, Members |

[Extension points](extension-points.md) lists the server-side points
beside these.

`package.json` lists under `exports` what an edition's package may
import: `mount`, the slots, the router, the build recipe
(`appConfig()` in `vite.app.ts`), the API client, session, and
types, identity, formatting, tool-call formatting
(`features/agent/runs/toolFormat`), and the member role helpers
(`features/settings/members`).

## State and events

The UI derives durable state from PostgreSQL through TanStack Query.

SSE carries transient deltas and newly committed rows
(`src/api/streams.ts`). The events are listed in
[Orchestrator](orchestrator.md#events).

| Stream | URL | What it keeps current |
|---|---|---|
| One per open guild | `/api/guilds/:id/group-chat/stream` | Chat, delivery state, issues, notes and records, routines, and scripts |
| The inbox | `/api/notifications/stream` | The inbox and its badge, each guild's unread count, and the chime for a message posted where the operator is not looking |
| One per open run | `/api/runs/:id/stream` | The run transcript |
| One per open Studio session | `/api/studio/sessions/:id/stream` | The coach chat and drafts |
| One per open Builder session | `/api/builder/sessions/:id/stream` | The coach chat and the recipe draft |

A dropped stream reconnects after one second. Each stream re-reads
what it covers on every (re)connect, since the server replays
nothing, so a reload reconstructs the same chat and the same resolved
access view.

A run stream marks the run generating when `generation.started`
arrives, and streams reasoning and text into the transcript. Studio
and Builder streams do the same for the coach, and while the coach
works their session and messages are also re-read every 2.5 s.

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

- the operator's user and organisation (`guilds-user-id`,
  `guilds-org-id`)
- the theme (`guilds-theme`)
- whether desktop notifications are wanted
  (`guilds-desktop-notifications`)
- view preferences: folded guilds, the retracted sidebar, the agent
  inspector's size, the Studio and Builder splits, the activity
  window, the last guild visited, and browser logins marked done

Every read and write tolerates storage being unavailable; the cookies
still carry the user and organisation.

`sessionStorage` holds the tab's request id (`guilds-request-id`)
and a new Studio session's pinned issue.

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
| `apps/web/src/api/` | API client, identity, session storage, streams, client log |
| `apps/web/src/features/` | One directory per area of the app |
| `apps/web/vite.app.ts` | Build and dev-server configuration, shared with an edition's package |
| `apps/orchestrator/src/http/web-app.ts` | Serving the build and the page fallback |
