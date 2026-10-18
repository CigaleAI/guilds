# Web app

The operator app is a single-page React app in `apps/web`. The
orchestrator serves its build at the site root, and the app talks to
the orchestrator's API on the same origin. It holds no durable state
of its own: it reads PostgreSQL through the API and follows changes
over server-sent events (SSE).

Screens and what they do are in [Operator app](../concepts/operator-app.md).
This page is the app as code. The [code map](code-map.md) lists its
directories and every route.

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
core image's `web` stage builds the app and Storybook.

The orchestrator serves the build at the site root
(`apps/orchestrator/src/http/web-app.ts`):

| Request | Answer |
|---|---|
| `/assets/…` (hashed files) | The file, cached as immutable for a year |
| Other files in the build | The file, `no-cache` |
| `/` | `index.html`, never cached |
| A browser page request (`GET` or `HEAD` accepting HTML) for any path outside the server's own (`/api/`, `/assets/`, `/avatars/`, `/health`, `/storybook`) | `index.html`, so the client router resolves the path |
| `/storybook` | The Storybook build at `dist/storybook` |
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
4. renders `App` into `#root`

`App.tsx` mounts the query client, the slots, `TooltipProvider`, and
`Toaster`. It shows the edition's public page when one owns the path,
and otherwise resolves the operator and organisation
(`src/api/identity.ts`) before the router renders any page. How a page
load picks the user and organisation is in
[Operator app](../concepts/operator-app.md#how-a-page-loads).

The query client keeps data fresh for 15 s. A query that fails with a
4xx is not retried; any other failure is retried up to twice.

Every API call (`src/api/client.ts`) carries `X-Request-Id` and the
identity headers. A 401 outside `compat-cookie` mode goes to the
edition's sign-in page when it has one, returning to the same page
afterwards; without one it is an error on the page.

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

## State and events

The UI derives durable state from PostgreSQL through TanStack Query.

SSE carries transient deltas and newly committed rows
(`src/api/streams.ts`):

| Stream | URL | What it keeps current |
|---|---|---|
| One per open guild | `/api/guilds/:id/group-chat/stream` | Chat, delivery state, issues, files, routines, and scripts |
| The inbox | `/api/notifications/stream` | The inbox and its badge, each guild's unread count, and the chime for a message posted where the operator is not looking |
| One per open run | `/api/runs/:id/stream` | The run transcript |
| One per open Studio session | `/api/studio/sessions/:id/stream` | The coach chat and drafts |
| One per open Builder session | `/api/builder/sessions/:id/stream` | The coach chat and the recipe draft |

`EventSource` cannot send headers, so streams identify the user and
organisation with the `guilds_user` and `guilds_org` cookies. A
dropped stream reconnects after one second. Each stream re-reads what
it covers on every (re)connect, since the server replays nothing, so
a reload reconstructs the same chat and the same resolved access view.

A run stream marks the run generating when `generation.started`
arrives, and streams reasoning and text into the transcript. Studio
and Builder streams do the same for the coach, and while the coach
works their session and messages are also re-read every 2.5 s.

Every API call carries the tab's `X-Request-Id`, kept in
`sessionStorage` as `guilds-request-id`, so server logs line up with
the tab's reports.

`src/api/clientLog.ts` reports uncaught errors, unhandled rejections,
React render errors, and API calls that fail with a 5xx or on the
network to `POST /api/client-errors`, deduplicated for 30 s and capped
at 10 a minute.

### Browser storage

`localStorage` holds the operator's user and organisation
(`guilds-user-id`, `guilds-org-id`), the theme (`guilds-theme`),
whether desktop notifications are wanted
(`guilds-desktop-notifications`), and view preferences: folded
guilds, the retracted sidebar, the agent inspector's size, the Studio
and Builder splits, the activity window, the last guild visited, and
browser logins marked done. Every read and
write tolerates storage being unavailable; the cookies still carry the
user and organisation.

`sessionStorage` holds the tab's request id and a new Studio session's
pinned issue.

## Design system

The app imports `@guildsrun/ui` and `@guildsrun/ui/theme.css`
([Design system](design-system.md)). Pages import components from the
package barrel. The instance serves the component catalogue at
[`/storybook`](/storybook), and the documentation site serves the same
build at that path.

`apps/web/claude-design-export/` holds the first Claude Design export
(`guilds.run Design System.dc.html`, `guilds.run Screens.dc.html`,
`support.js`). Those files are not the live library.

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
