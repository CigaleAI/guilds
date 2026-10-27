# Design system

The guilds.run visual language is the `@guildsrun/ui` workspace
package in `packages/ui`. The operator app (`apps/web`) and an
extension's build of it import that package.

Tokens live in CSS. Components are the barrel at
`packages/ui/src/index.ts`. Theme is `data-theme="light"` or
`data-theme="dark"` on `<html>`, never a `dark` class.

The catalogue is Storybook. A running instance serves it at
`/storybook` when the image built it. `pnpm storybook` at the repo
root serves it at `http://127.0.0.1:6006/`. Open Foundations before
inventing a colour or type size. Off-token colours have no Tailwind utilities.
The theme clears the default palette.

## Package

| Export | What it is |
| --- | --- |
| `@guildsrun/ui` | React components, `cn`, identity and status maps |
| `@guildsrun/ui/theme.css` | Tailwind v4 entry: fonts, tokens, motion, `@theme` |
| `@guildsrun/ui/tokens.css` | Brand and semantic CSS variables only |

The barrel is a client module (`"use client"`). Peer dependencies
are React 19 and React DOM 19. The package also uses Radix,
Lucide, `class-variance-authority`, and Tailwind v4.

A consumer depends on `@guildsrun/ui` with `workspace:*`. That
covers the operator app in this repository, and an extension's
operator app from a workspace that spans core's packages
([Extension points](extension-points.md)). The package is private
and unpublished.

| Path | Role |
| --- | --- |
| `src/tokens.css` | Brand constants and semantic colour and elevation tokens; each theme redefines the semantic ones |
| `src/theme.css` | Tailwind theme: colours, the 11-step type scale, nine radii, three shadows; `type-*` text styles; `dark:` and `selected:` variants |
| `src/motion.css` | Overlay enter/exit keyed on Radix `data-state`, and the skeleton pulse; reduced motion makes them instant |
| `src/cn.ts` | Class merging that knows the token scales |
| `src/tones.ts` | Status fills and wake outcomes |
| `src/identity.ts` | Six-colour identity palette for agents and people |
| `src/primitives/` | Surface, Card, Bubble, Text, Icon, Mark, Pill, Tag, Track, Field, Tile, Dot, Divider, Kbd, Row |
| `src/components/` | Composed components by area: actions, controls, identity, navigation, conversation, runs, overlays, feedback, data, content, blocks |
| `src/foundations/` | Storybook boards for colour, type, space, radius, elevation, icons |
| `.storybook/` | Storybook config |

## Theme

One CSS entry loads the system. Set `data-theme` on `<html>`.
Fonts (Manrope Variable for people, JetBrains Mono for machine
text) load from the kit. A consumer does not add a second pair of
body fonts.

The operator app does this in `apps/web/src/main.tsx` (`import
"@guildsrun/ui/theme.css"`) and `apps/web/src/app/theme.ts`
(preference in localStorage, applied as `data-theme` on
`document.documentElement`).

An extension's app names the core app's sources in its own CSS entry
so their classes are generated in its build. Do not add another
`@theme` block or a `tailwind.config` palette.

## Tokens

Use the named utilities. Grounds nest one step lighter: page ›
well › surface › paper. Panel (ink) is emphasis and machine
output. Plum is selection and people.

| Role | Utilities |
| --- | --- |
| Grounds | `bg-page` `bg-well` `bg-surface` `bg-paper` `bg-panel` |
| Text | `text-fg` `text-fg-2` `text-muted` `text-faint` |
| Type | `type-display` `type-hero` `type-h1` `type-h2` `type-title` `type-body` `type-caption` `type-label` `type-code` `type-meta` |
| Radius | `rounded-2xs` … `rounded-3xl` `rounded-full` |
| Elevation | `shadow-pop` `shadow-float` `shadow-modal` |

Type is those `type-*` utilities, or the `Text` primitive.
Manrope (sans) is for people. JetBrains Mono is for machine text
(`type-label`, `type-code`, `type-meta`).

Depth is stacked colour first. `shadow-pop` / `shadow-float` /
`shadow-modal` are for overlays.

The same names exist as React variants: `<Surface tone="page">`,
`<Text variant="hero">`, `<Card>`.

```tsx
<section className="bg-page px-6 py-16">
  <h1 className="type-display text-fg">Run a guild</h1>
  <p className="type-body text-fg-2">Agents that share a room and a job.</p>
  <div className="rounded-xl bg-paper p-6 shadow-pop">A paper card.</div>
</section>
```

## Components

Import from the package root only:

```tsx
import { BrandMark, Button, Card, CardBody, Surface, Text } from "@guildsrun/ui";
```

`Button` takes `asChild` so a consumer can style its own link,
such as the router's `Link`:

```tsx
<Button asChild>
  <Link to="/recipes">Open the recipes</Link>
</Button>
```

Overlays that need a provider (`TooltipProvider`, `Toaster`) are
mounted once at the app root. The operator app does this in
`apps/web/src/app/App.tsx`.

### What to use

- Foundations (tokens)
- primitives (Surface, Card, Text, Icon, and the rest of that
  folder)
- actions (`Button`, `IconButton`, `CopyButton`)
- form controls
- overlays (Dialog, Sheet, Menu, Popover, Tooltip, Toaster)
- BrandMark
- Avatar
- the generic badges

### What to leave unless embedding a product shot

- `navigation/` (GuildRow, Sidebar, agent chrome)
- `runs/` (ToolCall, RunTrace)
- `conversation/`
- most of `data/` (InboxItem, IssueCard)

Those are the operator app.

## New UI

A page that exists only on one surface, an operator feature layout
or a screen an extension adds, is composed in that app from tokens
and existing primitives. It is not added to `@guildsrun/ui`.

A change every consumer should share, a new token, type style,
radius, or a generic control, is a change in `packages/ui`. Add or
update the Storybook story next to the module in the same PR.
After merge, every workspace consumer picks it up on the next
build.

Do not fork `Button` in a consumer. Do not paste hex into a second
stylesheet. Do not deep-import package internals.

## Storybook and Claude Design

`pnpm storybook` starts the review surface. The sidebar is
Foundations, then Primitives, then Components. The toolbar
switches light and dark (`data-theme`).

A story file sits next to the module it shows. Token and icon
boards live in
`packages/ui/src/foundations/Foundations.stories.tsx`.

`pnpm build:storybook` writes `packages/ui/storybook-static/` (not
in git). The orchestrator image copies that tree to
`apps/web/dist/storybook` and serves it at `/storybook`. `make
check` builds it so the stories compile
([Development](../contributing/development.md)).

`pnpm design-system-doc` writes `packages/ui/design-system.md`
(not in git) from the live library: tokens, type, radius,
identity, status maps, JSDoc, `cva` variants, and Storybook
titles. Attach that file in Claude Design
([claude.ai/design](https://claude.ai/design)) when a design agent
should use the current system.

`apps/web/claude-design-export/` holds the first Claude Design
export. Those files are not the live library.

The screens that consume this kit are in the
[Screen map](screen-map.md). The package on disk is in the
[Code map](code-map.md#packagesui).
